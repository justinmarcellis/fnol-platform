import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootApp, call } from './helpers.mjs';
import { createLogger, redact } from '../../../src/core/log.mjs';
import { createClock } from '../../../src/core/clock.mjs';

test('server: boots, /healthz lists modules and tenants', async () => {
  const app = await bootApp();
  try {
    const r = await call(app, 'GET', '/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(r.json.modules.includes('health'));
    assert.equal(r.json.tenants, 2);
  } finally { await app.close(); }
});

test('server: loads modules (migrations, routes, subscriptions) and serves static apps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-mods-'));
  const mods = path.join(dir, 'mods');
  const web = path.join(dir, 'web');
  fs.mkdirSync(path.join(mods, 'zeta'), { recursive: true });
  fs.mkdirSync(path.join(web, 'claimant'), { recursive: true });
  fs.mkdirSync(path.join(web, 'csr'), { recursive: true });
  fs.writeFileSync(path.join(web, 'claimant', 'index.html'), '<h1>claimant</h1>');
  fs.writeFileSync(path.join(web, 'claimant', 'app.js'), 'export {}');
  fs.writeFileSync(path.join(web, 'csr', 'index.html'), '<h1>csr</h1>');
  fs.writeFileSync(path.join(mods, 'zeta', 'index.mjs'), `
export default {
  name: 'zeta',
  migrations: [{ sql: 'CREATE TABLE zs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, v TEXT)', tenantTables: ['zs'] }],
  routes(router, ctx) {
    router.post('/api/v1/zs', (req, res) => {
      const row = ctx.db.forTenant(req.tenant.id).insert('zs', { id: ctx.db.id('zs'), v: req.body.v });
      ctx.bus.publish(req.tenant.id, 'z.created', row.id, row);
      res.json(201, row);
    }, { roles: ['csr'] });
  },
  subscribe(bus, ctx) { bus.on('z.created', (e) => { ctx.zSeen = (ctx.zSeen ?? 0) + 1; }); },
};`);
  const app = await bootApp({ modulesDir: mods, webDir: web });
  try {
    assert.deepEqual(app.ctx.moduleNames, ['zeta']);
    const r = await call(app, 'POST', '/api/v1/zs', { token: app.token(['csr']), body: { v: 'x' } });
    assert.equal(r.status, 201);
    await app.ctx.bus.drain();
    assert.equal(app.ctx.zSeen, 1);
    assert.match((await call(app, 'GET', '/')).text, /claimant/);
    assert.match((await call(app, 'GET', '/csr')).text, /csr/);
    assert.equal((await call(app, 'GET', '/app.js')).status, 200);
    assert.equal((await call(app, 'GET', '/adjuster')).status, 404);
    assert.equal((await call(app, 'GET', '/..%2f..%2fpackage.json')).status, 404);
    assert.equal((await call(app, 'GET', '/api/v1/missing')).json.error.code, 'not_found');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tenants: versioned put, no-op on identical, validator hook, history', async () => {
  const app = await bootApp();
  const { tenants } = app.ctx;
  try {
    assert.equal(tenants.get('alpha').displayName, 'Alpha Mutual');
    assert.deepEqual(tenants.put('alpha', tenants.get('alpha'), 'me'), { version: 1, changed: false });
    assert.deepEqual(tenants.put('alpha', { id: 'alpha', displayName: 'Alpha 2' }, 'me'), { version: 2, changed: true });
    tenants.addValidator((c) => (c.displayName ? [] : ['displayName required']));
    assert.throws(() => tenants.put('alpha', { id: 'alpha' }, 'me'), /displayName required/);
    assert.equal(tenants.history('alpha').length, 2);
    assert.deepEqual(tenants.list(), ['alpha', 'beta']);
  } finally { await app.close(); }
});

test('log: redacts PII keys; clock is injectable', () => {
  const lines = [];
  const log = createLogger({ level: 'info', write: (l) => lines.push(JSON.parse(l)) });
  log.info('hello', { claimId: 'clm_1', claimantName: 'Jane', nested: { Email: 'a@b.test', licensePlate: 'ABC', ok: 1 } });
  log.debug('hidden');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].nested, { Email: '[redacted]', licensePlate: '[redacted]', ok: 1 });
  assert.equal(lines[0].claimantName, '[redacted]');
  assert.equal(lines[0].claimId, 'clm_1');
  assert.equal(redact('x'), 'x');
  const clock = createClock({ fixed: '2026-01-01T00:00:00Z' });
  clock.advance(1000);
  assert.equal(clock.nowIso(), '2026-01-01T00:00:01.000Z');
});
