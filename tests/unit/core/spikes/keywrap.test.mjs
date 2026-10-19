import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCrypto } from '../../../../src/core/crypto.mjs';
import {
  createFakeKms, createCloudKmsRest, encryptV2, decryptV2, decryptAny, keyIdOf, isV2, KeywrapError,
} from '../../../../src/core/keywrap.mjs';

const SECRET = 'Jane Q. Example, 12 Sample Road';
const KEY_NAME = 'projects/example-project/locations/global/keyRings/example/cryptoKeys/master';
const rejectsCode = (p, code) => assert.rejects(p, (e) => e instanceof KeywrapError && e.code === code);

test('round trip, null passthrough, unicode and empty', async () => {
  const kms = createFakeKms();
  for (const s of [SECRET, '', 'naïve ☂ 日本']) {
    assert.equal(await decryptV2(await encryptV2(s, { kms }), { kms }), s);
  }
  assert.equal(await encryptV2(null, { kms }), null);
  assert.equal(await encryptV2(undefined, { kms }), undefined);
});

test('envelope shape and no plaintext inside', async () => {
  const kms = createFakeKms();
  const v = await encryptV2(SECRET, { kms });
  assert.ok(isV2(v));
  const parts = v.slice('enc:v2:'.length).split(':');
  assert.equal(parts.length, 5);
  assert.equal(Buffer.from(parts[0], 'base64url').toString(), 'fake-key-v1');
  assert.equal(keyIdOf(v), 'fake-key-v1');
  assert.equal(Buffer.from(parts[2], 'base64url').length, 12);
  assert.equal(Buffer.from(parts[3], 'base64url').length, 16);
  assert.ok(!v.includes(SECRET));
  for (const p of parts) assert.ok(!Buffer.from(p, 'base64url').toString('latin1').includes('Jane'));
});

test('fresh DEK and IV per value, and the DEK is zeroed after use', async () => {
  const seen = [];
  const inner = createFakeKms();
  const kms = { wrapKey: async (dek) => { seen.push(dek); return inner.wrapKey(dek); }, unwrapKey: (a) => inner.unwrapKey(a) };
  const a = await encryptV2(SECRET, { kms });
  const b = await encryptV2(SECRET, { kms });
  const pa = a.split(':'); const pb = b.split(':');
  assert.notEqual(pa[3], pb[3]); // wrapped DEK
  assert.notEqual(pa[4], pb[4]); // iv
  assert.notEqual(pa[6], pb[6]); // ct
  assert.equal(seen.length, 2);
  for (const d of seen) assert.ok(d.every((x) => x === 0));
});

test('tamper in any part fails closed', async () => {
  const kms = createFakeKms();
  const v = await encryptV2(SECRET, { kms });
  const head = 'enc:v2';
  const parts = v.split(':').slice(2);
  const flip = (p) => {
    const b = Buffer.from(p, 'base64url');
    b[0] ^= 1;
    return b.toString('base64url');
  };
  for (let i = 1; i < 5; i++) { // wrappedDek, iv, tag, ct (keyId covered below)
    const t = parts.slice(); t[i] = flip(t[i]);
    await assert.rejects(decryptV2(`${head}:${t.join(':')}`, { kms }), KeywrapError, `part ${i}`);
  }
});

test('malformed envelopes are rejected strictly', async () => {
  const kms = createFakeKms();
  const v = await encryptV2(SECRET, { kms });
  const parts = v.split(':');
  const bads = [
    'enc:v2:', 'enc:v2:a:b:c:d', `${v}:extra`, v.replace(/.$/, '='), `${v}!`, 'enc:v2::::: ',
    ['enc', 'v2', parts[2], parts[3], parts[4].slice(0, -2), parts[5], parts[6]].join(':'), // short iv
    ['enc', 'v2', '', parts[3], parts[4], parts[5], parts[6]].join(':'), // empty key id
  ];
  for (const b of bads) await rejectsCode(decryptV2(b, { kms }), 'malformed');
  await rejectsCode(decryptV2(123, { kms }), 'malformed');
});

