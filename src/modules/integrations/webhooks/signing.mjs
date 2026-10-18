import crypto from 'node:crypto';

export const SIGNATURE_HEADER = 'X-FNOL-Signature';
export const EVENT_ID_HEADER = 'X-FNOL-Event-Id';
export const EVENT_TYPE_HEADER = 'X-FNOL-Event-Type';
export const DELIVERY_ID_HEADER = 'X-FNOL-Delivery-Id';
export const ATTEMPT_HEADER = 'X-FNOL-Attempt';

/**
 * Generate a new webhook signing secret (shown to the tenant admin exactly once).
 * @returns {string} e.g. 'whsec_<43 url-safe chars>'
 */
export function generateSecret() {
  return `whsec_${crypto.randomBytes(32).toString('base64url')}`;
}

/**
 * HMAC-SHA256 signature of the raw request body, lower-case hex.
 * @param {string} secret subscription signing secret
 * @param {string|Buffer} rawBody exact bytes sent on the wire
 * @returns {string}
 */
export function sign(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Constant-time verification of an X-FNOL-Signature header value.
 * Accepts the bare hex digest (an optional 'sha256=' prefix is tolerated).
 * @param {string} secret
 * @param {string|Buffer} rawBody
 * @param {string} header
 * @returns {boolean}
 */
export function verifySignature(secret, rawBody, header) {
  if (typeof header !== 'string') return false;
  const given = header.trim().replace(/^sha256=/i, '').toLowerCase();
  const expected = sign(secret, rawBody);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Headers for one delivery attempt.
 * @param {{ secret: string, body: string, eventId: string, eventType: string, deliveryId: string, attempt: number }} p
 * @returns {Record<string, string>}
 */
export function buildHeaders({ secret, body, eventId, eventType, deliveryId, attempt }) {
  return {
    'content-type': 'application/json',
    'user-agent': 'fnol-platform-webhooks/1.0',
    [SIGNATURE_HEADER]: sign(secret, body),
    [EVENT_ID_HEADER]: eventId,
    [EVENT_TYPE_HEADER]: eventType,
    [DELIVERY_ID_HEADER]: deliveryId,
    [ATTEMPT_HEADER]: String(attempt),
  };
}
