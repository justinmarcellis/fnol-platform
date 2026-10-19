// Local fakes for the modules the adapter service calls (claims, triage, coverage).
import { triage, coverage, snapshot } from '../../../unit/integrations/adapters/fixtures.mjs';

export const state = {
  bundles: new Map(), // `${tenant}:${claimId}` -> bundle
  externalRefs: [], // { tenantId, claimId, ref }
  failSetExternalRef: false,
};
export const reset = () => { state.bundles.clear(); state.externalRefs.length = 0; state.failSetExternalRef = false; };
export const putBundle = (tenantId, bundle) => state.bundles.set(`${tenantId}:${bundle.claim.id}`, structuredClone(bundle));

export const claimsModule = {
  name: 'claims',
  service: (ctx) => ({
    async getClaimBundle(claimId) {
      const b = state.bundles.get(`${ctx.tenant.id}:${claimId}`);
      if (!b) throw new ctx.AppError('not_found', 'Claim not found', 404);
      return structuredClone(b);
    },
    async setExternalRef(claimId, ref) {
      if (state.failSetExternalRef) throw new Error('claims unavailable');
      state.externalRefs.push({ tenantId: ctx.tenant.id, claimId, ref });
      return { id: claimId, externalRefs: [ref] };
    },
  }),
};

export const triageModule = {
  name: 'triage',
  service: () => ({ getLatestTriage: async (claimId) => (claimId.startsWith('clm_auto') ? triage : null) }),
};

export const coverageModule = {
  name: 'coverage',
  service: () => ({
    getLatestVerification: async (claimId) => (claimId.startsWith('clm_auto') ? coverage : null),
    getSnapshotById: async (id) => (id === snapshot.id ? snapshot : null),
  }),
};
