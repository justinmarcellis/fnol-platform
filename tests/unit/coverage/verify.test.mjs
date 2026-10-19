import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCoverage, lobFamily } from '../../../src/modules/coverage/verify.mjs';
import { statusAsOf } from '../../../src/modules/coverage/adapters/mock-pas.mjs';
import { policies } from '../../../src/modules/coverage/fixtures.mjs';
import { lossDateInTenantZone } from '../../../src/modules/coverage/dates.mjs';

const byNumber = (n) => policies.find((p) => p.policyNumber === n);
/** Policy as the mock PAS would return it for a loss date. */
const snap = (n, asOf) => ({ ...byNumber(n), status: statusAsOf(byNumber(n), asOf) });
const V1 = [{ role: 'insured', policyVehicleId: 'V1' }];
const LOC1 = [{ role: 'insured_location', policyLocationId: 'LOC1' }];

const auto = (policyNumber, lossCause, extra = {}) => ({
  policyNumber, lob: 'personal_auto', lossDate: '2026-09-15', lossCause, vehicles: V1, ...extra,
});
const home = (policyNumber, lossCause, extra = {}) => ({
  policyNumber, lob: 'homeowners', lossDate: '2026-09-15', lossCause, properties: LOC1, ...extra,
});

const cases = [
  // term
  ['loss inside term', 'AUT-100001', auto('AUT-100001', 'collision'), { status: 'in_force', outcome: 'covered', ded: 500, cov: ['COLL'] }],
  ['loss on effective date', 'AUT-100001', auto('AUT-100001', 'collision', { lossDate: '2026-01-01' }), { status: 'in_force' }],
  ['loss day before effective date', 'AUT-100001', auto('AUT-100001', 'collision', { lossDate: '2025-12-31' }), { status: 'lapsed', outcome: 'not_covered', reason: 'loss_before_effective_date' }],
  ['loss on expiration date', 'AUT-100001', auto('AUT-100001', 'collision', { lossDate: '2027-01-01' }), { status: 'lapsed', reason: 'loss_after_policy_end' }],
  ['policy expired', 'AUT-100003', auto('AUT-100003', 'collision', { lossDate: '2026-03-01' }), { status: 'lapsed', reason: 'loss_after_policy_end' }],
  ['cancelled before loss', 'AUT-100004', auto('AUT-100004', 'collision', { lossDate: '2026-08-01' }), { status: 'lapsed' }],
  ['loss before cancellation', 'AUT-100004', auto('AUT-100004', 'collision', { lossDate: '2026-06-14' }), { status: 'in_force' }],
  ['pending cancellation still in force', 'AUT-100006', auto('AUT-100006', 'collision', { lossDate: '2026-10-01' }), { status: 'in_force', reason: 'pending_cancellation' }],
  // LOB mismatch
  ['LOB mismatch', 'AUT-100001', { ...auto('AUT-100001', 'collision'), lob: 'homeowners' }, { status: 'needs_review', outcome: 'needs_review', reason: 'lob_mismatch' }],
  // unit not on policy
  ['vehicle not on policy', 'AUT-100001', auto('AUT-100001', 'collision', { vehicles: [{ role: 'insured', vin: '1FNOL00000Z999999' }] }), { status: 'excluded', reason: 'vehicle_not_on_policy' }],
  ['vehicle matched by VIN (case-insensitive)', 'AUT-100001', auto('AUT-100001', 'collision', { vehicles: [{ role: 'insured', vin: '1fnol00000a100001' }] }), { status: 'in_force' }],
  ['one of two vehicles unmatched', 'AUT-100005', auto('AUT-100005', 'collision', { vehicles: [{ role: 'insured', policyVehicleId: 'V1' }, { role: 'insured', policyVehicleId: 'V9' }] }), { status: 'needs_review', reason: 'vehicle_partly_on_policy' }],
  ['no insured vehicle reported', 'AUT-100001', auto('AUT-100001', 'collision', { vehicles: [{ role: 'third_party', vin: 'X' }] }), { status: 'needs_review', reason: 'no_insured_vehicle' }],
  ['property not on policy', 'HOM-200001', home('HOM-200001', 'fire', { properties: [{ role: 'insured_location', policyLocationId: 'LOC7' }] }), { status: 'excluded', reason: 'location_not_on_policy' }],
  ['single location assumed when claim omits it', 'HOM-200001', home('HOM-200001', 'fire', { properties: [] }), { status: 'in_force' }],
  // auto coverages
  ['collision', 'AUT-100001', auto('AUT-100001', 'collision'), { status: 'in_force', ded: 500, cov: ['COLL'] }],
  ['collision not purchased', 'AUT-100002', auto('AUT-100002', 'collision'), { status: 'excluded', reason: 'coverage_not_purchased' }],
  ['comprehensive: hail', 'AUT-100001', auto('AUT-100001', 'hail'), { status: 'in_force', ded: 250, cov: ['COMP'] }],
  ['comprehensive: animal strike', 'AUT-100001', auto('AUT-100001', 'collision_animal'), { status: 'in_force', ded: 250, cov: ['COMP'] }],
  ['glass with standalone glass cover uses its deductible', 'AUT-100001', auto('AUT-100001', 'glass'), { status: 'in_force', ded: 0, cov: ['GLASS', 'COMP'] }],
  ['glass falls under comprehensive', 'AUT-100005', auto('AUT-100005', 'glass'), { status: 'in_force', ded: 250, cov: ['COMP'] }],
  ['glass on second vehicle without comprehensive', 'AUT-100005', auto('AUT-100005', 'glass', { vehicles: [{ role: 'insured', policyVehicleId: 'V2' }] }), { status: 'excluded' }],
  ['theft under comprehensive', 'AUT-100006', auto('AUT-100006', 'theft', { lossDate: '2026-10-01' }), { status: 'in_force', cov: ['COMP'] }],
  ['liability bodily injury', 'AUT-100001', auto('AUT-100001', 'liability_bodily_injury'), { status: 'in_force', cov: ['BI'], ded: null, limit: { BI: { limitPerPerson: 100000, limitPerOccurrence: 300000 } } }],
  ['liability property damage', 'AUT-100002', auto('AUT-100002', 'liability_property_damage'), { status: 'in_force', cov: ['PD'], ded: null }],
  ['flood on auto is comprehensive', 'AUT-100001', auto('AUT-100001', 'flood'), { status: 'in_force', cov: ['COMP'] }],
  // home coverages
  ['dwelling: fire', 'HOM-200001', home('HOM-200001', 'fire'), { status: 'in_force', ded: 1000, cov: ['DWELLING', 'OTHER_STRUCTURES', 'PERSONAL_PROPERTY'], limit: { DWELLING: { limit: 350000 } } }],
  ['dwelling: percent deductible is 2% of dwelling limit', 'HOM-200002', home('HOM-200002', 'wind'), { status: 'in_force', ded: 8000, cov: ['DWELLING', 'PERSONAL_PROPERTY'] }],
  ['personal property: theft', 'HOM-200001', home('HOM-200001', 'theft'), { status: 'in_force', cov: ['PERSONAL_PROPERTY', 'DWELLING'], ded: 1000 }],
  ['personal property only policy: fire', 'HOM-200003', home('HOM-200003', 'fire'), { status: 'in_force', cov: ['PERSONAL_PROPERTY'], ded: 500 }],
  ['personal property only policy: no dwelling cover', 'HOM-200003', home('HOM-200003', 'glass'), { status: 'excluded', reason: 'coverage_not_purchased' }],
  ['personal liability', 'HOM-200001', home('HOM-200001', 'liability_bodily_injury'), { status: 'in_force', cov: ['PERSONAL_LIABILITY', 'MED_PAY_OTHERS'], ded: null }],
  // water exclusions
  ['plumbing leak is covered', 'HOM-200001', home('HOM-200001', 'water_plumbing'), { status: 'in_force', cov: ['DWELLING', 'OTHER_STRUCTURES', 'PERSONAL_PROPERTY'] }],
  ['surface water / seepage excluded by peril', 'HOM-200001', home('HOM-200001', 'water_weather'), { status: 'excluded', reason: 'peril_excluded' }],
  ['flood excluded without endorsement', 'HOM-200001', home('HOM-200001', 'flood'), { status: 'excluded', reason: 'flood_excluded' }],
  ['flood covered with endorsement', 'HOM-200002', home('HOM-200002', 'flood'), { status: 'in_force', cov: ['DWELLING', 'PERSONAL_PROPERTY'] }],
  // missing / ambiguous
  ['unknown policy number', null, auto('AUT-999999', 'collision'), { status: 'not_found', outcome: 'policy_not_found', reason: 'policy_not_found' }],
  ['claim without policy number', null, auto(undefined, 'collision'), { status: 'needs_review', reason: 'no_policy_number' }],
  ['ambiguous cause "other"', 'AUT-100001', auto('AUT-100001', 'other'), { status: 'needs_review', reason: 'cause_not_mapped' }],
  ['unsupported LOB', null, { policyNumber: 'X', lob: 'workers_comp', lossDate: '2026-09-15', lossCause: 'fire' }, { status: 'not_found' }],
];

