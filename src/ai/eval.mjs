// Offline AI evaluation harness. Scores the local provider (and recorded vertex responses) against
// golden cases in tests/fixtures/ai/golden/*.json. No network, no clock in scores, deterministic output.
//   node src/ai/eval.mjs            writes docs/ai-evaluation.md
//   node src/ai/eval.mjs --live ... live Vertex run (see eval-live.mjs); writes docs/ai-evaluation-live.md
//   import { runEval } from './eval.mjs'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard } from './guardrails.mjs';
import { TASKS } from './schemas.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = resolve(HERE, '../../tests/fixtures/ai/golden');
const TENANT_SETTINGS_DOC = "## Tenant AI settings\n\nRead from the tenant config `ai` block on every `ai.run`. Callers should pass `claimId` in the run options.\n\n- `ai.humanConfirmRequired` (boolean). When `true`, every `cascade.run` result carries `unconfirmed: true`, including early returns where confidence cleared the threshold. When `false` or absent, behaviour is unchanged.\n- `ai.redactPiiBeforeModel` (boolean). Cloud providers always receive redacted input (default `true`); an explicit `false` is honoured for the local provider only and never lowers cloud redaction. An explicit `true` also redacts input for the local provider and for injected (unguarded) providers; placeholders are restored in the returned output.\n- `ai.maxTokensPerClaim` (number). Tokens per claim are summed from `ai_inference` rows for the tenant whose `usage.claimId` matches (`inputTokens + outputTokens`; the claim id is stored inside the usage JSON, there is no schema change). Once the total reaches the limit, cloud entries are skipped and logged with `usage.skipped = 'budget'`, the local provider is used, and the result has `unconfirmed: true`. Counts are per tenant; another tenant's usage is never included. Without a `claimId` the budget is not enforced.\n\n";
export const DOC_PATH = resolve(HERE, '../../docs/ai-evaluation.md');
/** Fraud score at or above this counts as "flagged". */
export const FRAUD_FLAG_THRESHOLD = 40;
const BANDS = ['low', 'medium', 'high', 'severe'];

// ---------- scoring primitives ----------
const norm = (v) => (Array.isArray(v) ? [...v].map(norm).sort().join('|') : typeof v === 'number' ? String(v) : String(v ?? '').trim().toLowerCase());
const present = (v) => !(v === undefined || v === null || v === '' || v === 'unknown' || (Array.isArray(v) && v.length === 0));
const ratio = (a, b) => (b === 0 ? null : a / b);
const round = (n) => (n === null || n === undefined ? null : Math.round(n * 1000) / 1000);

/** Pair-set scoring: returns counts so callers can micro-average. */
export function setCounts(predicted, expected) {
  const p = new Set(predicted);
  const e = new Set(expected);
  let tp = 0;
  for (const x of p) if (e.has(x)) tp += 1;
  return { tp, pred: p.size, exp: e.size };
}

const pairs = (kind, obj, keys) => keys.filter((k) => present(obj?.[k])).map((k) => `${kind}:${k}=${norm(obj[k])}`);

/** Convert a case's output into the comparable set for set-based tasks. */
function factSet(task, output) {
  switch (task) {
    case 'extract_narrative': {
      const set = pairs('f', output, ['lossType', 'lossDate', 'location', 'atFault']);
      if (output?.injuries === true) set.push('f:injuries=true');
      for (const c of output?.cues ?? []) set.push(`cue:${c}`);
      return set;
    }
    case 'extract_document':
      return (output?.fields ?? []).filter((f) => present(f.value)).map((f) => `f:${f.name}=${norm(f.value)}`);
    case 'classify_photo':
      return (output?.damageAreas ?? []).map((a) => `area:${norm(a)}`);
    case 'next_best_actions':
      return (output?.actions ?? []).map((a) => `action:${a.code}`);
    default:
      return [];
  }
}

