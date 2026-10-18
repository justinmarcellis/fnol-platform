import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntakeApp, call } from './helpers.mjs';
import { reset } from './fakes.mjs';

let app;
let tok;
const base = '/api/v1/intake/sessions';
const MARK = 'ZEBRAMARKER-7731';
const narrative = `My car hit a pole yesterday and the driver hurt their neck. ${MARK}`;
const rows = () => JSON.stringify(app.ctx.db.raw.prepare('SELECT * FROM intake_sessions').all());
const docOf = (id) => JSON.parse(app.ctx.db.raw.prepare('SELECT doc FROM intake_sessions WHERE id = ?').get(id).doc);

before(async () => { app = await bootIntakeApp(); tok = app.token(['claimant'], 'tn-one', 'sg-1'); });
after(async () => { await app.close(); });
beforeEach(() => reset());

async function startWithNarrative() {
  const s = await call(app, 'POST', base, { token: tok, body: { lob: 'personal_auto', channel: 'claimant_web' } });
  const id = s.body.sessionId;
  const n = await call(app, 'POST', `${base}/${id}/narrative`, { token: tok, body: { text: narrative } });
  assert.equal(n.status, 200);
  return { id, n };
}

test('suggestions are encrypted at rest and decrypted on read', async () => {
  const { id, n } = await startWithNarrative();
  const sugg = n.body.suggestions ?? [];
  assert.ok(sugg.some((s) => String(s.value).includes(MARK)), 'suggestion returned decrypted');
  assert.ok(!rows().includes(MARK), 'raw row has no narrative text');
  assert.ok(docOf(id).suggestionsEnc, 'sealed suggestions present');
  assert.equal(docOf(id).suggestions, undefined);
  const again = await call(app, 'GET', `${base}/${id}/next-question`, { token: tok });
  assert.ok((again.body.suggestions ?? []).some((s) => String(s.value).includes(MARK)));
  // session read never exposes suggestions
  assert.equal((await call(app, 'GET', `${base}/${id}`, { token: tok })).body.suggestions, undefined);
});

test('confirming a suggestion still works (ai_extraction provenance)', async () => {
  const { id, n } = await startWithNarrative();
  const s = n.body.suggestions.find((x) => x.questionId === 'loss_description');
  const r = await call(app, 'POST', `${base}/${id}/answers`, { token: tok, body: { answers: [{ questionId: 'loss_description', value: s.value, provenance: 'ai_extraction' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal((await call(app, 'GET', `${base}/${id}`, { token: tok })).body.answers.loss_description.provenance.source, 'ai_extraction');
});

test('suggestions are purged on submit', async () => {
  const { id } = await startWithNarrative();
  const items = [
    { questionId: 'loss_date', value: '2020-01-02' }, { questionId: 'loss_description', value: 'Hit a pole.' },
    { questionId: 'injuries', value: false }, { questionId: 'vehicle_drivable', value: true },
    { questionId: 'other_party_involved', value: false }, { questionId: 'fraud_disclosure', value: true },
  ];
  assert.equal((await call(app, 'POST', `${base}/${id}/answers`, { token: tok, body: { answers: items } })).status, 200);
  assert.equal((await call(app, 'POST', `${base}/${id}/submit`, { token: tok })).status, 201);
  const d = docOf(id);
  assert.equal(d.suggestionsEnc, undefined);
  assert.equal(d.suggestions, undefined);
  assert.ok(!rows().includes(MARK));
});

test('suggestions are purged on lazy expiry and by the expiry sweep', async () => {
  const a = await startWithNarrative();
  app.ctx.db.raw.prepare('UPDATE intake_sessions SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', a.id);
  const r = await call(app, 'GET', `${base}/${a.id}/next-question`, { token: tok });
  assert.equal(r.status, 409);
  assert.equal(docOf(a.id).suggestionsEnc, undefined);

  const b = await startWithNarrative();
  app.ctx.db.raw.prepare('UPDATE intake_sessions SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', b.id);
  assert.ok(docOf(b.id).suggestionsEnc);
  assert.ok(app.intake().expireOrphaned() >= 1);
  assert.equal(docOf(b.id).suggestionsEnc, undefined);
  assert.equal(app.ctx.db.raw.prepare('SELECT status FROM intake_sessions WHERE id = ?').get(b.id).status, 'expired');
  assert.ok(!rows().includes(MARK));
});
