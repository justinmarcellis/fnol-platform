// KPI service: gathers normalised per-claim records through tenant-bound service functions, then
// hands them to the pure metrics. Read-only; output carries counts and ratios only (no PII).
import { computeMetrics } from './metrics.mjs';

export const DEFAULT_DAYS = 30;
export const MAX_CLAIMS = 5000;
const PAGE = 200;
const DAY = 86400000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse and validate the reporting period. Date-only `to` is inclusive of that whole day (UTC).
 * @param {{from?: string, to?: string}} q
 * @param {Date} now
 * @param {Function} AppError
 * @returns {{from: string, to: string}}
 */
export function resolvePeriod(q = {}, now, AppError) {
  const bad = (m) => new AppError('bad_request', m, 400);
  const one = (v, name, endOfDay) => {
    if (Array.isArray(v) || (v !== undefined && typeof v !== 'string')) throw bad(`${name} must be a single ISO date`);
    const dateOnly = DATE_ONLY.test(v);
    const d = new Date(dateOnly ? `${v}T00:00:00.000Z` : v);
    if (!Number.isFinite(d.getTime()) || (!dateOnly && !/^\d{4}-\d{2}-\d{2}T/.test(v))) throw bad(`${name} must be an ISO date (YYYY-MM-DD) or timestamp`);
    if (dateOnly && d.toISOString().slice(0, 10) !== v) throw bad(`${name} is not a valid calendar date`);
    return dateOnly && endOfDay ? new Date(d.getTime() + DAY - 1) : d;
  };
  const hasTo = q.to !== undefined && q.to !== '';
  const hasFrom = q.from !== undefined && q.from !== '';
  const to = hasTo ? one(q.to, 'to', true) : now;
  const from = hasFrom ? one(q.from, 'from', false) : new Date(to.getTime() - DEFAULT_DAYS * DAY);
  if (from.getTime() > to.getTime()) throw bad('from must not be after to');
  return { from: from.toISOString(), to: to.toISOString() };
}

const has = (obj, fn) => obj && typeof obj[fn] === 'function';

/**
 * @param {object} ctx tenant-bound ctx
 */
