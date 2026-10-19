// Cascade router: provider order, per-task confidence thresholds, hard escalation, fallback to local.
import { guard, redactValue, restore } from './guardrails.mjs';
import { hasRequiredShape, schemaFor, TASKS } from './schemas.mjs';

const KNOWN = ['local', 'vertex-claude', 'vertex-gemini'];
const DEFAULT_THRESHOLD = 0.7;
const TIER_NUM = { local: 0, cheap: 1, strong: 2 };

const truthy = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v !== '' && v !== 'false' : !!v);

/**
 * Hard-escalation flags: injury, fatality, litigation or a CAT code in the input (or input.facts).
 * @returns {string[]} names of the flags that fired
 */
export function hardFlags(input, extra = []) {
  const hits = new Set(extra);
  const scan = (o) => {
    if (!o || typeof o !== 'object') return;
    const g = (...keys) => keys.some((k) => truthy(o[k]));
    if (g('injuries', 'injury', 'injuriesReported', 'bodilyInjury')) hits.add('injury');
    if (g('fatality', 'fatalities', 'fatal')) hits.add('fatality');
    if (g('litigation', 'litigated', 'attorneyInvolved', 'suit')) hits.add('litigation');
    if (g('cat', 'isCat', 'catCode', 'catastrophe', 'catastropheCode')) hits.add('cat');
  };
  scan(input);
  scan(input?.facts);
  scan(input?.facts?.claim);
  scan(input?.facts?.loss);
  return [...hits];
}

const tierOf = (e) => e.tier ?? (e.provider === 'local' ? 'local' : /opus|pro\b|pro-|-pro/i.test(e.model ?? '') ? 'strong' : 'cheap');

/** Build the ordered chain of cascade entries for a task. Pure; exported for tests. */
export function resolveChain(aiConfig, task, { hard = false } = {}) {
  const cfg = aiConfig ?? { provider: 'local' };
  const tcfg = cfg.tasks?.[task] ?? {};
  let entries;
  if (cfg.provider === 'cascade') entries = (cfg.cascade ?? []).filter((e) => !e.tasks || e.tasks.length === 0 || e.tasks.includes(task));
  else entries = [{ provider: cfg.provider || 'local' }];
  entries = entries.filter((e) => KNOWN.includes(e.provider)).map((e) => ({ ...e, tier: tierOf(e) }));
  if (tcfg.enabled === false) entries = [];
  else if (tcfg.provider && KNOWN.includes(tcfg.provider)) {
    const forced = { provider: tcfg.provider, ...(tcfg.model ? { model: tcfg.model } : {}) };
    forced.tier = tierOf(forced);
    entries = [forced, ...entries.filter((e) => e.provider !== forced.provider)];
  }
  if (hard) {
    const cloud = entries.filter((e) => e.provider !== 'local');
    const strong = cloud.filter((e) => e.tier === 'strong');
    entries = strong.length ? strong : cloud.slice(-1);
  }
  if (!entries.some((e) => e.provider === 'local')) entries.push({ provider: 'local', tier: 'local' });
  return entries.map((e) => ({ ...e, threshold: tcfg.threshold ?? e.minConfidence ?? cfg.minConfidence ?? DEFAULT_THRESHOLD }));
}

/**
 * @param {object} ctx platform ctx (needs tenants.get; clock, log optional)
 * @param {{log?: {record: Function}, providers?: object}} deps
 */
