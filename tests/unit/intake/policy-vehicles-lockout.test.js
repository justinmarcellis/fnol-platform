// S5-WFL-05: holder verification lockout per (tenant, policy), atomic, independent of sessions.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call, sampleTenant } from './helpers.mjs';
import { reset, snapshots } from './fakes.mjs';
import { setCoverageLookup } from '../../../src/modules/intake/index.mjs';

const base = '/api/v1/intake/sessions';
let app;
const tok = (sub, tenant = 'tn-one') => app.ctx.auth.issueToken({ sub, tenantId: tenant, roles: ['claimant'] });
before(async () => { app = await bootIntakeApp({ tenants: [sampleTenant('tn-one'), sampleTenant('tn-two')] }); });
after(async () => { setCoverageLookup(); await app.close(); });
beforeEach(() => {
  reset(); setCoverageLookup();
  app.ctx.db.forTenant('tn-one').run('DELETE FROM intake_holder_lockouts');
  const veh = [{ unitId: 'V1', vin: '1FNOL00000A900001', year: 2021, make: 'Fabrikam', model: 'Roadster', garagingPostalCode: '60601' }];
  snapshots.set('AUT-1', { policyNumber: 'AUT-1', vehicles: veh, namedInsureds: [{ name: 'Zelda Quartz' }] });
});

const start = async (token, policyNumber = 'AUT-1') => (await call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'claimant_web', policyNumber } })).body.sessionId;
const get = (sid, token, q) => call(app, 'GET', `${base}/${sid}/policy-vehicles${q}`, { token });
const GOOD = '?lastName=Quartz&zip=60601';
const bad = (i) => `?lastName=Quartz&zip=${String(10000 + i)}`;

test('failures accumulate per policy across new sessions and lock the policy', async () => {
  const t = tok('c1');
  for (let i = 0; i < 10; i += 1) assert.equal((await get(await start(t), t, bad(i))).status, 404);
  const locked = await get(await start(t), t, GOOD);
  assert.equal(locked.status, 404);
  const unknown = await get(await start(t, 'NOPE-1'), t, GOOD);
  assert.deepEqual(locked.body, unknown.body);
  // another user and another tenant's same policy number are separate or equally locked per tenant
  assert.equal((await get(await start(tok('c2')), tok('c2'), GOOD)).status, 404);
});

test('lockout is per tenant and per policy; policy number is not stored in plain text', async () => {
  const t = tok('c1');
  for (let i = 0; i < 11; i += 1) await get(await start(t), t, bad(i));
  snapshots.set('AUT-9', { policyNumber: 'AUT-9', vehicles: [{ unitId: 'V1', garagingPostalCode: '60601' }], namedInsureds: [{ name: 'Zelda Quartz' }] });
  assert.equal((await get(await start(t, 'AUT-9'), t, GOOD)).status, 200);
  const rows = app.ctx.db.forTenant('tn-one').all('SELECT * FROM intake_holder_lockouts');
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes('AUT-'));
  assert.ok(rows.every((r) => r.tenant_id === 'tn-one'));
  assert.deepEqual(rows.map((r) => r.failures).sort((a, b) => a - b), [0, 11]);
});

test('20 concurrent wrong guesses across sessions are all recorded and the lock holds', async () => {
  const t = tok('c1');
  const sids = [];
  for (let i = 0; i < 20; i += 1) sids.push(await start(t));
  const rs = await Promise.all(sids.map((sid, i) => get(sid, t, bad(i))));
  assert.ok(rs.every((r) => r.status === 404));
  const row = app.ctx.db.forTenant('tn-one').get('SELECT failures FROM intake_holder_lockouts');
  assert.ok(row.failures >= 20, `failures=${row.failures}`);
  assert.equal((await get(await start(t), t, GOOD)).status, 404);
});

test('20 concurrent wrong guesses on one session are all recorded', async () => {
  const t = tok('c1');
  const sid = await start(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => get(sid, t, bad(i))));
  assert.ok(app.ctx.db.forTenant('tn-one').get('SELECT failures FROM intake_holder_lockouts').failures >= 20);
  assert.equal((await get(await start(t), t, GOOD)).status, 404);
});

test('successful verification below the limit does not consume the budget; per-session 5 limit kept', async () => {
  const t = tok('c1');
  for (let i = 0; i < 20; i += 1) assert.equal((await get(await start(t), t, GOOD)).status, 200);
  const sid = await start(t);
  for (let i = 0; i < 5; i += 1) await get(sid, t, bad(i));
  assert.equal((await get(sid, t, GOOD)).status, 404);
  assert.equal((await get(await start(t), t, GOOD)).status, 200);
});
