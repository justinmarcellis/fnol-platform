// Boots the platform against the real demo tenants and exercises /api/v1/config end to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, call } from '../core/helpers.mjs';

const tenantsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tenants');
let app;
let admin;
before(async () => {
  app = await bootApp({ tenantsDir });
  admin = app.token(['carrier_admin'], 'aurelia-mutual', 'admin1');
});
after(async () => { await app.close(); });

test('GET /config returns the seeded config with an ETag', async () => {
  const r = await call(app, 'GET', '/api/v1/config', { token: admin });
  assert.equal(r.status, 200);
  assert.equal(r.json.tenantId, 'aurelia-mutual');
  assert.equal(r.json.version, 1);
});

test('GET /config enforces roles', async () => {
  const csr = app.token(['csr'], 'aurelia-mutual');
  assert.equal((await call(app, 'GET', '/api/v1/config', { token: csr })).status, 403);
  assert.equal((await call(app, 'GET', '/api/v1/config')).status, 401);
});

test('GET /config/public hides rules and is available to csr', async () => {
  const r = await call(app, 'GET', '/api/v1/config/public', { token: app.token(['csr'], 'aurelia-mutual') });
  assert.equal(r.status, 200);
  assert.equal(r.json.tenantId, 'aurelia-mutual');
  assert.equal(r.json.rules, undefined);
  assert.deepEqual(r.json.locales, ['en', 'es']);
});

test('each tenant sees only its own config', async () => {
  const r = await call(app, 'GET', '/api/v1/config', { token: app.token(['carrier_admin'], 'kestrel-point') });
  assert.equal(r.json.tenantId, 'kestrel-point');
});

test('POST /config/validate returns a report; bad docs are valid:false', async () => {
  const cur = (await call(app, 'GET', '/api/v1/config', { token: admin })).json;
  const good = await call(app, 'POST', '/api/v1/config/validate', { token: admin, body: cur });
  assert.equal(good.status, 200);
  assert.equal(good.json.valid, true);
  const bad = await call(app, 'POST', '/api/v1/config/validate', { token: admin, body: { ...cur, queues: [] } });
  assert.equal(bad.json.valid, false);
  assert.ok(bad.json.errors.length > 0);
});

test('PUT /config: 409 on stale If-Match, 422 on invalid, 403 on tenant mismatch', async () => {
  const cur = (await call(app, 'GET', '/api/v1/config', { token: admin })).json;
  const stale = await call(app, 'PUT', '/api/v1/config', { token: admin, body: cur, headers: { 'if-match': '"99"' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'version_conflict');
  const invalid = await call(app, 'PUT', '/api/v1/config', { token: admin, body: { ...cur, queues: [] }, headers: { 'if-match': '"1"' } });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.json.valid, false);
  const other = await call(app, 'PUT', '/api/v1/config', { token: admin, body: { ...cur, tenantId: 'kestrel-point' } });
  assert.equal(other.status, 403);
  const csr = await call(app, 'PUT', '/api/v1/config', { token: app.token(['csr'], 'aurelia-mutual'), body: cur });
  assert.equal(csr.status, 403);
});

test('PUT /config saves a new version, audits, publishes tenant.config.updated and refreshes reads', async () => {
  const cur = (await call(app, 'GET', '/api/v1/config', { token: admin })).json;
  const events = [];
  app.ctx.bus.on('tenant.config.updated', (e) => { events.push(e); }, { name: 'test:config.updated' });
  const next = structuredClone(cur);
  next.branding.primaryColor = '#112233';
  const put = await call(app, 'PUT', '/api/v1/config', { token: admin, body: next, headers: { 'if-match': '"1"' } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.version, 2);
  assert.equal(put.json.updatedBy, 'admin1');
  assert.equal(put.json.branding.primaryColor, '#112233');

  await app.ctx.bus.drain();
  assert.equal(events.length, 1);
  assert.equal(events[0].tenantid, 'aurelia-mutual');
  assert.equal(events[0].data.version, 2);
  assert.equal(events[0].data.previousVersion, 1);
  assert.deepEqual(events[0].data.changedSections, ['branding']);

  const audit = app.ctx.audit.list('aurelia-mutual', { action: 'tenant.config.updated' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, 'admin1');

  const again = await call(app, 'GET', '/api/v1/config/public', { token: admin });
  assert.equal(again.json.branding.primaryColor, '#112233');

  // identical content: no new version, no new event
  const same = await call(app, 'PUT', '/api/v1/config', { token: admin, body: put.json, headers: { 'if-match': '"2"' } });
  assert.equal(same.status, 200);
  assert.equal(same.json.version, 2);
});

test('the registered validator rejects invalid full configs at ctx.tenants.put but tolerates stubs', () => {
  assert.throws(() => app.ctx.tenants.put('aurelia-mutual', { tenantId: 'aurelia-mutual', version: 9 }, 't'), /invalid_tenant_config|required/);
  assert.doesNotThrow(() => app.ctx.tenants.put('stub-tenant', { id: 'stub-tenant', displayName: 'Stub' }, 't'));
});
