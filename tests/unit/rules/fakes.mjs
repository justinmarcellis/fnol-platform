// Local fakes for the modules rules depends on (claims, triage, coverage, config).
// Each test app gets them copied into a temp modules dir by helpers.mjs.
export const store = {
  claims: new Map(), // `${tenant}:${id}` -> claim
  triage: new Map(),
  coverage: new Map(),
  calls: [], // { tenant, fn, args }
};

export const key = (t, id) => `${t}:${id}`;
export const reset = () => { for (const m of Object.values(store)) m.clear?.(); store.calls.length = 0; };

export function putClaim(tenant, claim) { store.claims.set(key(tenant, claim.id), claim); return claim; }
export function putTriage(tenant, claimId, t) { store.triage.set(key(tenant, claimId), t); return t; }
export function putCoverage(tenant, claimId, c) { store.coverage.set(key(tenant, claimId), c); return c; }

export const fakes = {
  claims: {
    name: 'claims',
    service: (ctx) => ({
      async getClaim(id) {
        const c = store.claims.get(key(ctx.tenant.id, id));
        if (!c) throw new ctx.AppError('not_found', 'Claim not found', 404);
        return structuredClone(c);
      },
      async addFlag(id, flag, opts) {
        store.calls.push({ tenant: ctx.tenant.id, fn: 'addFlag', args: [id, flag], opts });
        const c = store.claims.get(key(ctx.tenant.id, id));
        c.flags = [...new Set([...(c.flags ?? []), flag])];
        return c;
      },
      async addTask(id, input, opts) {
        store.calls.push({ tenant: ctx.tenant.id, fn: 'addTask', args: [id, input], opts });
        return { id: 'tsk_00000001', ...input };
      },
    }),
  },
  triage: {
    name: 'triage',
    service: (ctx) => ({ async getLatestTriage(id) { return store.triage.get(key(ctx.tenant.id, id)) ?? null; } }),
  },
  coverage: {
    name: 'coverage',
    service: (ctx) => ({ async getLatestVerification(id) { return store.coverage.get(key(ctx.tenant.id, id)) ?? null; } }),
  },
  // Tenant config reader with the config module's getRules/getQueues contract.
  config: {
    name: 'config',
    service: (ctx) => ({
      getTenantConfig: () => ctx.tenant.config,
      getQueues: () => ctx.tenant.config.queues ?? [],
      getRules({ stage, lob, state, lossType } = {}) {
        return (ctx.tenant.config.rules ?? []).filter((r) => {
          if (r.enabled === false || (stage && r.stage !== stage)) return false;
          const a = r.appliesTo ?? {};
          if (a.lobs?.length && (!lob || !a.lobs.includes(lob))) return false;
          if (a.states?.length && (!state || !a.states.includes(state))) return false;
          if (a.lossTypes?.length && (!lossType || !a.lossTypes.includes(lossType))) return false;
          return true;
        }).sort((x, y) => (x.priority ?? 100) - (y.priority ?? 100) || x.id.localeCompare(y.id));
      },
    }),
  },
};

let n = 0;
/** Claim-shaped fixture with only what rules reads. */
export function makeClaim(over = {}) {
  n += 1;
  const id = `clm_${String(n).padStart(20, '0')}`;
  return {
    id, status: 'triaged', lob: 'personal_auto', channel: 'web', riskState: 'WI', policyNumber: 'POL-1', flags: [], version: 1,
    lossEvent: { lossDate: '2026-09-15', cause: 'collision', injuriesReported: false },
    parties: [], vehicles: [], properties: [], answers: {},
    ...over,
  };
}

export const makeTriage = (claimId, over = {}) => ({
  id: 'tri_00000000000000000001', claimId, severityScore: 10, severityBand: 'minor', complexity: 'low',
  fraud: { score: 5, indicators: [] }, fastTrackEligible: true, ...over,
});

export const makeCoverage = (claimId, outcome = 'covered') => ({ id: 'cov_00000000000000000001', claimId, outcome });
