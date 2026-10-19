import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCrypto } from '../../../src/core/crypto.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-crypto-'));

test('crypto: roundtrip, format, random iv', () => {
  const c = createCrypto({ secretsDir: tmp() });
  const ct = c.encryptPii('alpha', 'Jane Q. Public');
  assert.match(ct, /^enc:v1:[\w-]+:[\w-]+:[\w-]*$/);
  assert.equal(c.decryptPii('alpha', ct), 'Jane Q. Public');
  assert.notEqual(ct, c.encryptPii('alpha', 'Jane Q. Public'));
  assert.equal(c.encryptPii('alpha', null), null);
  assert.equal(c.decryptPii('alpha', 'plain'), 'plain');
});

test('crypto: per-tenant keys differ; wrong tenant and tampering fail', () => {
  const c = createCrypto({ secretsDir: tmp() });
  assert.notDeepEqual(c.deriveKey('alpha', 'pii'), c.deriveKey('beta', 'pii'));
  const ct = c.encryptPii('alpha', 'secret');
  assert.throws(() => c.decryptPii('beta', ct));
  const parts = ct.split(':');
  parts[4] = Buffer.from('tampered!').toString('base64url');
  assert.throws(() => c.decryptPii('alpha', parts.join(':')));
});

test('crypto: blind index is deterministic, normalized, tenant-specific', () => {
  const c = createCrypto({ secretsDir: tmp() });
  assert.equal(c.hmacIndex('alpha', ' Jane@Example.test '), c.hmacIndex('alpha', 'jane@example.test'));
  assert.notEqual(c.hmacIndex('alpha', 'x'), c.hmacIndex('beta', 'x'));
  assert.match(c.hmacIndex('alpha', 'x'), /^[0-9a-f]{64}$/);
});

test('crypto: master key created 0600, 32 bytes, and reused', () => {
  const dir = path.join(tmp(), 'nested');
  const a = createCrypto({ secretsDir: dir });
  const file = path.join(dir, 'master.key');
  assert.equal(fs.statSync(file).size, 32);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const ct = a.encryptPii('t', 'v');
  assert.equal(createCrypto({ secretsDir: dir }).decryptPii('t', ct), 'v');
});
