import crypto from 'node:crypto';

/**
 * Cloud KMS master-key wrap spike (S5-PLT-03). Envelope encryption, enc:v2.
 * Not wired into crypto.mjs; no migration. See architecture/spikes/kms-keywrap.md.
 *
 * Envelope: enc:v2:<keyId>:<wrappedDek>:<iv>:<tag>:<ct>, every part base64url
 * (keyId is the UTF-8 key id string). AES-256-GCM, random 32-byte DEK and 12-byte IV
 * per value, AAD = 'enc:v2|' + keyId. The DEK is wrapped by the KMS.
 */

const PREFIX = 'enc:v2:';
const B64URL = /^[A-Za-z0-9_-]*$/;

export class KeywrapError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'KeywrapError';
    this.code = code;
  }
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const aadFor = (keyId) => Buffer.from(`enc:v2|${keyId}`, 'utf8');

/**
 * Kms port (duck-typed):
 *   wrapKey(dek: Buffer) => Promise<{ keyId: string, wrapped: Buffer }>
 *   unwrapKey({ keyId: string, wrapped: Buffer }) => Promise<Buffer>   // rejects when unknown/disabled/tampered
 * keyId identifies the key version used (for Cloud KMS, the full cryptoKeyVersions name).
 * @typedef {{ wrapKey(dek: Buffer): Promise<{keyId: string, wrapped: Buffer}>, unwrapKey(a: {keyId: string, wrapped: Buffer}): Promise<Buffer> }} Kms
 */

function assertKms(kms) {
  if (!kms || typeof kms.wrapKey !== 'function' || typeof kms.unwrapKey !== 'function') {
    throw new KeywrapError('bad_kms', 'kms must implement wrapKey and unwrapKey');
  }
}

/**
 * In-memory fake KMS with several key ids (versions) for rotation tests. Tests only.
 * @param {{ keyIds?: string[], active?: string }} [opts]
 */
export function createFakeKms({ keyIds = ['fake-key-v1'], active } = {}) {
  const keys = new Map(keyIds.map((id) => [id, crypto.randomBytes(32)]));
  const disabled = new Set();
  let activeId = active ?? keyIds[0];
  if (!keys.has(activeId)) throw new KeywrapError('bad_kms', 'active key id not among keyIds');
  const calls = { wrap: 0, unwrap: 0 };
  return {
    calls,
    get activeKeyId() { return activeId; },
    /** Add a new key version and make it active (rotation). */
    rotate(newId) {
      if (keys.has(newId)) throw new KeywrapError('bad_kms', 'key id already exists');
      keys.set(newId, crypto.randomBytes(32));
      activeId = newId;
    },
    /** Make a key version fail on unwrap (destroyed/disabled). */
    disable(id) { disabled.add(id); },
    async wrapKey(dek) {
      calls.wrap += 1;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', keys.get(activeId), iv);
      c.setAAD(Buffer.from(activeId, 'utf8'));
      const ct = Buffer.concat([c.update(dek), c.final()]);
      return { keyId: activeId, wrapped: Buffer.concat([iv, c.getAuthTag(), ct]) };
    },
    async unwrapKey({ keyId, wrapped }) {
      calls.unwrap += 1;
      const key = keys.get(keyId);
      if (!key || disabled.has(keyId)) throw new KeywrapError('kms_unwrap_failed', 'KMS cannot unwrap with this key id');
      try {
        const buf = Buffer.from(wrapped);
        const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
        d.setAAD(Buffer.from(keyId, 'utf8'));
        d.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
      } catch {
        throw new KeywrapError('kms_unwrap_failed', 'KMS unwrap failed');
      }
    },
  };
}

/**
 * Cloud KMS REST adapter. POST {keyName}:encrypt and :decrypt with a bearer token.
 * keyName: projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>. Fails closed on any non-2xx or odd response.
 * Error messages carry the HTTP status only, never the response body, token or key bytes.
 * @param {{ tokenProvider: () => Promise<string>, keyName: string, fetch?: typeof fetch, endpoint?: string }} opts
 * @returns {Kms}
 */
