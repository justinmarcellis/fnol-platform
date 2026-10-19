// PolicySummary builder for policy search results. Takes the stored (PII-free) policy doc and the
// already-decrypted PII bundle (the adapter calls ctx.crypto.decryptPii), and returns only masked
// contact data: last four phone digits and a truncated postal code. No full phone or address.

/** "(555) 010-0101" -> "***-***-0101"; null when there is no usable phone. */
export function maskPhone(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length >= 4 ? `***-***-${d.slice(-4)}` : null;
}

/** "60601-1234" -> "606**"; null when there is no postal code. */
export function maskPostal(postal) {
  const p = String(postal ?? '').trim().slice(0, 5);
  return p.length >= 3 ? `${p.slice(0, 3)}${'*'.repeat(p.length - 3)}` : null;
}

function describe(doc, pii) {
  const vehicles = doc.vehicles ?? [];
  const properties = doc.properties ?? [];
  if (vehicles.length) {
    const v = vehicles[0];
    const base = [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle';
    return vehicles.length > 1 ? `${base} + ${vehicles.length - 1} more (${vehicles.length} units)` : base;
  }
  if (properties.length) {
    const p = properties[0];
    const addr = pii?.addresses?.[p.locationId];
    const where = addr ? [addr.city, addr.state].filter(Boolean).join(', ') : '';
    const kind = String(p.dwellingType ?? 'property').replace(/_/g, ' ');
    return where ? `${kind} in ${where}` : kind;
  }
  return null;
}

/**
 * @param {object} doc stored policy doc (no PII)
 * @param {object|null} pii decrypted PII bundle { insureds, garaging, addresses }
 * @returns {object} PolicySummary
 */
export function summarizePolicy(doc, pii) {
  const primary = (pii?.insureds ?? [])[0] ?? null;
  const postal = Object.values(pii?.garaging ?? {})[0] ?? Object.values(pii?.addresses ?? {})[0]?.postalCode;
  return {
    policyNumber: doc.policyNumber,
    lob: doc.lob,
    status: doc.status,
    period: doc.period,
    riskState: doc.ratingState ?? null,
    insuredName: primary?.name ?? null,
    contact: { phone: maskPhone(primary?.phone), postalCode: maskPostal(postal) },
    description: describe(doc, pii),
    vehicleCount: (doc.vehicles ?? []).length,
    propertyCount: (doc.properties ?? []).length,
  };
}
