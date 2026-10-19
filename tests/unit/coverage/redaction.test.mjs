import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootCoverageApp, call } from './helpers.mjs';
import { putClaim, makeClaim } from './fake-claims.mjs';
import { policies } from '../../../src/modules/coverage/fixtures.mjs';
import { redactSnapshot, canSeePii, REDACTED } from '../../../src/modules/coverage/redact.mjs';

let app;
before(async () => {
  app = await bootCoverageApp();
  await app.cov('alpha').seedPolicies(policies);
  putClaim('alpha', makeClaim({ id: 'clm_aaaaaaaaaaaaaaaa0077', policyNumber: 'AUT-100001' }));
  await app.cov('alpha').verifyCoverage('clm_aaaaaaaaaaaaaaaa0077');
});
after(async () => { await app.close(); });

const snapUrl = '/api/v1/policies/AUT-100001/snapshot?asOf=2026-09-15';
const covUrl = '/api/v1/claims/clm_aaaaaaaaaaaaaaaa0077/coverage';

test('integration role gets masked names on snapshot and coverage', async () => {
  const token = app.token(['integration']);
  const s = await call(app, 'GET', snapUrl, { token });
  assert.equal(s.status, 200);
  assert.equal(s.json.namedInsureds[0].name, REDACTED);
  assert.ok(!s.text.includes('Testwell'));
  const c = await call(app, 'GET', covUrl, { token });
  assert.equal(c.status, 200);
  assert.ok(!c.text.includes('Testwell'));
});

test('auditor is masked on coverage; csr sees clear text', async () => {
  const c = await call(app, 'GET', covUrl, { token: app.token(['auditor']) });
  assert.equal(c.status, 200);
  assert.equal(c.json.policy.namedInsureds[0].name, REDACTED);
  const clear = await call(app, 'GET', snapUrl, { token: app.token(['csr']) });
  assert.equal(clear.json.namedInsureds[0].name, 'Avery Testwell');
});

test('PII_ROLES rule: tenant_admin clear, auditor/integration masked; masks addresses and garaging', () => {
  assert.ok(canSeePii({ roles: ['tenant_admin'] }));
  assert.ok(!canSeePii({ roles: ['auditor'] }) && !canSeePii({ roles: ['integration'] }));
  const r = redactSnapshot({
    namedInsureds: [{ name: 'X Y', relation: 'primary' }], drivers: [{ driverId: 'D1', name: 'Z' }],
    vehicles: [{ unitId: 'V1', garagingPostalCode: '55555' }], properties: [{ locationId: 'L1', address: { line1: '1 Test St' } }],
  });
  assert.equal(r.namedInsureds[0].name, REDACTED);
  assert.equal(r.namedInsureds[0].relation, 'primary');
  assert.equal(r.drivers[0].name, REDACTED);
  assert.equal(r.vehicles[0].garagingPostalCode, REDACTED);
  assert.equal(r.properties[0].address, REDACTED);
});
