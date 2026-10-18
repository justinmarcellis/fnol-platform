import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'enc:v1:';
const b64 = (buf) => Buffer.from(buf).toString('base64url');

/**
 * PII crypto: master key on disk (0600), per-tenant keys via HKDF, AES-256-GCM.
 * @param {{ secretsDir: string }} opts
 */
export function createCrypto({ secretsDir }) {
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(secretsDir, 'master.key');
  if (!fs.existsSync(keyPath)) {
    try {
      fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  const master = fs.readFileSync(keyPath);
  if (master.length !== 32) throw new Error(`master.key must be 32 bytes (found ${master.length})`);
  const cache = new Map();

  /** Derive a 32-byte key bound to a tenant (or system scope) and purpose. */
  function deriveKey(tenantId, info) {
    const k = `${tenantId}\0${info}`;
    if (!cache.has(k)) {
      cache.set(k, Buffer.from(crypto.hkdfSync('sha256', master, String(tenantId), info, 32)));
    }
    return cache.get(k);
  }

  return {
    deriveKey,
    /**
     * Encrypt a PII string. null/undefined pass through.
     * @returns {string|null|undefined} 'enc:v1:<iv>:<tag>:<ct>' (base64url parts)
     */
    encryptPii(tenantId, value) {
      if (value === null || value === undefined) return value;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(tenantId, 'pii'), iv);
      const ct = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      return `${PREFIX}${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ct)}`;
    },
    /** Decrypt a value from encryptPii. Non-encrypted input is returned unchanged. Throws on tamper/wrong tenant. */
    decryptPii(tenantId, value) {
      if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
      const [iv, tag, ct] = value.slice(PREFIX.length).split(':');
      if (!iv || !tag || ct === undefined) throw new Error('Malformed ciphertext');
      const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(tenantId, 'pii'), Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
    /** Deterministic blind index (hex HMAC-SHA256) for searching encrypted fields; value is trimmed + lowercased. */
    hmacIndex(tenantId, value) {
      if (value === null || value === undefined) return value;
      const norm = String(value).trim().toLowerCase();
      return crypto.createHmac('sha256', deriveKey(tenantId, 'pii-index')).update(norm).digest('hex');
    },
    /** True when value looks like an encryptPii output. */
    isEncrypted: (v) => typeof v === 'string' && v.startsWith(PREFIX),
  };
}