function expectedSet(task, expected) {
  switch (task) {
    case 'extract_narrative': {
      const set = pairs('f', expected, ['lossType', 'lossDate', 'location', 'atFault']);
      if (expected?.injuries === true) set.push('f:injuries=true');
      for (const c of expected?.cues ?? []) set.push(`cue:${c}`);
      return set;
    }
    case 'extract_document':
      return Object.entries(expected?.fields ?? {}).map(([k, v]) => `f:${k}=${norm(v)}`);
    case 'classify_photo':
      return (expected?.damageAreas ?? []).map((a) => `area:${norm(a)}`);
    case 'next_best_actions':
      return (expected?.actionCodes ?? []).map((c) => `action:${c}`);
    default:
      return [];
  }
}

/** Score one case. `output` is null when the provider fell back (refusal / invalid). */
export function scoreCase(task, output, expected) {
  if (task === 'severity') {
    const hit = output?.band === expected.band;
    const near = output ? Math.abs(BANDS.indexOf(output.band) - BANDS.indexOf(expected.band)) <= 1 : false;
    return { kind: 'band', hit, near };
  }
  if (task === 'fraud_signals') {
    const flag = output ? output.score >= FRAUD_FLAG_THRESHOLD : false;
    const codes = setCounts((output?.indicators ?? []).map((i) => `ind:${i.code}`), (expected.indicators ?? []).map((c) => `ind:${c}`));
    return { kind: 'flag', hit: flag === expected.flag, ...codes, predFlag: flag };
  }
  if (task === 'subrogation') {
    return { kind: 'flag', hit: output ? output.flag === expected.flag : false, predFlag: output?.flag ?? null };
  }
  if (task === 'summarize') {
    const hay = `${output?.summary ?? ''} ${(output?.bullets ?? []).join(' ')}`.toLowerCase();
    const need = expected.mustInclude ?? [];
    return { kind: 'coverage', found: need.filter((s) => hay.includes(s.toLowerCase())).length, total: need.length };
  }
  const sets = setCounts(factSet(task, output), expectedSet(task, expected));
  return { kind: 'set', ...sets };
}

/** Aggregate case scores into per-task metrics (micro-averaged). */
export function aggregate(task, scores, extra = {}) {
  const m = { cases: scores.length, ...extra };
  const k = scores[0]?.kind;
  if (k === 'set') {
    const tp = sum(scores, 'tp'); const pred = sum(scores, 'pred'); const exp = sum(scores, 'exp');
    m.precision = round(ratio(tp, pred)); m.recall = round(ratio(tp, exp));
    m.f1 = m.precision !== null && m.recall !== null && m.precision + m.recall > 0 ? round((2 * m.precision * m.recall) / (m.precision + m.recall)) : 0;
  } else if (k === 'band') {
    m.bandAccuracy = round(ratio(scores.filter((s) => s.hit).length, scores.length));
    m.withinOneBand = round(ratio(scores.filter((s) => s.near).length, scores.length));
  } else if (k === 'flag') {
    m.flagAccuracy = round(ratio(scores.filter((s) => s.hit).length, scores.length));
    if (task === 'fraud_signals') {
      const tp = sum(scores, 'tp'); const pred = sum(scores, 'pred'); const exp = sum(scores, 'exp');
      m.indicatorPrecision = round(ratio(tp, pred)); m.indicatorRecall = round(ratio(tp, exp));
    }
  } else if (k === 'coverage') {
    m.keyCoverage = round(ratio(sum(scores, 'found'), sum(scores, 'total')));
  }
  return m;
}
const sum = (a, k) => a.reduce((s, x) => s + (x[k] ?? 0), 0);

// ---------- golden loading ----------
/** @returns {Promise<object[]>} parsed golden files, sorted by file name */
export async function loadGolden(dir = GOLDEN_DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const out = [];
  for (const f of files) out.push(JSON.parse(await readFile(join(dir, f), 'utf8')));
  return out;
}

// ---------- providers ----------
/**
 * A cloud-looking fake that replays recorded responses. Never touches the network.
 * Call select(case) before run(); keeps what it received so tests can prove redaction.
 */
