import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call } from '../../unit/intake/helpers.mjs';
import { store, reset } from '../../unit/intake/fakes.mjs';

let app;
let token;
const base = '/api/v1/intake/sessions';
const A = (questionId, value) => ({ questionId, value });

before(async () => { app = await bootIntakeApp(); token = app.token(['claimant'], 'tn-one', 'cl-1'); });
after(async () => { await app.close(); });
beforeEach(() => reset());

async function fillSession(extra = {}) {
  const s = await call(app, 'POST', base, { token, body: { lob: 'personal_auto', lossType: 'collision', channel: 'claimant_web', policyNumber: 'POL-0001', ...extra } });
  assert.equal(s.status, 201);
  const id = s.body.sessionId;
  const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  let r = await call(app, 'POST', `${base}/${id}/answers`, { token, body: { answers: [
    A('loss_date', day), A('loss_description', 'A delivery van backed into my parked car.'), A('injuries', false), A('vehicle_drivable', true), A('other_party_involved', true),
  ] } });
  assert.equal(r.body.question.id, 'other_party_info');
  r = await call(app, 'POST', `${base}/${id}/answers`, { token, body: A('other_party_info', { firstName: 'Quincy', lastName: 'Testwell', phone: '555-0100', roles: ['third_party'] }) });
  assert.equal(r.body.question.id, 'fraud_disclosure');
  r = await call(app, 'POST', `${base}/${id}/answers`, { token, body: A('fraud_disclosure', true) });
  assert.equal(r.body.done, true);
  assert.equal(r.body.question, null);
  return { id, day };
}

test('guided session submits into claims.createClaim with a mapped ClaimCreate', async () => {
  const { id, day } = await fillSession();
  const sub = await call(app, 'POST', `${base}/${id}/submit`, { token });
  assert.equal(sub.status, 201);
  assert.equal(sub.body.status, 'reported');
  assert.equal(store.calls.length, 1);
  const { input, opts } = store.calls[0];
  assert.equal(input.lob, 'personal_auto');
  assert.equal(input.lossType, 'collision');
  assert.equal(input.channel, 'claimant_web');
  assert.equal(input.policyNumber, 'POL-0001');
  assert.equal(input.intakeSessionId, id);
  assert.equal(input.lossEvent.lossDate, day);
  assert.equal(input.lossEvent.cause, 'collision');
  assert.equal(input.lossEvent.injuriesReported, false);
  assert.equal(input.lossEvent.description, 'A delivery van backed into my parked car.');
  assert.deepEqual(input.vehicles, [{ role: 'insured', drivable: true }]);
  assert.equal(input.parties[0].firstName, 'Quincy');
  assert.deepEqual(input.parties[0].roles, ['third_party']);
  assert.deepEqual(opts.actor, { type: 'user', id: 'cl-1', role: 'claimant' });
  const sess = (await call(app, 'GET', `${base}/${id}`, { token })).body;
  assert.equal(sess.status, 'submitted');
  assert.equal(sess.claimId, sub.body.id);
  assert.ok(sess.submittedAt);
});

test('submit is idempotent: repeats and retries return the same claim and create it once', async () => {
  const { id } = await fillSession();
  const key = { 'idempotency-key': 'abc-123' };
  const [a, b] = await Promise.all([
    call(app, 'POST', `${base}/${id}/submit`, { token, headers: key }),
    call(app, 'POST', `${base}/${id}/submit`, { token, headers: key }),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.body.id, b.body.id);
  const c = await call(app, 'POST', `${base}/${id}/submit`, { token });
  assert.equal(c.body.id, a.body.id);
  assert.equal(store.claims.size, 1);
  assert.equal(store.calls[0].opts.idempotencyKey, `intake:${id}:abc-123`);
  // Answers are frozen after submit.
  const late = await call(app, 'POST', `${base}/${id}/answers`, { token, body: A('injuries', true) });
  assert.equal(late.status, 409);
});

test('incomplete session cannot be submitted (422) and creates nothing', async () => {
  const s = await call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'claimant_web' } });
  const r = await call(app, 'POST', `${base}/${s.body.sessionId}/submit`, { token });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'session_incomplete');
  assert.match(r.body.error.message, /loss_date/);
  assert.equal(store.calls.length, 0);
});

