import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isStructured, structuredFields, buildStructured, missingStructured, errorFor, policyVehicleOptions, fetchPolicyVehicles, coerceAnswer, PARTY_ROLES,
} from '../../../../src/web/csr/answers.js';
import { createAssistedIntake } from '../../../../src/web/csr/assisted.js';
import { csrStrings, makeT } from '../../../../src/web/csr/strings.js';
import { fakeApi, FakeApiError, step, q } from './helpers.mjs';

const t = makeT('en');

test('party, vehicle and address are structured; other types are not', () => {
  for (const type of ['party', 'vehicle', 'address']) assert.equal(isStructured({ type }), true);
  for (const type of ['text', 'boolean', 'location', 'disclosure']) assert.equal(isStructured({ type }), false);
});

test('party sub-form maps to an object with roles[], kind and dropped empties', () => {
  const v = buildStructured('party', { firstName: ' Pat ', lastName: 'Example', role: 'driver', phone: '(555) 010-0142', insurerName: '', otherPolicyNumber: 'OTH-1', atFault: true });
  assert.deepEqual(v, { firstName: 'Pat', lastName: 'Example', roles: ['driver'], kind: 'person', phone: '(555) 010-0142', otherPolicyNumber: 'OTH-1', atFault: true });
  assert.ok(!('insurerName' in v));
  assert.deepEqual(buildStructured('party', { lastName: 'Example', role: 'bogus', atFault: false }).roles, ['third_party']);
  assert.ok(!('atFault' in buildStructured('party', { lastName: 'Example', atFault: false })));
  assert.equal(typeof v, 'object');
});

test('vehicle and address sub-forms', () => {
  assert.deepEqual(buildStructured('vehicle', { year: '2024', make: 'Tamsin', model: 'Compact', vin: '5yzne4cn0sj747389', licensePlate: '' }),
    { year: 2024, make: 'Tamsin', model: 'Compact', vin: '5YZNE4CN0SJ747389' });
  assert.deepEqual(buildStructured('address', { line1: '1 Example St', city: 'Madison', state: 'wi', postalCode: '53703' }),
    { line1: '1 Example St', city: 'Madison', state: 'WI', postalCode: '53703' });
  assert.ok(!('year' in buildStructured('vehicle', { year: '', make: 'X' })));
});

test('missingStructured flags the required fields', () => {
  assert.deepEqual(missingStructured('party', { firstName: 'Pat', role: 'driver' }), { ok: false, missing: ['lastName'] });
  assert.equal(missingStructured('party', { lastName: 'Example', role: 'driver' }).ok, true);
  assert.deepEqual(missingStructured('address', { line1: 'x' }).missing, ['city', 'state', 'postalCode']);
  assert.equal(missingStructured('vehicle', { vin: '5YZNE4CN0SJ747389' }).ok, true);
  assert.equal(missingStructured('vehicle', { make: 'Tamsin', model: 'Compact' }).ok, true);
  assert.equal(missingStructured('vehicle', {}).ok, false);
});

test('field descriptors cover party roles and every field has a label string in en and es', () => {
  const roles = structuredFields('party').find((f) => f.key === 'role').options;
  assert.deepEqual(roles, PARTY_ROLES);
  for (const r of ['third_party', 'driver', 'witness']) assert.ok(roles.includes(r));
  for (const type of ['party', 'vehicle', 'address']) {
    for (const f of structuredFields(type)) for (const loc of ['en', 'es']) assert.ok(csrStrings[loc][`csr.sf.${f.key}`], `${loc} label for ${f.key}`);
  }
  for (const r of PARTY_ROLES) assert.ok(csrStrings.es[`csr.sf.role.${r}`]);
});

test('coerceAnswer leaves a structured object untouched', () => {
  const o = { lastName: 'Example' };
  assert.strictEqual(coerceAnswer({ type: 'party' }, o), o);
});

test('errorFor picks the server message for a question', () => {
  const errors = [{ questionId: 'a', message: 'Nope' }, { questionId: 'other_party_info', message: 'Provide the requested details.' }];
  assert.equal(errorFor(errors, 'other_party_info'), 'Provide the requested details.');
  assert.equal(errorFor(errors, 'zzz'), '');
  assert.equal(errorFor(undefined, 'a'), '');
});

