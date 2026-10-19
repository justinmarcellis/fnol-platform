import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootCoverageApp, call } from './helpers.mjs';
import { putClaim, makeClaim } from './fake-claims.mjs';
import { policies } from '../../../src/modules/coverage/fixtures.mjs';

const ID = 'clm_aaaaaaaaaaaaaaaa0088';
const URL = `/api/v1/claims/${ID}/coverage`;
let app;
before(async () => {
  app = await bootCoverageApp();
  await app.cov('alpha').seedPolicies(policies);
  putClaim('alpha', makeClaim({ id: ID, policyNumber: 'AUT-100001' }));
  await app.cov('alpha').verifyCoverage(ID);
});
after(async () => { await app.close(); });

test('GET /claims/{id}/coverage masks names for auditor and integration', async () => {
  for (const role of ['auditor', 'integration']) {
    const r = await call(app, 'GET', URL, { token: app.token([role]) });
    assert.equal(r.status, 200);
    assert.ok(r.json.policy.namedInsureds.length > 0, 'precondition: snapshot returned');
    assert.ok(!r.text.includes('Avery Testwell') && !r.text.includes('Testwell'), `${role} sees names`);
    assert.equal(r.json.policy.namedInsureds[0].name, '[redacted]');
  }
});

test('adjuster and supervisor coverage views are unchanged', async () => {
  for (const role of ['adjuster', 'supervisor']) {
    const r = await call(app, 'GET', URL, { token: app.token([role]) });
    assert.equal(r.status, 200);
    assert.equal(r.json.policy.namedInsureds[0].name, 'Avery Testwell');
    assert.ok(r.json.verification.id || r.json.verification.status);
  }
});
