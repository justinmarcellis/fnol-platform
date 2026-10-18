import { deriveFlags, ruleActions, mergeActions } from './actions.mjs';

const TIER = { local: 0, cheap: 1, strong: 2 };

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

const enc = (n) => Buffer.from(String(n)).toString('base64url');
const dec = (c) => {
  const n = parseInt(Buffer.from(String(c ?? ''), 'base64url').toString(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

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

  /** Facts for AI prompts: ids, codes, scores and booleans only (no PII). */
  function buildFacts({ claim, triage, coverage, timers, documents, routing, flags }) {
    const le = claim.lossEvent ?? {};
    return {
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
    };
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

  const aiRun = (task, facts, claimId) => ctx.ai.run(task, { facts }, { tenantId: tenantId(), ...(claimId ? { claimId } : {}) });

  /** Summary cached per triage attempt in adjuster_summaries. */
  async function getSummary(claimId, attempt, facts, { refresh = false } = {}) {
    if (!refresh) {
      const row = ctx.db.get('SELECT doc FROM adjuster_summaries WHERE claim_id = ? AND triage_attempt = ?', claimId, attempt);
      if (row) return ctx.db.parseJson(row.doc, null);
    }
    if (!ctx.ai) return null;
    let r;
    try { r = await aiRun('summarize', facts, claimId); } catch (e) { ctx.log?.warn?.('adjuster summary failed', { error: e.message }); return null; }
    const body = [r.output.summary, ...(r.output.bullets ?? []).map((b) => `- ${b}`)].join('\n');
    const citedFacts = citeFacts(facts, body);
    const text = citedFacts.length ? `${body}\nFacts used: ${citedFacts.map((f) => `${f.name}=${f.value}`).join(', ')}` : body;
    const doc = { text, citedFacts, ai: provenance(r), bullets: r.output.bullets ?? [], explanation: r.explanation, ...(r.unconfirmed ? { unconfirmed: true } : {}) };
    const now = ctx.clock.nowIso();
    const exists = ctx.db.get('SELECT 1 AS x FROM adjuster_summaries WHERE claim_id = ? AND triage_attempt = ?', claimId, attempt);
    if (exists) ctx.db.run('UPDATE adjuster_summaries SET doc = ?, created_at = ? WHERE claim_id = ? AND triage_attempt = ?', JSON.stringify(doc), now, claimId, attempt);
    else ctx.db.insert('adjuster_summaries', { claim_id: claimId, triage_attempt: attempt, doc: JSON.stringify(doc), created_at: now });
    return doc;
  }

  /** Timeline from the claim's outbox events and audit entries, oldest first. No PII in labels. */
  async function buildTimeline(claimId) {
    const items = [];
    const rows = await safe(() => ctx.bus.outbox(tenantId()), []);
    for (const r of rows) {
      const evt = ctx.db.parseJson(r.event, null);
      const d = evt?.data ?? {};
      if (d.claimId !== claimId && r.subject !== claimId) continue;
      let label = evt?.type ?? r.type;
      if (label === 'claim.status.changed') label = `Status changed: ${d.from} to ${d.to}`;
      else if (label === 'claim.routed') label = `Routed to ${d.queue}${d.adjusterId ? ` (${d.adjusterId})` : ''}`;
      else if (label === 'claim.triaged') label = `Triaged: severity ${d.severityScore}, fraud ${d.fraudScore}`;
      else if (label.startsWith('claim.timer.')) label = `Timer ${d.kind} ${label.endsWith('due') ? 'due soon' : 'breached'}`;
      items.push({ at: evt?.time ?? r.created_at, type: evt?.type ?? r.type, label });
    }
    const audit = await safe(() => ctx.audit.list({ entityId: claimId, order: 'asc', limit: 200 }), []);
    for (const a of audit) items.push({ at: a.at, type: `audit.${a.action}`, label: `Audit: ${a.action}` });
    return items.filter((i) => i.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
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

      const rules = ruleActions({ claim, triage, coverage, timers, documents });
      const aiActions = ctx.ai ? await safe(async () => (await aiRun('next_best_actions', facts, claimId)).output.actions, []) : [];
      const nextActions = mergeActions(rules, aiActions);

      const view = {
        claim: { ...claim, flags },
        policy, coverage, triage, routing, documents, timers, tasks, notes,
        summary, nextActions,
        timestamps: await lifecycleTimestamps(claim, timers, routing),
        timeline: await buildTimeline(claimId),
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
    getInbox({ adjusterId, queue, status, limit = 50, cursor } = {}) {
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
      return { items: page, nextCursor: rows.length > lim ? enc(offset + lim) : null };
    },
  };
}
