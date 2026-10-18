import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootCoverageApp, call } from './helpers.mjs';
import { policies } from '../../../src/modules/coverage/fixtures.mjs';
import { classifyQuery } from '../../../src/modules/coverage/service.mjs';
import { maskPhone, maskPostal } from '../../../src/modules/coverage/summarize.mjs';

let app;
before(async () => {
  app = await bootCoverageApp();
  await app.cov('alpha').seedPolicies(policies);
  await app.cov('beta').seedPolicies([{ ...policies[0], policyNumber: 'AUT-900001', namedInsureds: [{ name: 'Zed Betaonly', phone: '555-010-0999' }] }]);
});
after(async () => { await app.close(); });

const get = (q, { roles = ['csr'], tenant = 'alpha' } = {}) =>
  call(app, 'GET', `/api/v1/policies?q=${encodeURIComponent(q)}`, { token: app.token(roles, tenant) });
const numbers = (r) => r.json.items.map((p) => p.policyNumber);

test('classifyQuery recognises each query kind', () => {
  const kind = (q) => classifyQuery(q)?.kind;
  assert.equal(kind('1FNOL00000A100001'), 'vin');
  assert.equal(kind('(555) 010-0101'), 'phone');
  assert.equal(kind('+1 555.010.0101'), 'phone');
  assert.equal(kind('60601'), 'postalCode');
  assert.equal(kind('60601-1234'), 'postalCode');
  assert.equal(kind('AUT-1000'), 'policyNumberPrefix');
  assert.equal(kind('hom-'), 'policyNumberPrefix');
  assert.equal(kind("O'Brien"), 'lastName');
  assert.equal(kind('Testwell'), 'lastName');
  assert.equal(classifyQuery('12'), null);
  assert.equal(classifyQuery('  '), null);
});

test('search by each kind of q', async () => {
  assert.deepEqual(numbers(await get('1fnol00000a100001')), ['AUT-100001']);
  assert.deepEqual(numbers(await get('555-010-0202')), ['HOM-200002']);
  assert.deepEqual(numbers(await get('53202')), ['AUT-100002', 'HOM-200002']);
  assert.deepEqual(numbers(await get('Testwell')), ['AUT-100001', 'AUT-100005']);
  const pre = await get('aut-1000');
  assert.equal(pre.json.matchedOn, 'policyNumberPrefix');
  assert.equal(numbers(pre).length, 6);
  assert.deepEqual(numbers(await get('CAU-3')), ['CAU-300001', 'CAU-300002']);
});

test('prefix match treats % and _ literally', async () => {
  assert.equal((await get('AUT_1')).status, 400); // not a valid query shape
  assert.deepEqual(await get('A%T-1').then((r) => r.status), 400);
});

test('summaries are masked: no full phone, address or raw PII columns', async () => {
  const r = await get('HOM-200001');
  assert.equal(r.status, 200);
  const [p] = r.json.items;
  assert.equal(p.riskState, 'IL');
  assert.equal(p.contact.phone, '***-***-0201');
  assert.equal(p.contact.postalCode, '606**');
  assert.equal(p.description, 'single family in Exampleton, IL');
  assert.equal(p.insuredName, 'Gray Fictionova');
  assert.ok(!r.text.includes('555-010-0201') && !r.text.includes('100 Placeholder') && !r.text.includes('60601'));
  const v = (await get('1FNOL00000E500005')).json.items[0];
  assert.equal(v.description, '2020 Fabrikam Wagon + 1 more (2 units)');
  const fleet = (await get('CAU-300001')).json.items[0];
  assert.equal(fleet.vehicleCount, 3);
  assert.equal(fleet.riskState, 'IL');
});

test('mask helpers', () => {
  assert.equal(maskPhone('(555) 010-0101'), '***-***-0101');
  assert.equal(maskPhone(null), null);
  assert.equal(maskPostal('60601-1234'), '606**');
});

test('blind indexes only: no plaintext PII in coverage_policies columns', () => {
  const rows = app.ctx.db.forTenant('alpha').all('SELECT * FROM coverage_policies');
  assert.ok(rows.length > 0);
  // Searchable columns are hashes; VIN stays in the policy doc as an asset identifier (not a searchable column).
  const blob = JSON.stringify(rows.map(({ last_name_idx, postal_idx, vin_idx, phone_idx, pii, doc }) => ({ last_name_idx, postal_idx, vin_idx, phone_idx, pii, doc: doc.replace(/1FNOL\w+/g, '') })));
  for (const secret of ['Testwell', 'Fictionova', '555-010-0101', '1FNOL00000A100001', '60601', 'Placeholder', 'Exampleton']) {
    assert.ok(!blob.includes(secret), `plaintext ${secret} found in coverage_policies`);
  }
});

test('400 on empty or unclassifiable q', async () => {
  assert.equal((await call(app, 'GET', '/api/v1/policies', { token: app.token(['csr']) })).status, 400);
  assert.equal((await get('')).status, 400);
  assert.equal((await get('   ')).status, 400);
  assert.equal((await get('12')).status, 400);
  assert.equal((await get('$$$')).status, 400);
});

test('roles: csr, agent, adjuster, supervisor allowed; others denied', async () => {
  for (const roles of [['csr'], ['agent'], ['adjuster'], ['supervisor']]) assert.equal((await get('Testwell', { roles })).status, 200, roles[0]);
  for (const roles of [['claimant'], ['integration']]) assert.equal((await get('Testwell', { roles })).status, 403, roles[0]);
  assert.equal((await call(app, 'GET', '/api/v1/policies?q=Testwell')).status, 401);
});

test('tenant isolation', async () => {
  assert.deepEqual(numbers(await get('Betaonly', { tenant: 'beta' })), ['AUT-900001']);
  assert.deepEqual(numbers(await get('Betaonly', { tenant: 'alpha' })), []);
  assert.deepEqual(numbers(await get('Testwell', { tenant: 'beta' })), []);
  assert.deepEqual(numbers(await get('AUT-1', { tenant: 'beta' })), []);
  assert.deepEqual(numbers(await get('555-010-0999', { tenant: 'alpha' })), []);
});

test('searchPolicies accepts policyNumberPrefix additively', async () => {
  const rows = await app.cov('alpha').searchPolicies({ policyNumberPrefix: 'HOM-' });
  assert.deepEqual(rows.map((r) => r.policyNumber), ['HOM-200001', 'HOM-200002', 'HOM-200003']);
  const both = await app.cov('alpha').searchPolicies({ policyNumberPrefix: 'AUT-', lastName: 'Testwell' });
  assert.equal(both.length, 2);
});
