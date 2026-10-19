// Glass claim through intake: the submitted ClaimCreate carries policy number and the insured vehicle from the
// policy snapshot (unit), and for tenant aurelia-mutual the created claim is coverage verified and fast tracked (integration).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../src/server.mjs';
import { sampleTenant, call, href, root } from './helpers.mjs';
import { store, reset } from './fakes.mjs';
import { policies as seedPolicies } from '../../../src/modules/coverage/fixtures.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-glass-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const GLASS_POLICY = seedPolicies.find((p) => p.policyNumber === 'AUT-100001'); // synthetic; one vehicle with GLASS cover

test('intake submit maps policy number and the insured vehicle from the policy snapshot', async () => {
  reset();
  const dir = tmp();
  const modulesDir = path.join(dir, 'modules');
  const wrap = (name, body) => { fs.mkdirSync(path.join(modulesDir, name), { recursive: true }); fs.writeFileSync(path.join(modulesDir, name, 'index.mjs'), body); };
  wrap('intake', `export { default } from '${href(path.join(root, 'src/modules/intake/index.mjs'))}';\n`);
  wrap('config', `export { default } from '${href(path.join(root, 'src/modules/config/index.mjs'))}';\n`);
  wrap('rules', `import { fakes } from '${href(path.resolve(import.meta.dirname, 'fakes.mjs'))}';\nexport default fakes.rules;\n`);
  wrap('claims', `import { fakes } from '${href(path.resolve(import.meta.dirname, 'fakes.mjs'))}';\nexport default fakes.claims;\n`);
  wrap('coverage', `export default { name: 'coverage', service: () => ({ async getPolicySnapshot({ policyNumber }) {
    if (policyNumber !== 'AUT-100001') throw new Error('not_found');
    return ${JSON.stringify(GLASS_POLICY)};
  } }) };\n`);
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  fs.writeFileSync(path.join(tenantsDir, 'tn-one.json'), JSON.stringify(sampleTenant('tn-one')));
  const app = await createApp({ dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, modulesDir, logLevel: 'silent' });
  try {
    const token = app.ctx.auth.issueToken({ sub: 'csr-1', tenantId: 'tn-one', roles: ['csr'] });
    const base = '/api/v1/intake/sessions';
    const s = await call(app, 'POST', base, { token, body: { lob: 'personal_auto', lossType: 'glass', channel: 'csr_phone', policyNumber: 'AUT-100001' } });
    assert.equal(s.status, 201);
    const A = (questionId, value) => ({ questionId, value });
    const r = await call(app, 'POST', `${base}/${s.body.sessionId}/answers`, { token, body: { answers: [
      A('loss_date', '2026-05-01'), A('loss_description', 'A stone cracked my windshield.'), A('injuries', false), A('vehicle_drivable', true), A('other_party_involved', false), A('fraud_disclosure', true),
    ] } });
    assert.equal(r.body.done, true, JSON.stringify(r.body));
    const sub = await call(app, 'POST', `${base}/${s.body.sessionId}/submit`, { token });
    assert.equal(sub.status, 201);
    const { input } = store.calls.at(-1);
    assert.equal(input.policyNumber, 'AUT-100001');
    const veh = input.vehicles.find((v) => v.role === 'insured');
    assert.equal(veh.vin, '1FNOL00000A100001');
    assert.equal(veh.policyVehicleId, 'V1');
    assert.equal(veh.drivable, true, 'answer-derived fields are kept');
  } finally {
    await app.close();
  }
});

test('aurelia-mutual: glass claim from CSR intake is coverage verified and fast tracked', async () => {
  const dir = tmp();
  const app = await createApp({ dbPath: path.join(dir, 'g.db'), port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir: path.join(root, 'tenants'), logLevel: 'silent', devMode: true });
  try {
    const tid = 'aurelia-mutual';
    const tctx = app.ctx.forTenant(tid);
    await tctx.modules.coverage.seedPolicies([GLASS_POLICY]);
    app.ctx.clock.set('2026-05-04T15:00:00.000Z');
    const token = app.ctx.auth.issueToken({ sub: 'csr-glass', tenantId: tid, roles: ['csr'] });
    const base = '/api/v1/intake/sessions';
    const s = await call(app, 'POST', base, { token, body: { lob: 'personal_auto', lossType: 'glass', channel: 'csr_phone', policyNumber: 'AUT-100001' } });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const id = s.body.sessionId;
    let step = s.body;
    for (let i = 0; i < 40 && step.question; i += 1) {
      const qn = step.question;
      const value = { date: '2026-05-01', boolean: qn.id === 'injuries' ? false : true, select: qn.options?.[0]?.value, disclosure: true, text: 'Windshield', longtext: 'A stone cracked my windshield.' }[qn.type];
      assert.notEqual(value, undefined, `cannot answer ${qn.id} (${qn.type})`);
      const res = await call(app, 'POST', `${base}/${id}/answers`, { token, body: { questionId: qn.id, value } });
      assert.equal(res.status, 200, `answer ${qn.id}: ${JSON.stringify(res.body)}`);
      step = res.body;
    }
    const sub = await call(app, 'POST', `${base}/${id}/submit`, { token });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    await app.ctx.bus.drain();
    const claim = await tctx.modules.claims.getClaim(sub.body.id, { include: ['vehicles'] });
    assert.equal(claim.policyNumber, 'AUT-100001');
    assert.equal(claim.vehicles.find((v) => v.role === 'insured')?.policyVehicleId, 'V1');
    const cov = await tctx.modules.coverage.getLatestVerification(claim.id);
    assert.equal(cov?.outcome, 'covered', JSON.stringify(cov?.reasons));
    assert.notEqual(claim.checks.coverage, 'needs_review');
    assert.equal(claim.checks.coverage, 'covered');
    const routing = await tctx.modules.rules.getRoutingDecision(claim.id);
    const fastTracked = claim.status === 'fast_tracked' || routing?.fastTrack === true || (claim.flags ?? []).includes('fast_track') || routing?.outcome === 'fast_track';
    assert.equal(claim.status, 'fast_tracked');
    assert.ok(fastTracked, `status=${claim.status} routing=${JSON.stringify(routing)} flags=${JSON.stringify(claim.flags)}`);
  } finally {
    app.ctx.clock.reset?.();
    await app.close();
  }
});
