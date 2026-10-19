// S5-WFL-04 (replaces the S5-WFL-01 token-name match): claimants verify with last name + ZIP; policy-vehicles is not a policy-number oracle.
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
  const veh = [{ unitId: 'V1', vin: '1FNOL00000A900001', year: 2021, make: 'Fabrikam', model: 'Roadster', garagingPostalCode: '60601' }];
  snapshots.set('AUT-1', { policyNumber: 'AUT-1', vehicles: veh, namedInsureds: [{ name: 'Zelda Quartz', relation: 'named_insured' }] });
  snapshots.set('AUT-2', { policyNumber: 'AUT-2', vehicles: veh, namedInsureds: [{ name: 'Other Person' }] });
});

const start = (token, policyNumber) => call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'claimant_web', ...(policyNumber ? { policyNumber } : {}) } });
const Q = '?lastName=Quartz&zip=60601';
const vehicles = async (policyNumber, token, q = Q, reader = token) => {
  const s = await start(token, policyNumber);
  assert.equal(s.status, 201);
  return call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles${q}`, { token: reader });
};

test('holder claimant gets masked vehicles (name match is case and punctuation insensitive; token name is irrelevant)', async () => {
  for (const q of [Q, '?lastName=quartz.&zip=60601', '?lastName=QUARTZ&zip=60601-1234']) {
    const r = await vehicles('AUT-1', tok(['claimant'], 'c1'), q);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ unitId: 'V1', year: 2021, make: 'Fabrikam', model: 'Roadster', vinLast4: '0001' }]);
  }
});

test('mailing postal code on the snapshot also verifies', async () => {
  snapshots.set('AUT-3', { policyNumber: 'AUT-3', mailingAddress: { postalCode: '53202' }, vehicles: [{ unitId: 'V9', year: 2020, make: 'Contoso', model: 'Hatch' }], namedInsureds: [{ name: 'Zelda Quartz' }] });
  assert.equal((await vehicles('AUT-3', tok(['claimant'], 'c1'), '?lastName=Quartz&zip=53202')).status, 200);
});

test('wrong name, wrong ZIP, missing fields, other holder and unknown policy return the identical 404 with no vehicle data', async () => {
  const t = tok(['claimant'], 'c1');
  const results = [
    await vehicles('AUT-2', t),
    await vehicles('NOPE-999', t),
    await vehicles('AUT-1', t, '?lastName=Smith&zip=60601'),
    await vehicles('AUT-1', t, '?lastName=Quartz&zip=99999'),
    await vehicles('AUT-1', t, '?lastName=Quartz'),
    await vehicles('AUT-1', t, ''),
  ];
  for (const r of results) {
    assert.equal(r.status, 404);
    assert.deepEqual({ status: r.status, body: r.body }, { status: results[0].status, body: results[0].body });
    assert.ok(!/V1|Fabrikam|0001/.test(JSON.stringify(r.body)));
  }
});

test('brute-force guard: after 5 failed verifications the session returns the uniform 404 even for correct credentials', async () => {
  const t = tok(['claimant'], 'c1');
  const s = await start(t, 'AUT-1');
  const get = (q) => call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles${q}`, { token: t });
  for (let i = 0; i < 5; i += 1) assert.equal((await get(`?lastName=Quartz&zip=9999${i}`)).status, 404);
  const locked = await get(Q);
  const unknown = await vehicles('NOPE-999', t);
  assert.equal(locked.status, 404);
  assert.deepEqual(locked.body, unknown.body);
  // A fresh session is unaffected, and the counter is not exposed on the session view.
  assert.equal((await vehicles('AUT-1', t)).status, 200);
  assert.ok(!('holderFailures' in (await call(app, 'GET', `${base}/${s.body.sessionId}`, { token: t })).body));
});

test('four failures then the right answer still succeeds', async () => {
  const t = tok(['claimant'], 'c1');
  const s = await start(t, 'AUT-1');
  const get = (q) => call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles${q}`, { token: t });
  for (let i = 0; i < 4; i += 1) await get('?lastName=Nope&zip=60601');
  assert.equal((await get(Q)).status, 200);
});

test('a policy that exists only in another tenant looks like an unknown policy', async () => {
  const t = tok(['claimant'], 'c1');
  const s = await start(t, 'AUT-1');
  const cross = await call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles${Q}`, { token: tok(['claimant'], 'c1', 'Zelda Quartz', 'tn-two') });
  assert.equal(cross.status, 404);
  const unknown = await vehicles('NOPE-999', t);
  assert.equal(cross.body.error.code, unknown.body.error.code);
  assert.ok(!/V1|Fabrikam|0001/.test(JSON.stringify(cross.body)));
});

// S5-WFL-03/S5-WFL-04: csr unchanged; an agent on a policy it does not produce gets the uniform 404.
test('csr unchanged; agent without producer link gets the uniform 404', async () => {
  const c = tok(['claimant'], 'c1');
  const s = await start(c, 'AUT-2');
  const csr = await call(app, 'GET', `${base}/${s.body.sessionId}/policy-vehicles`, { token: tok(['csr'], 'u9') });
  assert.equal(csr.status, 200);
  assert.equal(csr.body.length, 1);
  const own = await start(tok(['agent'], 'ag1'), 'NOPE-999');
  assert.equal((await call(app, 'GET', `${base}/${own.body.sessionId}/policy-vehicles`, { token: tok(['agent'], 'ag1') })).status, 404);
});
