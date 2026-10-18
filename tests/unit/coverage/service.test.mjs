import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootCoverageApp, call } from './helpers.mjs';
import { putClaim, makeClaim } from './fake-claims.mjs';
import { policies } from '../../../src/modules/coverage/fixtures.mjs';

let app;
before(async () => {
  app = await bootCoverageApp();
  await app.cov('alpha').seedPolicies(policies);
  await app.cov('pacific').seedPolicies(policies);
});
after(async () => { await app.close(); });

const claim = (id, o) => putClaim('alpha', makeClaim({ id, ...o }));
const events = (tenant, type) => app.ctx.bus.outbox(tenant).map((r) => JSON.parse(r.event)).filter((e) => e.type === type);

test('service exports the contract functions', () => {
  const svc = app.cov('alpha');
  for (const fn of ['getPolicySnapshot', 'searchPolicies', 'verifyCoverage', 'getLatestVerification', 'seedPolicies']) {
    assert.equal(typeof svc[fn], 'function', fn);
  }
});

test('verifyCoverage: covered claim returns status, reasons, deductible, limits and persists', async () => {
  claim('clm_aaaaaaaaaaaaaaaa0001', { policyNumber: 'AUT-100001', cause: 'collision' });
  const v = await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0001');
  assert.equal(v.status, 'in_force');
  assert.equal(v.outcome, 'covered');
  assert.deepEqual(v.deductible, { amount: 500, currency: 'USD' });
  assert.deepEqual(v.applicableDeductible, v.deductible);
  assert.deepEqual(v.applicableCoverages, ['COLL']);
  assert.deepEqual(v.matchedCoverages, ['COLL']);
  assert.ok(v.reasons.length > 0);
  assert.equal(v.tenantId, 'alpha');
  assert.equal(v.claimId, 'clm_aaaaaaaaaaaaaaaa0001');
  assert.match(v.id, /^cvr_/);
  assert.match(v.policySnapshotId, /^psn_/);
  assert.ok(v.checks.some((c) => c.code === 'policy_found' && c.passed));
  const row = app.ctx.db.raw.prepare('SELECT * FROM coverage_verifications WHERE id = ?').get(v.id);
  assert.equal(row.tenant_id, 'alpha');
  assert.equal(row.outcome, 'covered');
  assert.deepEqual(await app.cov('alpha').getLatestVerification('clm_aaaaaaaaaaaaaaaa0001'), v);
});