test('wrong or swapped key id fails (AAD and KMS binding)', async () => {
  const kms = createFakeKms({ keyIds: ['k1', 'k2'], active: 'k1' });
  const v = await encryptV2(SECRET, { kms });
  const p = v.split(':');
  p[2] = Buffer.from('k2').toString('base64url');
  await assert.rejects(decryptV2(p.join(':'), { kms }), KeywrapError); // k2 cannot unwrap a k1 wrap
  p[2] = Buffer.from('nope').toString('base64url');
  await rejectsCode(decryptV2(p.join(':'), { kms }), 'kms_unwrap_failed');

  // A KMS that ignores key id still cannot be used to relabel: AAD binds the key id to the data.
  const key = createFakeKms({ keyIds: ['k1'] });
  const lax = { wrapKey: (d) => key.wrapKey(d), unwrapKey: ({ wrapped }) => key.unwrapKey({ keyId: 'k1', wrapped }) };
  const w = await encryptV2(SECRET, { kms: lax });
  const q = w.split(':');
  q[2] = Buffer.from('other').toString('base64url');
  await rejectsCode(decryptV2(q.join(':'), { kms: lax }), 'auth_failed');
});

test('rotation: old envelopes still decrypt, new ones use the new key, disabled key fails', async () => {
  const kms = createFakeKms({ keyIds: ['k1'] });
  const old = await encryptV2('old', { kms });
  kms.rotate('k2');
  const fresh = await encryptV2('new', { kms });
  assert.equal(keyIdOf(old), 'k1');
  assert.equal(keyIdOf(fresh), 'k2');
  assert.equal(await decryptV2(old, { kms }), 'old');
  assert.equal(await decryptV2(fresh, { kms }), 'new');
  kms.disable('k1');
  await rejectsCode(decryptV2(old, { kms }), 'kms_unwrap_failed');
  assert.equal(await decryptV2(fresh, { kms }), 'new');
});

test('KMS failure on encrypt or decrypt fails closed without leaking plaintext', async () => {
  const boom = { wrapKey: async () => { throw new Error('down'); }, unwrapKey: async () => { throw new Error('down'); } };
  await assert.rejects(encryptV2(SECRET, { kms: boom }), (e) => !String(e.message).includes('Jane'));
  const v = await encryptV2(SECRET, { kms: createFakeKms() });
  await assert.rejects(decryptV2(v, { kms: boom }), /down/);
  await rejectsCode(encryptV2('x', { kms: {} }), 'bad_kms');
  const badDek = { wrapKey: async () => ({ keyId: 'a', wrapped: Buffer.from('w') }), unwrapKey: async () => Buffer.alloc(16) };
  await rejectsCode(decryptV2(await encryptV2('x', { kms: badDek }), { kms: badDek }), 'kms_error');
});

