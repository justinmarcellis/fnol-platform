// Claimant-safe projection (SEC2-004). Non-staff roles get a whitelist view of a claim, never the stored doc:
// no triage (fraud, severity), flags (siu), routing, checks, notes, reserves or free text.

/** Roles that see the full (PII-redacted or decrypted per route policy) claim. Everything else is projected. */
export const STAFF_ROLES = ['csr', 'adjuster', 'supervisor', 'auditor', 'integration', 'carrier_admin', 'tenant_admin', 'platform_admin'];
/** Non-staff roles whose reads are limited to claims they reported. */
export const OWNED_ROLES = ['claimant', 'agent'];

const CLAIM_FIELDS = ['id', 'claimNumber', 'status', 'lob', 'lossType', 'reportedAt', 'updatedAt', 'closedAt', 'version'];
const LOSS_FIELDS = ['lossDate', 'cause'];

export const isStaff = (user) => (user?.roles ?? []).some((r) => STAFF_ROLES.includes(r));

/** Whitelist copy of a claim for a non-staff viewer. Unknown fields are dropped by construction. */
export function projectClaim(claim) {
  if (!claim || typeof claim !== 'object') return claim;
  const out = {};
  for (const k of CLAIM_FIELDS) if (claim[k] !== undefined) out[k] = claim[k];
  if (claim.lossEvent && typeof claim.lossEvent === 'object') {
    const le = {};
    for (const k of LOSS_FIELDS) if (claim.lossEvent[k] !== undefined) le[k] = claim.lossEvent[k];
    out.lossEvent = le;
  }
  return out;
}

/** Ownership: claim.reportedBy.id must equal the token subject. Staff are not restricted here. */
export function ownsClaim(claim, user) {
  return Boolean(claim?.reportedBy?.id) && claim.reportedBy.id === user?.sub;
}

/** Shape a claim (or page of claims) for the viewer: staff pass through, others get the projection. */
export const viewFor = (user, claim) => (isStaff(user) ? claim : projectClaim(claim));
