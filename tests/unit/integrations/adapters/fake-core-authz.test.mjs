// S3-INT-02: fake-core receiver authz (SEC2-003), PII redaction in the listing and the POST body cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { bootIntegrations, MODULE_SRC } from '../webhooks/helpers.mjs';
import { call } from '../../core/helpers.mjs';
import { redactCorePayload, FAKE_CORE_MAX_BODY_BYTES } from '../../../../src/modules/integrations/adapters/fake-core.mjs';

const URL_ = '/api/v1/integrations/fake-core/claims';
const adaptersSource = `export * from ${JSON.stringify(pathToFileURL(path.join(MODULE_SRC, 'adapters/index.mjs')).href)};`;
const PAYLOAD = {
  CLAIM_REF: 'CLM-1',
  LOSS_DESC: 'Rear-ended at the lights',
  PARTY_1_FIRST_NAME: 'Avery',
  PARTY_1_EMAIL: 'avery@example.test',
  PARTY_1_CITY: 'Springfield',
};

async function boot() {
  const app = await bootIntegrations({ adaptersSource });
  // Let the async route registration from the adapter service finish.
  await new Promise((r) => setTimeout(r, 50));
  const tok = (roles, tenant = 'alpha') => app.ctx.auth.issueToken({ sub: 'u1', tenantId: tenant, roles });
  const post = (roles, body = PAYLOAD) => call(app, 'POST', URL_, { token: tok(roles), body });
  const get = (roles, tenant = 'alpha') => call(app, 'GET', URL_, { token: tok(roles, tenant) });
  return { app, tok, post, get };
}

test('GET listing: only tenant_admin, carrier_admin and supervisor; every other role gets 403', async () => {
  const { app, post, get } = await boot();
  try {
    assert.equal((await post(['integration'])).status, 201);
    for (const role of ['integration', 'auditor', 'csr', 'adjuster', 'claimant']) {
      assert.equal((await get([role])).status, 403, role);
    }
    for (const role of ['tenant_admin', 'carrier_admin', 'supervisor']) {
      assert.equal((await get([role])).status, 200, role);
    }
    assert.equal((await call(app, 'GET', URL_)).status, 401);
  } finally { await app.close(); }
});

test('GET listing applies claims PII redaction for roles that are redacted on /claims', async () => {
  const { app, post, get } = await boot();
  try {
    await post(['integration']);
    const admin = await get(['tenant_admin']);
    const p = admin.json.items[0].payload;
    assert.equal(p.LOSS_DESC, '[redacted]');
    assert.equal(p.PARTY_1_FIRST_NAME, '[redacted]');
    assert.equal(p.PARTY_1_EMAIL, '[redacted]');
    assert.equal(p.PARTY_1_CITY, 'Springfield');
    assert.ok(!admin.text.includes('avery@example.test'));
    const sup = await get(['supervisor']);
    assert.equal(sup.json.items[0].payload.PARTY_1_EMAIL, 'avery@example.test');
  } finally { await app.close(); }
});

test('POST stays tenant scoped and role limited', async () => {
  const { app, post, get } = await boot();
  try {
    assert.equal((await post(['auditor'])).status, 403);
    assert.equal((await post(['supervisor'])).status, 403);
    assert.equal((await post(['integration'])).status, 201);
    assert.equal((await get(['supervisor'], 'beta')).json.items.length, 0);
  } finally { await app.close(); }
});

test('POST body cap is 256 KiB (well under the 15 MB platform limit) and returns 413', async () => {
  assert.ok(FAKE_CORE_MAX_BODY_BYTES <= 1024 * 1024);
  const { app, post } = await boot();
  try {
    const big = { CLAIM_REF: 'CLM-BIG', pad: 'x'.repeat(FAKE_CORE_MAX_BODY_BYTES + 10) };
    const r = await post(['integration'], big);
    assert.equal(r.status, 413);
    assert.equal(r.json.error.code, 'payload_too_large');
    const ok = await post(['integration'], { CLAIM_REF: 'CLM-OK', pad: 'x'.repeat(10000) });
    assert.equal(ok.status, 201);
  } finally { await app.close(); }
});

test('redactCorePayload handles profile A nesting and leaves non-PII alone', () => {
  const out = redactCorePayload({ claimsNotificationAddRq: { claimsParty: [{ generalPartyInfo: { nameInfo: { personName: { givenName: 'A', surname: 'B' } }, addr: { addr1: '1 Main', city: 'X' }, communicationsInfo: { emailAddr: 'a@b.test' } } }] } });
  const g = out.claimsNotificationAddRq.claimsParty[0].generalPartyInfo;
  assert.deepEqual(g.nameInfo.personName, { givenName: '[redacted]', surname: '[redacted]' });
  assert.deepEqual(g.addr, { addr1: '[redacted]', city: 'X' });
  assert.equal(g.communicationsInfo.emailAddr, '[redacted]');
});