export function createService(ctx) {
  /** Run `fn(item)` for each claim. not_found counts as absent; any other error marks the source failed. */
  async function perClaim(svc, fnName, claims, fn) {
    if (!has(svc, fnName)) return { status: 'unavailable', byId: new Map() };
    const byId = new Map();
    for (const c of claims) {
      try {
        byId.set(c.id, await fn(c));
      } catch (e) {
        if (e?.status === 404 || e?.code === 'not_found') { byId.set(c.id, null); continue; }
        ctx.log?.warn?.('kpi source failed', { fn: fnName, code: e?.code });
        return { status: 'failed', byId: new Map() };
      }
    }
    return { status: 'ok', byId };
  }

  async function listClaims(period) {
    const claims = ctx.modules.claims;
    if (!has(claims, 'listClaims')) return { status: 'unavailable', items: [] };
    const items = [];
    let cursor;
    let truncated = false;
    try {
      do {
        const page = await claims.listClaims({ reportedFrom: period.from, reportedTo: period.to }, { limit: PAGE, cursor });
        items.push(...(page.items ?? []));
        cursor = page.nextCursor;
        if (items.length >= MAX_CLAIMS) { truncated = Boolean(cursor); items.length = Math.min(items.length, MAX_CLAIMS); break; }
      } while (cursor);
    } catch (e) {
      ctx.log?.warn?.('kpi claims list failed', { code: e?.code });
      return { status: 'failed', items: [] };
    }
    return { status: 'ok', items, truncated };
  }

  /** Index outbox events by claim: earliest time per event type. Reads this tenant only. */
  function loadEvents() {
    try {
      const out = new Map();
      for (const row of ctx.bus.outbox(ctx.tenant.id)) {
        let evt;
        try { evt = typeof row.event === 'string' ? JSON.parse(row.event) : row.event; } catch { continue; }
        const id = evt?.data?.claimId ?? evt?.subject ?? row.subject;
        if (!id || !evt?.type || !evt.time) continue;
        const byType = out.get(id) ?? new Map();
        const prev = byType.get(evt.type);
        if (!prev || evt.time < prev) byType.set(evt.type, evt.time);
        out.set(id, byType);
      }
      return { status: 'ok', byId: out };
    } catch (e) {
      ctx.log?.warn?.('kpi outbox read failed', { code: e?.code });
      return { status: 'failed', byId: new Map() };
    }
  }

  /**
   * Compute KPIs for a period.
   * @param {{from?: string, to?: string}} [q]
   * @returns {Promise<{period: {from: string, to: string}, metrics: object[], truncated?: boolean}>}
   */
  async function compute(q = {}) {
    const period = resolvePeriod(q, ctx.clock.now(), ctx.AppError);
    const m = ctx.modules;
    const list = await listClaims(period);
    if (list.status !== 'ok') {
      const sources = Object.fromEntries(['routing', 'tasks', 'evidence', 'events', 'timers', 'coverage', 'triage', 'intake']
        .map((s) => [s, list.status]));
      return { period, metrics: computeMetrics([], sources).map((x) => ({ ...x, value: null, numerator: null, denominator: null, note: `claims ${list.status}` })) };
    }
    const claims = list.items;

    const [routing, tasks, timers, triage, facts, coverage, intake] = await Promise.all([
      perClaim(m.rules, 'getRoutingDecision', claims, (c) => m.rules.getRoutingDecision(c.id)),
      perClaim(m.claims, 'listTasks', claims, (c) => m.claims.listTasks(c.id)),
      perClaim(m.claims, 'listTimers', claims, (c) => m.claims.listTimers(c.id)),
      perClaim(m.triage, 'getLatestTriage', claims, (c) => m.triage.getLatestTriage(c.id)),
      perClaim(m.evidence, 'getAcceptedFacts', claims, (c) => m.evidence.getAcceptedFacts(c.id)),
      perClaim(m.coverage, 'getLatestVerification', claims, (c) => m.coverage.getLatestVerification(c.id)),
      perClaim(m.intake, 'getSession', claims, async (c) => (c.intakeSessionId ? (await m.intake.getSession(c.intakeSessionId)).locale ?? null : null)),
    ]);
    const events = loadEvents();

    const sources = {
      routing: routing.status, tasks: tasks.status, timers: timers.status, triage: triage.status,
      evidence: facts.status, coverage: coverage.status, intake: intake.status, events: events.status,
    };

    const records = claims.map((c) => {
      const ev = events.byId.get(c.id);
      const rt = routing.byId.get(c.id);
      const tm = timers.byId.get(c.id) ?? [];
      const tr = triage.byId.get(c.id);
      const f = facts.byId.get(c.id);
      const vf = coverage.byId.get(c.id);
      const flags = c.flags ?? [];
      const ackTimer = tm.filter((t) => t.kind === 'acknowledge' && t.metAt).map((t) => t.metAt).sort()[0];
      return {
        claimId: c.id,
        status: c.status,
        channel: c.channel,
        reportedAt: c.reportedAt ?? ev?.get('claim.reported'),
        actorRole: c.reportedBy?.role,
        actorType: c.reportedBy?.type,
        flags,
        locale: intake.byId.get(c.id) ?? c.locale,
        fastTrack: rt ? rt.fastTrack === true || rt.outcome === 'fast_tracked' : false,
        manualTaskCount: (tasks.byId.get(c.id) ?? []).filter((t) => t.createdBy?.type === 'user').length,
        fraudFlag: tr?.fraud?.referToSiu === true || flags.includes('siu'),
        subrogationFlag: tr?.subrogation?.flag === true || flags.includes('subrogation'),
        aiFactCount: Object.values(f ?? {}).filter((x) => x?.provenance?.source === 'ai_extraction').length,
        verifiedAt: vf?.verifiedAt,
        ackAt: ev?.get('claim.acknowledged') ?? ackTimer,
        assignedAt: ev?.get('claim.routed') ?? rt?.decidedAt,
        timers: tm.map((t) => ({ status: t.status, kind: t.kind })),
      };
    });

    const out = { period, metrics: computeMetrics(records, sources) };
    if (list.truncated) out.truncated = true;
    return out;
  }

  return { compute, computeKpis: compute };
}