export function createCloudKmsRest({ tokenProvider, keyName, fetch: fetchImpl = globalThis.fetch, endpoint = 'https://cloudkms.googleapis.com/v1' }) {
  if (typeof tokenProvider !== 'function') throw new KeywrapError('bad_config', 'tokenProvider is required');
  if (typeof fetchImpl !== 'function') throw new KeywrapError('bad_config', 'fetch is required');
  if (typeof keyName !== 'string' || !/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(keyName)) {
    throw new KeywrapError('bad_config', 'keyName must be a cryptoKeys resource name');
  }
  const versionPrefix = `${keyName}/cryptoKeyVersions/`;

  async function call(op, body) {
    let token;
    try { token = await tokenProvider(); } catch { throw new KeywrapError('kms_auth_failed', 'token provider failed'); }
    if (typeof token !== 'string' || !token) throw new KeywrapError('kms_auth_failed', 'token provider returned no token');
    let res;
    try {
      res = await fetchImpl(`${endpoint}/${keyName}:${op}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new KeywrapError('kms_unavailable', `KMS ${op} request failed`);
    }
    if (!res || !res.ok) throw new KeywrapError('kms_error', `KMS ${op} returned HTTP ${res ? res.status : 'none'}`);
    try { return await res.json(); } catch { throw new KeywrapError('kms_error', `KMS ${op} returned invalid JSON`); }
  }

  return {
    async wrapKey(dek) {
      const out = await call('encrypt', { plaintext: Buffer.from(dek).toString('base64') });
      if (!out || typeof out.ciphertext !== 'string' || typeof out.name !== 'string' || !out.name.startsWith(versionPrefix)) {
        throw new KeywrapError('kms_error', 'KMS encrypt response malformed or from an unexpected key');
      }
      return { keyId: out.name, wrapped: Buffer.from(out.ciphertext, 'base64') };
    },
    async unwrapKey({ keyId, wrapped }) {
      // Never send a ciphertext to a key we were not configured for.
      if (typeof keyId !== 'string' || !keyId.startsWith(versionPrefix)) {
        throw new KeywrapError('key_id_mismatch', 'key id does not belong to the configured key');
      }
      const out = await call('decrypt', { ciphertext: Buffer.from(wrapped).toString('base64') });
      if (!out || typeof out.plaintext !== 'string') throw new KeywrapError('kms_error', 'KMS decrypt response malformed');
      const dek = Buffer.from(out.plaintext, 'base64');
      if (dek.length !== 32) { dek.fill(0); throw new KeywrapError('kms_error', 'unwrapped key has wrong length'); }
      return dek;
    },
  };
}

/**
 * Encrypt a string into an enc:v2 envelope. null/undefined pass through.
 * @param {string|null|undefined} plaintext
 * @param {{ kms: Kms }} opts
 * @returns {Promise<string|null|undefined>}
 */
export async function encryptV2(plaintext, { kms }) {
  if (plaintext === null || plaintext === undefined) return plaintext;
  assertKms(kms);
  const dek = crypto.randomBytes(32);
  try {
    const { keyId, wrapped } = await kms.wrapKey(dek);
    if (typeof keyId !== 'string' || !keyId || !wrapped || !wrapped.length) throw new KeywrapError('kms_error', 'KMS returned an invalid wrap result');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', dek, iv);
    c.setAAD(aadFor(keyId));
    const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
    return `${PREFIX}${b64(Buffer.from(keyId, 'utf8'))}:${b64(wrapped)}:${b64(iv)}:${b64(c.getAuthTag())}:${b64(ct)}`;
  } finally {
    dek.fill(0);
  }
}

/** Strict parser. Throws KeywrapError('malformed') on anything non-canonical. */
function parseV2(value) {
  const bad = () => new KeywrapError('malformed', 'Malformed enc:v2 envelope');
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) throw bad();
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 5) throw bad();
  const bufs = parts.map((p) => {
    if (!B64URL.test(p)) throw bad();
    const b = Buffer.from(p, 'base64url');
    if (b.toString('base64url') !== p) throw bad(); // canonical encoding only
    return b;
  });
  const [keyIdB, wrapped, iv, tag, ct] = bufs;
  if (!keyIdB.length || !wrapped.length || iv.length !== 12 || tag.length !== 16) throw bad();
  const keyId = keyIdB.toString('utf8');
  if (Buffer.from(keyId, 'utf8').compare(keyIdB) !== 0) throw bad();
  return { keyId, wrapped, iv, tag, ct };
}

/** Extract the key id from an enc:v2 envelope without decrypting (for rekey scans). */
export function keyIdOf(value) {
  return parseV2(value).keyId;
}

/** True when value looks like an enc:v2 envelope. */
export const isV2 = (v) => typeof v === 'string' && v.startsWith(PREFIX);

/**
 * Decrypt an enc:v2 envelope. Fails closed: malformed, unknown key id, KMS failure or bad tag all throw.
 * @param {string} value
 * @param {{ kms: Kms }} opts
 * @returns {Promise<string>}
 */
export async function decryptV2(value, { kms }) {
  assertKms(kms);
  const { keyId, wrapped, iv, tag, ct } = parseV2(value);
  const dek = await kms.unwrapKey({ keyId, wrapped });
  try {
    if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new KeywrapError('kms_error', 'unwrapped key has wrong length');
    const d = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    d.setAAD(aadFor(keyId));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) {
    if (e instanceof KeywrapError) throw e;
    throw new KeywrapError('auth_failed', 'enc:v2 authentication failed');
  } finally {
    if (Buffer.isBuffer(dek)) dek.fill(0);
  }
}

/**
 * Decrypt either format. enc:v1 goes to the supplied v1Decrypt (e.g. (v) => crypto.decryptPii(tenantId, v));
 * enc:v2 to decryptV2; anything else passes through unchanged (same as decryptPii).
 * @param {unknown} value
 * @param {{ v1Decrypt: (v: string) => string, kms: Kms }} opts
 */
export async function decryptAny(value, { v1Decrypt, kms }) {
  if (typeof value !== 'string') return value;
  if (value.startsWith(PREFIX)) return decryptV2(value, { kms });
  if (value.startsWith('enc:v1:')) {
    if (typeof v1Decrypt !== 'function') throw new KeywrapError('bad_config', 'v1Decrypt is required for enc:v1 values');
    return v1Decrypt(value);
  }
  return value;
}