export function createRecordedProvider(name) {
  const state = { current: null, received: [] };
  return {
    name, kind: 'cloud', state,
    select(c) { state.current = c; },
    async available() { return true; },
    async run(task, input) {
      state.received.push(JSON.stringify(input));
      const rec = state.current?.recorded?.[name];
      if (!rec) return { refusal: true, error: 'no_recording' };
      return structuredClone(rec);
    },
  };
}

async function defaultLocal() {
  const mod = await import('./providers/local.mjs');
  return mod.default({}, {});
}

// ---------- run ----------
/**
 * @param {object} [opts]
 * @param {object[]} [opts.golden] golden files already parsed ({task, cases}); default loads GOLDEN_DIR
 * @param {string} [opts.goldenDir]
 * @param {object} [opts.local] local provider (default providers/local.mjs)
 * @param {string[]} [opts.vertex] recorded-provider names to replay (default: every name found in recordings)
 * @param {object} [opts.guardOpts]
 * @returns {Promise<{providers: Record<string, {label: string, recorded: boolean, tasks: Record<string, object>, pii: object}>, taskOrder: string[]}>}
 */
export async function runEval(opts = {}) {
  const golden = opts.golden ?? await loadGolden(opts.goldenDir);
  const byTask = new Map(TASKS.map((t) => [t, []]));
  for (const g of golden) if (byTask.has(g.task)) byTask.get(g.task).push(...g.cases.map((c) => ({ ...c, _task: g.task })));
  const names = opts.vertex ?? [...new Set(golden.flatMap((g) => g.cases.flatMap((c) => Object.keys(c.recorded ?? {}))))].sort();

  const subjects = [{ name: 'local', recorded: false, raw: opts.local ?? await defaultLocal() }];
  for (const n of names) subjects.push({ name: n, recorded: true, raw: createRecordedProvider(n) });

  const providers = {};
  for (const s of subjects) {
    const reports = [];
    const wrapped = guard(s.raw, { ...opts.guardOpts, onGuard: (r) => reports.push(r) });
    const tasks = {};
    let leaks = 0; let redactedTokens = 0; let calls = 0;
    for (const [task, cases] of byTask) {
      const scores = [];
      let invalid = 0; let fellBack = 0;
      for (const c of cases) {
        if (s.recorded && !c.recorded?.[s.name]) continue;
        s.raw.select?.(c);
        const before = reports.length;
        const res = await wrapped.run(task, structuredClone(c.input), {});
        const rep = reports[before];
        calls += 1;
        redactedTokens += rep?.redacted ?? 0;
        if (!res || res.refusal) { fellBack += 1; if (res?.error === 'invalid_output') invalid += 1; }
        if (s.recorded) {
          const sent = s.raw.state.received.at(-1) ?? '';
          leaks += (c.pii ?? []).filter((p) => sent.includes(p)).length;
        }
        scores.push(scoreCase(task, res && !res.refusal ? res.output : null, c.expected));
      }
      if (scores.length) tasks[task] = aggregate(task, scores, { invalid, fellBack });
    }
    providers[s.name] = {
      label: s.recorded ? `${s.name} (recorded fakes)` : `${s.name} (rules)`,
      recorded: s.recorded, tasks, pii: { calls, placeholders: redactedTokens, leaks },
    };
  }
  return { providers, taskOrder: [...TASKS] };
}

// ---------- report ----------
const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);

const COLUMNS = {
  extract_narrative: [['Precision', 'precision'], ['Recall', 'recall'], ['F1', 'f1']],
  extract_document: [['Precision', 'precision'], ['Recall', 'recall'], ['F1', 'f1']],
  classify_photo: [['Precision', 'precision'], ['Recall', 'recall'], ['F1', 'f1']],
  next_best_actions: [['Precision', 'precision'], ['Recall', 'recall'], ['F1', 'f1']],
  severity: [['Band accuracy', 'bandAccuracy'], ['Within one band', 'withinOneBand']],
  fraud_signals: [['Flag accuracy', 'flagAccuracy'], ['Indicator precision', 'indicatorPrecision'], ['Indicator recall', 'indicatorRecall']],
  subrogation: [['Flag accuracy', 'flagAccuracy']],
  summarize: [['Key-fact coverage', 'keyCoverage']],
};

