// Fakes for the modules the adjuster module reads (claims, evidence, coverage, triage, rules).
export const store = { claims: new Map(), timers: new Map(), docs: new Map(), cov: new Map(), triage: new Map(), routing: new Map() };
export const reset = () => Object.values(store).forEach((m) => m.clear());
const k = (t, id) => `${t}:${id}`;

const mk = (name, fn) => ({ name, service: fn });

export const fakeModules = {
  claims: mk('claims', (ctx) => ({
    async getClaim(id) {
      const c = store.claims.get(k(ctx.tenant.id, id));
      if (!c) throw new ctx.AppError('not_found', 'Claim not found', 404);
      return c;
    },
    async listTimers(id) { return store.timers.get(k(ctx.tenant.id, id)) ?? []; },
    async listTasks() { return []; },
    async listNotes() { return []; },
  })),
  evidence: mk('evidence', (ctx) => ({ async listDocuments(id) { return store.docs.get(k(ctx.tenant.id, id)) ?? []; } })),
  coverage: mk('coverage', (ctx) => ({
    async getLatestVerification(id) { return store.cov.get(k(ctx.tenant.id, id)) ?? null; },
    async getSnapshotById() { return null; },
    async getPolicySnapshot() { return null; },
  })),
  triage: mk('triage', (ctx) => ({ async getLatestTriage(id) { return store.triage.get(k(ctx.tenant.id, id)) ?? null; } })),
  rules: mk('rules', (ctx) => ({ async getRoutingDecision(id) { return store.routing.get(k(ctx.tenant.id, id)) ?? null; } })),
};

export const put = (map, tenantId, id, v) => store[map].set(k(tenantId, id), v);

export const CLAIM_ID = 'clm_00000000000000000001';
export const TS = '2026-09-16T10:00:00.000Z';

export const makeClaim = (over = {}) => ({
  id: CLAIM_ID, tenantId: 'alpha', claimNumber: 'ALP-26-000001', status: 'assigned', lob: 'personal_auto', channel: 'claimant_web',
  policyNumber: 'PA-1001', riskState: 'WI', lossEvent: { lossDate: '2026-09-15', cause: 'collision', description: 'synthetic' },
  reportedAt: TS, version: 3, createdAt: TS, updatedAt: TS, ...over,
});

export const makeTriage = (attempt = 1) => ({
  id: `trg_0000000000000000000${attempt}`, tenantId: 'alpha', claimId: CLAIM_ID, attempt, severityScore: 40, severityBand: 'moderate',
  complexity: 'medium', fraud: { score: 10, indicators: [] }, subrogation: { flag: false, reasons: [] },
  explanation: 'Synthetic triage.', ai: { provider: 'local', model: 'local-rules-v1', confidence: 0.9 }, createdAt: TS,
});

export const makeCoverage = (outcome = 'covered') => ({
  id: 'cov_00000000000000000001', tenantId: 'alpha', claimId: CLAIM_ID, outcome, checks: [], verifiedAt: TS,
});
