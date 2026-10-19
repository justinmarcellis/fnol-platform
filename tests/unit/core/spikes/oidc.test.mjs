import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOidcVerifier, createStaticJwks, OidcError, OIDC_ERROR_CODES } from '../../../../src/core/oidc.mjs';

// Synthetic issuer and audience only. Keys are generated per run; nothing touches the network.
const ISS = 'https://idp.example.test';
const AUD = 'fnol-platform-test';
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);
const T0S = T0 / 1000;

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function genKey(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, publicKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } };
}
const K1 = genKey('k1');
const K2 = genKey('k2');

const baseClaims = (extra = {}) => ({
  iss: ISS, aud: AUD, sub: 'user-0001', tenantId: 'alpha', roles: ['adjuster'], iat: T0S - 10, exp: T0S + 300, ...extra,
});

function sign(claims, { key = K1, header = { alg: 'RS256', typ: 'JWT', kid: key.kid } } = {}) {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${crypto.sign('sha256', Buffer.from(input), key.privateKey).toString('base64url')}`;
}

function make({ keys = [K1.jwk], nowMs = T0, ...o } = {}) {
  const clock = { t: nowMs };
  const jwks = o.jwks ?? createStaticJwks(keys);
  const v = createOidcVerifier({ issuer: ISS, audience: AUD, jwks, clockSkewSec: 60, now: () => clock.t, ...o });
  return { v, jwks, clock };
}

async function rejects(p, code) {
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof OidcError, `expected OidcError, got ${e}`);
    assert.equal(e.code, code);
    assert.equal(e.status, 401);
    assert.ok(OIDC_ERROR_CODES.includes(e.code));
    return true;
  });
}

test('oidc: valid RS256 token resolves claims', async () => {
  const { v } = make();
  const c = await v.verify(sign(baseClaims()));
  assert.equal(c.sub, 'user-0001');
  assert.equal(c.tenantId, 'alpha');
  assert.deepEqual(c.roles, ['adjuster']);
});

test('oidc: issuer must match exactly', async () => {
  const { v } = make();
  await rejects(v.verify(sign(baseClaims({ iss: 'https://idp.example.test/' }))), 'bad_iss');
  await rejects(v.verify(sign(baseClaims({ iss: 'https://other.example.test' }))), 'bad_iss');
  await rejects(v.verify(sign(baseClaims({ iss: undefined }))), 'bad_iss');
});

test('oidc: audience as string or array', async () => {
  const { v } = make();
  assert.equal((await v.verify(sign(baseClaims({ aud: [AUD] })))).sub, 'user-0001');
  assert.equal((await v.verify(sign(baseClaims({ aud: ['other-client', AUD] })))).sub, 'user-0001');
  await rejects(v.verify(sign(baseClaims({ aud: 'other-client' }))), 'bad_aud');
  await rejects(v.verify(sign(baseClaims({ aud: ['other-client'] }))), 'bad_aud');
  await rejects(v.verify(sign(baseClaims({ aud: [] }))), 'bad_aud');
  await rejects(v.verify(sign(baseClaims({ aud: [AUD, 7] }))), 'bad_aud');
  await rejects(v.verify(sign(baseClaims({ aud: undefined }))), 'bad_aud');
});

test('oidc: exp required and enforced', async () => {
  const { v } = make();
  await rejects(v.verify(sign(baseClaims({ exp: undefined }))), 'bad_token');
  await rejects(v.verify(sign(baseClaims({ exp: '9999999999' }))), 'bad_token');
  await rejects(v.verify(sign(baseClaims({ exp: T0S - 3600 }))), 'expired');
});

test('oidc: nbf enforced', async () => {
  const { v } = make();
  await rejects(v.verify(sign(baseClaims({ nbf: T0S + 3600 }))), 'not_yet_valid');
  await rejects(v.verify(sign(baseClaims({ nbf: 'soon' }))), 'bad_token');
  assert.ok(await v.verify(sign(baseClaims({ nbf: T0S - 5 }))));
});

test('oidc: clock skew boundary for exp and nbf (60 s)', async () => {
  const { v, clock } = make();
  const exp = T0S;
  const tok = sign(baseClaims({ exp }));
  clock.t = (exp + 59) * 1000; assert.ok(await v.verify(tok), 'inside skew');
  clock.t = (exp + 60) * 1000 - 1; assert.ok(await v.verify(tok), '1 ms before boundary');
  clock.t = (exp + 60) * 1000; await rejects(v.verify(tok), 'expired');

  const nbf = T0S + 1000;
  const tok2 = sign(baseClaims({ nbf, exp: nbf + 600 }));
  clock.t = (nbf - 60) * 1000; assert.ok(await v.verify(tok2), 'nbf exactly at skew edge');
  clock.t = (nbf - 60) * 1000 - 1; await rejects(v.verify(tok2), 'not_yet_valid');

  const { v: strict, clock: c2 } = make({ clockSkewSec: 0 });
  c2.t = exp * 1000; await rejects(strict.verify(tok), 'expired');
  assert.throws(() => make({ clockSkewSec: 301 }), TypeError);
  assert.throws(() => make({ clockSkewSec: -1 }), TypeError);
});

/** Fake JWKS port whose refresh() swaps in the next key set; counts calls. */
function rotatingJwks(initial, next) {
  let keys = initial;
  return {
    calls: { get: 0, refresh: 0 },
    async getKeys() { this.calls.get += 1; return { keys }; },
    async refresh() { this.calls.refresh += 1; keys = next; },
  };
}

test('oidc: kid rotation triggers exactly one refresh, then cached', async () => {
  const jwks = rotatingJwks([K1.jwk], [K1.jwk, K2.jwk]);
  const { v } = make({ jwks });
  assert.ok(await v.verify(sign(baseClaims())));
  assert.equal(jwks.calls.refresh, 0, 'known kid never refreshes');
  const c = await v.verify(sign(baseClaims(), { key: K2 }));
  assert.equal(c.sub, 'user-0001');
  assert.equal(jwks.calls.refresh, 1);
  assert.ok(await v.verify(sign(baseClaims(), { key: K2 })));
  assert.equal(jwks.calls.refresh, 1, 'rotated key now in cache');
});

test('oidc: unknown kid refreshes at most once per verify and is rate limited', async () => {
  const jwks = createStaticJwks([K1.jwk]);
  const { v, clock } = make({ jwks, minRefreshIntervalMs: 60_000 });
  const stranger = genKey('k-unknown');
  const tok = sign(baseClaims(), { key: stranger });
  await rejects(v.verify(tok), 'unknown_kid');
  assert.equal(jwks.refreshCount, 1);
  await rejects(v.verify(tok), 'unknown_kid');
  await rejects(v.verify(tok), 'unknown_kid');
  assert.equal(jwks.refreshCount, 1, 'rate limited within interval');
  clock.t += 60_000;
  await rejects(v.verify(tok), 'unknown_kid');
  assert.equal(jwks.refreshCount, 2, 'allowed again after interval');
  await Promise.all([1, 2, 3].map(() => rejects(v.verify(tok), 'unknown_kid')));
  assert.equal(jwks.refreshCount, 2);
});

test('oidc: refresh failure keeps kid unknown, no leak', async () => {
  const jwks = { async getKeys() { return [K1.jwk]; }, async refresh() { throw new Error('network down'); } };
  const { v } = make({ jwks });
  await rejects(v.verify(sign(baseClaims(), { key: K2 })), 'unknown_kid');
  assert.ok(await v.verify(sign(baseClaims())));
});

test('oidc: key selection honours use, kty and alg', async () => {
  const encKey = { ...K1.jwk, use: 'enc' };
  await rejects(make({ keys: [encKey] }).v.verify(sign(baseClaims())), 'unknown_kid');
  const ps = { ...K1.jwk, alg: 'PS256' };
  await rejects(make({ keys: [ps] }).v.verify(sign(baseClaims())), 'unknown_kid');
  const noUse = { ...K1.jwk }; delete noUse.use; delete noUse.alg;
  assert.ok(await make({ keys: [noUse] }).v.verify(sign(baseClaims())));
  const oct = { kty: 'oct', kid: 'k1', k: 'c2VjcmV0' };
  await rejects(make({ keys: [oct] }).v.verify(sign(baseClaims())), 'unknown_kid');
  const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const smallKey = { kid: 'k-small', privateKey: small.privateKey, jwk: { ...small.publicKey.export({ format: 'jwk' }), kid: 'k-small' } };
  await rejects(make({ keys: [smallKey.jwk] }).v.verify(sign(baseClaims(), { key: smallKey })), 'unknown_kid');
});

test('oidc: tampered payload, header or signature fails', async () => {
  const { v } = make();
  const tok = sign(baseClaims());
  const [h, p, s] = tok.split('.');
  const elevated = b64(baseClaims({ roles: ['platform_admin'] }));
  await rejects(v.verify(`${h}.${elevated}.${s}`), 'bad_signature');
  const h2 = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1', x: 1 });
  await rejects(v.verify(`${h2}.${p}.${s}`), 'bad_signature');
  const sb = Buffer.from(s, 'base64url'); sb[10] ^= 1;
  await rejects(v.verify(`${h}.${p}.${sb.toString('base64url')}`), 'bad_signature');
  await rejects(v.verify(`${h}.${p}.${s.slice(0, -4)}`), 'bad_signature');
  // Signed by a different key under the same kid.
  await rejects(v.verify(sign(baseClaims(), { key: { ...K2, kid: 'k1' } })), 'bad_signature');
});

test('oidc: alg=none rejected', async () => {
  const { v } = make();
  const p = b64(baseClaims());
  await rejects(v.verify(`${b64({ alg: 'none', typ: 'JWT', kid: 'k1' })}.${p}.`), 'bad_alg');
  await rejects(v.verify(`${b64({ alg: 'none', kid: 'k1' })}.${p}.${b64('x')}`), 'bad_alg');
  await rejects(v.verify(`${b64({ alg: 'None', kid: 'k1' })}.${p}.`), 'bad_alg');
  await rejects(v.verify(`${b64({ typ: 'JWT', kid: 'k1' })}.${p}.`), 'bad_alg');
});

test('oidc: HS256 key confusion with the PEM public key is bad_alg', async () => {
  let touched = 0;
  const jwks = { async getKeys() { touched += 1; return [K1.jwk]; }, async refresh() { touched += 1; } };
  const { v } = make({ jwks });
  const pem = K1.publicKey.export({ type: 'spki', format: 'pem' });
  const input = `${b64({ alg: 'HS256', typ: 'JWT', kid: 'k1' })}.${b64(baseClaims({ roles: ['platform_admin'] }))}`;
  const mac = crypto.createHmac('sha256', pem).update(input).digest('base64url');
  await rejects(v.verify(`${input}.${mac}`), 'bad_alg');
  const jwkMac = crypto.createHmac('sha256', JSON.stringify(K1.jwk)).update(input).digest('base64url');
  await rejects(v.verify(`${input}.${jwkMac}`), 'bad_alg');
  assert.equal(touched, 0, 'no key lookup before the alg check');
});

test('oidc: RS256 only (RS384/RS512/PS256/ES256 rejected even if correctly signed)', async () => {
  const { v } = make();
  const claims = b64(baseClaims());
  for (const [alg, hash, padding] of [['RS384', 'sha384'], ['RS512', 'sha512'], ['PS256', 'sha256', crypto.constants.RSA_PKCS1_PSS_PADDING]]) {
    const input = `${b64({ alg, kid: 'k1' })}.${claims}`;
    const sig = crypto.sign(hash, Buffer.from(input), padding ? { key: K1.privateKey, padding } : K1.privateKey).toString('base64url');
    await rejects(v.verify(`${input}.${sig}`), 'bad_alg');
  }
  for (const alg of ['ES256', 'EdDSA', 'rs256', ' RS256', ['RS256'], null]) {
    await rejects(v.verify(`${b64({ alg, kid: 'k1' })}.${claims}.${b64('sig')}`), 'bad_alg');
  }
});

test('oidc: missing or invalid kid is bad_token', async () => {
  const { v, jwks } = make();
  await rejects(v.verify(sign(baseClaims(), { header: { alg: 'RS256', typ: 'JWT' } })), 'bad_token');
  await rejects(v.verify(sign(baseClaims(), { header: { alg: 'RS256', kid: '' } })), 'bad_token');
  await rejects(v.verify(sign(baseClaims(), { header: { alg: 'RS256', kid: 7 } })), 'bad_token');
  await rejects(v.verify(sign(baseClaims(), { header: { alg: 'RS256', kid: 'k1', crit: ['exp'] } })), 'bad_token');
  assert.equal(jwks.refreshCount, 0);
});

test('oidc: malformed tokens are bad_token', async () => {
  const { v } = make();
  const good = sign(baseClaims());
  const [h, p, s] = good.split('.');
  const cases = [
    undefined, null, 42, '', 'garbage', 'a.b', `${h}.${p}`, `${h}.${p}.${s}.x`, `${h}..${s}`, `.${p}.${s}`,
    `${h}.${p}.`, `${h}.${p}.${s}=`, `${h}.${p}+.${s}`, `${b64('not json')}.${p}.${s}`,
    `${b64('[1,2]')}.${p}.${s}`, `${b64('null')}.${p}.${s}`, `${h}.${b64('"str"')}.${s}`, `${h}.${b64('{bad')}.${s}`,
    `${h}.A.${s}`, `${'A'.repeat(9000)}.${p}.${s}`,
  ];
  for (const t of cases) await rejects(v.verify(t), 'bad_token');
  const big = sign(baseClaims({ pad: 'x'.repeat(10_000) }));
  await rejects(v.verify(big), 'bad_token');
});

test('oidc: error messages never contain token contents', async () => {
  const { v } = make();
  const secretSub = 'synthetic-subject-should-not-leak';
  const tokens = [
    sign(baseClaims({ sub: secretSub, iss: 'https://evil.example.test' })),
    sign(baseClaims({ sub: secretSub, aud: 'evil-client' })),
    sign(baseClaims({ sub: secretSub, exp: 1 })),
    sign(baseClaims({ sub: secretSub }), { key: genKey('kid-should-not-leak') }),
    `${b64({ alg: 'HS256', kid: 'kid-should-not-leak' })}.${b64(baseClaims({ sub: secretSub }))}.${b64('x')}`,
  ];
  for (const t of tokens) {
    await assert.rejects(v.verify(t), (e) => {
      const text = `${e.message} ${e.stack} ${JSON.stringify(e)}`;
      assert.ok(!text.includes(secretSub) && !text.includes('evil') && !text.includes('kid-should-not-leak'), e.code);
      return e instanceof OidcError;
    });
  }
});

test('oidc: constructor validates config', () => {
  const jwks = createStaticJwks([K1.jwk]);
  assert.throws(() => createOidcVerifier({ audience: AUD, jwks }), TypeError);
  assert.throws(() => createOidcVerifier({ issuer: ISS, jwks }), TypeError);
  assert.throws(() => createOidcVerifier({ issuer: ISS, audience: AUD }), TypeError);
  assert.throws(() => createOidcVerifier({ issuer: ISS, audience: AUD, jwks: { getKeys() {} } }), TypeError);
  assert.equal(new OidcError('weird').code, 'bad_token');
});

test('oidc: spike is not wired into src/ and auth.mjs is untouched', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../src');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(d, e.name);
    return e.isDirectory() ? walk(f) : /\.(mjs|js)$/.test(e.name) ? [f] : [];
  });
  const importers = walk(root).filter((f) => !f.endsWith(`${path.sep}oidc.mjs`) && /from\s+['"][^'"]*oidc(\.mjs)?['"]|import\(\s*['"][^'"]*oidc/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(importers, []);
  const auth = fs.readFileSync(path.join(root, 'core/auth.mjs'), 'utf8');
  assert.ok(!/oidc|jwks|RS256/i.test(auth));
});
