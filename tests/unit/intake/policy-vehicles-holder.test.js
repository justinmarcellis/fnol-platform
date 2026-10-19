// S5-WFL-01: policy-vehicles is not a policy-number oracle. Claimants see vehicles only as the named insured.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call, sampleTenant } from './helpers.mjs';
import { reset, snapshots } from './fakes.mjs';
import { setCoverageLookup } from '../../../src/modules/intake/index.mjs';

const base = '/api/v1/intake/sessions';
let app;
const tok = (roles, sub, name, tenant = 'tn-one') => app.ctx.auth.issueToken({ sub, tenantId: tenant, roles, ...(name ? { name } : {}) });
before(async () => { app = await bootIntakeApp({ tenants: [sampleTenant('tn-one'), sampleTenant('tn-two')] }); });
after(async () => { setCoverageLookup(); await app.close(); });
beforeEach(() => {
  reset(); setCoverageLookup();
  const veh = [{ unitId: 'V1', vin: '1FNOL00000A900001', year: 2021, make: 'Fabrikam', model: 'Roadster' }];
  snapshots.set('AUT-1', { policyNumber: 'AUT-1', vehicles: veh, namedInsureds: [{ name: 'Zelda Quartz', relation: 'named_insured' }] });
  snapshots.set('AUT-2', { policyNumber: 'AUT-2', vehicles: veh, namedInsureds: [{ name: 'Other Person' }] });
});

const start = (token, policyNumber) => call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'claimant_web', ...(policyNumber ? { policyNumber } : {}) } });
const vehicles = async (policyNumber, token, reader = token) => {
  const s = await start(token, policyNumber);
  assert.equal(s.status, 201);
  return call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles`, { token: reader });
};

test('holder claimant gets masked vehicles (name match is case and punctuation insensitive)', async () => {
  for (const name of ['Zelda Quartz', 'zelda  QUARTZ.']) {
    const r = await vehicles('AUT-1', tok(['claimant'], 'c1', name));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ unitId: 'V1', year: 2021, make: 'Fabrikam', model: 'Roadster', vinLast4: '0001' }]);
  }
});

test('non-holder and unknown policy return the identical 404 with no vehicle data', async () => {
  const t = tok(['claimant'], 'c1', 'Zelda Quartz');
  const notMine = await vehicles('AUT-2', t);
  const unknown = await vehicles('NOPE-999', t);
  assert.equal(notMine.status, 404);
  assert.deepEqual({ status: notMine.status, body: notMine.body }, { status: unknown.status, body: unknown.body });
  assert.ok(!/V1|Fabrikam|0001/.test(JSON.stringify(notMine.body)));
});

test('claimant without a verifiable identity (token name defaults to sub) gets the uniform 404', async () => {
  const unknown = await vehicles('NOPE-999', tok(['claimant'], 'c1'));
  const noName = await vehicles('AUT-1', tok(['claimant'], 'c1'));
  assert.equal(noName.status, 404);
  assert.deepEqual(noName.body, unknown.body);
});

test('a policy that exists only in another tenant looks like an unknown policy', async () => {
  const t = tok(['claimant'], 'c1', 'Zelda Quartz');
  const s = await start(t, 'AUT-1');
  // A tn-two claimant cannot reach the tn-one session at all, and the tn-one policy lookup is tenant-bound.
  const cross = await call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles`, { token: tok(['claimant'], 'c1', 'Zelda Quartz', 'tn-two') });
  assert.equal(cross.status, 404);
  const unknown = await vehicles('NOPE-999', t);
  assert.equal(cross.body.error.code, unknown.body.error.code);
  assert.ok(!/V1|Fabrikam|0001/.test(JSON.stringify(cross.body)));
});

test('csr and agent keep current behaviour', async () => {
  const c = tok(['claimant'], 'c1', 'Someone Else');
  const s = await start(c, 'AUT-2');
  const csr = await call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles`, { token: tok(['csr'], 'u9') });
  assert.equal(csr.status, 200);
  assert.equal(csr.body.length, 1);
  const own = await start(tok(['agent'], 'ag1'), 'NOPE-999');
  assert.deepEqual((await call(app, 'GET', `${base}/${own.body.sessionId}/policy-vehicles`, { token: tok(['agent'], 'ag1') })).body, []);
});
