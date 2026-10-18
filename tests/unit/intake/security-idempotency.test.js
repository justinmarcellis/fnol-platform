import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call } from './helpers.mjs';
import { reset, store } from './fakes.mjs';
import { namespacedKey } from '../../../src/modules/intake/security.js';

let app;
const base = '/api/v1/intake/sessions';
const answers = [
  { questionId: 'loss_date', value: '2020-01-02' }, { questionId: 'loss_description', value: 'Rear ended at a light.' },
  { questionId: 'injuries', value: false }, { questionId: 'vehicle_drivable', value: true },
  { questionId: 'other_party_involved', value: false }, { questionId: 'fraud_disclosure', value: true },
];
before(async () => { app = await bootIntakeApp(); });
after(async () => { await app.close(); });
beforeEach(() => reset());

async function completeSession(token) {
  const s = await call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'claimant_web' } });
  const a = await call(app, 'POST', `${base}/${s.body.sessionId}/answers`, { token, body: { answers } });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return s.body.sessionId;
}

test('client key is namespaced intake:<sessionId>:<key>; default is intake:<sessionId>', async () => {
  const t = app.token(['claimant'], 'tn-one', 'idem-1');
  const id = await completeSession(t);
  const r = await call(app, 'POST', `${base}/${id}/submit`, { token: t, headers: { 'idempotency-key': 'k-1' } });
  assert.equal(r.status, 201);
  assert.equal(store.calls.at(-1).opts.idempotencyKey, `intake:${id}:k-1`);
  const id2 = await completeSession(t);
  await call(app, 'POST', `${base}/${id2}/submit`, { token: t });
  assert.equal(store.calls.at(-1).opts.idempotencyKey, `intake:${id2}`);
});

test('the same client key in another session cannot return the first session claim', async () => {
  const a = app.token(['claimant'], 'tn-one', 'idem-a');
  const b = app.token(['claimant'], 'tn-one', 'idem-b');
  const ida = await completeSession(a);
  const idb = await completeSession(b);
  const ra = await call(app, 'POST', `${base}/${ida}/submit`, { token: a, headers: { 'idempotency-key': 'shared' } });
  const rb = await call(app, 'POST', `${base}/${idb}/submit`, { token: b, headers: { 'idempotency-key': 'shared' } });
  assert.equal(rb.status, 201);
  assert.notEqual(rb.body.id, ra.body.id);
  // a key crafted to equal the victim's default key cannot collide either
  const c = app.token(['claimant'], 'tn-one', 'idem-c');
  const idc = await completeSession(c);
  const rc = await call(app, 'POST', `${base}/${idc}/submit`, { token: c, headers: { 'idempotency-key': `intake:${ida}` } });
  assert.notEqual(rc.body.id, ra.body.id);
});

test('malformed or oversized keys are rejected with 400; helper validates', async () => {
  const t = app.token(['claimant'], 'tn-one', 'idem-d');
  const id = await completeSession(t);
  for (const k of ['x'.repeat(129), 'bad key!']) {
    const r = await call(app, 'POST', `${base}/${id}/submit`, { token: t, headers: { 'idempotency-key': k } });
    assert.equal(r.status, 400, k.slice(0, 10));
  }
  assert.equal(namespacedKey('s1', undefined), 'intake:s1');
  assert.equal(namespacedKey('s1', 'a.b'), 'intake:s1:a.b');
  assert.throws(() => namespacedKey('s1', 'a/b'));
});
