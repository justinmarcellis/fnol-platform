import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call, sampleTenant } from './helpers.mjs';
import { reset } from './fakes.mjs';
import { setCoverageLookup } from '../../../src/modules/intake/index.mjs';
import { isSafePattern, plan } from '../../../src/modules/intake/questions.js';
import { validateAnswer } from '../../../src/modules/intake/questions.js';
import { suggestFromNarrative } from '../../../src/modules/intake/conversation.js';

const base = '/api/v1/intake/sessions';
let app;
let tok;
before(async () => {
  const t = sampleTenant('tn-one');
  t.questionSets[0].questions.push({ id: 'plate', text: { en: 'Plate', es: 'Placa' }, type: 'text', order: 80, validation: { pattern: '^(a+)+$' } });
  app = await bootIntakeApp({ tenants: [t] });
  tok = (roles, sub) => app.token(roles, 'tn-one', sub);
});
after(async () => { setCoverageLookup(); await app.close(); });
beforeEach(() => { reset(); setCoverageLookup(); });

const start = (token, extra = {}) => call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'claimant_web', ...extra } });
const get = (id, token) => call(app, 'GET', `${base}/${id}`, { token });

test('claimant reaches only own sessions', async () => {
  const s = await start(tok(['claimant'], 'c1'));
  assert.equal((await get(s.body.sessionId, tok(['claimant'], 'c1'))).status, 200);
  assert.equal((await get(s.body.sessionId, tok(['claimant'], 'c2'))).status, 404);
});

test('csr and integration see any session in the tenant', async () => {
  const s = await start(tok(['claimant'], 'c1'));
  assert.equal((await get(s.body.sessionId, tok(['csr'], 'u9'))).status, 200);
  assert.equal((await get(s.body.sessionId, tok(['integration'], 'i9'))).status, 200);
});

test('agent: own sessions only, 404 on claimant session, fail closed without lookup', async () => {
  const c = await start(tok(['claimant'], 'c1'), { policyNumber: 'P-1' });
  const a = tok(['agent'], 'ag1');
  assert.equal((await get(c.body.sessionId, a)).status, 404);
  const own = await start(a);
  assert.equal((await get(own.body.sessionId, a)).status, 200);
  assert.equal((await call(app, 'POST', `${base}/${c.body.sessionId}/answers`, { token: a, body: { questionId: 'injuries', value: true } })).status, 404);
  assert.equal((await call(app, 'POST', `${base}/${c.body.sessionId}/submit`, { token: a })).status, 404);
});

test('agent reaches sessions on policies it produces (injected lookup); lookup errors fail closed', async () => {
  const c = await start(tok(['claimant'], 'c1'), { policyNumber: 'P-1' });
  const a = tok(['agent'], 'ag1');
  const seen = [];
  setCoverageLookup(async (q) => { seen.push(q); return q.policyNumber === 'P-1' && q.actor.id === 'ag1'; });
  assert.equal((await get(c.body.sessionId, a)).status, 200);
  assert.equal(seen[0].tenantId, 'tn-one');
  assert.equal((await get(c.body.sessionId, tok(['agent'], 'ag2'))).status, 404);
  setCoverageLookup(async () => { throw new Error('down'); });
  assert.equal((await get(c.body.sessionId, a)).status, 404);
  setCoverageLookup(async () => 'yes');
  assert.equal((await get(c.body.sessionId, a)).status, 404);
});

test('carrier_admin and tenant_admin are not intake roles', async () => {
  for (const r of ['carrier_admin', 'tenant_admin']) {
    const res = await call(app, 'POST', base, { token: tok([r], 'x'), body: { lob: 'personal_auto', channel: 'csr_phone' } });
    assert.equal(res.status, 403, r);
  }
});

test('narrative ai.run passes tenantId', async () => {
  const calls = [];
  const ctx = { tenant: { id: 'tn-one' }, clock: { nowIso: () => new Date().toISOString(), now: () => new Date() }, ai: { run: async (...a) => { calls.push(a); return null; } } };
  await suggestFromNarrative(ctx, 'rear-ended yesterday', { questions: [] });
  assert.equal(calls[0][0], 'extract_narrative');
  assert.equal(calls[0][2].tenantId, 'tn-one');
});

test('unsafe validation.pattern is skipped without hanging', () => {
  for (const p of ['^(a+)+$', '(a|aa)+$', '(\\w|\\d)+x$', '(a*)*b', '(a+){2,}', '(']) assert.equal(isSafePattern(p), false, p);
  for (const p of ['^[A-Z]{2}\\d{4}$', '^[A-Za-z0-9-]+$', '^\\d{3}-\\d{4}$']) assert.equal(isSafePattern(p), true, p);
  const q = { id: 'plate', type: 'text', validation: { pattern: '^(a+)+$' } };
  const t0 = Date.now();
  assert.equal(validateAnswer(q, 'a'.repeat(40) + '!'), null);
  assert.ok(Date.now() - t0 < 500);
  const safe = { id: 'p', type: 'text', validation: { pattern: '^\\d{3}$' } };
  assert.equal(validateAnswer(safe, '12x') === null, false);
  assert.equal(validateAnswer(safe, '123'), null);
});

test('submit returns only {id, claimNumber, status} to claimant and agent, including on replay', async () => {
  const answers = [
    { questionId: 'loss_date', value: '2020-01-02' }, { questionId: 'loss_description', value: 'Rear ended at a light.' },
    { questionId: 'injuries', value: false }, { questionId: 'vehicle_drivable', value: true },
    { questionId: 'other_party_involved', value: false }, { questionId: 'fraud_disclosure', value: true },
  ];
  for (const [role, sub] of [['claimant', 'c5'], ['agent', 'ag5']]) {
    const token = tok([role], sub);
    const s = await start(token);
    const a = await call(app, 'POST', `${base}/${s.body.sessionId}/answers`, { token, body: { answers } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    for (const expectStatus of [201, 201]) {
      const r = await call(app, 'POST', `${base}/${s.body.sessionId}/submit`, { token });
      assert.equal(r.status, expectStatus, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body).sort(), ['claimNumber', 'id', 'status'], role);
    }
  }
});