/** Render the evaluation as Markdown. `date` is the only non-deterministic input. */
export function renderReport(result, { date }) {
  const L = [];
  L.push('# AI evaluation', '', `Generated by \`node src/ai/eval.mjs\` on ${date}. All data is synthetic.`, '');
  L.push('## Method', '');
  L.push('- Golden cases live in `tests/fixtures/ai/golden/*.json`, one file per task. Each case has an `input`, an `expected` block, optional `pii` strings that must never reach a cloud provider, and optional `recorded` responses for the vertex providers.');
  L.push('- Every provider call goes through `guard()` in `src/ai/guardrails.mjs`: injection markers are neutralised, input is capped, cloud providers receive redacted text, and outputs are validated against `src/ai/schemas.mjs`. An invalid output counts as a fallback and scores as an empty prediction.');
  L.push('- The local rules provider runs for real. The vertex providers are never called: their responses are replayed from the recorded fakes in the golden files, so results are fixed and say nothing about live model quality.');
  L.push('- Set metrics (extraction, photo damage areas, next best actions) are micro-averaged over `name=value` facts: precision is correct facts over predicted facts, recall is correct facts over expected facts. Narrative scoring also counts the `cues` list. Empty values and `unknown` are not predictions.');
  L.push(`- Severity is scored on band accuracy (exact, and within one band). Fraud is scored on the flag (score >= ${FRAUD_FLAG_THRESHOLD}) plus indicator precision and recall. Subrogation is scored on the flag. Summaries are scored on how many required key facts appear.`);
  L.push('- `Cases` is the number of golden cases scored for that provider; `Fallbacks` counts calls that returned no usable output (refusal or invalid), of which `Invalid` failed schema validation.', '');
  for (const [name, p] of Object.entries(result.providers)) {
    L.push(`## ${p.label}`, '');
    L.push('| Task | Cases | Fallbacks | Invalid | Metrics |', '| --- | ---: | ---: | ---: | --- |');
    for (const t of result.taskOrder) {
      const m = p.tasks[t];
      if (!m) continue;
      const metrics = (COLUMNS[t] ?? []).map(([label, key]) => `${label} ${pct(m[key])}`).join('; ');
      L.push(`| ${t} | ${m.cases} | ${m.fellBack} | ${m.invalid} | ${metrics} |`);
    }
    L.push('');
    if (p.recorded) L.push(`Redaction check: ${p.pii.calls} guarded calls sent ${p.pii.placeholders} placeholder token(s) and leaked ${p.pii.leaks} known PII string(s) to the provider.`, '');
    else L.push('The local provider receives the full, un-redacted text by design.', '');
    void name;
  }
  L.push(TENANT_SETTINGS_DOC);
  L.push('## Limits', '');
  L.push('- Golden sets are small and written for this proof of concept; treat the numbers as regression guards, not benchmarks.');
  L.push('- Recorded vertex responses are hand-written to exercise scoring and the guardrails, including one deliberately invalid reply.');
  L.push('');
  return L.join('\n');
}

/** Run the default evaluation and write docs/ai-evaluation.md. */
export async function writeReport({ docPath = DOC_PATH, date = process.env.EVAL_DATE ?? new Date().toISOString().slice(0, 10), ...opts } = {}) {
  const result = await runEval(opts);
  await mkdir(dirname(docPath), { recursive: true });
  await writeFile(docPath, renderReport(result, { date }));
  return { result, docPath };
}

async function main(argv) {
  if (argv.includes('--live')) {
    // Live mode lives in eval-live.mjs; no flag means the offline, deterministic report below.
    const { liveMain } = await import('./eval-live.mjs');
    const { exitCode } = await liveMain(argv);
    process.exitCode = exitCode;
    return;
  }
  const { docPath } = await writeReport();
  process.stdout.write(`wrote ${docPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Not awaited at module level, so a lazy import of eval-live.mjs (which imports this file) cannot deadlock.
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = 1; });
}
