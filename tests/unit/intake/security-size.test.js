import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call, sampleTenant } from './helpers.mjs';
import { reset } from './fakes.mjs';

let app;
let tok;
const base = '/api/v1/intake/sessions';
before(async () => {
  const cfg = sampleTenant('tn-one');
  for (let i = 0; i < 40; i++) cfg.questionSets[0].questions.push({ id: `notes_${i}`, text: { en: `n${i}` }, type: 'longtext', validation: { maxLength: 400000 }, order: 101 + i });
  app = await bootIntakeApp({ tenants: [cfg] });
  tok = app.token(['claimant'], 'tn-one', 'sz-1');
});
after(async () => { await app.close(); });
beforeEach(() => reset());
const start = async () => (await call(app, 'POST', base, { token: tok, body: { lob: 'personal_auto', channel: 'claimant_web' } })).body.sessionId;
const post = (id, items) => call(app, 'POST', `${base}/${id}/answers`, { token: tok, body: { answers: items } });

test('a structured answer over 16 KB is rejected with 400', async () => {
  const id = await start();
  await post(id, [{ questionId: 'other_party_involved', value: true }]);
  const r = await post(id, [{ questionId: 'other_party_info', value: { name: 'x'.repeat(17000) } }]);
  assert.equal(r.status, 400, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.error.code, 'answer_too_large');
});

test('a value just under 16 KB is accepted', async () => {
  const id = await start();
  await post(id, [{ questionId: 'other_party_involved', value: true }]);
  const r = await post(id, [{ questionId: 'other_party_info', value: { name: 'x'.repeat(16000) } }]);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
});

test('a session whose answers exceed 512 KB is rejected with 400 and nothing extra is stored', async () => {
  const id = await start();
  const chunk = 'y'.repeat(15000); // under the 16 KB per-answer cap
  const ok = await post(id, Array.from({ length: 30 }, (_, i) => ({ questionId: `notes_${i}`, value: chunk }))); // 450 KB
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
  const over = await post(id, Array.from({ length: 6 }, (_, i) => ({ questionId: `notes_${30 + i}`, value: chunk }))); // would reach 540 KB
  assert.equal(over.status, 400);
  assert.equal(over.body.error.code, 'answer_too_large');
  const sess = await call(app, 'GET', `${base}/${id}`, { token: tok });
  assert.equal(Object.keys(sess.body.answers).filter((k) => k.startsWith('notes_')).length, 30);
  // replacing an existing answer does not double count
  const again = await post(id, [{ questionId: 'notes_0', value: chunk }]);
  assert.equal(again.status, 200);
});
