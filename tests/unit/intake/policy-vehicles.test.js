// GET /intake/sessions/{id}/policy-vehicles (S4-WFL-03) and picked-unit precedence in mapping.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call, sampleTenant } from './helpers.mjs';
import { reset, snapshots } from './fakes.mjs';
import { setCoverageLookup } from '../../../src/modules/intake/index.mjs';
import { enrichClaimCreate } from '../../../src/modules/intake/mapping.js';

const base = '/api/v1/intake/sessions';
let app;
let tok;
before(async () => { app = await bootIntakeApp({ tenants: [sampleTenant('tn-one')] }); tok = (roles, sub) => app.ctx.auth.issueToken({ sub, tenantId: 'tn-one', roles, name: sub === 'c1' ? 'Zelda Quartz' : sub }); });
after(async () => { setCoverageLookup(); await app.close(); });
beforeEach(() => {
  reset(); setCoverageLookup();
  snapshots.set('AUT-1', { policyNumber: 'AUT-1', vehicles: [
    { unitId: 'V1', vin: '1FNOL00000A900001', year: 2021, make: 'Fabrikam', model: 'Roadster', licensePlate: 'ZZ-1' },
    { unitId: 'V2', vin: '1FNOL00000A900002', year: 2018, make: 'Contoso', model: 'Hatch' },
  ], namedInsureds: [{ name: 'Zelda Quartz', relation: 'named_insured' }] });
});

const start = (token, extra = {}) => call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'claimant_web', policyNumber: 'AUT-1', ...extra } });
const vehicles = (id, token) => call(app, 'GET', `${base}/${id}/policy-vehicles`, { token });

test('owner claimant gets masked vehicles only', async () => {
  const s = await start(tok(['claimant'], 'c1'));
  const r = await vehicles(s.body.sessionId, tok(['claimant'], 'c1'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [
    { unitId: 'V1', year: 2021, make: 'Fabrikam', model: 'Roadster', vinLast4: '0001' },
    { unitId: 'V2', year: 2018, make: 'Contoso', model: 'Hatch', vinLast4: '0002' },
  ]);
  assert.ok(!/1FNOL00000A9000|ZZ-1|Quartz/.test(JSON.stringify(r.body)), 'no full VIN, plate or insured PII');
});

test('csr can read any session; other claimant and unrelated agent get 404', async () => {
  const s = await start(tok(['claimant'], 'c1'));
  assert.equal((await vehicles(s.body.sessionId, tok(['csr'], 'u9'))).status, 200);
  assert.equal((await vehicles(s.body.sessionId, tok(['claimant'], 'c2'))).status, 404);
  assert.equal((await vehicles(s.body.sessionId, tok(['agent'], 'ag9'))).status, 404);
});

test('agent who owns the session (started it) can read; producer agent too', async () => {
  const own = await start(tok(['agent'], 'ag1'));
  assert.equal((await vehicles(own.body.sessionId, tok(['agent'], 'ag1'))).status, 200);
  const c = await start(tok(['claimant'], 'c1'));
  setCoverageLookup(async ({ actor }) => actor.id === 'ag2');
  assert.equal((await vehicles(c.body.sessionId, tok(['agent'], 'ag2'))).status, 200);
});

test('no policy returns []; unknown policy is 404 for a claimant (S5-WFL-01); unknown session is 404', async () => {
  const none = await start(tok(['claimant'], 'c1'), { policyNumber: undefined });
  assert.deepEqual((await vehicles(none.body.sessionId, tok(['claimant'], 'c1'))).body, []);
  const unk = await start(tok(['claimant'], 'c1'), { policyNumber: 'NOPE' });
  assert.equal((await vehicles(unk.body.sessionId, tok(['claimant'], 'c1'))).status, 404);
  assert.deepEqual((await vehicles(unk.body.sessionId, tok(['csr'], 'u9'))).body, []);
  assert.equal((await vehicles('ins_missing', tok(['csr'], 'u9'))).status, 404);
});

test('a picked unitId wins over a conflicting typed VIN and overrides year/make/model', async () => {
  const questions = [{ id: 'insured_vehicle', type: 'vehicle' }];
  const value = { policyVehicleId: 'V2', vin: '1FNOL00000A900001', year: 1999, make: 'Typo', model: 'Typo' };
  const input = { lob: 'personal_auto', channel: 'claimant_web', policyNumber: 'AUT-1', lossEvent: { lossDate: '2026-05-01', cause: 'collision', description: 'x' }, vehicles: [{ role: 'insured', ...value }] };
  const out = await enrichClaimCreate(input, { session: { policyNumber: 'AUT-1' }, answers: { insured_vehicle: { value } }, questions, getSnapshot: async () => snapshots.get('AUT-1') });
  assert.deepEqual(out.vehicles, [{ role: 'insured', vin: '1FNOL00000A900002', year: 2018, make: 'Contoso', model: 'Hatch', policyVehicleId: 'V2' }]);
});
