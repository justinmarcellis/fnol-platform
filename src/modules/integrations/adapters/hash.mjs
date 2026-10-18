import { createHash } from 'node:crypto';

/** Per-request values that change on every send and must not affect the payload hash. */
const VOLATILE = new Set(['rqUID', 'transactionRequestDt', 'RQ_UID', 'REQUEST_TS']);

/** JSON with sorted keys and volatile request fields removed, so equal content hashes equally. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => !VOLATILE.has(k) && value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Deterministic sha256 (hex) of a mapped payload.
 * @param {object} payload
 * @returns {string}
 */
export function hashPayload(payload) {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