test('decryptAny handles v1 (real crypto.mjs), v2 and plain values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keywrap-test-'));
  try {
    const c = createCrypto({ secretsDir: dir });
    const kms = createFakeKms();
    const v1 = c.encryptPii('tenant-a', SECRET);
    assert.ok(v1.startsWith('enc:v1:'));
    const v1Decrypt = (v) => c.decryptPii('tenant-a', v);
    assert.equal(await decryptAny(v1, { v1Decrypt, kms }), SECRET);
    assert.equal(await decryptAny(await encryptV2(SECRET, { kms }), { v1Decrypt, kms }), SECRET);
    assert.equal(await decryptAny('plain', { v1Decrypt, kms }), 'plain');
    assert.equal(await decryptAny(null, { v1Decrypt, kms }), null);
    await rejectsCode(decryptAny(v1, { kms }), 'bad_config');
    // crypto.mjs does not know v2 and leaves it alone (no migration, no behaviour change).
    assert.equal(c.isEncrypted(await encryptV2('x', { kms })), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Cloud KMS REST adapter with fakes only (no network) ----

function fakeKmsServer({ version = 1 } = {}) {
  const requests = [];
  const name = `${KEY_NAME}/cryptoKeyVersions/${version}`;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, init, body });
    if (url.endsWith(':encrypt')) {
      // Fake "encryption": reverse bytes; enough to prove the round trip and base64 handling.
      const pt = Buffer.from(body.plaintext, 'base64');
      return { ok: true, status: 200, json: async () => ({ name, ciphertext: Buffer.from(pt).reverse().toString('base64') }) };
    }
    if (url.endsWith(':decrypt')) {
      const ct = Buffer.from(body.ciphertext, 'base64');
      return { ok: true, status: 200, json: async () => ({ plaintext: Buffer.from(ct).reverse().toString('base64') }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, requests, name };
}

test('REST adapter: request shape, bearer token, round trip', async () => {
  const srv = fakeKmsServer({ version: 3 });
  const kms = createCloudKmsRest({ tokenProvider: async () => 'fake-token', keyName: KEY_NAME, fetch: srv.fetch });
  const v = await encryptV2(SECRET, { kms });
  const enc = srv.requests[0];
  assert.equal(enc.url, `https://cloudkms.googleapis.com/v1/${KEY_NAME}:encrypt`);
  assert.equal(enc.init.method, 'POST');
  assert.equal(enc.init.headers.authorization, 'Bearer fake-token');
  assert.deepEqual(Object.keys(enc.body), ['plaintext']);
  assert.equal(Buffer.from(enc.body.plaintext, 'base64').length, 32); // only the DEK goes to KMS
  assert.equal(keyIdOf(v), `${KEY_NAME}/cryptoKeyVersions/3`);
  assert.equal(await decryptV2(v, { kms }), SECRET);
  const dec = srv.requests[1];
  assert.equal(dec.url, `https://cloudkms.googleapis.com/v1/${KEY_NAME}:decrypt`);
  assert.deepEqual(Object.keys(dec.body), ['ciphertext']);
  assert.ok(!JSON.stringify(srv.requests).includes(SECRET)); // data never leaves the process
});

test('REST adapter fails closed: HTTP errors, network errors, token errors, foreign key, bad responses', async () => {
  const mk = (fetch, tokenProvider = async () => 't') => createCloudKmsRest({ tokenProvider, keyName: KEY_NAME, fetch });
  const secretBody = { ok: false, status: 403, json: async () => ({ error: 'leak-me-not' }) };
  await assert.rejects(encryptV2('x', { kms: mk(async () => secretBody) }), (e) => e.code === 'kms_error' && /403/.test(e.message) && !/leak-me-not/.test(e.message));
  await rejectsCode(encryptV2('x', { kms: mk(async () => { throw new Error('ECONNRESET'); }) }), 'kms_unavailable');
  await rejectsCode(encryptV2('x', { kms: mk(fakeKmsServer().fetch, async () => { throw new Error('no creds'); }) }), 'kms_auth_failed');
  await rejectsCode(encryptV2('x', { kms: mk(fakeKmsServer().fetch, async () => '') }), 'kms_auth_failed');
  await rejectsCode(encryptV2('x', { kms: mk(async () => ({ ok: true, status: 200, json: async () => ({ ciphertext: 'AA==', name: 'projects/other/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1' }) })) }), 'kms_error');
  await rejectsCode(encryptV2('x', { kms: mk(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })) }), 'kms_error');

  const srv = fakeKmsServer();
  const kms = mk(srv.fetch);
  const v = await encryptV2('x', { kms });
  const foreign = v.split(':');
  foreign[2] = Buffer.from('projects/other/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1').toString('base64url');
  const before = srv.requests.length;
  await rejectsCode(decryptV2(foreign.join(':'), { kms }), 'key_id_mismatch');
  assert.equal(srv.requests.length, before); // nothing sent to KMS for a foreign key id
  await rejectsCode(decryptV2(v, { kms: mk(async () => ({ ok: true, status: 200, json: async () => ({ plaintext: Buffer.alloc(8).toString('base64') }) })) }), 'kms_error');
});

test('REST adapter validates config', () => {
  assert.throws(() => createCloudKmsRest({ keyName: KEY_NAME, fetch: async () => {} }), KeywrapError);
  assert.throws(() => createCloudKmsRest({ tokenProvider: async () => 't', keyName: 'bad', fetch: async () => {} }), KeywrapError);
});

test('error messages never contain plaintext or key material', async () => {
  const kms = createFakeKms();
  const v = await encryptV2(SECRET, { kms });
  const p = v.split(':'); p[6] = Buffer.from('zz').toString('base64url');
  try { await decryptV2(p.join(':'), { kms }); assert.fail('should throw'); } catch (e) {
    assert.ok(!e.message.includes('Jane'));
    assert.ok(!e.message.includes(p[3]));
  }
});
