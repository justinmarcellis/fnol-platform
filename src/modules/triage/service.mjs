// Triage service: gathers inputs through ctx.modules (each read degrades gracefully), builds PII-free
// facts, runs the AI passes, merges with deterministic logic, persists and publishes claim.triaged.
import { buildTriageFacts, sha256 } from './facts.mjs';
import { computeSeverity } from './severity.mjs';
import { computeComplexity } from './complexity.mjs';
import { deterministicIndicators, mergeFraud } from './fraud.mjs';
import { computeSubrogation } from './subrogation.mjs';
import { explain } from './explain.mjs';

const SYSTEM_ACTOR = 'system:triage';
const NO_RETRIAGE = new Set(['in_review', 'pending_info', 'closed', 'withdrawn']);
const TERMINAL = new Set(['closed', 'withdrawn']);

/** @param {object} ctx tenant-bound context */
export function createService(ctx) {
  const AppError = ctx.AppError;
  const chains = new Map(); // claimId -> promise, serializes runs per claim

  /** Run an optional dependency; absence or failure yields the fallback. Logs the error message only. */
  async function safe(label, fn, fallback = null) {
    try {
      const v = await fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      ctx.log.warn('triage input unavailable', { input: label, error: e?.code ?? e?.message });
      return fallback;
    }
  }
  const mod = (name, fn) => { const m = ctx.modules?.[name]; return m && typeof m[fn] === 'function' ? m[fn].bind(m) : null; };

  const row2doc = (r) => (r ? ctx.db.parseJson(r.doc, null) : null);

  async function runAi(task, facts, claimId) {
    if (!ctx.ai || typeof ctx.ai.run !== 'function') return null;
    return safe(`ai.${task}`, () => ctx.ai.run(task, { facts }, { tenantId: ctx.tenant.id, ...(claimId ? { claimId } : {}) }));
  }

  async function gather(claimId) {
    const getBundle = mod('claims', 'getClaimBundle');
    if (!getBundle) throw new AppError('unavailable', 'Claims module unavailable', 503);
    const bundle = await getBundle(claimId); // not_found propagates
    if (!bundle?.claim) throw new AppError('not_found', 'Claim not found', 404);
    const accepted = await safe('evidence', async () => mod('evidence', 'getAcceptedFacts')?.(claimId), {});
    const verification = await safe('coverage', async () => mod('coverage', 'getLatestVerification')?.(claimId), null);
    const snapId = verification?.policySnapshotId ?? bundle.claim.policySnapshotId;
    const policy = snapId ? await safe('policy', async () => mod('coverage', 'getSnapshotById')?.(snapId), null) : null;
    return { bundle, accepted: accepted ?? {}, verification, policy };
  }

  async function ruleOutcome(facts, bundle) {
    const evaluate = mod('rules', 'evaluate');
    if (!evaluate) return { deltas: [], complexity: [], fired: [] };
    const buildFacts = mod('rules', 'buildFacts');
    const claim = bundle.claim;
    const base = buildFacts ? await safe('rules.buildFacts', () => buildFacts(claim.id), {}) : {};
    const ruleFacts = {
      ...base, ...facts,
      claim: { ...(base?.claim ?? {}), id: claim.id, lob: facts.lob, lossType: facts.lossType },
      loss: { ...(base?.loss ?? {}), cause: facts.cause, injuriesReported: facts.injuries, fatality: facts.fatality, vehiclesInvolved: facts.vehiclesInvolved },
      coverage: { ...(base?.coverage ?? {}), ...(facts.coverage ?? {}) },
    };
    const res = await safe('rules.evaluate', () => evaluate({
      stage: 'triage', facts: ruleFacts, lob: facts.lob ?? undefined, state: facts.riskState ?? undefined, lossType: facts.lossType ?? undefined,
    }), null);
    const actions = res?.actions ?? [];
    return {
      deltas: actions.filter((a) => a.type === 'add_severity').map((a) => Number(a.points)).filter(Number.isFinite),
      complexity: actions.filter((a) => a.type === 'set_complexity').map((a) => a.complexity),
      fired: (res?.fired ?? []).map((f) => f.ruleId),
    };
  }

  const latestRow = (claimId) => ctx.db.get('SELECT * FROM triage_results WHERE claim_id = ? ORDER BY attempt DESC LIMIT 1', claimId);

  async function execute(claimId, { force = false, actor, sourceEventId } = {}) {
    const { bundle, accepted, verification, policy } = await gather(claimId);
    if (TERMINAL.has(bundle.claim.status) && actor && actor !== SYSTEM_ACTOR) {
      throw new AppError('conflict', `Claim is ${bundle.claim.status}; triage cannot be re-run`, 409);
    }
    const facts = buildTriageFacts({ bundle, accepted, verification, policy });
    const rules = await ruleOutcome(facts, bundle);
    const inputsHash = sha256({ facts, rules: { deltas: rules.deltas, complexity: rules.complexity } });

    const prior = latestRow(claimId);
    if (prior && !force && prior.input_hash === inputsHash) return row2doc(prior);

    // AI passes in parallel; any failure degrades to deterministic logic.
    const [sevAi, fraudAi, subAi] = await Promise.all([runAi('severity', facts, claimId), runAi('fraud_signals', facts, claimId), runAi('subrogation', facts, claimId)]);

    const tenantCfg = ctx.tenant.config ?? {};
    const cfg = tenantCfg.triage ?? {};
    // Band cut-offs: TenantConfig.severityBands (contract), legacy triage.severityBands, else 25/50/75.
    const severity = computeSeverity(sevAi?.output ?? null, rules.deltas, facts, tenantCfg.severityBands ?? cfg.severityBands);
    const complexity = computeComplexity(facts, rules.complexity, severity);
    const fraud = mergeFraud(deterministicIndicators(facts, cfg.fraud), fraudAi?.output ?? null, cfg.fraud);
    const subrogation = computeSubrogation(facts, subAi?.output ?? null);
    const degraded = !sevAi;
    const explanation = explain({ severity, complexity, fraud, subrogation, degraded });
    const fastTrackEligible = severity.band === 'minor' && complexity.complexity === 'low' && fraud.score < 25
      && !subrogation.flag && (facts.coverage?.outcome ?? null) === 'covered';
    const ai = sevAi
      ? { provider: sevAi.provider, model: sevAi.model, confidence: Math.max(0, Math.min(1, Number(sevAi.confidence) || 0)), ...(Number.isInteger(sevAi.tier) ? { tier: sevAi.tier } : {}) }
      : { provider: 'local', model: 'triage-deterministic-v1', confidence: 0.3, tier: 0 };

    return ctx.db.transaction(() => {
      const again = latestRow(claimId);
      if (again && !force && again.input_hash === inputsHash) return row2doc(again); // lost a race
      const attempt = (again?.attempt ?? 0) + 1;
      const now = ctx.clock.nowIso();
      const doc = {
        id: ctx.db.id('trg'), tenantId: ctx.tenant.id, claimId, attempt,
        severityScore: severity.score, severityBand: severity.band, complexity: complexity.complexity,
        fraud: { score: fraud.score, indicators: fraud.indicators, referToSiu: fraud.referToSiu },
        subrogation: { flag: subrogation.flag, reasons: subrogation.reasons, confidence: subrogation.confidence },
        factors: severity.factors, fastTrackEligible, explanation, ai, inputsHash, createdAt: now,
      };
      // Initial reserve suggestion: the accepted estimate total from evidence, when one exists.
      if (typeof facts.estimateTotal === 'number' && facts.estimateTotal >= 0) {
        doc.suggestedReserve = { amount: facts.estimateTotal, currency: 'USD' };
      }
      ctx.db.insert('triage_results', {
        id: doc.id, claim_id: claimId, attempt, severity_score: doc.severityScore, complexity: doc.complexity,
        fraud_score: fraud.score, subrogation: subrogation.flag ? 1 : 0, doc: JSON.stringify(doc),
        provider: ai.provider, model: ai.model, confidence: ai.confidence, input_hash: inputsHash,
        source_event_id: sourceEventId ?? null, created_at: now,
      });
      ctx.audit.record({
        actor: actor ?? SYSTEM_ACTOR, action: 'triage.run', entityType: 'claim', entityId: claimId,
        details: { triageResultId: doc.id, attempt, severityScore: doc.severityScore, fraudScore: fraud.score, force: !!force, ruleIds: rules.fired },
      });
      ctx.bus.publish('claim.triaged', claimId, {
        claimId, triageResultId: doc.id, attempt, severityScore: doc.severityScore, severityBand: doc.severityBand,
        complexity: doc.complexity, fraudScore: fraud.score, fraudIndicatorCodes: fraud.indicators.map((i) => i.code),
        subrogation: subrogation.flag, fastTrackEligible, ai,
      });
      return doc;
    });
  }

  const svc = {
    /**
     * Run (or re-run) triage. Skips when inputsHash is unchanged unless force. Publishes claim.triaged.
     * @param {string} claimId
     * @param {{force?: boolean, actor?: string, sourceEventId?: string}} [opts]
     * @returns {Promise<object>} TriageResult
     */
    runTriage(claimId, opts = {}) {
      if (!claimId) throw new AppError('bad_request', 'claimId is required', 400);
      const prev = chains.get(claimId) ?? Promise.resolve();
      const next = prev.catch(() => {}).then(() => execute(claimId, opts));
      chains.set(claimId, next);
      const clear = () => { if (chains.get(claimId) === next) chains.delete(claimId); };
      next.then(clear, clear);
      return next;
    },

    /** @returns {Promise<object|null>} latest TriageResult */
    async getLatestTriage(claimId) {
      return row2doc(latestRow(claimId));
    },

    /** @returns {Promise<object[]>} all attempts, oldest first */
    async listTriage(claimId) {
      return ctx.db.all('SELECT doc FROM triage_results WHERE claim_id = ? ORDER BY attempt ASC', claimId).map(row2doc);
    },

    /**
     * Event entry point. 'coverage': first triage. 'evidence': re-triage only when a result exists,
     * the claim is not past in_review, and the inputs changed (hash check in runTriage).
     * @returns {Promise<object|null>}
     */
    async onEvent(kind, evt) {
      const claimId = evt?.data?.claimId;
      if (!claimId) return null;
      const bundle = await safe('claims', async () => mod('claims', 'getClaimBundle')?.(claimId), null);
      if (!bundle?.claim) return null;
      const exists = !!latestRow(claimId);
      if (NO_RETRIAGE.has(bundle.claim.status) && (kind === 'evidence' || exists)) return null;
      if (kind === 'evidence' && !exists) return null;
      return svc.runTriage(claimId, { actor: SYSTEM_ACTOR, sourceEventId: evt.id });
    },
  };
  return svc;
}
