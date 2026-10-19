import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootCoverageApp } from './helpers.mjs';
import { policies } from '../../../src/modules/coverage/fixtures.mjs';

let app;
before(async () => { app = await bootCoverageApp(); });
after(async () => { await app.close(); });

test('seedPolicies returns { inserted } and stores per-tenant rows in coverage_policies', async () => {
  const out = await app.cov('alpha').seedPolicies(policies);
  assert.deepEqual(out, { inserted: policies.length });
  const rows = app.ctx.db.raw.prepare('SELECT * FROM coverage_policies WHERE tenant_id = ?').all('alpha');
  assert.equal(rows.length, policies.length);
  assert.equal(app.ctx.db.raw.prepare('SELECT COUNT(*) AS n FROM coverage_policies WHERE tenant_id = ?').get('beta').n, 0);
});

test('reseeding replaces rows instead of duplicating them', async () => {
  await app.cov('alpha').seedPolicies(policies.slice(0, 2));
  const n = app.ctx.db.raw.prepare('SELECT COUNT(*) AS n FROM coverage_policies WHERE tenant_id = ?').get('alpha').n;
  assert.equal(n, policies.length);
});

test('seedPolicies validates input', async () => {
  await assert.rejects(app.cov('alpha').seedPolicies('nope'), { code: 'bad_request' });
  await assert.rejects(app.cov('alpha').seedPolicies([{ policyNumber: 'X' }]), { code: 'bad_request' });
});

test('PII is not stored in plaintext; index columns hold only hashes', async () => {
  const rows = app.ctx.db.raw.prepare('SELECT * FROM coverage_policies WHERE tenant_id = ?').all('alpha');
  const blob = JSON.stringify(rows);
  for (const secret of ['Testwell', 'Fictionova', 'Placeholder Lane', '5550100101', '555-010-0101', '60601', 'Exampleton', 'Avery']) {
    assert.ok(!blob.includes(secret), `plaintext ${secret} leaked into coverage_policies`);
  }
  const home = rows.find((r) => r.policy_number === 'HOM-200001');
  for (const col of ['last_name_idx', 'postal_idx', 'phone_idx']) assert.match(home[col], /^,[0-9a-f]{64}(,[0-9a-f]{64})*,$/);
  assert.ok(home.vin_idx === null);
  const auto = rows.find((r) => r.policy_number === 'AUT-100001');
  assert.match(auto.vin_idx, /^,[0-9a-f]{64},$/);
  assert.ok(app.ctx.crypto.isEncrypted(auto.pii));
  assert.equal(auto.last_name_idx, `,${app.ctx.crypto.hmacIndex('alpha', 'testwell')},`);
});

test('getPolicySnapshot returns the full snapshot with PII restored and status as of the date', async () => {
  const s = await app.cov('alpha').getPolicySnapshot({ policyNumber: 'AUT-100001', asOf: '2026-09-15' });
  assert.equal(s.tenantId, 'alpha');
  assert.equal(s.status, 'in_force');
  assert.equal(s.asOfDate, '2026-09-15');
  assert.equal(s.sourceSystem, 'mock-pas');
  assert.equal(s.namedInsureds[0].name, 'Avery Testwell');
  assert.equal(s.vehicles[0].garagingPostalCode, '60601');
  assert.match(s.id, /^psn_/);
  assert.ok(s.retrievedAt);
  const home = await app.cov('alpha').getPolicySnapshot({ policyNumber: 'HOM-200001', asOf: '2026-09-15' });
  assert.equal(home.properties[0].address.postalCode, '60601');
  const expired = await app.cov('alpha').getPolicySnapshot({ policyNumber: 'AUT-100003', asOf: '2026-09-15' });
  assert.equal(expired.status, 'expired');
});

test('snapshots are cached in policy_snapshots and not duplicated for unchanged policies', async () => {
  const q = { policyNumber: 'AUT-100002', asOf: '2026-09-15' };
  const a = await app.cov('alpha').getPolicySnapshot(q);
  const b = await app.cov('alpha').getPolicySnapshot(q);
  assert.equal(a.id, b.id);
  const n = app.ctx.db.raw.prepare('SELECT COUNT(*) AS n FROM policy_snapshots WHERE tenant_id = ? AND policy_number = ?').get('alpha', 'AUT-100002').n;
  assert.equal(n, 1);
  const c = await app.cov('alpha').getPolicySnapshot({ ...q, asOf: '2026-09-16' });
  assert.notEqual(c.id, a.id);
});

test('getPolicySnapshot: not_found, bad input, and other tenants cannot see the policy', async () => {
  await assert.rejects(app.cov('alpha').getPolicySnapshot({ policyNumber: 'NOPE', asOf: '2026-09-15' }), { code: 'not_found', status: 404 });
  await assert.rejects(app.cov('alpha').getPolicySnapshot({ policyNumber: 'AUT-100001', asOf: 'yesterday' }), { code: 'bad_request' });
  await assert.rejects(app.cov('beta').getPolicySnapshot({ policyNumber: 'AUT-100001', asOf: '2026-09-15' }), { code: 'not_found' });
});

test('unknown policy adapter surfaces as a 502 upstream error', async () => {
  await assert.rejects(app.cov('broken').getPolicySnapshot({ policyNumber: 'AUT-100001', asOf: '2026-09-15' }), { code: 'upstream_error', status: 502 });
});
