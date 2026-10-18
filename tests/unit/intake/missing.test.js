import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call } from './helpers.mjs';
import intakeModule from '../../../src/modules/intake/index.mjs';
import { reset } from './fakes.mjs';

let app;
let csr;
const base = '/api/v1/intake/sessions';
const A = (q, v) => ({ questionId: q, value: v });
const ids = (step) => step.missing.map((m) => m.questionId);

before(async () => { app = await bootIntakeApp(); csr = app.token(['csr'], 'tn-one', 'csr-1'); });
after(async () => { await app.close(); });
beforeEach(() => reset());

test('missing[] lists required unanswered questions, including requiredIf, and shrinks as answers arrive', async () => {
  const svc = app.intake();
  const s = await svc.startSession({ lob: 'personal_auto', channel: 'claimant_web' });
  assert.deepEqual(ids(s), ['loss_date', 'loss_description', 'injuries', 'vehicle_drivable', 'other_party_involved', 'fraud_disclosure']);
  assert.equal(s.missing[0].text, 'When did the loss happen?');
  assert.ok(!ids(s).includes('severity_band'), 'optional questions are not listed');

  const s2 = await svc.answer(s.sessionId, [A('other_party_involved', true), A('loss_date', '2026-01-01')]);
  assert.ok(ids(s2).includes('other_party_info'), 'requiredIf makes the question required');
  assert.ok(!ids(s2).includes('loss_date'));
  const s3 = await svc.answer(s.sessionId, [A('other_party_involved', false)]);
  assert.ok(!ids(s3).includes('other_party_info'));
});

test('missing[] is localized and empty when nothing is required', async () => {
  const svc = app.intake();
  const s = await svc.startSession({ lob: 'personal_auto', channel: 'claimant_web', locale: 'es' });
  assert.equal(s.missing[0].text, 'Cuando ocurrio la perdida?');
  const done = await svc.answer(s.sessionId, [
    A('loss_date', '2026-01-01'), A('loss_description', 'Short.'), A('injuries', false), A('vehicle_drivable', true),
    A('other_party_involved', false), A('fraud_disclosure', true),
  ]);
  assert.deepEqual(done.missing, []);
  assert.equal(done.done, true);
  const viaHttp = await call(app, 'GET', `${base}/${s.sessionId}/next`, { token: csr }).catch(() => null);
  if (viaHttp && viaHttp.status === 200) assert.ok(Array.isArray(viaHttp.body.missing));
});

test('startSession normalizes channel csr to csr_phone and keeps canonical values', async () => {
  const svc = app.intake();
  const alias = await svc.startSession({ lob: 'personal_auto', channel: 'csr' });
  assert.equal((await svc.getSession(alias.sessionId)).channel, 'csr_phone');
  const canon = await svc.startSession({ lob: 'personal_auto', channel: 'csr_phone' });
  assert.equal((await svc.getSession(canon.sessionId)).channel, 'csr_phone');
  const web = await svc.startSession({ lob: 'personal_auto', channel: 'agent_portal' });
  assert.equal((await svc.getSession(web.sessionId)).channel, 'agent_portal');
  await assert.rejects(svc.startSession({ lob: 'personal_auto', channel: 'carrier_pigeon' }), { code: 'unsupported_channel' });
});

test('intake event handler logs and returns when its service fails or the tenant is unknown', async () => {
  const handlers = {};
  const logs = [];
  const ctx = { log: { warn: (m, f) => logs.push([m, f]) }, forTenant: () => { throw new Error('unknown tenant'); } };
  intakeModule.subscribe({ on: (type, fn) => { handlers[type] = fn; } }, ctx);
  await assert.doesNotReject(async () => handlers['tenant.config.updated']({ id: 'e1', type: 'tenant.config.updated', tenantId: 'ghost' }));
  assert.equal(logs.length, 1);
  const tctx = { modules: { intake: { expireOrphaned: () => { throw Object.assign(new Error('gone'), { code: 'not_found' }); } } } };
  await assert.doesNotReject(async () => handlers['tenant.config.updated']({ id: 'e2', type: 'tenant.config.updated' }, tctx));
  assert.equal(logs.length, 2);
});
