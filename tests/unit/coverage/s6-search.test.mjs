// S6-BUG-05 regressions for policy search and agent access: seeded policy-number shape (CSR-1, CSR-2, DATA-6), business names
// (CSR-3), phone (CSR-4), full name and VIN tail (CSR-6), true totals (CSR-7) and the agent's own book (DATA-4, DATA-5).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootCoverageApp, call } from './helpers.mjs';
import { classifyQuery } from '../../../src/modules/coverage/service.mjs';
import { holderNameMatches, isOrganization, nameKeys, normName } from '../../../src/modules/coverage/names.mjs';

const period = { effectiveDate: '2026-01-01', expirationDate: '2027-01-01' };
const agent = { agentId: 'agt-alpha-01', name: 'Avery Lindqvist' };
const auto = (policyNumber, name, extra = {}) => ({
  policyNumber, lob: 'personal_auto', status: 'in_force', period, ratingState: policyNumber.split('-')[1],
  namedInsureds: [{ name, relation: 'named_insured', phone: '(312) 555-0177' }],
  vehicles: [{ unitId: 'veh-1', vin: '1GZUD0LL9MP394242', year: 2021, make: 'Aldera', model: 'Sedan LX', garagingPostalCode: '60002' }],
  ...extra,
});
const policies = [
  auto('PA-IL-6671841', 'Riley Lockhart', { producer: agent }),
  { policyNumber: 'HO-IL-1030185', lob: 'homeowners', status: 'in_force', period, ratingState: 'IL', namedInsureds: [{ name: 'Casey Everhart' }],
    properties: [{ locationId: 'loc-1', dwellingType: 'single_family', address: { line1: '1 Elm St', city: 'Westfield', state: 'IL', postalCode: '60002' } }] },
  { ...auto('CA-MI-1421980', 'Brightfield Freight Co (fictional)'), lob: 'commercial_auto', vehicles: [{ unitId: 'veh-1', vin: '3VZPZM9A9MW314065', year: 2022, make: 'Brightwell', model: 'Van', garagingPostalCode: '48002' }] },
  ...Array.from({ length: 55 }, (_, i) => auto(`PA-WI-${String(5000000 + i)}`, `Morgan Dunmore${i}`, { namedInsureds: [{ name: 'Morgan Ashgrove' }], vehicles: [{ unitId: 'veh-1', vin: `1FNOL00000B${String(100000 + i)}`, year: 2020, make: 'Tamsin', model: 'Compact', garagingPostalCode: '53001' }] })),
];

let app;
before(async () => { app = await bootCoverageApp(); await app.cov('alpha').seedPolicies(policies); });
after(async () => { await app.close(); });
const get = (q, roles = ['csr'], sub = 'u1') => call(app, 'GET', `/api/v1/policies?q=${encodeURIComponent(q)}`, { token: app.token(roles, 'alpha', sub) });
const numbers = (r) => r.json.items.map((p) => p.policyNumber);

test('CSR-1 / DATA-6: the full seeded policy number finds its policy', async () => {
  for (const n of ['HO-IL-1030185', 'PA-IL-6671841', 'CA-MI-1421980', 'ho-il-1030185']) {
    const r = await get(n);
    assert.equal(r.status, 200, n);
    assert.equal(r.json.matchedOn, 'policyNumberPrefix');
    assert.deepEqual(numbers(r), [n.toUpperCase()]);
  }
});

test('CSR-2: prefixes with the state segment list the matching policies', async () => {
  assert.deepEqual(numbers(await get('HO-IL')), ['HO-IL-1030185']);
  assert.deepEqual(numbers(await get('PA-IL-')), ['PA-IL-6671841']);
  assert.deepEqual(numbers(await get('CA-MI')), ['CA-MI-1421980']);
  assert.deepEqual(numbers(await get('HO-IL-10')), ['HO-IL-1030185']);
  assert.deepEqual(numbers(await get('PA-IL-66')), ['PA-IL-6671841']);
  const ho = await get('HO');
  assert.equal(ho.json.matchedOn, 'policyNumberPrefix', 'a bare line code with no matching last name falls back to the prefix');
  assert.deepEqual(numbers(ho), ['HO-IL-1030185']);
});

test('CSR-3: commercial insureds are found by the leading words of the business name', async () => {
  for (const q of ['Brightfield', 'Brightfield Freight', 'brightfield freight co']) assert.deepEqual(numbers(await get(q)), ['CA-MI-1421980'], q);
  assert.deepEqual(numbers(await get('Freight')), [], 'a later word alone is not a business-name match');
});