for (const [name, policyNo, facts, want] of cases) {
  test(`evaluateCoverage: ${name}`, () => {
    const policy = policyNo ? snap(policyNo, facts.lossDate) : null;
    const out = evaluateCoverage(policy, facts);
    assert.equal(out.status, want.status, out.reasons.join(' | '));
    if (want.outcome) assert.equal(out.outcome, want.outcome);
    if (want.reason) assert.ok(out.reasons.some((r) => r.startsWith(want.reason)), `expected reason ${want.reason} in ${out.reasons}`);
    if ('ded' in want) assert.equal(out.deductible?.amount ?? null, want.ded);
    if (want.cov) assert.deepEqual(out.applicableCoverages, want.cov);
    if (want.limit) {
      for (const [code, l] of Object.entries(want.limit)) {
        for (const [k, v] of Object.entries(l)) assert.equal(out.limits[code][k].amount, v);
      }
    }
    assert.ok(Array.isArray(out.reasons) && out.reasons.length > 0);
    assert.ok(out.checks.every((c) => typeof c.code === 'string' && typeof c.passed === 'boolean'));
  });
}

test('evaluateCoverage: unsupported LOB with an existing policy needs review', () => {
  const p = { ...snap('AUT-100001', '2026-09-15'), lob: 'workers_comp' };
  const out = evaluateCoverage(p, { policyNumber: 'AUT-100001', lob: 'workers_comp', lossDate: '2026-09-15', lossCause: 'fire' });
  assert.equal(out.status, 'needs_review');
});