test('rule-driven required question gates submit, and block_submit rules stop it', async () => {
  const { id } = await fillSession();
  await call(app, 'POST', `${base}/${id}/answers`, { token, body: A('injuries', true) });
  let r = await call(app, 'POST', `${base}/${id}/submit`, { token });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /driver_phone/);
  await call(app, 'POST', `${base}/${id}/answers`, { token, body: A('driver_phone', '555-0111') });
  const cfg = structuredClone(app.ctx.tenants.get('tn-one'));
  const orig = structuredClone(cfg);
  cfg.version += 1;
  cfg.rules.push({ id: 'IN-BLOCK-TEST', name: 'Block', stage: 'intake', when: { fact: 'answers.injuries', op: 'eq', value: true }, then: [{ type: 'block_submit' }] });
  app.ctx.tenants.put('tn-one', cfg, 'test');
  r = await call(app, 'POST', `${base}/${id}/submit`, { token });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'submit_blocked');
  orig.version = cfg.version + 1;
  app.ctx.tenants.put('tn-one', orig, 'test');
  r = await call(app, 'POST', `${base}/${id}/submit`, { token });
  assert.equal(r.status, 201);
  assert.equal(store.calls[0].input.parties.find((p) => p.roles.includes('driver')).phone, '555-0111');
});

test('conversational flow: narrative -> confirm suggestions -> submit; provenance reaches the claim', async () => {
  const s = await call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'claimant_web' } });
  const id = s.body.sessionId;
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const n = await call(app, 'POST', `${base}/${id}/narrative`, { token, body: { text: `Collision on ${day}: a car rear-ended me at a red light. No one was injured.` } });
  const ids = n.body.suggestions.map((x) => x.questionId);
  assert.ok(ids.includes('loss_date') && ids.includes('loss_description'));
  const confirm = n.body.suggestions.filter((x) => ['loss_date', 'loss_description'].includes(x.questionId)).map((x) => ({ questionId: x.questionId, value: x.value, provenance: 'ai_extraction' }));
  let r = await call(app, 'POST', `${base}/${id}/answers`, { token, body: { answers: confirm } });
  assert.equal(r.status, 200);
  const rest = [A('injuries', false), A('vehicle_drivable', true), A('other_party_involved', false), A('fraud_disclosure', true)];
  r = await call(app, 'POST', `${base}/${id}/answers`, { token, body: { answers: rest } });
  assert.equal(r.body.done, true);
  const sub = await call(app, 'POST', `${base}/${id}/submit`, { token });
  assert.equal(sub.status, 201);
  const fp = store.calls[0].input.lossEvent.fieldProvenance;
  assert.equal(fp.lossDate.source, 'ai_extraction');
  assert.equal(fp.lossDate.confirmedBy, 'cl-1');
});

test('no-login claimant token works end to end but cannot reach other claimants sessions or staff routes', async () => {
  const { id } = await fillSession();
  const other = app.token(['claimant'], 'tn-one', 'cl-9');
  assert.equal((await call(app, 'POST', `${base}/${id}/submit`, { token: other })).status, 404);
  assert.equal(store.calls.length, 0);
  const csr = app.token(['csr'], 'tn-one', 'csr-1');
  const sub = await call(app, 'POST', `${base}/${id}/submit`, { token: csr });
  assert.equal(sub.status, 201);
  assert.equal(store.calls[0].opts.actor.role, 'csr');
});

test('tenants are isolated: same session id is invisible and claims are created in the caller tenant', async () => {
  const { id } = await fillSession();
  const t2 = app.token(['csr'], 'tn-two', 'csr-2');
  assert.equal((await call(app, 'GET', `${base}/${id}`, { token: t2 })).status, 404);
  assert.equal((await call(app, 'POST', `${base}/${id}/submit`, { token: t2 })).status, 404);
  await call(app, 'POST', `${base}/${id}/submit`, { token });
  assert.equal(store.calls[0].tenant, 'tn-one');
});