export function createCascade(ctx, { log, providers: injected = {} } = {}) {
  const loaded = new Map();

  /** Lazy provider load: absence of src/ai/providers/<name>.mjs never throws. */
  async function getProvider(name, extra) {
    if (extra?.[name]) return extra[name];
    if (injected[name]) return injected[name];
    if (!loaded.has(name)) {
      loaded.set(name, (async () => {
        try {
          const mod = await import(`./providers/${name}.mjs`);
          const make = mod.default ?? mod.createProvider;
          const provider = typeof make === 'function' ? await make(ctx, {}) : make ?? null;
          // Every real provider runs behind the guardrails (injection stripping, PII redaction
          // for cloud providers, output validation). Injected test providers are left as given.
          return provider ? guard(provider) : null;
        } catch (e) {
          ctx.log?.debug?.('ai provider not loadable', { provider: name, error: e.message });
          return null;
        }
      })());
    }
    return loaded.get(name);
  }

  async function run(task, input, opts = {}) {
    if (!TASKS.includes(task)) {
      throw new ctx.AppError('validation_error', `Unknown AI task '${task}'. Expected one of: ${TASKS.join(', ')}`, 400);
    }
    const tenantId = opts.tenantId ?? ctx.tenant?.id;
    const aiConfig = (tenantId && ctx.tenants?.get?.(tenantId)?.ai) || { provider: 'local' };
    const humanConfirm = aiConfig.humanConfirmRequired === true;
    const redactSetting = aiConfig.redactPiiBeforeModel; // cloud is always redacted; only an explicit true affects local
    const maxTokens = Number(aiConfig.maxTokensPerClaim);
    const claimId = opts.claimId ?? undefined;
    const budgetConfigured = Number.isFinite(maxTokens) && maxTokens > 0;
    let budgetHit = false;
    // Fail closed: a configured budget that cannot be measured (no claim, tenant or log) blocks cloud calls.
    const overBudget = () => {
      if (!budgetConfigured) return false;
      if (!claimId || !tenantId || typeof log?.tokensForClaim !== 'function') return true;
      try { return log.tokensForClaim(tenantId, claimId) >= maxTokens; } catch { return true; }
    };
    const spent = (u) => (u && typeof u === 'object' ? u : {});
    const finish = (o) => (humanConfirm || budgetHit ? { ...o, unconfirmed: true } : o);
    const flags = hardFlags(input, opts.flags ?? []);
    const hard = flags.length > 0;
    const chain = resolveChain(aiConfig, task, { hard });
    const finalThreshold = aiConfig.tasks?.[task]?.threshold
      ?? chain.find((e) => e.provider === 'local')?.threshold ?? DEFAULT_THRESHOLD;
    const attempts = [];
    const tried = [];
    const schema = schemaFor(task);

    for (const entry of chain) {
      const started = performance.now();
      const logIt = (extra) => log?.record(tenantId, {
        task, provider: entry.provider, model: entry.model, tier: entry.tier, input, claimId,
        latencyMs: performance.now() - started, escalated: tried.length > 0, ...extra,
      });
      let res;
      let map = {};
      try {
        if (entry.provider !== 'local' && overBudget()) {
          budgetHit = true;
          tried.push(entry.provider);
          logIt({ usage: { skipped: 'budget' } });
          continue;
        }
        const p = await getProvider(entry.provider, opts.providers);
        if (!p || (typeof p.available === 'function' && !(await p.available()))) {
          tried.push(entry.provider);
          logIt({ usage: { skipped: 'unavailable' } });
          continue;
        }
        const explicitRedact = redactSetting === true;
        let sendInput = input;
        // Guarded providers redact themselves (forceRedact); injected/unguarded ones are redacted here.
        if (explicitRedact && !p.guarded) {
          const r = redactValue(input ?? {});
          sendInput = r.value; map = r.map;
        }
        res = await p.run(task, sendInput, { tier: entry.tier, schema, model: entry.model, tenantId, ...(claimId ? { claimId } : {}), ...(explicitRedact ? { forceRedact: true } : {}) });
        if (res && !res.refusal && explicitRedact && !p.guarded && Object.keys(map).length) {
          res = { ...res, output: restore(res.output, map), explanation: restore(res.explanation ?? '', map) };
        }
        if (!res || res.refusal) {
          tried.push(entry.provider);
          logIt({ model: res?.model, usage: { ...spent(res?.usage), skipped: 'refusal' } });
          continue;
        }
        if (!hasRequiredShape(task, res.output) || typeof res.confidence !== 'number') {
          tried.push(entry.provider);
          logIt({ model: res.model, usage: { ...spent(res.usage), skipped: 'invalid_output' } });
          continue;
        }
      } catch (e) {
        tried.push(entry.provider);
        logIt({ usage: { ...spent(e?.usage), skipped: 'error', error: String(e?.message ?? e).slice(0, 120) } });
        continue;
      }
      const out = {
        output: res.output,
        provider: entry.provider,
        model: res.model ?? entry.model ?? entry.provider,
        confidence: res.confidence,
        explanation: res.explanation ?? '',
        usage: res.usage ?? {},
        tier: TIER_NUM[entry.tier] ?? 1, // AiProvenance.tier: 0 local, 1 cheap cloud, 2 strong cloud
        tierName: entry.tier,
        ...(tried.length ? { escalatedFrom: [...tried] } : {}),
        ...(hard ? { hardEscalation: flags } : {}),
      };
      logIt({ model: out.model, confidence: out.confidence, usage: out.usage });
      if (out.confidence >= entry.threshold) return finish(out);
      attempts.push(out);
      tried.push(entry.provider);
    }
    if (!attempts.length) {
      throw new ctx.AppError('ai_unavailable', `No AI provider could complete '${task}'`, 503);
    }
    const best = attempts.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    return { ...best, unconfirmed: best.confidence < finalThreshold || humanConfirm || budgetHit };
  }

  async function health() {
    const out = {};
    for (const n of KNOWN) {
      const p = await getProvider(n);
      try { out[n] = !p ? 'unconfigured' : (await p.available?.()) === false ? 'unconfigured' : 'available'; } catch { out[n] = 'error'; }
    }
    return out;
  }

  return { run, health };
}
