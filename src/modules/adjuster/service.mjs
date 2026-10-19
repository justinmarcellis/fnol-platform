import { deriveFlags, ruleActions, mergeActions, hasPoliceReport, isTerminal } from './actions.mjs';
import { buildDirectory, nameOf } from './directory.mjs';

const TIER = { local: 0, cheap: 1, strong: 2 };
/**
 * Version of the facts the AI tasks receive. A cached summary built from an older fact set is regenerated,
 * so a fix to buildFacts reaches claims that were summarised before it (S6-BUG-03: police report, damage).
 */
export const FACTS_VERSION = 2;

/** Call another module's function; absence or failure yields the fallback (not_found rethrown when strict). */
async function safe(fn, fallback, { strict = false } = {}) {
  try {
    const v = await fn();
    return v ?? fallback;
  } catch (e) {
    if (strict && e?.status === 404) throw e;
    return fallback;
  }
}

/** Open timers (not met or cancelled), earliest due first. Same rule as the claim view. */
const openTimers = (timers) => timers.filter((x) => !['met', 'cancelled'].includes(x.status)).sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
const dueMs = (row) => { const d = Date.parse(row.nextTimer?.dueAt); return Number.isNaN(d) ? Infinity : d; };

const enc = (n) => Buffer.from(String(n)).toString('base64url');
const dec = (c) => {
  const n = parseInt(Buffer.from(String(c ?? ''), 'base64url').toString(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** Insured party's display name from a claim with parties (person or organisation), or ''. */
function insuredName(claim) {
  const ps = claim?.parties ?? [];
  const p = ps.find((x) => (x.roles ?? []).includes('insured')) ?? ps.find((x) => x.isPolicyParty);
  if (!p) return '';
  return [p.firstName, p.lastName].filter(Boolean).join(' ') || p.organizationName || '';
}

/** AiProvenance-shaped object from an ai.run result. */
function provenance(r) {
  const p = { provider: r.provider, model: r.model, confidence: r.confidence };
  if (Number.isInteger(r.tier)) p.tier = r.tier; else if (r.tier in TIER) p.tier = TIER[r.tier];
  if (Array.isArray(r.escalatedFrom)) p.escalatedFrom = r.escalatedFrom;
  return p;
}

/**
 * adjuster service (read models). Bound per tenant by ctx.forTenant(); never writes claim state.
 * @param {object} ctx tenant-bound ctx (root ctx at boot: methods are only called on bound ones)
 */
export function createService(ctx) {
  const mod = (name) => ctx.modules?.[name];
  const tenantId = () => ctx.tenant.id;

  /** Total from the most recent estimate document's extraction, or undefined. */
  function estimateTotal(documents) {
    for (const d of [...documents].reverse()) {
      if (d.kind !== 'estimate') continue;
      const f = (d.extraction?.fields ?? []).find((x) => x.name === 'estimateTotal');
      const n = Number(f?.value?.amount ?? f?.value);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  }

  /**
   * Facts for AI prompts: ids, codes, scores, amounts and booleans only (no PII: no names, contact details,
   * addresses, plates or free-text narrative). Includes the police report state, vehicle drivability and
   * damage areas so the summary and next best actions reflect what is on file.
   */
  function buildFacts({ claim, triage, coverage, timers, documents, routing, flags }) {
    const le = claim.lossEvent ?? {};
    const pr = le.policeReport;
    const policeFiled = hasPoliceReport(le, documents);
    const vehicles = claim.vehicles ?? [];
    const insuredVehicle = vehicles.find((v) => v.role === 'insured') ?? vehicles[0];
    const properties = claim.properties ?? [];
    const damageAreas = [...new Set([
      ...vehicles.flatMap((v) => v.damageAreas ?? []),
      ...properties.flatMap((x) => x.damagedAreas ?? []),
    ])];
    const estimate = estimateTotal(documents);
    const habitable = properties.find((x) => typeof x.habitable === 'boolean')?.habitable;
    const facts = {
      claimNumber: claim.claimNumber, lob: claim.lob, lossType: claim.lossType, status: claim.status, riskState: claim.riskState,
      lossDate: le.lossDate, lossCause: le.cause, vehiclesInvolved: le.vehiclesInvolved,
      injuries: !!le.injuriesReported || flags.includes('injury'),
      fatality: !!le.fatality || flags.includes('fatality'),
      litigation: flags.includes('litigation'),
      cat: le.catastropheCode || (flags.includes('cat') ? 'cat' : false),
      severityScore: triage?.severityScore, severityBand: triage?.severityBand, complexity: triage?.complexity,
      fraudScore: triage?.fraud?.score, fraudIndicators: (triage?.fraud?.indicators ?? []).map((i) => i.code),
      subrogation: !!triage?.subrogation?.flag,
      coverageOutcome: coverage?.outcome, coverageStatus: coverage?.status,
      documents: documents.map((d) => d.kind),
      timers: timers.map((t) => ({ kind: t.kind, status: t.status, dueAt: t.dueAt })),
      routing: routing ? { outcome: routing.outcome, queue: routing.queue } : undefined,
      flags,
      policeReport: { filed: policeFiled },
      policeReportFiled: policeFiled,
      ...(pr?.reportNumber || pr?.number ? { policeReportNumber: String(pr.reportNumber ?? pr.number) } : {}),
      ...(typeof insuredVehicle?.drivable === 'boolean' ? { drivable: insuredVehicle.drivable } : {}),
      ...(damageAreas.length ? { damageAreas } : {}),
      ...(estimate ? { estimateTotal: estimate } : {}),
      ...(typeof habitable === 'boolean' ? { habitable } : {}),
      ...(le.cause === 'glass' || (damageAreas.length && damageAreas.every((a) => /glass|windshield/.test(a))) ? { glassOnly: true } : {}),
    };
    return facts;
  }

  /** Facts that count as baseline citations when none of the facts is mentioned in the text. */
  const BASELINE_FACTS = ['lossCause', 'status', 'coverageOutcome', 'severityBand'];
  const scalar = (v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean');
  const norm = (s) => String(s).toLowerCase().replace(/[_-]+/g, ' ');

  /** Deterministic: which input facts the summary text mentions (by value). No AI call. */
  function citeFacts(facts, text) {
    const hay = norm(text);
    const named = (k, v) => scalar(v) && v !== '' && v !== false && (typeof v === 'boolean' ? hay.includes(norm(k)) : hay.includes(norm(v)));
    let names = Object.entries(facts).filter(([k, v]) => named(k, v)).map(([k]) => k);
    if (!names.length) names = BASELINE_FACTS.filter((k) => scalar(facts[k]) && facts[k] !== '');
    return names.map((name) => ({ name, value: facts[name] }));
  }

  /** Why AI output needs a person to confirm it: carrier policy (humanConfirmRequired) or the token budget. */
  const confirmReason = () => (ctx.tenants?.get?.(tenantId())?.ai?.humanConfirmRequired === true ? 'carrier_policy' : 'budget');

  const aiRun = (task, facts, claimId) => ctx.ai.run(task, { facts }, { tenantId: tenantId(), ...(claimId ? { claimId } : {}) });

  /** Summary cached per triage attempt in adjuster_summaries. */
  async function getSummary(claimId, attempt, facts, { refresh = false } = {}) {
    if (!refresh) {
      const row = ctx.db.get('SELECT doc FROM adjuster_summaries WHERE claim_id = ? AND triage_attempt = ?', claimId, attempt);
      const cached = row ? ctx.db.parseJson(row.doc, null) : null;
      if (cached && cached.factsVersion === FACTS_VERSION) {
        const { factsVersion: _v, ...doc } = cached;
        return doc;
      }
    }
    if (!ctx.ai) return null;
    let r;
    try { r = await aiRun('summarize', facts, claimId); } catch (e) { ctx.log?.warn?.('adjuster summary failed', { error: e.message }); return null; }
    const body = [r.output.summary, ...(r.output.bullets ?? []).map((b) => `- ${b}`)].join('\n');
    const citedFacts = citeFacts(facts, body);
    const text = citedFacts.length ? `${body}\nFacts used: ${citedFacts.map((f) => `${f.name}=${f.value}`).join(', ')}` : body;
    const doc = {
      text, citedFacts, ai: provenance(r), bullets: r.output.bullets ?? [], explanation: r.explanation,
      // unconfirmed comes from the tenant's humanConfirmRequired setting or the token budget (src/ai/cascade.mjs), not from low confidence.
      ...(r.unconfirmed ? { unconfirmed: true, unconfirmedReason: confirmReason() } : {}),
    };
    const stored = JSON.stringify({ ...doc, factsVersion: FACTS_VERSION });
    const now = ctx.clock.nowIso();
    const exists = ctx.db.get('SELECT 1 AS x FROM adjuster_summaries WHERE claim_id = ? AND triage_attempt = ?', claimId, attempt);
    if (exists) ctx.db.run('UPDATE adjuster_summaries SET doc = ?, created_at = ? WHERE claim_id = ? AND triage_attempt = ?', stored, now, claimId, attempt);
    else ctx.db.insert('adjuster_summaries', { claim_id: claimId, triage_attempt: attempt, doc: stored, created_at: now });
    return doc;
  }

  /**
   * Business events the Activity timeline shows. Audit entries mirror these events one for one, and
   * claim.updated, timer starts, external refs and integration pushes are plumbing, so they are left out.
   * Audit-only actions that are business events (a routing override) are kept under their own type.
   */
  const TIMELINE_EVENTS = new Set([
    'claim.reported', 'claim.acknowledged', 'claim.coverage.verified', 'claim.triaged', 'claim.routed', 'claim.status.changed',
    'claim.note.added', 'claim.timer.due', 'claim.timer.breached', 'claim.evidence.added', 'claim.evidence.extracted',
  ]);
  const TIMELINE_AUDIT = new Set(['claim.routing.overridden', 'claim.task.updated']);

  /**
   * Timeline from the claim's outbox events plus the few audit-only business actions, oldest first.
   * Each item has a stable English `label` and `params` the UI uses to localise it. Ties on the same
   * timestamp keep publication order. No PII in labels.
   */
  async function buildTimeline(claimId, dir) {
    const items = [];
    const rows = await safe(() => ctx.bus.outbox(tenantId()), []);
    for (const r of rows) {
      const evt = ctx.db.parseJson(r.event, null);
      const d = evt?.data ?? {};
      if (d.claimId !== claimId && r.subject !== claimId) continue;
      const type = evt?.type ?? r.type;
      if (!TIMELINE_EVENTS.has(type)) continue;
      let label = type;
      let params = {};
      if (type === 'claim.reported') label = 'Claim reported';
      else if (type === 'claim.acknowledged') label = 'Claim acknowledged';
      else if (type === 'claim.coverage.verified') { params = { outcome: d.outcome }; label = `Coverage verified${d.outcome ? `: ${d.outcome}` : ''}`; }
      else if (type === 'claim.status.changed') { params = { from: d.from, to: d.to }; label = `Status changed: ${d.from} to ${d.to}`; }
      else if (type === 'claim.routed') {
        const adjusterName = d.adjusterId ? nameOf(dir, d.adjusterId) : '';
        params = { queue: d.queue, outcome: d.outcome, ...(d.adjusterId ? { adjusterId: d.adjusterId, adjusterName } : {}), ...(d.override ? { override: true } : {}) };
        label = `Routed to ${d.queue}${adjusterName ? ` (${adjusterName})` : ''}`;
      } else if (type === 'claim.triaged') { params = { severity: d.severityScore, fraud: d.fraudScore }; label = `Triaged: severity ${d.severityScore}, fraud ${d.fraudScore}`; }
      else if (type.startsWith('claim.timer.')) { params = { kind: d.kind }; label = `Timer ${d.kind} ${type.endsWith('due') ? 'due soon' : 'breached'}`; }
      else if (type === 'claim.note.added') { params = { category: d.category }; label = 'Note added'; }
      else if (type === 'claim.evidence.added') label = 'Document added';
      else if (type === 'claim.evidence.extracted') label = 'Document read';
      items.push({ at: evt?.time ?? r.created_at, type, label, params, seq: items.length });
    }
    const audit = await safe(() => ctx.audit.list({ entityId: claimId, order: 'asc', limit: 500 }), []);
    for (const a of audit) {
      if (!TIMELINE_AUDIT.has(a.action)) continue;
      if (a.action === 'claim.task.updated' && !['done', 'cancelled'].includes(a.details?.status)) continue;
      const params = a.action === 'claim.task.updated' ? { status: a.details?.status } : {};
      const label = a.action === 'claim.task.updated' ? `Task ${a.details?.status === 'done' ? 'completed' : 'cancelled'}` : 'Routing overridden by a supervisor';
      items.push({ at: a.at, type: a.action, label, params, seq: items.length });
    }
    return items.filter((i) => i.at)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.seq - b.seq)
      .map(({ seq: _s, ...i }) => (Object.keys(i.params).length ? i : (({ params: _p, ...rest }) => rest)(i)));
  }

  /** First time a claim event of this type was published (from the outbox), or undefined. */
  async function firstEventTime(claimId, type) {
    const rows = await safe(() => ctx.bus.outbox(tenantId()), []);
    const times = [];
    for (const r of rows) {
      const evt = ctx.db.parseJson(r.event, null);
      if ((evt?.type ?? r.type) !== type) continue;
      if (evt?.data?.claimId !== claimId && r.subject !== claimId) continue;
      times.push(evt?.time ?? r.created_at);
    }
    return times.filter(Boolean).sort()[0];
  }

  /** reportedAt / acknowledgedAt / assignedAt; absent when not yet known. */
  async function lifecycleTimestamps(claim, timers, routing) {
    const ackTimer = timers.filter((t) => t.kind === 'acknowledge' && t.metAt).map((t) => t.metAt).sort()[0];
    const assigned = routing && ['assigned', 'fast_tracked'].includes(routing.outcome) ? routing.decidedAt : undefined;
    const out = {
      reportedAt: claim.reportedAt ?? claim.createdAt,
      acknowledgedAt: (await firstEventTime(claim.id, 'claim.acknowledged')) ?? ackTimer,
      assignedAt: assigned ?? (routing ? undefined : await firstEventTime(claim.id, 'claim.routed')),
    };
    for (const k of Object.keys(out)) if (!out[k]) delete out[k];
    return out;
  }

  return {
    /**
     * Display directory: adjuster names, queues (with their adjusters) and routing rule names for this tenant.
     * @returns {{people: Record<string,string>, queues: object[], rules: Record<string,string>}}
     */
    getDirectory() {
      return buildDirectory(ctx);
    },

    /**
     * Aggregated first view, valid against AdjusterView.schema.json.
     * Derived flags are merged into claim.flags; nextActions holds the next best actions.
     * @param {string} claimId
     * @param {{actor?: string, refresh?: boolean}} [opts]
     */
    async getFirstView(claimId, opts = {}) {
      const claims = mod('claims');
      if (!claims) throw new ctx.AppError('upstream_unavailable', 'claims module unavailable', 502);
      const claim = await claims.getClaim(claimId, { include: ['parties', 'vehicles', 'properties'] });
      const [timers, tasks, notes, documents, coverage, triage, routing] = await Promise.all([
        safe(() => claims.listTimers(claimId), []),
        safe(() => claims.listTasks(claimId), []),
        safe(() => claims.listNotes(claimId), []),
        safe(() => mod('evidence').listDocuments(claimId), []),
        safe(() => mod('coverage').getLatestVerification(claimId), null),
        safe(() => mod('triage').getLatestTriage(claimId), null),
        safe(() => mod('rules').getRoutingDecision(claimId), null),
      ]);
      const policy = coverage ? await safe(async () => {
        const cov = mod('coverage');
        if (coverage.policySnapshotId && cov.getSnapshotById) return cov.getSnapshotById(coverage.policySnapshotId);
        return cov.getPolicySnapshot({ policyNumber: claim.policyNumber, asOf: claim.lossEvent?.lossDate });
      }, null) : null;

      const flags = deriveFlags({ claim, triage, coverage, timers });
      const facts = buildFacts({ claim, triage, coverage, timers, documents, routing, flags });
      const summary = await getSummary(claimId, triage?.attempt ?? 0, facts, { refresh: opts.refresh });

      // A closed or withdrawn claim is read-only: no next best actions (and no AI call for them).
      let nextActions = [];
      if (!isTerminal(claim)) {
        const rules = ruleActions({ claim, triage, coverage, timers, documents });
        const nba = ctx.ai ? await safe(async () => {
          const r = await aiRun('next_best_actions', facts, claimId);
          // Keep the run's provenance with every action (standards: AI output carries provider, model, confidence).
          return { actions: r.output?.actions ?? [], ai: r.provider && r.model && Number.isFinite(Number(r.confidence)) ? provenance(r) : undefined };
        }, { actions: [] }) : { actions: [] };
        nextActions = mergeActions(rules, nba.actions, nba.ai);
      }

      const view = {
        claim: { ...claim, flags },
        policy, coverage, triage, routing, documents, timers, tasks, notes,
        summary, nextActions,
        timestamps: await lifecycleTimestamps(claim, timers, routing),
        timeline: await buildTimeline(claimId, buildDirectory(ctx)),
        generatedAt: ctx.clock.nowIso(),
      };
      for (const k of Object.keys(view)) if (view[k] === null || view[k] === undefined) delete view[k];
      return view;
    },

    /**
     * Inbox rows filtered by adjuster/queue, ordered by timer urgency then severity.
     * @param {{adjusterId?: string, queue?: string, status?: string, limit?: number, cursor?: string}} [q]
     * @returns {{items: object[], nextCursor: string|null}}
     */
    async getInbox({ adjusterId, queue, status, limit = 50, cursor } = {}) {
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
      const where = [];
      const p = [];
      if (adjusterId) { where.push('adjuster_id = ?'); p.push(adjusterId); }
      if (queue) { where.push('queue = ?'); p.push(queue); }
      if (status) { where.push('status = ?'); p.push(status); }
      const offset = dec(cursor);
      const rows = ctx.db.all(
        `SELECT * FROM adjuster_inbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY (next_due_at IS NULL), next_due_at ASC, COALESCE(severity, -1) DESC, claim_id ASC LIMIT ? OFFSET ?`,
        ...p, lim + 1, offset,
      );
      const page = rows.slice(0, lim).map((r) => ({
        claimId: r.claim_id, claimNumber: r.claim_number ?? undefined, status: r.status ?? undefined, lob: r.lob ?? undefined,
        queue: r.queue ?? undefined, adjusterId: r.adjuster_id ?? undefined,
        severityScore: r.severity ?? undefined, complexity: r.complexity ?? undefined,
        flags: ctx.db.parseJson(r.flags, []),
        nextTimer: ctx.db.parseJson(r.next_timer, undefined) ?? undefined,
        reportedAt: r.reported_at ?? undefined,
      }));
      // Insured name, assignment time and fast-track outcome travel with each row, so the inbox renders
      // complete from this one response (no per-row browser calls). Read in-process from the owning modules.
      const claimsMod = mod('claims');
      const rulesMod = mod('rules');
      await Promise.all(page.map(async (row) => {
        const [claim, routing] = await Promise.all([
          claimsMod?.getClaim ? safe(() => claimsMod.getClaim(row.claimId, { include: ['parties'] }), null) : null,
          rulesMod?.getRoutingDecision ? safe(() => rulesMod.getRoutingDecision(row.claimId), null) : null,
        ]);
        const name = insuredName(claim);
        if (name) row.insuredName = name;
        const fastTrack = routing ? routing.fastTrack === true || routing.outcome === 'fast_tracked' : claim?.routing?.fastTrack === true;
        if (routing || claim?.routing) row.fastTrack = fastTrack;
        if (routing?.outcome) row.routingOutcome = routing.outcome;
        if (routing?.decidedAt && ['assigned', 'fast_tracked'].includes(routing.outcome)) row.assignedAt = routing.decidedAt;
      }));
      // The timer column reads the same source as the claim view (claims.listTimers), not the event-fed projection,
      // which only learns of a timer once it is due soon or breached. The projection value is the fallback.
      const claims = mod('claims');
      if (claims?.listTimers) {
        await Promise.all(page.map(async (row) => {
          const live = await safe(() => claims.listTimers(row.claimId), null);
          if (!Array.isArray(live)) return;
          const next = openTimers(live)[0];
          if (next) row.nextTimer = next; else delete row.nextTimer;
        }));
        page.sort((a, b) => dueMs(a) - dueMs(b));
      }
      return { items: page, nextCursor: rows.length > lim ? enc(offset + lim) : null };
    },
  };
}
