// Minimal stand-in for the claims module (service.getClaim only), so coverage
// tests do not depend on the claims team's code.
export const claims = new Map();

export const key = (tenantId, id) => `${tenantId}:${id}`;

export function putClaim(tenantId, claim) {
  claims.set(key(tenantId, claim.id), claim);
  return claim;
}

/** Build a Claim-shaped object with the fields coverage reads. */
export function makeClaim({
  id = 'clm_00000000000000000001', policyNumber, lob = 'personal_auto', lossDate = '2026-09-15', cause = 'collision',
  lossTime, lossTimeZone, vehicles, properties,
} = {}) {
  return {
    id,
    policyNumber,
    lob,
    lossEvent: { lossDate, cause, description: 'synthetic', ...(lossTime ? { lossTime } : {}), ...(lossTimeZone ? { lossTimeZone } : {}) },
    vehicles: vehicles ?? (lob.includes('auto') ? [{ role: 'insured', policyVehicleId: 'V1' }] : []),
    properties: properties ?? (lob.includes('auto') ? [] : [{ role: 'insured_location', policyLocationId: 'LOC1' }]),
  };
}

export default {
  name: 'claims',
  service: (ctx) => ({
    async getClaim(claimId) {
      const c = claims.get(key(ctx.tenant.id, claimId));
      if (!c) throw new ctx.AppError('not_found', 'Claim not found', 404);
      return c;
    },
  }),
};
