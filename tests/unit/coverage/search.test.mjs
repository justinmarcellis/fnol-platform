import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootCoverageApp } from './helpers.mjs';
import { policies } from '../../../src/modules/coverage/fixtures.mjs';

let app;
before(async () => {
  app = await bootCoverageApp();
  await app.cov('alpha').seedPolicies(policies);
});
after(async () => { await app.close(); });

const numbers = (rows) => rows.map((r) => r.policyNumber);

test('search by lastName (case-insensitive, finds every household policy)', async () => {
  assert.deepEqual(numbers(await app.cov('alpha').searchPolicies({ lastName: 'TESTWELL' })), ['AUT-100001', 'AUT-100005']);
  assert.deepEqual(numbers(await app.cov('alpha').searchPolicies({ lastName: ' fictionova ' })), ['HOM-200001']);
});

test('search by postalCode, vin and phone', async () => {
  assert.deepEqual(numbers(await app.cov('alpha').searchPolicies({ postalCode: '53202' })), ['AUT-100002', 'HOM-200002']);
  assert.deepEqual(numbers(await app.cov('alpha').searchPolicies({ postalCode: '60601-1234' })), ['AUT-100001', 'AUT-100005', 'HOM-200001']);
  assert.deepEqual(numbers(await app.cov('alpha').searchPolicies({ vin: '1fnol00000e500006' })), ['AUT-100005']);
  assert.deepEqual(numbers(await app.cov('alpha').searchPolicies({ phone: '555.010.0101' })), ['AUT-100001']);
  assert.deepEqual(numbers(await app.cov('alpha').searchPolicies({ phone: '+1 (555) 010-0202' })), ['HOM-200002']);
});

test('criteria combine with AND; no match returns []', async () => {
  assert.deepEqual(numbers(await app.cov('alpha').searchPolicies({ lastName: 'Testwell', postalCode: '60601', vin: '1FNOL00000E500005' })), ['AUT-100005']);
  assert.deepEqual(await app.cov('alpha').searchPolicies({ lastName: 'Testwell', postalCode: '53202' }), []);
  assert.deepEqual(await app.cov('alpha').searchPolicies({ lastName: 'Nobody' }), []);
});

test('summaries carry decrypted insured names and no snapshot internals', async () => {
  const [row] = await app.cov('alpha').searchPolicies({ vin: '1FNOL00000A100001' });
  assert.equal(row.policyNumber, 'AUT-100001');
  assert.equal(row.lob, 'personal_auto');
  assert.deepEqual(row.namedInsureds, [{ name: 'Avery Testwell' }]);
  assert.equal(row.vehicleCount, 1);
  assert.ok(!('coverages' in row));
});

test('at least one criterion is required; empty values do not match everything', async () => {
  await assert.rejects(app.cov('alpha').searchPolicies({}), { code: 'bad_request' });
  await assert.rejects(app.cov('alpha').searchPolicies({ lastName: '  ' }), { code: 'bad_request' });
});

test('search uses blind indexes: a LIKE wildcard in input does not widen the match', async () => {
  assert.deepEqual(await app.cov('alpha').searchPolicies({ lastName: '%' }), []);
  assert.deepEqual(await app.cov('alpha').searchPolicies({ lastName: 'Test%' }), []);
});

test('tenant isolation: tenant A policies are invisible to tenant B', async () => {
  assert.equal((await app.cov('alpha').searchPolicies({ lastName: 'Testwell' })).length, 2);
  assert.deepEqual(await app.cov('beta').searchPolicies({ lastName: 'Testwell' }), []);
  await app.cov('beta').seedPolicies([{ ...policies[0], policyNumber: 'AUT-BETA-1', namedInsureds: [{ name: 'Robin Betatester', phone: '555-010-0999' }] }]);
  assert.deepEqual(numbers(await app.cov('beta').searchPolicies({ lastName: 'Betatester' })), ['AUT-BETA-1']);
  assert.deepEqual(await app.cov('alpha').searchPolicies({ lastName: 'Betatester' }), []);
  // Same VIN seeded in both tenants: each sees only its own row.
  assert.deepEqual(numbers(await app.cov('beta').searchPolicies({ vin: '1FNOL00000A100001' })), ['AUT-BETA-1']);
  assert.deepEqual(numbers(await app.cov('alpha').searchPolicies({ vin: '1FNOL00000A100001' })), ['AUT-100001']);
});

test('blind indexes differ per tenant (same value, different hash)', async () => {
  const rows = app.ctx.db.raw.prepare("SELECT tenant_id, vin_idx FROM coverage_policies WHERE vin_idx LIKE '%' AND policy_number IN ('AUT-100001', 'AUT-BETA-1')").all();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].vin_idx, rows[1].vin_idx);
});
