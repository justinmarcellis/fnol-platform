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

const verifiedEvents = (claimId) => app.ctx.bus.outbox('alpha').map((r) => JSON.parse(r.event))
  .filter((e) => e.type === 'claim.coverage.verified' && e.subject === claimId);
const rowCount = (claimId) => app.ctx.db.raw.prepare('SELECT COUNT(*) AS n FROM coverage_verifications WHERE tenant_id = ? AND claim_id = ?').get('alpha', claimId).n;
const reported = (claimId, policyNumber) => ({
  claimId, claimNumber: 'ALP-26-000001', lob: 'personal_auto', channel: 'web', policyNumber,
  lossDate: '2026-09-15', lossCause: 'collision', reportedAt: '2026-09-16T10:00:00Z',
});

test('claim.reported triggers verifyCoverage once and publishes claim.coverage.verified', async () => {
  const id = 'clm_eeeeeeeeeeeeeeee0001';
  putClaim('alpha', makeClaim({ id, policyNumber: 'AUT-100001' }));
  app.ctx.forTenant('alpha').bus.publish('claim.reported', id, reported(id, 'AUT-100001'));
  await app.ctx.bus.drain();
  assert.equal(rowCount(id), 1);
  const [evt] = verifiedEvents(id);
  assert.equal(evt.data.outcome, 'covered');
  const v = await app.cov('alpha').getLatestVerification(id);
  assert.equal(v.id, evt.data.verificationId);
});

test('replaying the same event (outbox recovery or direct redelivery) does not verify twice', async () => {
  const id = 'clm_eeeeeeeeeeeeeeee0002';
  putClaim('alpha', makeClaim({ id, policyNumber: 'AUT-100001' }));
  const evt = app.ctx.forTenant('alpha').bus.publish('claim.reported', id, reported(id, 'AUT-100001'));
  await app.ctx.bus.drain();
  assert.equal(rowCount(id), 1);

  // Core replays pending/failed outbox rows; force that path.
  app.ctx.db.raw.prepare("UPDATE outbox SET status = 'pending' WHERE id = ?").run(evt.id);
  app.ctx.bus.recover(['alpha']);
  await app.ctx.bus.drain();
  assert.equal(rowCount(id), 1);

  // Service-level idempotency on event id, independent of core's handler dedupe.
  const again = await app.cov('alpha').verifyCoverage(id, { sourceEventId: evt.id });
  assert.equal(again.id, (await app.cov('alpha').getLatestVerification(id)).id);
  assert.equal(rowCount(id), 1);
  assert.equal(verifiedEvents(id).length, 1);
});

test('two distinct claim.reported events each verify once', async () => {
  const id = 'clm_eeeeeeeeeeeeeeee0003';
  putClaim('alpha', makeClaim({ id, policyNumber: 'AUT-100001' }));
  app.ctx.forTenant('alpha').bus.publish('claim.reported', id, reported(id, 'AUT-100001'));
  app.ctx.forTenant('alpha').bus.publish('claim.reported', id, reported(id, 'AUT-100001'));
  await app.ctx.bus.drain();
  assert.equal(rowCount(id), 2);
});

test('handler runs in the event tenant and does not touch other tenants', async () => {
  const id = 'clm_eeeeeeeeeeeeeeee0004';
  putClaim('beta', makeClaim({ id, policyNumber: 'AUT-100001' }));
  app.ctx.forTenant('beta').bus.publish('claim.reported', id, reported(id, 'AUT-100001'));
  await app.ctx.bus.drain();
  // beta has no seeded policies: policy_not_found, stored under beta only.
  const v = await app.cov('beta').getLatestVerification(id);
  assert.equal(v.status, 'not_found');
  assert.equal(v.tenantId, 'beta');
  assert.equal(await app.cov('alpha').getLatestVerification(id), null);
});

test('a claim.reported for an unknown claim fails visibly after retries, with no partial verification', async () => {
  const id = 'clm_eeeeeeeeeeeeeeee0005';
  const evt = app.ctx.forTenant('alpha').bus.publish('claim.reported', id, reported(id, 'AUT-100001'));
  await app.ctx.bus.drain();
  assert.equal(rowCount(id), 0);
  const row = app.ctx.bus.outbox('alpha').find((r) => r.id === evt.id);
  assert.equal(row.status, 'failed');
});
