// rules module service (modules.md "rules"). `ctx` is a tenant-bound context (ctx.forTenant(id)).
// Rules are read from the live tenant config on every call, so rule changes apply without a restart.
import { evaluateCondition } from './condition.js';
import { filterRules, runRules, validateRules } from './engine.js';
import { decideRouting } from './routing.js';

const SYSTEM_ACTOR = { type: 'system', id: 'rules-engine' };
const OVERRIDE_ROLES = ['supervisor', 'carrier_admin', 'platform_admin'];
const ROUTABLE = ['triaged', 'assigned', 'fast_tracked'];
const TASK_TYPES = ['contact_insured', 'contact_claimant', 'request_document', 'inspect', 'review_coverage', 'siu_referral', 'subrogation_review', 'review_ai_output', 'other'];
const SIDE_EFFECTS = ['add_flag', 'add_task', 'refer_siu', 'notify', 'start_timer'];

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const asBool = (v) => (v ? 1 : 0);

/**
 * Build the service object mounted at ctx.modules.rules.
 * @param {object} ctx tenant-bound context (or the root context, where only the pure functions work)
 */
export function createService(ctx) {
  const mod = (name) => ctx.modules?.[name];
  const tenantId = () => ctx.tenant.id;
  const cfg = () => {
    const c = mod('config')?.getTenantConfig?.() ?? ctx.tenant?.config;
    if (!c) throw new ctx.AppError('not_found', 'Tenant configuration not found', 404);
    return c;
  };

  // ------------------------------------------------------------ rule evaluation

  function rulesFor({ stage, lob, state, lossTypes, at }) {
    const config = mod('config');
    const byId = new Map();
    for (const lossType of lossTypes.length ? lossTypes : [undefined]) {
      const list = typeof config?.getRules === 'function'
        ? config.getRules({ stage, lob, state, lossType, at })
        : filterRules(cfg().rules, { stage, lob, state, lossType, at });
      for (const r of list) byId.set(r.id, r);
    }
    return [...byId.values()].sort((x, y) => (x.priority ?? 100) - (y.priority ?? 100) || x.id.localeCompare(y.id));
  }

  /**
   * Evaluate the tenant's rules for a stage against a fact document.
   * lob, state and lossType default from the facts (claim.lob or session.lob, claim.riskState, loss.cause and claim.lossType).
   * @returns {Promise<{ fired: { ruleId: string, actions: object[] }[], actions: object[], trace: object[] }>}
   */
  async function evaluate({ stage, facts = {}, lob, state, lossType, at } = {}) {
    const lobs = lob ?? facts.claim?.lob ?? facts.session?.lob;
    const st = state ?? facts.claim?.riskState;
    const types = [...new Set([lossType, facts.loss?.cause, facts.claim?.lossType].filter(Boolean))];
    const rules = rulesFor({ stage, lob: lobs, state: st, lossTypes: types, at: at ?? facts.now ?? ctx.clock.nowIso() });
    return runRules(rules, facts);
  }

  // ------------------------------------------------------------ facts

  async function loadInputs(claimId, claim) {
    const c = claim ?? await mod('claims').getClaim(claimId, { include: ['parties', 'vehicles', 'properties'] });
    const triage = (await mod('triage')?.getLatestTriage?.(claimId)) ?? null;
    const coverage = (await mod('coverage')?.getLatestVerification?.(claimId)) ?? null;
    return { claim: c, triage, coverage };
  }

  async function factsFrom({ claim, triage, coverage }) {
    let policy;
    if (coverage?.policySnapshotId && typeof mod('coverage')?.getSnapshotById === 'function') {
      try { policy = await mod('coverage').getSnapshotById(coverage.policySnapshotId); } catch { policy = undefined; }
    }
    let answers = claim.answers ?? {};
    if (claim.intakeSessionId && typeof mod('intake')?.getSession === 'function') {
      try {
        const s = await mod('intake').getSession(claim.intakeSessionId);
        answers = Object.fromEntries(Object.entries(s?.answers ?? {}).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? v.value : v]));
      } catch { /* answers stay as on the claim */ }
    }
    const config = cfg();
    return {
      claim: {
        id: claim.id, status: claim.status, lob: claim.lob, lossType: claim.lossType, channel: claim.channel,
        riskState: claim.riskState, flags: claim.flags ?? [], policyNumber: claim.policyNumber,
        queue: claim.routing?.queue, version: claim.version,
      },
      loss: claim.lossEvent ?? {},
      policy,
      coverage: coverage ?? undefined,
      triage: triage ?? undefined,
      parties: claim.parties ?? [],
      vehicles: claim.vehicles ?? [],
      property: claim.properties ?? [],
      evidence: claim.evidence ?? [],
      answers,
      session: { lob: claim.lob, channel: claim.channel },
      tenant: { id: tenantId(), timeZone: config.timeZone, fastTrack: config.fastTrack, defaultQueue: config.defaultQueue },
      now: ctx.clock.nowIso(),
    };
  }

  /** The fact document (claim, loss, policy, coverage, triage, ...) for a claim. */
  async function buildFacts(claimId) {
    return factsFrom(await loadInputs(claimId));
  }

  // ------------------------------------------------------------ persistence

  const rowToDecision = (row) => (row ? ctx.db.parseJson(row.doc, null) : null);
  const latestRow = (claimId) => ctx.db.get('SELECT * FROM routing_decisions WHERE claim_id = ? ORDER BY seq DESC LIMIT 1', claimId);

  /** Latest routing decision for a claim, or null. */
  async function getRoutingDecision(claimId) {
    return rowToDecision(latestRow(claimId));
  }

  function pickAdjuster(queueDef) {
    const list = queueDef?.adjusters ?? [];
    if (!list.length) return undefined;
    const mode = queueDef.assignment ?? 'round_robin';
    if (mode === 'manual') return undefined;
    if (mode === 'least_loaded') {
      const latest = new Map();
      for (const r of ctx.db.all('SELECT claim_id, queue, adjuster_id FROM routing_decisions ORDER BY seq')) latest.set(r.claim_id, r);
      const load = new Map(list.map((a) => [a, 0]));
      for (const r of latest.values()) if (r.queue === queueDef.id && load.has(r.adjuster_id)) load.set(r.adjuster_id, load.get(r.adjuster_id) + 1);
      return list.reduce((best, a) => (load.get(a) < load.get(best) ? a : best), list[0]);
    }
    const cur = ctx.db.get('SELECT last_adjuster_id FROM queue_cursors WHERE queue_id = ?', queueDef.id);
    const next = list[(list.indexOf(cur?.last_adjuster_id) + 1) % list.length];
    if (cur) ctx.db.run('UPDATE queue_cursors SET last_adjuster_id = ? WHERE queue_id = ?', next, queueDef.id);
    else ctx.db.insert('queue_cursors', { queue_id: queueDef.id, last_adjuster_id: next });
    return next;
  }

  // ------------------------------------------------------------ side effects of fired actions

  async function applyActions(claimId, actions, actor) {
    const claims = mod('claims');
    const other = [];
    for (const a of actions) {
      if (a.type === 'add_flag') {
        await claims.addFlag(claimId, a.flag, { actor });
      } else if (a.type === 'refer_siu') {
        await claims.addFlag(claimId, 'siu', { actor });
        await claims.addTask(claimId, { type: 'siu_referral', title: a.reason ?? 'SIU referral', queue: 'siu', priority: 'high' }, { actor, sourceRuleId: a.ruleId });
      } else if (a.type === 'add_task') {
        const t = a.task ?? {};
        const input = clean({
          type: TASK_TYPES.includes(t.type) ? t.type : 'other',
          title: t.title ?? t.type ?? 'Task',
          description: TASK_TYPES.includes(t.type) || !t.type ? undefined : t.type,
          queue: t.queue,
          priority: 'normal',
          dueAt: Number.isFinite(t.dueInHours) ? new Date(ctx.clock.now().getTime() + t.dueInHours * 3600000).toISOString() : undefined,
        });
        await claims.addTask(claimId, input, { actor, sourceRuleId: a.ruleId });
      } else {
        other.push(`${a.ruleId}:${a.type}${a.template ? `:${a.template}` : ''}${a.timerId ? `:${a.timerId}` : ''}`);
      }
    }
    if (other.length) ctx.log.info('rules: actions without a direct side effect', { claimId, actions: other });
  }

  async function finishActions(row) {
    if (row.actions_done) return;
    const actions = ctx.db.parseJson(row.actions, []);
    await applyActions(row.claim_id, actions, SYSTEM_ACTOR);
    ctx.db.update('routing_decisions', row.id, { actions_done: 1 });
  }

  // ------------------------------------------------------------ routing

  function overrideProposal(override, actor, config, claim) {
    if (!override || typeof override !== 'object' || typeof override.reason !== 'string' || !override.reason.trim()) {
      throw new ctx.AppError('invalid_override', 'An override needs a reason', 400);
    }
    if (!OVERRIDE_ROLES.includes(actor?.role)) throw new ctx.AppError('forbidden', 'Only a supervisor can override routing', 403);
    const queues = config.queues ?? [];
    const ftQueue = config.fastTrack?.queue ?? 'fast_track';
    const fastTrack = override.fastTrack === true;
    const queue = override.queue ?? (fastTrack ? ftQueue : claim.routing?.queue ?? queues.find((q) => q.id !== ftQueue)?.id);
    if (!queues.some((q) => q.id === queue)) throw new ctx.AppError('unknown_queue', `Queue "${queue}" is not configured`, 422);
    return { queue, adjusterId: override.adjusterId, fastTrack, reasons: [`supervisor override: ${override.reason.trim()}`], actions: [], ruleIds: [] };
  }

  async function rulesProposal(inputs, facts, config) {
    const routing = await evaluate({ stage: 'routing', facts });
    const estimate = inputs.triage?.suggestedReserve
      ?? (typeof facts.answers?.estimated_damage === 'number' ? { amount: facts.answers.estimated_damage } : undefined);
    const d = decideRouting({ actions: routing.actions, config, lob: inputs.claim.lob, triage: inputs.triage, coverage: inputs.coverage, estimate });
    if (!d.queue || !(config.queues ?? []).some((q) => q.id === d.queue)) {
      throw new ctx.AppError('routing_misconfigured', `Routing resolved to unknown queue "${d.queue}"`, 422);
    }
    const afterFacts = { ...facts, claim: { ...facts.claim, queue: d.queue } };
    const post = await evaluate({ stage: 'post_routing', facts: afterFacts });
    const actions = [...routing.actions, ...post.actions].filter((a) => SIDE_EFFECTS.includes(a.type));
    return { ...d, actions, ruleIds: [...routing.fired, ...post.fired].map((f) => f.ruleId) };
  }

  /**
   * Route a triaged claim by the tenant's routing rules, or apply a supervisor override.
   * Additive options (internal, used by the claim.triaged handler): `sourceEventId` makes the call idempotent
   * per event, and `auto` makes it a no-op when a re-route would not change queue or fast-track outcome.
   * @param {string} claimId
   * @param {{ override?: { queue?: string, adjusterId?: string, fastTrack?: boolean, reason: string }, actor?: object, sourceEventId?: string, auto?: boolean }} [opts]
   * @returns {Promise<object>} RoutingDecision
   */
  async function route(claimId, { override, actor = SYSTEM_ACTOR, sourceEventId, auto = false } = {}) {
    if (sourceEventId) {
      const done = ctx.db.get('SELECT * FROM routing_decisions WHERE source_event_id = ?', sourceEventId);
      if (done) { await finishActions(done); return rowToDecision(done); }
    }
    const inputs = await loadInputs(claimId);
    const { claim } = inputs;
    if (!ROUTABLE.includes(claim.status)) {
      throw new ctx.AppError(claim.status === 'validating' && auto ? 'claim_not_ready' : 'invalid_state', `Claim in status "${claim.status}" cannot be routed`, 409);
    }
    const config = cfg();
    const facts = await factsFrom(inputs);
    const p = override ? overrideProposal(override, actor, config, claim) : await rulesProposal(inputs, facts, config);

    const prior = latestRow(claimId);
    const outcome = p.fastTrack ? 'fast_tracked' : 'assigned';
    if (auto && prior && prior.queue === p.queue && Boolean(prior.fast_track) === p.fastTrack && !override) return rowToDecision(prior);

    const queueDef = config.queues.find((q) => q.id === p.queue);
    const decision = ctx.db.transaction(() => {
      const adjusterId = p.adjusterId ?? pickAdjuster(queueDef);
      const id = ctx.db.id('rte');
      const decidedAt = ctx.clock.nowIso();
      const d = clean({
        id, tenantId: tenantId(), claimId, triageResultId: inputs.triage?.id, outcome, queue: p.queue, adjusterId,
        fastTrack: p.fastTrack, ruleIds: p.ruleIds, rulesetVersion: String(ctx.tenants?.version?.(tenantId()) ?? config.version ?? ''),
        reasons: p.reasons,
        override: override ? { by: { type: actor.type ?? 'user', id: actor.id, role: actor.role }, reason: override.reason.trim() } : undefined,
        decidedAt,
      });
      if (!d.rulesetVersion) delete d.rulesetVersion;
      const seq = (ctx.db.get('SELECT COALESCE(MAX(seq), 0) AS n FROM routing_decisions WHERE claim_id = ?', claimId)?.n ?? 0) + 1;
      ctx.db.insert('routing_decisions', {
        id, claim_id: claimId, seq, outcome, queue: p.queue, adjuster_id: adjusterId ?? null, fast_track: asBool(p.fastTrack),
        rule_ids: p.ruleIds, doc: d, decided_at: decidedAt, source_event_id: sourceEventId ?? null,
        actions: p.actions, actions_done: p.actions.length ? 0 : 1,
      });
      ctx.audit.record({
        actor: actor.id ?? 'rules-engine', action: override ? 'claim.routing.overridden' : 'claim.routed', entityType: 'claim', entityId: claimId,
        details: { decisionId: id, outcome, queue: p.queue, adjusterId, ruleIds: p.ruleIds },
      });
      ctx.bus.publish('claim.routed', claimId, clean({
        claimId, decisionId: id, outcome, queue: p.queue, adjusterId, ruleIds: p.ruleIds, override: override ? true : undefined,
      }));
      return d;
    });
    if (p.actions.length) await finishActions(latestRow(claimId));
    return decision;
  }

  /** claim.triaged handler body: route a triaged claim; re-route an assigned one only if the outcome changes. */
  async function onClaimTriaged(evt) {
    const claimId = evt.data?.claimId;
    if (!claimId) return null;
    const claim = await mod('claims').getClaim(claimId);
    if (!ROUTABLE.includes(claim.status) && claim.status !== 'validating') return null;
    return route(claimId, { sourceEventId: evt.id, auto: true });
  }

  return {
    evaluateCondition,
    validateRules,
    evaluate,
    buildFacts,
    route,
    getRoutingDecision,
    onClaimTriaged,
  };
}
