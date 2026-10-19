// enrichClaimCreate: policy number, insured vehicle (VIN / unit) and insured location from a policy snapshot.
// Synthetic, fictional data only; the snapshot is a local fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toClaimCreate, enrichClaimCreate } from '../../../src/modules/intake/mapping.js';

const autoSnap = {
  policyNumber: 'AUT-900001', lob: 'personal_auto', status: 'in_force',
  vehicles: [
    { unitId: 'V1', vin: '1FNOL00000A900001', year: 2021, make: 'Fabrikam', model: 'Roadster' },
    { unitId: 'V2', vin: '1FNOL00000A900002', year: 2018, make: 'Contoso', model: 'Hatch' },
  ],
};
const homeSnap = {
  policyNumber: 'HOM-900001', lob: 'homeowners', status: 'in_force',
  properties: [
    { locationId: 'L1', address: { line1: '1 Example Way', city: 'Madison', state: 'WI', postalCode: '53703' }, dwellingType: 'single_family' },
    { locationId: 'L2', address: { line1: '9 Sample Rd', city: 'Madison', state: 'WI', postalCode: '53704' } },
  ],
};
const q = (id, type, mapsTo) => ({ id, type, mapsTo });
const base = (extra = {}) => ({ lob: 'personal_auto', channel: 'csr_phone', intakeSessionId: 'ins_1', lossEvent: { lossDate: '2026-05-01', cause: 'glass', description: 'x' }, ...extra });
const fake = (snap, seen = []) => async (policyNumber, asOf) => { seen.push({ policyNumber, asOf }); return snap; };

test('matches the insured vehicle by VIN, case-insensitively, and copies vin/year/make/model/unit', async () => {
  const questions = [q('vin', 'text', 'vehicles[role=insured].vin')];
  const input = base({ policyNumber: 'AUT-900001', vehicles: [{ role: 'insured', vin: '1fnol00000a900002' }] });
  const out = await enrichClaimCreate(input, { session: { policyNumber: 'AUT-900001' }, answers: { vin: { value: '1fnol00000a900002' } }, questions, getSnapshot: fake(autoSnap) });
  assert.deepEqual(out.vehicles, [{ role: 'insured', vin: '1FNOL00000A900002', year: 2018, make: 'Contoso', model: 'Hatch', policyVehicleId: 'V2' }]);
  assert.equal(out.enrichment.vehicle, 'matched');
  assert.equal(input.vehicles[0].vin, '1fnol00000a900002', 'input is not mutated');
});

test('matches by unit id from a vehicle-type answer', async () => {
  const questions = [q('veh', 'vehicle')];
  const answers = { veh: { value: { unit: 'v2', drivable: true } } };
  const { input } = toClaimCreate({ lob: 'personal_auto', channel: 'csr_phone', id: 'ins_1', policyNumber: 'AUT-900001' }, answers, questions, {});
  const out = await enrichClaimCreate(input, { session: { policyNumber: 'AUT-900001' }, answers, questions, getSnapshot: fake(autoSnap) });
  const v = out.vehicles.find((x) => x.role === 'insured');
  assert.equal(v.policyVehicleId, 'V2');
  assert.equal(v.vin, '1FNOL00000A900002');
  assert.equal(v.drivable, true);
});

test('a single-vehicle policy identifies the vehicle when none was named', async () => {
  const snap = { ...autoSnap, vehicles: [autoSnap.vehicles[0]] };
  const out = await enrichClaimCreate(base({ policyNumber: 'AUT-900001' }), { session: {}, answers: {}, questions: [], getSnapshot: fake(snap) });
  assert.equal(out.vehicles[0].policyVehicleId, 'V1');
  assert.equal(out.vehicles[0].role, 'insured');
});

test('policy number: an answer mapped to policyNumber wins over the session; the snapshot is asked with it and the loss date', async () => {
  const seen = [];
  const questions = [q('pn', 'text', 'policyNumber')];
  const out = await enrichClaimCreate(base({ policyNumber: 'SESSION-1' }), { session: { policyNumber: 'SESSION-1' }, answers: { pn: { value: 'AUT-900001' } }, questions, getSnapshot: fake(autoSnap, seen) });
  assert.equal(out.policyNumber, 'AUT-900001');
  assert.deepEqual(seen, [{ policyNumber: 'AUT-900001', asOf: '2026-05-01' }]);
});

