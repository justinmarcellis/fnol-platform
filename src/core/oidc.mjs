// OIDC SSO spike (S5-PLT-04): RS256 ID/access token verifier against an issuer JWKS.
// Design plus proof only. Nothing in src/ imports this module yet; Sprint 6 wires it
// into auth.authenticate (see architecture/spikes/oidc-sso.md). node:crypto only.
import crypto from 'node:crypto';
import { HttpError } from './errors.mjs';

/** Stable OidcError codes. Messages are fixed per code and never echo token contents. */
export const OIDC_ERROR_CODES = Object.freeze([
  'bad_token', 'bad_alg', 'unknown_kid', 'bad_signature', 'bad_iss', 'bad_aud', 'expired', 'not_yet_valid',
]);

const MESSAGES = {
  bad_token: 'Malformed token',
  bad_alg: 'Token algorithm not allowed',
  unknown_kid: 'Token signing key not found',
  bad_signature: 'Invalid token signature',
  bad_iss: 'Token issuer not accepted',
  bad_aud: 'Token audience not accepted',
  expired: 'Token expired',
  not_yet_valid: 'Token not yet valid',
};

/** Verification failure. status 401, code one of OIDC_ERROR_CODES. */
export class OidcError extends HttpError {
  /** @param {string} code one of OIDC_ERROR_CODES */
  constructor(code) {
    const c = OIDC_ERROR_CODES.includes(code) ? code : 'bad_token';
    super(401, c, MESSAGES[c]);
    this.name = 'OidcError';
  }
}

const fail = (code) => { throw new OidcError(code); };

export const DEFAULT_MAX_TOKEN_BYTES = 8192;
export const DEFAULT_MIN_REFRESH_INTERVAL_MS = 60_000;
export const MAX_CLOCK_SKEW_SEC = 300;
export const MIN_RSA_BITS = 2048;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Strict base64url decode: alphabet check, no padding, no impossible length. */
function b64urlDecode(seg) {
  if (typeof seg !== 'string' || !seg.length || !B64URL_RE.test(seg) || seg.length % 4 === 1) fail('bad_token');
  return Buffer.from(seg, 'base64url');
}

/** Decode a segment as a JSON object (not array/null), capped at maxBytes. */
function decodeJsonSegment(seg, maxBytes) {
  if (typeof seg !== 'string' || seg.length > Math.ceil((maxBytes * 4) / 3)) fail('bad_token');
  const buf = b64urlDecode(seg);
  if (buf.length > maxBytes) fail('bad_token');
  let v;
  try { v = JSON.parse(buf.toString('utf8')); } catch { fail('bad_token'); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail('bad_token');
  return v;
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** True when a JWK may verify RS256 signatures for this kid. */
function usableJwk(jwk, kid) {
  if (!jwk || typeof jwk !== 'object' || jwk.kid !== kid || jwk.kty !== 'RSA') return false;
  if (jwk.use !== undefined && jwk.use !== 'sig') return false;
  if (jwk.alg !== undefined && jwk.alg !== 'RS256') return false;
  if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) return false;
  return typeof jwk.n === 'string' && typeof jwk.e === 'string';
}

/** Normalize a JWKS port result: JWK[] or { keys: JWK[] }. */
function keyList(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.keys)) return v.keys;
  return [];
}

/**
 * Create an RS256 OIDC token verifier.
 * The JWKS port is `{ getKeys(): JWK[] | {keys} | Promise<...>, refresh(): Promise<void> }`: getKeys returns the
 * cached set, refresh re-fetches it. The verifier calls refresh at most once per verify(), only for an unknown kid,
 * and never more often than minRefreshIntervalMs (measured with the injected now()).
 * @param {object} o
 * @param {string} o.issuer exact expected `iss`
 * @param {string} o.audience expected `aud` (token aud may be a string or an array containing it)
 * @param {{ getKeys: Function, refresh: Function }} o.jwks JWKS port
 * @param {number} [o.clockSkewSec=60] leeway for exp/nbf, 0..300
 * @param {() => number} [o.now=Date.now] epoch milliseconds
 * @param {number} [o.maxTokenBytes=8192] reject longer compact tokens
 * @param {number} [o.minRefreshIntervalMs=60000] JWKS refresh rate limit
 * @returns {{ verify(token: string): Promise<object>, issuer: string, audience: string }}
 */