test('verifyCoverage: limits for liability, status for not_found, lapsed and needs_review', async () => {
  claim('clm_aaaaaaaaaaaaaaaa0002', { policyNumber: 'AUT-100001', cause: 'liability_bodily_injury' });
  const bi = await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0002');
  assert.equal(bi.limits.BI.limitPerPerson.amount, 100000);
  assert.equal(bi.deductible, null);

  claim('clm_aaaaaaaaaaaaaaaa0003', { policyNumber: 'AUT-404404', cause: 'collision' });
  const nf = await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0003');
  assert.equal(nf.status, 'not_found');
  assert.equal(nf.outcome, 'policy_not_found');
  assert.equal(nf.policySnapshotId, undefined);

  claim('clm_aaaaaaaaaaaaaaaa0004', { policyNumber: 'AUT-100003', cause: 'collision', lossDate: '2026-06-01' });
  assert.equal((await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0004')).status, 'lapsed');

  claim('clm_aaaaaaaaaaaaaaaa0005', { policyNumber: 'AUT-100001', cause: 'other' });
  const nr = await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0005');
  assert.equal(nr.status, 'needs_review');
  assert.equal(nr.outcome, 'needs_review');

  claim('clm_aaaaaaaaaaaaaaaa0006', { policyNumber: undefined, cause: 'collision' });
  assert.equal((await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0006')).status, 'needs_review');
});

test('claim.coverage.verified is published with ids and codes only (no PII), matching the event schema', async () => {
  claim('clm_aaaaaaaaaaaaaaaa0007', { policyNumber: 'HOM-200001', lob: 'homeowners', cause: 'fire' });
  const v = await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0007');
  const evt = events('alpha', 'claim.coverage.verified').find((e) => e.subject === 'clm_aaaaaaaaaaaaaaaa0007');
  assert.ok(evt);
  const allowed = ['claimId', 'verificationId', 'policySnapshotId', 'policyNumber', 'outcome', 'policyStatus', 'lossInPeriod', 'matchedCoverages', 'failedChecks'];
  assert.deepEqual(Object.keys(evt.data).filter((k) => !allowed.includes(k)), []);
  assert.equal(evt.data.verificationId, v.id);
  assert.equal(evt.data.outcome, 'covered');
  assert.equal(evt.data.policyStatus, 'in_force');
  assert.equal(evt.data.lossInPeriod, true);
  assert.deepEqual(evt.data.matchedCoverages, ['DWELLING', 'OTHER_STRUCTURES', 'PERSONAL_PROPERTY']);
  assert.deepEqual(evt.data.failedChecks, []);
  const text = JSON.stringify(evt);
  for (const pii of ['Fictionova', 'Placeholder', '555-010', 'Exampleton', '60601']) assert.ok(!text.includes(pii), pii);
  // failedChecks carries codes for a failure
  claim('clm_aaaaaaaaaaaaaaaa0008', { policyNumber: 'AUT-100002', cause: 'collision' });
  await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0008');
  const bad = events('alpha', 'claim.coverage.verified').find((e) => e.subject === 'clm_aaaaaaaaaaaaaaaa0008');
  assert.equal(bad.data.outcome, 'not_covered');
  assert.deepEqual(bad.data.failedChecks, ['coverage_present']);
});

test('verification is audited without PII', async () => {
  const entries = app.ctx.audit.list('alpha', { action: 'coverage.verified' });
  assert.ok(entries.length > 0);
  assert.ok(!JSON.stringify(entries).includes('Testwell'));
});

test('re-verification adds a new row and getLatestVerification returns the newest', async () => {
  claim('clm_aaaaaaaaaaaaaaaa0009', { policyNumber: 'AUT-100001', cause: 'hail' });
  const a = await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0009');
  app.ctx.clock.advance(60000);
  const b = await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0009');
  assert.notEqual(a.id, b.id);
  assert.equal((await app.cov('alpha').getLatestVerification('clm_aaaaaaaaaaaaaaaa0009')).id, b.id);
  assert.equal(await app.cov('alpha').getLatestVerification('clm_unknown00000000001'), null);
});

test('loss date is evaluated in the tenant time zone', async () => {
  // AUT-100001 is effective 2026-01-01. A loss at 2026-01-01T03:30Z is 2025-12-31 in Los Angeles: outside the term.
  putClaim('pacific', makeClaim({ id: 'clm_pppppppppppppppp0001', policyNumber: 'AUT-100001', lossDate: '2026-01-01T03:30:00Z' }));
  const la = await app.cov('pacific').verifyCoverage('clm_pppppppppppppppp0001');
  assert.equal(la.status, 'lapsed');
  putClaim('alpha', makeClaim({ id: 'clm_aaaaaaaaaaaaaaaa0010', policyNumber: 'AUT-100001', lossDate: '2026-01-01T07:00:00Z' }));
  assert.equal((await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0010')).status, 'in_force');
});

test('unknown claim -> not_found; policy system failure -> 502 and nothing persisted', async () => {
  await assert.rejects(app.cov('alpha').verifyCoverage('clm_doesnotexist0000001'), { code: 'not_found' });
  putClaim('broken', makeClaim({ id: 'clm_bbbbbbbbbbbbbbbb0001', policyNumber: 'AUT-100001' }));
  await assert.rejects(app.cov('broken').verifyCoverage('clm_bbbbbbbbbbbbbbbb0001'), { code: 'upstream_error', status: 502 });
  assert.equal(await app.cov('broken').getLatestVerification('clm_bbbbbbbbbbbbbbbb0001'), null);
});

test('tenant isolation: verifications are not visible across tenants', async () => {
  assert.equal(await app.cov('beta').getLatestVerification('clm_aaaaaaaaaaaaaaaa0001'), null);
});

test('HTTP: POST verify, GET coverage, GET snapshot', async () => {
  claim('clm_aaaaaaaaaaaaaaaa0011', { policyNumber: 'AUT-100001', cause: 'glass' });
  const csr = app.token(['csr']);
  const missing = await call(app, 'GET', '/api/v1/claims/clm_aaaaaaaaaaaaaaaa0011/coverage', { token: csr });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');

  const post = await call(app, 'POST', '/api/v1/claims/clm_aaaaaaaaaaaaaaaa0011/coverage/verify', { token: csr });
  assert.equal(post.status, 200);
  assert.equal(post.json.outcome, 'covered');
  assert.deepEqual(post.json.applicableCoverages, ['GLASS', 'COMP']);

  const get = await call(app, 'GET', '/api/v1/claims/clm_aaaaaaaaaaaaaaaa0011/coverage', { token: app.token(['supervisor']) });
  assert.equal(get.status, 200);
  assert.equal(get.json.verification.id, post.json.id);
  assert.equal(get.json.policy.id, post.json.policySnapshotId);
  assert.equal(get.json.policy.policyNumber, 'AUT-100001');

  const snap = await call(app, 'GET', '/api/v1/policies/AUT-100001/snapshot?asOf=2026-09-15', { token: csr });
  assert.equal(snap.status, 200);
  assert.equal(snap.json.policyNumber, 'AUT-100001');
  assert.equal((await call(app, 'GET', '/api/v1/policies/NOPE/snapshot?asOf=2026-09-15', { token: csr })).status, 404);
  assert.equal((await call(app, 'GET', '/api/v1/policies/AUT-100001/snapshot', { token: csr })).status, 400);
});

test('HTTP: roles and unknown claim', async () => {
  assert.equal((await call(app, 'POST', '/api/v1/claims/clm_aaaaaaaaaaaaaaaa0011/coverage/verify')).status, 401);
  assert.equal((await call(app, 'POST', '/api/v1/claims/clm_aaaaaaaaaaaaaaaa0011/coverage/verify', { token: app.token(['agent']) })).status, 403);
  const nf = await call(app, 'POST', '/api/v1/claims/clm_doesnotexist0000001/coverage/verify', { token: app.token(['adjuster']) });
  assert.equal(nf.status, 404);
  assert.equal(nf.json.error.code, 'not_found');
  const bad = await call(app, 'POST', '/api/v1/claims/clm_bbbbbbbbbbbbbbbb0001/coverage/verify', { token: app.token(['adjuster'], 'broken') });
  assert.equal(bad.status, 502);
  // other tenant cannot read alpha's verification
  assert.equal((await call(app, 'GET', '/api/v1/claims/clm_aaaaaaaaaaaaaaaa0011/coverage', { token: app.token(['csr'], 'beta') })).status, 404);
});
