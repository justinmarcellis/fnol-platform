import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootCoverageApp } from './helpers.mjs';
import { putClaim, makeClaim } from './fake-claims.mjs';
import { policies } from '../../../src/modules/coverage/fixtures.mjs';

let app;
before(async () => {
  app = await bootCoverageApp();
  await app.cov('alpha').seedPolicies(policies);
});
after(async () => { await app.close(); });

const dump = () => JSON.stringify(app.ctx.db.raw.prepare('SELECT * FROM policy_snapshots').all());

test('cacheSnapshot never stores PII in plaintext; shape unchanged on read', async () => {
  const snap = await app.cov('alpha').getPolicySnapshot({ policyNumber: 'AUT-100001', asOf: '2026-09-15' });
  assert.equal(snap.namedInsureds[0].name, 'Avery Testwell');
  const text = dump();
  assert.ok(!text.includes('Avery'), 'insured name leaked');
  assert.ok(!text.includes('Testwell'), 'insured name leaked');
  const row = app.ctx.db.raw.prepare('SELECT * FROM policy_snapshots WHERE id = ?').get(snap.id);
  assert.equal(row.policy_number, 'AUT-100001');
  assert.equal(row.as_of, '2026-09-15');
  const again = await app.cov('alpha').getPolicySnapshot({ policyNumber: 'AUT-100001', asOf: '2026-09-15' });
  assert.deepEqual(again, snap);
  assert.deepEqual(await app.cov('alpha').getSnapshotById(snap.id), snap);
});

test('verifyCoverage events and audit carry no PII', async () => {
  putClaim('alpha', makeClaim({ id: 'clm_aaaaaaaaaaaaaaaa0042', policyNumber: 'AUT-100001' }));
  await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0042');
  const out = JSON.stringify(app.ctx.bus.outbox('alpha')) + JSON.stringify(app.ctx.forTenant('alpha').audit.list({}));
  assert.ok(!out.includes('Testwell'));
});

test('legacy plaintext row is lazily rewritten encrypted on read', async () => {
  const a = app.ctx.forTenant('alpha');
  const snap = await app.cov('alpha').getPolicySnapshot({ policyNumber: 'AUT-100002', asOf: '2026-09-15' });
  a.db.run('UPDATE policy_snapshots SET doc = ? WHERE id = ?', JSON.stringify(snap), snap.id);
  assert.ok(dump().includes('Blake'));
  assert.deepEqual(await app.cov('alpha').getSnapshotById(snap.id), snap);
  assert.ok(!dump().includes('Blake'));
});

test('init sweep migrates legacy rows idempotently', async () => {
  const a = app.ctx.forTenant('alpha');
  const snap = await app.cov('alpha').getPolicySnapshot({ policyNumber: 'AUT-100003', asOf: '2026-09-15' });
  a.db.run('UPDATE policy_snapshots SET doc = ? WHERE id = ?', JSON.stringify(snap), snap.id);
  assert.ok(dump().includes('Casey'));
  assert.ok(app.cov('alpha').sweepLegacySnapshots() >= 1);
  assert.ok(!dump().includes('Casey'));
  assert.equal(app.cov('alpha').sweepLegacySnapshots(), 0);
  assert.deepEqual(await app.cov('alpha').getSnapshotById(snap.id), snap);
});
