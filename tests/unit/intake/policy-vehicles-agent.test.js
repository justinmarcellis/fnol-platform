// S5-WFL-03: agents see policy vehicles only for policies they produce; otherwise the uniform 404.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call, sampleTenant } from './helpers.mjs';
import { reset, snapshots } from './fakes.mjs';
import { setCoverageLookup } from '../../../src/modules/intake/index.mjs';

const base = '/api/v1/intake/sessions';
let app;
const tok = (roles, sub, name) => app.ctx.auth.issueToken({ sub, tenantId: 'tn-one', roles, ...(name ? { name } : {}) });
before(async () => { app = await bootIntakeApp({ tenants: [sampleTenant('tn-one')] }); });
after(async () => { setCoverageLookup(); await app.close(); });
beforeEach(() => {
  reset(); setCoverageLookup();
  const veh = [{ unitId: 'V1', vin: '1FNOL00000A900001', year: 2021, make: 'Fabrikam', model: 'Roadster' }];
  snapshots.set('AUT-1', { policyNumber: 'AUT-1', vehicles: veh, namedInsureds: [{ name: 'Zelda Quartz' }] });
});

const start = (token, policyNumber) => call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'agent_portal', ...(policyNumber ? { policyNumber } : {}) } });
const vehicles = async (policyNumber, token) => {
  const s = await start(token, policyNumber);
  assert.equal(s.status, 201);
  return call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles`, { token });
};
const producerIs = (id) => setCoverageLookup(async (q) => q.actor.id === id && q.policyNumber === 'AUT-1');

test('agent who produces the policy gets masked vehicles', async () => {
  producerIs('ag1');
  const r = await vehicles('AUT-1', tok(['agent'], 'ag1'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [{ unitId: 'V1', year: 2021, make: 'Fabrikam', model: 'Roadster', vinLast4: '0001' }]);
});

test('non-producer agent and unknown policy give the identical 404 with no vehicle data', async () => {
  producerIs('ag1');
  const t = tok(['agent'], 'ag2');
  const notMine = await vehicles('AUT-1', t);
  const unknown = await vehicles('NOPE-999', t);
  assert.equal(notMine.status, 404);
  assert.deepEqual({ status: notMine.status, body: notMine.body }, { status: unknown.status, body: unknown.body });
  assert.ok(!/V1|Fabrikam|0001/.test(JSON.stringify(notMine.body)));
});

test('producer lookup failure fails closed; csr unchanged', async () => {
  setCoverageLookup(async () => { throw new Error('down'); });
  assert.equal((await vehicles('AUT-1', tok(['agent'], 'ag1'))).status, 404);
  setCoverageLookup();
  const r = await vehicles('AUT-1', tok(['csr'], 'csr1'));
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
});
