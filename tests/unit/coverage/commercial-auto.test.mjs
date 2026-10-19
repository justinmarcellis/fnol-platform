import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCoverage } from '../../../src/modules/coverage/verify.mjs';
import { statusAsOf } from '../../../src/modules/coverage/adapters/mock-pas.mjs';
import { policies } from '../../../src/modules/coverage/fixtures.mjs';

const snap = (n, asOf) => {
  const p = policies.find((x) => x.policyNumber === n);
  return { ...p, status: statusAsOf(p, asOf) };
};
const facts = (policyNumber, lossCause, extra = {}) => ({
  policyNumber, lob: 'commercial_auto', lossDate: '2026-07-15', lossCause,
  vehicles: [{ role: 'insured', policyVehicleId: 'F1' }], ...extra,
});
const run = (n, f) => evaluateCoverage(snap(n, f.lossDate), f);

test('fleet unit collision is covered with the unit deductible', () => {
  const out = run('CAU-300001', facts('CAU-300001', 'collision'));
  assert.equal(out.status, 'in_force');
  assert.deepEqual(out.applicableCoverages, ['COLL']);
  assert.equal(out.deductible.amount, 2500);
  assert.ok(out.checks.some((c) => c.code === 'fleet_unit_on_policy' && c.passed));
});

test('fleet unit matched by VIN; trailer deductible differs', () => {
  const out = run('CAU-300001', facts('CAU-300001', 'collision', { vehicles: [{ role: 'insured', vin: '1fnol00000g300013' }] }));
  assert.equal(out.status, 'in_force');
  assert.equal(out.deductible.amount, 1500);
});

test('fleet unit removed before the loss date is not on the policy', () => {
  const out = run('CAU-300001', facts('CAU-300001', 'collision', { lossDate: '2026-09-01', vehicles: [{ role: 'insured', policyVehicleId: 'F3' }] }));
  assert.equal(out.status, 'excluded');
  assert.ok(out.reasons.some((r) => r.startsWith('unit_not_active')));
});

test('unscheduled unit that is not hired or non-owned is excluded', () => {
  const out = run('CAU-300001', facts('CAU-300001', 'collision', { vehicles: [{ role: 'insured', vin: '1FNOL00000Z000000' }] }));
  assert.equal(out.status, 'excluded');
  assert.ok(out.reasons.some((r) => r.startsWith('vehicle_not_on_policy')));
});

test('hired auto liability is covered under HNOA', () => {
  const out = run('CAU-300001', facts('CAU-300001', 'liability_property_damage', { vehicles: [{ role: 'hired', vin: '1FNOL00000R000001' }] }));
  assert.equal(out.status, 'in_force');
  assert.deepEqual(out.applicableCoverages, ['HNOA']);
  assert.equal(out.limits.HNOA.limitPerOccurrence.amount, 1000000);
  assert.ok(out.reasons.some((r) => r.startsWith('hired_non_owned')));
});

test('non-owned auto physical damage is not covered (liability only)', () => {
  const out = run('CAU-300001', facts('CAU-300001', 'collision', { vehicles: [{ role: 'insured', ownership: 'non_owned', vin: '1FNOL00000R000002' }] }));
  assert.equal(out.status, 'excluded');
  assert.ok(out.reasons.some((r) => r.startsWith('hnoa_physical_damage_excluded')));
});

test('hired auto without HNOA purchased is excluded', () => {
  const out = run('CAU-300002', facts('CAU-300002', 'liability_bodily_injury', { vehicles: [{ role: 'non_owned', vin: '1FNOL00000R000003' }] }));
  assert.equal(out.status, 'excluded');
  assert.ok(out.reasons.some((r) => r.startsWith('hnoa_not_purchased')));
});

test('cargo loss is excluded unless the cargo endorsement is present', () => {
  const no = run('CAU-300001', facts('CAU-300001', 'collision', { cargoInvolved: true }));
  assert.equal(no.status, 'excluded');
  assert.ok(no.reasons.some((r) => r.startsWith('cargo_excluded')));
  const yes = run('CAU-300002', facts('CAU-300002', 'collision', { cargoInvolved: true }));
  assert.equal(yes.status, 'in_force');
  assert.deepEqual(yes.applicableCoverages, ['CARGO']);
  assert.equal(yes.deductible.amount, 2500);
  assert.equal(yes.limits.CARGO.limit.amount, 100000);
});

test('liability on a fleet unit uses policy-level BI/PD; lob mismatch needs review', () => {
  const out = run('CAU-300002', facts('CAU-300002', 'liability_bodily_injury'));
  assert.equal(out.status, 'in_force');
  assert.deepEqual(out.applicableCoverages, ['BI']);
  const mm = evaluateCoverage(snap('CAU-300002', '2026-07-15'), facts('CAU-300002', 'collision', { lob: 'personal_auto' }));
  assert.equal(mm.status, 'needs_review');
});

test('personal auto behaviour is unchanged for hired vehicles', () => {
  const p = snap('AUT-100001', '2026-07-15');
  const out = evaluateCoverage(p, { policyNumber: 'AUT-100001', lob: 'personal_auto', lossDate: '2026-07-15', lossCause: 'collision', vehicles: [{ role: 'hired', vin: 'X' }] });
  assert.equal(out.status, 'needs_review');
});
