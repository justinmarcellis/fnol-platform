import test from 'node:test';
import assert from 'node:assert/strict';
import { progressModel, policyTone, coverageDetail, contextModel } from '../../../../src/web/csr/desk.js';
import { makeT } from '../../../../src/web/csr/strings.js';
import { summaryToRow } from '../../../../src/web/csr/search.js';

const t = makeT('en');
const fmt = { date: (v) => `D(${v})`, money: (v) => `$${v.amount}`, enum: (v) => `E(${v})` };
const usd = (amount) => ({ amount, currency: 'USD' });

test('progressModel: percent from answered and remaining, 100 when done, safe on bad input', () => {
  assert.deepEqual(progressModel({ answered: 2, requiredRemaining: 6 }), { answered: 2, remaining: 6, percent: 25 });
  assert.equal(progressModel({ answered: 5, requiredRemaining: 0 }).percent, 100);
  assert.equal(progressModel({ answered: 0, requiredRemaining: 4 }, true).percent, 100);
  assert.deepEqual(progressModel(undefined), { answered: 0, remaining: 0, percent: 0 });
  assert.equal(progressModel({ answered: -3, requiredRemaining: 'x' }).percent, 0);
});

test('policyTone maps statuses to chip tones', () => {
  assert.equal(policyTone('in_force'), 'success');
  assert.equal(policyTone('pending_cancellation'), 'warning');
  assert.equal(policyTone('cancelled'), 'danger');
  assert.equal(policyTone('expired'), 'danger');
  assert.equal(policyTone('not_found'), 'neutral');
  assert.equal(policyTone(undefined), 'neutral');
});

test('coverageDetail joins limits and deductible', () => {
  assert.equal(coverageDetail({ limitPerPerson: usd(100), limitPerOccurrence: usd(300) }, { t, fmt }), '$100 per person, $300 per occurrence');
  assert.equal(coverageDetail({ limit: usd(900) }, { t, fmt }), 'Limit $900');
  assert.equal(coverageDetail({ deductible: usd(500) }, { t, fmt }), '$500 deductible');
  assert.equal(coverageDetail({ deductible: usd(0) }, { t, fmt }), 'No deductible');
  assert.equal(coverageDetail({}, { t, fmt }), '');
});

const snapshot = {
  policyNumber: 'PA-WI-1', lob: 'personal_auto', status: 'in_force', period: { effectiveDate: '2026-05-04', expirationDate: '2027-05-04' },
  namedInsureds: [{ name: 'Harper Hollis', relation: 'named_insured' }],
  coverages: [{ code: 'BI', description: 'Bodily injury liability', limitPerPerson: usd(100) }],
  drivers: [{ name: 'Harper Hollis' }, { name: 'Casey Oakridge', excluded: true }],
  vehicles: [{ unitId: 'veh-1', vin: '5YZNE4CN0SJ747389', year: 2025, make: 'Tamsin', model: 'Compact', coverages: [{ code: 'COLL', description: 'Collision', deductible: usd(500) }] }],
};

test('contextModel builds policy, insured, drivers, vehicle and coverage cards from a snapshot', () => {
  const m = contextModel({ summary: { policyNumber: 'PA-WI-1' }, snapshot }, { t, fmt });
  assert.equal(m.number, 'PA-WI-1');
  assert.deepEqual(m.status, { tone: 'success', label: 'E(in_force)' });
  assert.equal(m.term, 'D(2026-05-04) to D(2027-05-04)');
  assert.deepEqual(m.insureds.map((n) => n.name), ['Harper Hollis']);
  assert.deepEqual(m.drivers, [{ name: 'Harper Hollis', excluded: false }, { name: 'Casey Oakridge', excluded: true }]);
  assert.equal(m.vehicles[0].title, '2025 Tamsin Compact');
  assert.equal(m.vehicles[0].sub, 'VIN ending 7389');
  assert.equal(m.vehicles[0].coverages[0].detail, '$500 deductible');
  assert.equal(m.coverages[0].title, 'Bodily injury liability');
  assert.deepEqual(m.coverages[0].status, { tone: 'success', label: 'Active' });
  assert.equal(m.detailed, true);
});

test('contextModel degrades to the search row plus policy-vehicles when the snapshot is unavailable', () => {
  const summary = { policyNumber: 'PA-WI-1', lob: 'personal_auto', status: 'cancelled', insuredName: 'Harper Hollis', period: { effectiveDate: '2026-05-04', expirationDate: '2027-05-04' } };
  const m = contextModel({ summary, snapshot: null, vehicleOptions: [{ unitId: 'veh-1', label: '2025 Tamsin Compact' }] }, { t, fmt });
  assert.equal(m.detailed, false);
  assert.deepEqual(m.insureds.map((n) => n.name), ['Harper Hollis']);
  assert.equal(m.vehicles[0].title, '2025 Tamsin Compact');
  assert.deepEqual(m.coverages, []);
  assert.equal(m.status.tone, 'danger');
});

test('summaryToRow reads insuredName from the real GET /policies row and keeps the vehicle description', () => {
  const row = summaryToRow({ policyNumber: 'PA-WI-1', lob: 'personal_auto', status: 'in_force', insuredName: 'Harper Hollis', description: '2025 Tamsin Compact' });
  assert.equal(row.insured, 'Harper Hollis');
  assert.equal(row.description, '2025 Tamsin Compact');
});

test('a newer search wins: an older, slower response cannot overwrite it', async () => {
  const { createPolicySearch } = await import('../../../../src/web/csr/search.js');
  const resolvers = {};
  const api = { get: (_p, { q }) => new Promise((res) => { resolvers[q] = () => res({ items: [{ policyNumber: `P-${q}`, lob: 'personal_auto', status: 'in_force' }], matchedOn: 'lastName' }); }) };
  const s = createPolicySearch({ api, t });
  const first = s.search('Ho');
  const second = s.search('Hollis');
  resolvers.Hollis(); await second;
  resolvers.Ho(); await first;
  assert.deepEqual(s.state.results.map((r) => r.policyNumber), ['P-Hollis']);
  s.clear();
  assert.equal(s.state.phase, 'idle');
  assert.deepEqual(s.state.results, []);
});
