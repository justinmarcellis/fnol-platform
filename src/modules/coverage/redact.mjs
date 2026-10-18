// Role-based masking of x-pii fields in PolicySnapshot documents (names, addresses, garaging postcodes).
// Same rule as claims/routes.mjs PII_ROLES (tenant_admin added: it sees clear text); auditor and integration are masked.
export const REDACTED = '[redacted]';
export const PII_ROLES = ['csr', 'adjuster', 'supervisor', 'tenant_admin', 'carrier_admin', 'platform_admin'];

export const canSeePii = (user) => (user?.roles ?? []).some((r) => PII_ROLES.includes(r));

const mask = (v) => (v === undefined || v === null ? v : REDACTED);

/** Returns a copy of a PolicySnapshot (or PolicySummary-like) with every x-pii field masked. */
export function redactSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return snap;
  const out = structuredClone(snap);
  for (const i of out.namedInsureds ?? []) if ('name' in i) i.name = mask(i.name);
  for (const d of out.drivers ?? []) if ('name' in d) d.name = mask(d.name);
  for (const v of out.vehicles ?? []) if ('garagingPostalCode' in v) v.garagingPostalCode = mask(v.garagingPostalCode);
  for (const p of out.properties ?? []) if ('address' in p) p.address = mask(p.address);
  return out;
}

export const viewSnapshot = (user, snap) => (canSeePii(user) ? snap : redactSnapshot(snap));
