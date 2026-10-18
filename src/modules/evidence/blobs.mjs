// Encrypted blob store on local disk: data/blobs/<tenant>/<claim>/<docId> next to dbPath.
// File layout: iv(12) | authTag(16) | AES-256-GCM ciphertext, key derived per tenant by ctx.crypto.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots = new WeakMap();

function blobRoot(ctx) {
  const root = ctx.root ?? ctx;
  if (!roots.has(root)) {
    const dbPath = root.config?.dbPath;
    let dir;
    if (root.config?.blobDir) dir = root.config.blobDir;
    else if (!dbPath || dbPath === ':memory:') dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-blobs-'));
    else dir = path.join(path.dirname(path.resolve(dbPath)), 'blobs');
    roots.set(root, dir);
  }
  return roots.get(root);
}

const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');

/** Storage key is tenant-prefixed and relative to the blob root. */
export const blobKey = (tenantId, claimId, docId) => `${safe(tenantId)}/${safe(claimId)}/${safe(docId)}`;

/** Encrypt and write bytes. */
export function putBlob(ctx, key, bytes) {
  const file = path.join(blobRoot(ctx), key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ctx.crypto.deriveKey(ctx.tenant.id, 'blob'), iv);
  const ct = Buffer.concat([c.update(bytes), c.final()]);
  fs.writeFileSync(file, Buffer.concat([iv, c.getAuthTag(), ct]), { mode: 0o600 });
}

/** Read and decrypt bytes. Throws on tamper or wrong tenant. */
export function getBlob(ctx, key) {
  const file = path.join(blobRoot(ctx), key);
  const buf = fs.readFileSync(file);
  const d = crypto.createDecipheriv('aes-256-gcm', ctx.crypto.deriveKey(ctx.tenant.id, 'blob'), buf.slice(0, 12));
  d.setAuthTag(buf.slice(12, 28));
  return Buffer.concat([d.update(buf.slice(28)), d.final()]);
}

/** Absolute path of a stored blob (tests, ops). */
export const blobPath = (ctx, key) => path.join(blobRoot(ctx), key);
