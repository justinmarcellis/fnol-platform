// Fake claims, evidence, coverage and rules modules for triage tests, plus a fake ai.
export const state = { claims: new Map(), facts: new Map(), coverage: new Map(), snapshots: new Map(), rules: { actions: [], fail: false }, evalCalls: [] };
export const reset = () => {
  state.claims.clear(); state.facts.clear(); state.coverage.clear(); state.snapshots.clear();
  state.rules = { actions: [], fail: false }; state.evalCalls = [];
};
const k = (ctx, id) => `${ctx.tenant.id}:${id}`;

export function putClaim(tenant, over = {}) {
  const id = over.id ?? 'clm_00000000000000000001';
  const claim = {
    id, tenantId: tenant, claimNumber: 'ALP-2026-000001', status: 'validating', lob: 'personal_auto', lossType: 'auto_collision',
    channel: 'web', policyNumber: 'AUT-100001', riskState: 'IL', reportedAt: '2026-09-16T10:00:00.000Z',
    lossEvent: { lossDate: '2026-09-15', cause: 'collision', description: 'Synthetic narrative: minor bump in a parking lot.', injuriesReported: false, vehiclesInvolved: 2 },
    ...over.claim,
  };
  const bundle = { claim, parties: over.parties ?? [{ id: 'pty_1', roles: ['insured'], kind: 'person' }], vehicles: over.vehicles ?? [{ id: 'veh_1', role: 'insured' }], properties: [], ...over.extra };
  state.claims.set(`${tenant}:${id}`, bundle);
  return bundle;
}
export const setFacts = (tenant, id, facts) => state.facts.set(`${tenant}:${id}`, Object.fromEntries(Object.entries(facts).map(([n, v]) => [n, { value: v, confidence: 0.95, provenance: { source: 'ai_extraction' } }])));
export const setCoverage = (tenant, id, v) => state.coverage.set(`${tenant}:${id}`, v);

export const fakeModule = (name, build) => ({ name, service: build });
export const modules = {
  claims: fakeModule('claims', (ctx) => ({
    async getClaimBundle(id) {
      const b = state.claims.get(k(ctx, id));
      if (!b) throw new ctx.AppError('not_found', 'Claim not found', 404);
      return b;
    },
  })),
  evidence: fakeModule('evidence', (ctx) => ({ async getAcceptedFacts(id) { return state.facts.get(k(ctx, id)) ?? {}; } })),
  coverage: fakeModule('coverage', (ctx) => ({
    async getLatestVerification(id) { return state.coverage.get(k(ctx, id)) ?? null; },
    async getSnapshotById(id) { return state.snapshots.get(`${ctx.tenant.id}:${id}`) ?? null; },
  })),
  rules: fakeModule('rules', () => ({
    async evaluate(q) {
      state.evalCalls.push(q);
      if (state.rules.fail) throw new Error('rules down');
      return { fired: state.rules.actions.length ? [{ ruleId: 'R1', actions: state.rules.actions }] : [], actions: state.rules.actions, trace: [] };
    },
  })),
};
export default modules.claims;

/** Fake ai.run: records calls; per-task output overrides; set fail to throw. */
export function makeAi(over = {}) {
  const calls = [];
  const out = {
    severity: { score: 30, band: 'moderate', drivers: ['collision loss'] },
    fraud_signals: { score: 0, indicators: [] },
    subrogation: { flag: false, reasons: [], confidence: 0.6 },
    ...over.outputs,
  };
  return {
    calls,
    fail: false,
    async run(task, input, opts) {
      calls.push({ task, input, opts });
      if (this.fail) throw new Error('ai down');
      return { output: out[task], provider: 'vertex-gemini', model: 'fake-model-1', confidence: 0.82, explanation: 'fake', usage: {}, tier: 1 };
    },
  };
}