test('CSR-4: phone search finds the named insured', async () => {
  for (const q of ['(312) 555-0177', '312-555-0177', '3125550177']) {
    const r = await get(q);
    assert.equal(r.json.matchedOn, 'phone');
    assert.ok(numbers(r).includes('PA-IL-6671841'), q);
  }
  const [row] = (await get('PA-IL-6671841')).json.items;
  assert.equal(row.contact.phone, '***-***-0177');
});

test('CSR-6: full name and VIN tail', async () => {
  assert.deepEqual(numbers(await get('Riley Lockhart')), ['PA-IL-6671841']);
  assert.deepEqual(numbers(await get('Lockhart')), ['PA-IL-6671841']);
  const tail = await get('P394242');
  assert.equal(tail.json.matchedOn, 'vinSuffix');
  assert.deepEqual(numbers(tail), ['PA-IL-6671841']);
  assert.equal((await get('MP394242')).json.matchedOn, 'vinSuffix', 'letters+digits with no prefix match fall back to the VIN tail');
  const bad = await get('!!');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /policy number or prefix/);
});

test('CSR-7: results report the true total and say when they are truncated', async () => {
  const r = await get('53001');
  assert.equal(r.json.items.length, 50);
  assert.equal(r.json.total, 55);
  assert.equal(r.json.truncated, true);
  const one = await get('HO-IL-1030185');
  assert.equal(one.json.total, 1);
  assert.equal(one.json.truncated, false);
});

test('DATA-5: an agent searches and reads only the policies it produces', async () => {
  const mine = await get('PA-', ['agent'], agent.agentId);
  assert.equal(mine.status, 200);
  assert.deepEqual(numbers(mine), ['PA-IL-6671841']);
  assert.deepEqual(numbers(await get('HO-IL-1030185', ['agent'], agent.agentId)), []);
  const snap = await call(app, 'GET', '/api/v1/policies/PA-IL-6671841/snapshot?asOf=2026-10-01', { token: app.token(['agent'], 'alpha', agent.agentId) });
  assert.equal(snap.status, 200);
  assert.equal(snap.json.namedInsureds[0].name, 'Riley Lockhart', 'the producing agent sees its insured');
  assert.equal(snap.json.producer.agentId, agent.agentId);
  const other = await call(app, 'GET', '/api/v1/policies/HO-IL-1030185/snapshot?asOf=2026-10-01', { token: app.token(['agent'], 'alpha', agent.agentId) });
  assert.equal(other.status, 404);
  const stranger = await call(app, 'GET', '/api/v1/policies/PA-IL-6671841/snapshot?asOf=2026-10-01', { token: app.token(['agent'], 'alpha', 'agt-other') });
  assert.equal(stranger.status, 404);
  assert.equal(await app.cov('alpha').isProducer('PA-IL-6671841', agent.agentId), true);
  assert.deepEqual(await app.cov('alpha').producedPolicyNumbers(agent.agentId), ['PA-IL-6671841']);
  // CSR is unchanged: tenant-wide.
  assert.ok((await get('PA-')).json.total > 1);
});

test('classifyQuery readings and alternates', () => {
  const k = (q) => classifyQuery(q)?.kind;
  assert.equal(k('HO-IL-1030185'), 'policyNumberPrefix');
  assert.equal(k('Riley Lockhart'), 'lastName');
  assert.equal(k('P394242'), 'vinSuffix');
  assert.equal(k('394242'), 'vinSuffix');
  assert.equal(k('48002'), 'postalCode');
  assert.deepEqual(classifyQuery('Ray-Li').alternates.map((a) => a.kind), ['lastName'], 'hyphenated surname is retried as a name');
  assert.deepEqual(classifyQuery('HO').alternates[0].criteria, { policyNumberPrefix: 'HO-' });
});

test('name keys and holder rule', () => {
  assert.equal(normName('Brightfield Freight Co (fictional)'), 'brightfield freight co');
  assert.equal(isOrganization({ name: 'Brightfield Freight Co (fictional)' }), true);
  assert.equal(isOrganization({ name: 'Riley Lockhart' }), false);
  assert.deepEqual(nameKeys({ name: 'Riley Lockhart' }), ['lockhart', 'riley lockhart']);
  assert.deepEqual(nameKeys({ name: 'Brightfield Freight Co (fictional)' }), ['brightfield', 'brightfield freight', 'brightfield freight co']);
  assert.equal(holderNameMatches({ name: 'Brightfield Freight Co (fictional)' }, 'Co'), false);
  assert.equal(holderNameMatches({ name: 'Brightfield Freight Co (fictional)' }, 'Brightfield Freight Co'), true);
  assert.equal(holderNameMatches({ name: 'Riley Lockhart' }, 'lockhart'), true);
  assert.equal(holderNameMatches({ name: 'Riley Lockhart' }, 'Riley'), false);
});
