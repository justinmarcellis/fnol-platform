// Local fakes for the modules KPI reads (claims, rules, triage, evidence, coverage, intake).
// Data is keyed by tenant so isolation can be tested.
export const data = new Map(); // tenantId -> { claims, tasks, timers, routing, triage, facts, verification, locale, fail }

const T = (ctx) => data.get(ctx.tenant.id) ?? { claims: [], fail: {} };
const notFound = (ctx) => new ctx.AppError('not_found', 'not found', 404);
const maybeFail = (ctx, name) => { if (T(ctx).fail?.[name]) throw new Error(`boom ${name}`); };
const by = (ctx, key, id) => { maybeFail(ctx, key); return T(ctx)[key]?.[id] ?? null; };

export const claims = {
  name: 'claims',
  service: (ctx) => ({
    async listClaims(filter = {}, { limit = 50, cursor } = {}) {
      maybeFail(ctx, 'listClaims');
      const all = T(ctx).claims.filter((c) => (!filter.reportedFrom || c.reportedAt >= filter.reportedFrom)
        && (!filter.reportedTo || c.reportedAt <= filter.reportedTo));
      const o = cursor ? Number(cursor) : 0;
      const items = all.slice(o, o + limit);
      return { items, nextCursor: o + limit < all.length ? String(o + limit) : null };
    },
    async listTasks(id) { return by(ctx, 'tasks', id) ?? []; },
    async listTimers(id) { return by(ctx, 'timers', id) ?? []; },
  }),
};
export const rules = { name: 'rules', service: (ctx) => ({ async getRoutingDecision(id) { return by(ctx, 'routing', id); } }) };
export const triage = { name: 'triage', service: (ctx) => ({ async getLatestTriage(id) { return by(ctx, 'triage', id); } }) };
export const evidence = { name: 'evidence', service: (ctx) => ({ async getAcceptedFacts(id) { return by(ctx, 'facts', id) ?? {}; } }) };
export const coverage = { name: 'coverage', service: (ctx) => ({ async getLatestVerification(id) { return by(ctx, 'verification', id); } }) };
export const intake = {
  name: 'intake',
  service: (ctx) => ({
    async getSession(sid) {
      const s = T(ctx).sessions?.[sid];
      if (!s) throw notFound(ctx);
      return s;
    },
  }),
};

const REPORTED = '2026-09-10T10:00:00.000Z';
const at = (hhmm) => `2026-09-10T${hhmm}:00.000Z`;

/** Alpha fixture: four claims in September 2026 plus one in August (out of period). */
export function alphaFixture() {
  const claim = (id, channel, role, extra = {}) => ({
    id, channel, status: 'in_review', reportedAt: REPORTED, reportedBy: { type: 'user', role }, flags: [], intakeSessionId: `ses_${id}`, ...extra,
  });
  return {
    fail: {},
    claims: [
      claim('c1', 'claimant_web', 'claimant', { status: 'fast_tracked' }),
      claim('c2', 'csr_phone', 'csr'),
      claim('c3', 'claimant_mobile', 'claimant', { status: 'fast_tracked' }),
      claim('c4', 'claimant_web', 'csr', { flags: ['siu'] }),
      claim('c5', 'claimant_web', 'claimant', { reportedAt: '2026-08-01T10:00:00.000Z' }),
    ],
    sessions: { ses_c1: { locale: 'en-US' }, ses_c2: { locale: 'es-US' }, ses_c3: { locale: 'es-MX' }, ses_c4: { locale: 'en' }, ses_c5: { locale: 'es' } },
    routing: { c1: { fastTrack: true, outcome: 'fast_tracked' }, c2: { fastTrack: false, outcome: 'assigned' }, c3: { fastTrack: true, outcome: 'fast_tracked' }, c4: { fastTrack: true, outcome: 'fast_tracked' } },
    tasks: { c2: [{ createdBy: { type: 'user', id: 'u9' } }], c4: [{ createdBy: { type: 'user', id: 'u9' } }, { createdBy: { type: 'system' } }], c1: [{ createdBy: { type: 'system' } }] },
    timers: {
      c1: [{ kind: 'acknowledge', status: 'met', metAt: at('10:30') }],
      c2: [{ kind: 'decide', status: 'breached' }, { kind: 'contact', status: 'running' }],
      c3: [{ kind: 'contact', status: 'met', metAt: at('11:30') }],
    },
    triage: {
      c1: { fraud: { score: 3, indicators: [], referToSiu: false }, subrogation: { flag: false, reasons: [] } },
      c2: { fraud: { score: 80, indicators: [], referToSiu: true }, subrogation: { flag: true, reasons: [] } },
      c4: { fraud: { score: 5, indicators: [] }, subrogation: { flag: false, reasons: [] } },
    },
    facts: {
      c1: { policyNumber: { value: 'x', provenance: { source: 'ai_extraction' } }, vin: { value: 'y', provenance: { source: 'ai_extraction' } } },
      c2: { policyNumber: { value: 'x', provenance: { source: 'user' } } },
      c3: { plate: { value: 'z', provenance: { source: 'ai_extraction' } } },
    },
    verification: { c1: { verifiedAt: at('10:02') }, c2: { verifiedAt: at('10:40') }, c3: { verifiedAt: at('10:01') } },
  };
}

/** Publish the outbox events the fixture needs (times come from the pinned clock). */
export function publishAlphaEvents(app, tenantId = 'alpha') {
  const pub = (hhmm, type, id, extra = {}) => {
    app.ctx.clock.set(at(hhmm));
    app.ctx.bus.publish(tenantId, type, id, { claimId: id, ...extra });
  };
  pub('10:05', 'claim.routed', 'c1', { outcome: 'fast_tracked' });
  pub('10:20', 'claim.routed', 'c2', { outcome: 'assigned' });
  pub('11:00', 'claim.routed', 'c3', { outcome: 'fast_tracked' });
  pub('10:10', 'claim.acknowledged', 'c2');
  app.ctx.clock.reset();
}
