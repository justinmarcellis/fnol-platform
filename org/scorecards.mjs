#!/usr/bin/env node
// Performance scorecards engine (S1-PMO-01).
//   node org/scorecards.mjs [--sprint n]
// Writes org/scorecards/latest.json and org/scorecards/sprint-<n>.json.
// Pure functions take ticket arrays; only the CLI path touches the board.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(HERE, 'scorecards');

export const DEFAULT_WEIGHTS = { firstPass: 0.35, rework: 0.2, estimate: 0.2, cost: 0.15, defects: 0.1 };
export const MIN_TICKETS = 3; // fewer than this = lowConfidence, never actionable
export const LOW_PERCENTILE = 0.1;
const DEFAULT_TARGET = 0.75;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const round = (x) => (x === null || x === undefined ? null : Math.round(x * 1000) / 1000);

export function median(values) {
  const v = values.filter((x) => num(x) !== null).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const hoursOf = (t) => {
  const a = Date.parse(t.startedAt), b = Date.parse(t.doneAt);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 3.6e6 : null;
};
const costOf = (t) => num(t.spend?.usd);
const pointsOf = (t) => num(t.points) ?? 0;

/** Done tickets only. */
export const doneTickets = (tickets) => (tickets ?? []).filter((t) => t && t.status === 'done');

/** Company medians of per-ticket hours/point and cost/point over done tickets (tickets lacking data skipped). */
export function medians(tickets) {
  const done = doneTickets(tickets).filter((t) => pointsOf(t) > 0);
  return {
    hoursPerPoint: round(median(done.map((t) => (hoursOf(t) === null ? null : hoursOf(t) / pointsOf(t))))),
    costPerPoint: round(median(done.map((t) => (costOf(t) === null ? null : costOf(t) / pointsOf(t))))),
  };
}

/**
 * Composite per config formula:
 * 0.35*firstPass + 0.2*(1-rework) + 0.2*estimateAccuracy + 0.15*costEfficiency + 0.1*(1-defects).
 * estimateAccuracy = clamp(1-|hpp/medianHpp-1|); costEfficiency = clamp(medianCpp/cpp); both 1 when no data.
 */
export function compositeScore(m, med, weights = DEFAULT_WEIGHTS) {
  const hpp = num(m.hoursPerPoint), cpp = num(m.costPerPoint);
  const estimateAccuracy = hpp !== null && hpp > 0 && med.hoursPerPoint > 0
    ? clamp01(1 - Math.abs(hpp / med.hoursPerPoint - 1)) : 1;
  const costEfficiency = cpp !== null && cpp > 0 && med.costPerPoint > 0
    ? clamp01(med.costPerPoint / cpp) : 1;
  const w = weights;
  return round(
    w.firstPass * clamp01(m.firstPassAcceptance ?? 0) +
    w.rework * (1 - clamp01(m.reworkRate ?? 0)) +
    w.estimate * estimateAccuracy +
    w.cost * costEfficiency +
    w.defects * (1 - clamp01(m.defects ?? 0)),
  );
}

/** Raw metrics for one group of done tickets. */
export function metricsFor(group) {
  const n = group.length;
  const points = group.reduce((s, t) => s + pointsOf(t), 0);
  const timed = group.filter((t) => hoursOf(t) !== null && pointsOf(t) > 0);
  const costed = group.filter((t) => costOf(t) !== null && pointsOf(t) > 0);
  const tp = timed.reduce((s, t) => s + pointsOf(t), 0);
  const cp = costed.reduce((s, t) => s + pointsOf(t), 0);
  return {
    ticketsDone: n,
    points,
    firstPassAcceptance: n ? group.filter((t) => t.review?.firstPass === true).length / n : 0,
    reworkRate: n ? group.filter((t) => (num(t.review?.reworkCount) ?? 0) > 0).length / n : 0,
    defects: n ? group.reduce((s, t) => s + (num(t.review?.escapedDefects) ?? 0), 0) / n : 0,
    hoursPerPoint: tp ? timed.reduce((s, t) => s + hoursOf(t), 0) / tp : null,
    costPerPoint: cp ? costed.reduce((s, t) => s + costOf(t), 0) / cp : null,
  };
}

/**
 * Diagnosis heuristics (all documented here):
 *  - oversized task: a ticket with points>8 and rework        -> split into <=5 point tickets
 *  - wrong tier: costPerPoint > 2x company median              -> try a cheaper tier or tighter prompt
 *  - slow vs estimate: hoursPerPoint > 2x median               -> estimates or scope off
 *  - low first pass: firstPassAcceptance < target (>=3 tickets)-> acceptance criteria / prompt unclear
 *  - escaped defects: defects >= 0.5 per ticket                -> add tests / review step
 *  - low confidence: < 3 tickets                               -> no action
 */
export function diagnose(row, group, med, targets = {}) {
  const out = [];
  const big = group.filter((t) => pointsOf(t) > 8 && (num(t.review?.reworkCount) ?? 0) > 0);
  if (big.length) out.push(`oversized task: ${big.map((t) => t.id).join(', ')} (>8 points with rework); split into smaller tickets`);
  if (row.costPerPoint !== null && med.costPerPoint > 0 && row.costPerPoint > 2 * med.costPerPoint) {
    out.push(`wrong tier: cost per point ${row.costPerPoint} is over 2x median ${med.costPerPoint}; try a cheaper tier`);
  }
  if (row.hoursPerPoint !== null && med.hoursPerPoint > 0 && row.hoursPerPoint > 2 * med.hoursPerPoint) {
    out.push(`slow vs estimate: hours per point ${row.hoursPerPoint} is over 2x median ${med.hoursPerPoint}`);
  }
  if (!row.lowConfidence && row.firstPassAcceptance < (targets.firstPassAcceptance ?? DEFAULT_TARGET)) {
    out.push(`low first-pass acceptance (${row.firstPassAcceptance}); tighten acceptance criteria or prompt`);
  }
  if (row.defects >= 0.5) out.push(`escaped defects (${row.defects} per ticket); add tests or review`);
  if (row.lowConfidence) out.push(`low confidence: fewer than ${MIN_TICKETS} tickets, no action`);
  return out;
}

function groupBy(done, keyFn) {
  const map = new Map();
  for (const t of done) {
    const k = keyFn(t);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function scoreRows(done, keyFn, extra, med, cfg) {
  const rows = groupBy(done, keyFn).map(([key, group]) => {
    const m = metricsFor(group);
    const lowConfidence = m.ticketsDone < MIN_TICKETS;
    const row = {
      key, ...extra(group[0]),
      ticketsDone: m.ticketsDone, points: m.points,
      firstPassAcceptance: round(m.firstPassAcceptance), reworkRate: round(m.reworkRate), defects: round(m.defects),
      hoursPerPoint: round(m.hoursPerPoint), costPerPoint: round(m.costPerPoint),
      composite: compositeScore(m, med, cfg.weights),
      lowPerformer: false, lowConfidence,
    };
    row.diagnosis = diagnose(row, group, med, cfg.targets);
    return row;
  });
  flagLowPerformers(rows, cfg);
  return rows;
}

/** Low performer: bottom 10% composite among rows with >=3 tickets, or below target two sprints running. */
export function flagLowPerformers(rows, { target = DEFAULT_TARGET, previous = {} } = {}) {
  const eligible = rows.filter((r) => !r.lowConfidence).sort((a, b) => a.composite - b.composite || (a.key < b.key ? -1 : 1));
  const k = eligible.length ? Math.max(1, Math.ceil(eligible.length * LOW_PERCENTILE)) : 0;
  const best = eligible.length ? eligible[eligible.length - 1].composite : 0;
  const bottom = new Set(eligible.slice(0, k).filter((r) => r.composite < best).map((r) => r.key));
  for (const r of rows) {
    if (r.lowConfidence) { r.lowPerformer = false; continue; }
    const prev = previous[r.key];
    const twoRunning = r.composite < target && num(prev) !== null && prev < target;
    r.lowPerformer = bottom.has(r.key) || twoRunning;
    if (bottom.has(r.key)) r.diagnosis.push('bottom 10% composite');
    if (twoRunning) r.diagnosis.push(`composite below target ${target} two sprints running`);
  }
  return rows;
}

const cfgOf = (config = {}, previous = {}) => ({
  weights: DEFAULT_WEIGHTS,
  targets: config.targets ?? {},
  // composite target: the program first-pass target is the bar a composite must clear (documented assumption)
  target: config.targets?.firstPassAcceptance ?? DEFAULT_TARGET,
  previous,
});

export const agentScorecards = (tickets, opts = {}) => {
  const done = doneTickets(tickets), med = opts.medians ?? medians(done);
  return scoreRows(done, (t) => t.owner, (t) => ({ owner: t.owner }), med, cfgOf(opts.config, opts.previous?.agents));
};
export const configScorecards = (tickets, opts = {}) => {
  const done = doneTickets(tickets), med = opts.medians ?? medians(done);
  return scoreRows(done, (t) => t.owner && t.tier && `${t.owner}+${t.tier}`, (t) => ({ owner: t.owner, tier: t.tier }), med, cfgOf(opts.config, opts.previous?.configs));
};
export const teamScorecards = (tickets, opts = {}) => {
  const done = doneTickets(tickets), med = opts.medians ?? medians(done);
  return scoreRows(done, (t) => t.team, (t) => ({ team: t.team }), med, cfgOf(opts.config, opts.previous?.teams));
};

/**
 * Build the full scorecard document. Counts done tickets with sprint <= `sprint` (cumulative).
 * `previous` = {agents:{key:composite}, configs:{...}, teams:{...}} from the prior sprint's file.
 */
export function buildScorecards({ tickets = [], sprint, config = {}, previous = {}, now = new Date().toISOString() } = {}) {
  const done = doneTickets(tickets);
  const sp = sprint ?? done.reduce((m, t) => Math.max(m, num(t.sprint) ?? 0), 0);
  const scoped = done.filter((t) => (num(t.sprint) ?? 0) <= sp);
  const med = medians(scoped);
  const opts = { config, previous, medians: med };
  return {
    sprint: sp, generatedAt: now, medians: med,
    agents: agentScorecards(scoped, opts), configs: configScorecards(scoped, opts), teams: teamScorecards(scoped, opts),
  };
}

const previousMap = (doc) => Object.fromEntries(['agents', 'configs', 'teams'].map((k) => [k, Object.fromEntries((doc?.[k] ?? []).map((r) => [r.key, r.composite]))]));

export function loadPrevious(sprint, dir = OUT_DIR) {
  const p = join(dir, `sprint-${sprint - 1}.json`);
  try { return existsSync(p) ? previousMap(JSON.parse(readFileSync(p, 'utf8'))) : {}; } catch { return {}; }
}

export async function main(argv = process.argv.slice(2)) {
  const { listTickets, config } = await import('./fabric.mjs');
  const i = argv.indexOf('--sprint');
  const sprint = i >= 0 ? Number(argv[i + 1]) : undefined;
  if (i >= 0 && !Number.isInteger(sprint)) throw new Error('--sprint needs an integer');
  const tickets = listTickets();
  const sp = sprint ?? doneTickets(tickets).reduce((m, t) => Math.max(m, num(t.sprint) ?? 0), 0);
  const doc = buildScorecards({ tickets, sprint: sp, config: config(), previous: loadPrevious(sp) });
  mkdirSync(OUT_DIR, { recursive: true });
  const text = JSON.stringify(doc, null, 2) + '\n';
  writeFileSync(join(OUT_DIR, 'latest.json'), text);
  writeFileSync(join(OUT_DIR, `sprint-${doc.sprint}.json`), text);
  console.log(`scorecards sprint ${doc.sprint}: ${doc.agents.length} agents, ${doc.configs.length} configs, ${doc.teams.length} teams`);
  return doc;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