test('policy number falls back to the session when the input lacks one', async () => {
  const out = await enrichClaimCreate(base(), { session: { policyNumber: 'AUT-900001' }, answers: {}, questions: [], getSnapshot: fake({ ...autoSnap, vehicles: [] }) });
  assert.equal(out.policyNumber, 'AUT-900001');
});

test('no policy number: input returned unchanged and the snapshot is not requested', async () => {
  const seen = [];
  const input = base();
  const out = await enrichClaimCreate(input, { session: {}, answers: {}, questions: [], getSnapshot: fake(autoSnap, seen) });
  assert.deepEqual(out, input);
  assert.equal(seen.length, 0);
});

test('no match (unknown VIN, or several vehicles and none named): unchanged, reported as unmatched', async () => {
  const input = base({ policyNumber: 'AUT-900001', vehicles: [{ role: 'insured', vin: 'NOPE' }] });
  const out = await enrichClaimCreate(input, { session: {}, answers: {}, questions: [], getSnapshot: fake(autoSnap) });
  assert.deepEqual(out, input);
  assert.equal(out.enrichment.vehicle, 'unmatched');
  const none = base({ policyNumber: 'AUT-900001' });
  assert.deepEqual(await enrichClaimCreate(none, { session: {}, answers: {}, questions: [], getSnapshot: fake(autoSnap) }), none);
});

test('no snapshot, no getSnapshot, or a throwing lookup never throws', async () => {
  const input = base({ policyNumber: 'AUT-900001' });
  assert.deepEqual(await enrichClaimCreate(input, { session: {}, getSnapshot: async () => null }), input);
  assert.deepEqual(await enrichClaimCreate(input, { session: {} }), input);
  assert.deepEqual(await enrichClaimCreate(input, { session: {}, getSnapshot: async () => { throw new Error('policy system down'); } }), input);
  assert.equal(await enrichClaimCreate(undefined, {}), undefined);
  assert.deepEqual(await enrichClaimCreate(input), input);
});

test('property LOB: sole-location policy gives an insured_location entry; named location is matched by id or address', async () => {
  const homeInput = (extra = {}) => base({ lob: 'homeowners', policyNumber: 'HOM-900001', lossEvent: { lossDate: '2026-05-01', cause: 'water', description: 'x' }, ...extra });
  const sole = await enrichClaimCreate(homeInput(), { session: {}, getSnapshot: fake({ ...homeSnap, properties: [homeSnap.properties[0]] }) });
  assert.equal(sole.properties.length, 1);
  assert.equal(sole.properties[0].role, 'insured_location');
  assert.equal(sole.properties[0].policyLocationId, 'L1');
  assert.equal(sole.properties[0].address.line1, '1 Example Way');
  assert.equal(sole.properties[0].dwellingType, 'single_family');
  assert.equal(sole.vehicles, undefined);

  const byId = await enrichClaimCreate(homeInput({ properties: [{ role: 'insured_location', policyLocationId: 'L2', habitable: true }] }), { session: {}, getSnapshot: fake(homeSnap) });
  assert.equal(byId.properties[0].policyLocationId, 'L2');
  assert.equal(byId.properties[0].habitable, true);

  const byAddr = await enrichClaimCreate(homeInput({ properties: [{ role: 'insured_location', address: { line1: '9 sample rd' } }] }), { session: {}, getSnapshot: fake(homeSnap) });
  assert.equal(byAddr.properties[0].policyLocationId, 'L2');

  const ambiguous = homeInput();
  const unchanged = await enrichClaimCreate(ambiguous, { session: {}, getSnapshot: fake(homeSnap) });
  assert.deepEqual(unchanged, ambiguous);
  assert.equal(unchanged.enrichment.property, 'unmatched');
});

test('toClaimCreate stays synchronous', () => {
  const r = toClaimCreate({ lob: 'personal_auto', channel: 'csr_phone', id: 'i' }, {}, [], {});
  assert.ok(!(r instanceof Promise));
  assert.ok(r.input);
});