export function createOidcVerifier({
  issuer, audience, jwks, clockSkewSec = 60, now = Date.now,
  maxTokenBytes = DEFAULT_MAX_TOKEN_BYTES, minRefreshIntervalMs = DEFAULT_MIN_REFRESH_INTERVAL_MS,
} = {}) {
  if (typeof issuer !== 'string' || !issuer) throw new TypeError('issuer is required');
  if (typeof audience !== 'string' || !audience) throw new TypeError('audience is required');
  if (!jwks || typeof jwks.getKeys !== 'function' || typeof jwks.refresh !== 'function') {
    throw new TypeError('jwks port with getKeys() and refresh() is required');
  }
  if (!isFiniteNumber(clockSkewSec) || clockSkewSec < 0 || clockSkewSec > MAX_CLOCK_SKEW_SEC) {
    throw new TypeError(`clockSkewSec must be 0..${MAX_CLOCK_SKEW_SEC}`);
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  let lastRefreshAt = -Infinity;
  let inflight = null;
  // KeyObject cache keyed by the JWK object identity, so a refreshed set rebuilds keys.
  const keyCache = new WeakMap();

  async function findKey(kid) {
    const jwk = keyList(await jwks.getKeys()).find((k) => usableJwk(k, kid));
    if (!jwk) return null;
    let key = keyCache.get(jwk);
    if (key === undefined) {
      try {
        key = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
        if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) key = null;
      } catch { key = null; }
      keyCache.set(jwk, key);
    }
    return key;
  }

  async function refreshOnce() {
    if (inflight) return inflight.catch(() => {}); // concurrent verifies share one refresh
    if (now() - lastRefreshAt < minRefreshIntervalMs) return undefined;
    lastRefreshAt = now();
    inflight = Promise.resolve().then(() => jwks.refresh()).finally(() => { inflight = null; });
    try { await inflight; } catch { /* keep the cached set; the kid stays unknown */ }
    return undefined;
  }

  async function verify(token) {
    if (typeof token !== 'string' || !token.length || token.length > maxTokenBytes) fail('bad_token');
    const parts = token.split('.');
    if (parts.length !== 3) fail('bad_token');
    const [h, p, s] = parts;

    // 1. Header and algorithm, before any key is touched.
    const header = decodeJsonSegment(h, 1024);
    if (header.alg !== 'RS256') fail('bad_alg');
    if (header.crit !== undefined) fail('bad_token'); // no critical extensions are understood
    if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 256) fail('bad_token');

    // 2. Payload and signature shape.
    const claims = decodeJsonSegment(p, maxTokenBytes);
    const sig = b64urlDecode(s);

    // 3. Key by kid, with at most one rate-limited JWKS refresh.
    let key = await findKey(header.kid);
    if (!key) {
      await refreshOnce();
      key = await findKey(header.kid);
    }
    if (!key) fail('unknown_kid');

    // 4. Signature (RSASSA-PKCS1-v1_5 with SHA-256).
    if (sig.length !== Math.ceil(key.asymmetricKeyDetails.modulusLength / 8)) fail('bad_signature');
    let ok = false;
    try {
      ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`, 'ascii'), { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
    } catch { ok = false; }
    if (!ok) fail('bad_signature');

    // 5. Claims.
    if (claims.iss !== issuer) fail('bad_iss');
    const aud = claims.aud;
    const audOk = typeof aud === 'string'
      ? aud === audience
      : Array.isArray(aud) && aud.length > 0 && aud.every((a) => typeof a === 'string') && aud.includes(audience);
    if (!audOk) fail('bad_aud');
    if (!isFiniteNumber(claims.exp)) fail('bad_token');
    if (claims.nbf !== undefined && !isFiniteNumber(claims.nbf)) fail('bad_token');
    if (claims.iat !== undefined && !isFiniteNumber(claims.iat)) fail('bad_token');
    const nowSec = now() / 1000;
    if (nowSec >= claims.exp + clockSkewSec) fail('expired');
    if (claims.nbf !== undefined && nowSec < claims.nbf - clockSkewSec) fail('not_yet_valid');

    return claims;
  }

  return { verify, issuer, audience };
}

/**
 * In-memory JWKS port for tests and fixtures. refresh() is a no-op; calls are counted.
 * @param {object[] | { keys: object[] }} keys public JWKs
 * @returns {{ getKeys(): Promise<object[]>, refresh(): Promise<void>, refreshCount: number }}
 */
export function createStaticJwks(keys) {
  const list = Object.freeze(keyList(keys).map((k) => Object.freeze({ ...k })));
  const port = {
    refreshCount: 0,
    async getKeys() { return list; },
    async refresh() { port.refreshCount += 1; },
  };
  return port;
}