test('a party answer is POSTed as an object; a 422 puts errors[] in state for inline display', async () => {
  const party = q('other_party_info', { type: 'party' });
  const bad = [{ questionId: 'other_party_info', message: 'Provide the requested details.' }];
  let n = 0;
  const api = fakeApi({
    'POST /intake/sessions': step({ question: party }),
    'POST /intake/sessions/s1/answers': () => {
      n += 1;
      if (n === 1) { const e = new FakeApiError(422, 'validation_failed', '1 answer(s) were not accepted'); e.errors = bad; throw e; }
      return step({ done: true });
    },
  });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  const value = buildStructured('party', { lastName: 'Example', role: 'third_party', atFault: true });
  await f.answer('other_party_info', value);
  assert.deepEqual(api.calls.at(-1).body, { questionId: 'other_party_info', value });
  assert.equal(typeof api.calls.at(-1).body.value, 'object');
  assert.equal(f.state.phase, 'asking');
  assert.equal(errorFor(f.state.errors, 'other_party_info'), 'Provide the requested details.');
  await f.answer('other_party_info', value);
  assert.deepEqual(f.state.errors, []);
  assert.equal(f.state.done, true);
});

const snap = [
  { unitId: 'veh-1', vinLast4: '7389', year: 2025, make: 'Tamsin', model: 'Compact' },
  { unitId: 'veh-2', year: 2019, make: 'Orbit', model: 'Wagon' },
  { vinLast4: '0000' },
];

test('policy-vehicles rows become picker options carrying policyVehicleId (no full VIN)', () => {
  const opts = policyVehicleOptions(snap);
  assert.equal(opts.length, 2);
  assert.deepEqual(opts[0].answer, { year: 2025, make: 'Tamsin', model: 'Compact', policyVehicleId: 'veh-1' });
  assert.match(opts[0].label, /2025 Tamsin Compact/);
  assert.match(opts[0].label, /7389/);
  assert.equal(opts[1].answer.policyVehicleId, 'veh-2');
  assert.deepEqual(policyVehicleOptions({}), []);
  assert.deepEqual(policyVehicleOptions(null), []);
});

test('fetchPolicyVehicles reads GET /intake/sessions/{id}/policy-vehicles and hides the picker on failure or no vehicles', async () => {
  const api = fakeApi({ 'GET /intake/sessions/s1/policy-vehicles': snap, 'GET /intake/sessions/s0/policy-vehicles': [] });
  assert.equal((await fetchPolicyVehicles(api, 's1')).length, 2);
  assert.deepEqual(await fetchPolicyVehicles(api, 's0'), []);
  assert.deepEqual(await fetchPolicyVehicles(api, 'missing'), []);
  assert.deepEqual(await fetchPolicyVehicles(api, ''), []);
});

test('setInsuredVehicle posts the vehicle answer; a rejection is kept in state as insuredVehicleError', async () => {
  const [veh] = policyVehicleOptions(snap);
  const api = fakeApi({
    'POST /intake/sessions': step({ question: q('a') }),
    'POST /intake/sessions/s1/answers': step({ question: q('a') }),
  });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  await f.setInsuredVehicle(veh.answer);
  const sent = api.calls.at(-1).body;
  assert.equal(sent.questionId, 'insured_vehicle');
  assert.equal(sent.value.policyVehicleId, 'veh-1');
  assert.equal(f.state.insuredVehicleSent, true);

  const api2 = fakeApi({ 'POST /intake/sessions': step({ question: q('a') }), 'POST /intake/sessions/s1/answers': () => { throw new FakeApiError(422, 'validation_failed', 'x'); } });
  const g = createAssistedIntake({ api: api2, t });
  await g.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  assert.equal(await g.setInsuredVehicle(veh.answer), null);
  assert.equal(g.state.insuredVehicleSent, false);
  assert.ok(g.state.insuredVehicleError, 'the failure is exposed so the UI can show it');
  assert.equal(f.state.insuredVehicleError, null);
  assert.equal(g.state.insuredVehicle.policyVehicleId, 'veh-1');
  assert.equal(g.state.phase, 'asking');
});

test('setInsuredVehicle targets the tenant vehicle question when one was asked', async () => {
  const [veh] = policyVehicleOptions(snap);
  const api = fakeApi({
    'POST /intake/sessions': step({ question: q('my_vehicle', { type: 'vehicle' }) }),
    'POST /intake/sessions/s1/answers': step({ done: true }),
  });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  await f.setInsuredVehicle(veh.answer);
  assert.equal(api.calls.at(-1).body.questionId, 'my_vehicle');
});