test('evaluateCoverage is pure: same input, same output, input untouched', () => {
  const policy = snap('HOM-200001', '2026-09-15');
  const before = JSON.stringify(policy);
  const a = evaluateCoverage(policy, home('HOM-200001', 'fire'));
  const b = evaluateCoverage(policy, home('HOM-200001', 'fire'));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(policy), before);
});

test('lobFamily maps tenant LOB ids to rule families', () => {
  assert.equal(lobFamily('personal_auto'), 'auto');
  assert.equal(lobFamily('commercial_auto'), 'auto');
  assert.equal(lobFamily('homeowners'), 'property');
  assert.equal(lobFamily('renters'), 'property');
  assert.equal(lobFamily('marine'), null);
});

test('statusAsOf derives policy status from dates', () => {
  assert.equal(statusAsOf(byNumber('AUT-100003'), '2025-06-01'), 'in_force');
  assert.equal(statusAsOf(byNumber('AUT-100003'), '2026-01-01'), 'expired');
  assert.equal(statusAsOf(byNumber('AUT-100004'), '2026-06-14'), 'in_force');
  assert.equal(statusAsOf(byNumber('AUT-100004'), '2026-06-15'), 'cancelled');
  assert.equal(statusAsOf(byNumber('AUT-100006'), '2026-10-01'), 'pending_cancellation');
});

test('loss date is compared in the tenant time zone', () => {
  // 2026-01-01 03:30 UTC is still 2025-12-31 in Chicago and Los Angeles.
  assert.equal(lossDateInTenantZone({ lossDate: '2026-01-01T03:30:00Z' }, 'America/Chicago'), '2025-12-31');
  assert.equal(lossDateInTenantZone({ lossDate: '2026-01-01T03:30:00Z' }, 'UTC'), '2026-01-01');
  // 22:30 on Dec 31 in Los Angeles is Jan 1 in Chicago.
  assert.equal(lossDateInTenantZone({ lossDate: '2025-12-31', lossTime: '22:30', lossTimeZone: 'America/Los_Angeles' }, 'America/Chicago'), '2026-01-01');
  // Bare date, or same zone: unchanged.
  assert.equal(lossDateInTenantZone({ lossDate: '2025-12-31' }, 'America/Chicago'), '2025-12-31');
  assert.equal(lossDateInTenantZone({ lossDate: '2025-12-31', lossTime: '22:30', lossTimeZone: 'America/Chicago' }, 'America/Chicago'), '2025-12-31');
  // Bad zone falls back to the bare date.
  assert.equal(lossDateInTenantZone({ lossDate: '2025-12-31', lossTime: '22:30', lossTimeZone: 'Nope/Nowhere' }, 'America/Chicago'), '2025-12-31');
});

test('fixtures: 6+ synthetic policies with unique numbers and fictional data', () => {
  assert.ok(policies.length >= 6);
  assert.equal(new Set(policies.map((p) => p.policyNumber)).size, policies.length);
  const text = JSON.stringify(policies);
  assert.ok(!/gmail|yahoo|state farm|allstate|geico/i.test(text));
  for (const p of policies) for (const i of p.namedInsureds) if (i.phone) assert.match(i.phone, /555/);
});
