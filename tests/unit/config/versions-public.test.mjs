// S6-BUG-04 regressions: GET /config/versions (ADMIN-1, DATA-8, ADMIN-2), channel-aware public config (CLAIMANT-2)
// and placeholder-question validation (ADMIN-9). Boots the platform against the real demo tenants.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, call } from '../core/helpers.mjs';
import { channelForCaller, humanizeActor, validateTenantConfig, changedKeys } from '../../../src/modules/config/index.mjs';

const tenantsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tenants');
let app;
before(async () => { app = await bootApp({ tenantsDir }); });
after(async () => { await app.close(); });

const named = (roles, tenantId, sub, name) => app.ctx.auth.issueToken({ sub, tenantId, roles, name });

test('GET /config/versions lists the seeded version 1 on a fresh tenant (no 404)', async () => {
  const admin = named(['carrier_admin'], 'kestrel-point', 'dev-kestrel-point-carrier-admin', 'Taylor Brandt');
  const r = await call(app, 'GET', '/api/v1/config/versions', { token: admin });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.items.map((i) => i.version), [1]);
  assert.equal(r.json.items[0].source, 'tenant_file');
  assert.equal(r.json.items[0].actorName, 'System (tenant file)');
  assert.ok(r.json.items[0].createdAt);
});

test('GET /config/versions enforces roles', async () => {
  assert.equal((await call(app, 'GET', '/api/v1/config/versions', { token: app.token(['claimant'], 'kestrel-point') })).status, 403);
  assert.equal((await call(app, 'GET', '/api/v1/config/versions')).status, 401);
});

test('a console save is listed with the saver name and the readable changed keys', async () => {
  const admin = named(['carrier_admin'], 'aurelia-mutual', 'dev-aurelia-mutual-carrier-admin', 'Taylor Brandt');
  const cur = await call(app, 'GET', '/api/v1/config', { token: admin });
  const body = { ...cur.json, displayName: `${cur.json.displayName} Test`, branding: { ...cur.json.branding, primaryColor: '#123456' } };
  const put = await call(app, 'PUT', '/api/v1/config', { token: admin, body, headers: { 'if-match': `"${cur.json.version}"` } });
  assert.equal(put.status, 200, put.text);
  const r = await call(app, 'GET', '/api/v1/config/versions', { token: admin });
  assert.deepEqual(r.json.items.map((i) => i.version), [2, 1], 'version 1 is still listed after saves');
  assert.equal(r.json.items[0].actorName, 'Taylor Brandt');
  assert.deepEqual(r.json.items[0].changedKeys, ['branding', 'displayName']);
  assert.equal(r.json.items[0].source, 'console');
});

test('GET /config/public marks lines a claimant cannot use on the web (Kestrel)', async () => {
  const claimant = app.token(['claimant'], 'kestrel-point');
  const r = await call(app, 'GET', '/api/v1/config/public', { token: claimant });
  assert.equal(r.status, 200);
  assert.equal(r.json.channel, 'claimant_web');
  // S6-BUG-05 opened claimant_web for Kestrel personal auto (demo blocker CLAIMANT-1); commercial auto stays phone/API only.
  assert.deepEqual(r.json.availableLobs, ['personal_auto'], 'Kestrel takes commercial auto by phone and API only');
  // The lob list itself still mirrors the tenant (contract shape unchanged).
  assert.deepEqual(r.json.lobs.map((l) => l.id).sort(), ['commercial_auto', 'personal_auto']);
  const csr = await call(app, 'GET', '/api/v1/config/public', { token: app.token(['csr'], 'kestrel-point') });
  assert.deepEqual(csr.json.availableLobs.sort(), ['commercial_auto', 'personal_auto']);
  const aur = await call(app, 'GET', '/api/v1/config/public', { token: app.token(['claimant'], 'aurelia-mutual') });
  assert.deepEqual(aur.json.availableLobs.sort(), ['homeowners', 'personal_auto']);
  const api = await call(app, 'GET', '/api/v1/config/public?channel=api', { token: claimant });
  assert.equal(api.json.channel, 'api');
  assert.deepEqual(api.json.availableLobs.sort(), ['commercial_auto', 'personal_auto']);
});

test('channelForCaller and humanizeActor', () => {
  assert.equal(channelForCaller(['claimant']), 'claimant_web');
  assert.equal(channelForCaller(['claimant'], 'claimant_mobile'), 'claimant_mobile');
  assert.equal(channelForCaller(['claimant'], 'bogus'), 'claimant_web');
  assert.equal(channelForCaller(['carrier_admin']), null);
  assert.equal(humanizeActor('dev-aurelia-mutual-carrier-admin'), 'Carrier admin');
  assert.equal(humanizeActor(''), 'Unknown');
  assert.deepEqual(changedKeys({ a: 1, version: 1 }, { a: 2, version: 2, b: 1 }), ['a', 'b']);
});

test('a placeholder or empty question fails validation; a missing translation warns', async () => {
  const admin = named(['carrier_admin'], 'aurelia-mutual', 'a1', 'A');
  const cfg = (await call(app, 'GET', '/api/v1/config', { token: admin })).json;
  const qs = cfg.questionSets[0].questions;
  qs.push({ id: 'question_11', text: 'New question', type: 'text', required: false });
  let rep = validateTenantConfig(cfg);
  assert.equal(rep.valid, false);
  assert.ok(rep.errors.some((e) => e.code === 'placeholder_text' && e.path.endsWith(`/questions/${qs.length - 1}/text`)), JSON.stringify(rep.errors));
  qs[qs.length - 1].text = '';
  rep = validateTenantConfig(cfg);
  assert.ok(rep.errors.some((e) => e.code === 'missing_text'));
  qs[qs.length - 1].text = 'Was anyone hurt?';
  rep = validateTenantConfig(cfg);
  assert.ok(!rep.errors.some((e) => /text$/.test(e.path)), 'real text clears the error');
  assert.ok(rep.warnings.some((w) => w.path.endsWith(`/questions/${qs.length - 1}/text`) && /es/.test(w.message)), 'Aurelia offers Spanish');
});
