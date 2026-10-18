// PII handling for claims. Fields marked x-pii in architecture/contracts/domain/*.schema.json are
// encrypted with ctx.crypto before they reach the database, and never appear in events or audit details.

export const REDACTED = '[redacted]';

/** Dotted paths (relative to the entity) that are x-pii. */
export const PII_PATHS = {
  party: ['firstName', 'lastName', 'dateOfBirth', 'phone', 'email', 'address', 'driversLicense', 'injuryDescription'],
  vehicle: ['licensePlate'],
  property: ['address'],
  lossEvent: ['description', 'location.address'],
  note: ['body'],
};

const get = (o, parts) => parts.reduce((a, k) => (a == null ? undefined : a[k]), o);

function setPath(o, parts, value) {
  let cur = o;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') return;
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** Walk an entity's PII paths; fn(value) -> new value for each present, non-null field. Returns a copy. */
function mapPii(entity, kind, fn) {
  if (!entity || typeof entity !== 'object') return entity;
  const out = structuredClone(entity);
  for (const path of PII_PATHS[kind]) {
    const parts = path.split('.');
    const v = get(out, parts);
    if (v !== undefined && v !== null) setPath(out, parts, fn(v));
  }
  return out;
}

/**
 * @param {object} ctx tenant-bound ctx (ctx.crypto.encryptPii(value))
 */
export function createPii(ctx) {
  const wrap = (v) => ctx.crypto.encryptPii(JSON.stringify({ v }));
  const unwrap = (v) => {
    if (typeof v !== 'string' || !ctx.crypto.isEncrypted(v)) return v;
    return JSON.parse(ctx.crypto.decryptPii(v)).v;
  };
  return {
    /** Encrypt the x-pii fields of an entity of the given kind (party, vehicle, property, lossEvent, note). */
    encrypt: (entity, kind) => mapPii(entity, kind, (v) => (typeof v === 'string' && ctx.crypto.isEncrypted(v) ? v : wrap(v))),
    decrypt: (entity, kind) => mapPii(entity, kind, unwrap),
    redact: (entity, kind) => mapPii(entity, kind, () => REDACTED),
  };
}
