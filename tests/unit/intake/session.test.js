import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootIntakeApp, call, sampleTenant, root } from './helpers.mjs';
import { reset } from './fakes.mjs';
import { validate, fileResolver } from '../../../src/modules/config/validator.js';

let app;
let claimant;
let csr;
const A = (q, v) => ({ questionId: q, value: v });
const base = '/api/v1/intake/sessions';

before(async () => {
  app = await bootIntakeApp();
  claimant = app.token(['claimant'], 'tn-one', 'cl-1');
  csr = app.token(['csr'], 'tn-one', 'csr-1');
});
after(async () => { await app.close(); });
beforeEach(() => reset());

const start = async (extra = {}, token = claimant) => call(app, 'POST', base, { token, body: { lob: 'personal_auto', channel: 'claimant_web', ...extra } });
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

test('start returns 201 with the first question, progress and fraud disclosure', async () => {
  const r = await start();
  assert.equal(r.status, 201);
  assert.match(r.body.sessionId, /^isn_/);
  assert.equal(r.body.done, false);
  assert.equal(r.body.question.id, 'loss_date');
  assert.equal(r.body.prompt, 'When did the loss happen?');
  assert.equal(r.body.progress.requiredRemaining, 6);
  assert.equal(r.body.progress.answered, 0);
  assert.equal(r.body.disclosures.length, 1);
});

test('es locale returns Spanish prompt and messages; unknown locale falls back to en', async () => {
  const r = await start({ locale: 'es' });
  assert.equal(r.body.prompt, 'Cuando ocurrio la perdida?');
  assert.match(r.body.disclosures[0], /Aviso/);
  const bad = await call(app, 'POST', `${base}/${r.body.sessionId}/answers`, { token: claimant, body: A('loss_date', 'nope') });
  assert.equal(bad.status, 422);
  assert.match(bad.body.errors[0].message, /fecha/i);
  const fb = await start({ locale: 'fr' });
  assert.equal(fb.body.prompt, 'When did the loss happen?');
});

test('start validates body, lob, channel and tenant mismatch', async () => {
  assert.equal((await call(app, 'POST', base, { token: claimant, body: { channel: 'claimant_web' } })).status, 400);
  assert.equal((await call(app, 'POST', base, { token: claimant, body: { lob: 'personal_auto', channel: 'claimant_web', extra: 1 } })).status, 400);
  assert.equal((await start({ lob: 'boat' })).status, 422);
  assert.equal((await start({ channel: 'email' })).status, 422);
  const m = await start({ tenantId: 'tn-two' });
  assert.equal(m.status, 403);
  assert.equal(m.body.error.code, 'tenant_mismatch');
  assert.equal((await call(app, 'POST', base, { body: { lob: 'personal_auto', channel: 'claimant_web' } })).status, 401);
});

test('showIf / requiredIf drive the next question', async () => {
  const { body } = await start();
  const id = body.sessionId;
  const ans = (a) => call(app, 'POST', `${base}/${id}/answers`, { token: claimant, body: { answers: a } });
  let r = await ans([A('loss_date', yesterday()), A('loss_description', 'Another car hit mine at the corner.'), A('injuries', false), A('vehicle_drivable', true)]);
  assert.equal(r.status, 200);
  assert.equal(r.body.question.id, 'other_party_involved');
  r = await ans([A('other_party_involved', false)]);
  assert.equal(r.body.question.id, 'fraud_disclosure', 'other_party_info hidden');
  r = await ans([A('other_party_involved', true)]);
  assert.equal(r.body.question.id, 'other_party_info', 'shown and required once true');
  assert.equal(r.body.optional.some((q) => q.id === 'severity_band'), true);
  const hidden = await call(app, 'POST', `${base}/${id}/answers`, { token: claimant, body: A('other_party_info', {}) });
  assert.equal(hidden.status, 200);
});

test('answers to hidden or unknown questions are rejected without blocking valid ones', async () => {
  const { body } = await start();
  const r = await call(app, 'POST', `${base}/${body.sessionId}/answers`, { token: claimant, body: { answers: [A('other_party_info', { firstName: 'X' }), A('nope', 1), A('injuries', true)] } });
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'validation_failed');
  assert.deepEqual(r.body.errors.map((e) => e.questionId).sort(), ['nope', 'other_party_info']);
  const s = await call(app, 'GET', `${base}/${body.sessionId}`, { token: claimant });
  assert.equal(s.body.answers.injuries.value, true);
  assert.equal(s.body.answers.other_party_info, undefined);
});

test('validation: future date, bad select, wrong type, disclosure must be true', async () => {
  const { body } = await start();
  const post = (b) => call(app, 'POST', `${base}/${body.sessionId}/answers`, { token: claimant, body: b });
  assert.equal((await post(A('loss_date', '2999-01-01'))).status, 422);
  assert.equal((await post(A('loss_date', '2026-02-30'))).status, 422);
  assert.equal((await post(A('severity_band', 'huge'))).status, 422);
  assert.equal((await post(A('injuries', 'yes'))).status, 422);
  assert.equal((await post(A('fraud_disclosure', false))).status, 422);
  assert.equal((await post(A('driver_phone', 'abc'))).status, 422);
  assert.equal((await post({ nonsense: true })).status, 400);
  assert.equal((await post(A('severity_band', 'minor'))).status, 200);
});

test('a question added in tenant config appears with no code change; removed set expires sessions', async () => {
  const { body } = await start();
  const original = structuredClone(app.ctx.tenants.get('tn-one'));
  const cfg = structuredClone(original);
  cfg.version = 2;
  cfg.questionSets[0].questions.push({ id: 'roadside_needed', text: { en: 'Do you need roadside help?', es: 'Necesita asistencia vial?' }, type: 'boolean', required: true, order: 5 });
  app.ctx.tenants.put('tn-one', cfg, 'test');
  const next = await call(app, 'GET', `${base}/${body.sessionId}/next-question`, { token: claimant });
  assert.equal(next.body.question.id, 'roadside_needed');
  const fresh = await start({ locale: 'es' });
  assert.equal(fresh.body.question.id, 'roadside_needed');
  assert.equal(fresh.body.prompt, 'Necesita asistencia vial?');

  const gone = structuredClone(cfg);
  gone.version = 3;
  gone.questionSets[0].id = 'auto-renamed';
  app.ctx.tenants.put('tn-one', gone, 'test');
  const r = await call(app, 'GET', `${base}/${body.sessionId}/next-question`, { token: claimant });
  assert.equal(r.status, 409);
  assert.equal((await call(app, 'GET', `${base}/${body.sessionId}`, { token: claimant })).body.status, 'expired');
  app.ctx.tenants.put('tn-one', { ...original, version: 4 }, 'test');
});

test('intake-stage rule require_question makes an optional question required', async () => {
  const { body } = await start();
  const id = body.sessionId;
  const r = await call(app, 'POST', `${base}/${id}/answers`, { token: claimant, body: { answers: [A('loss_date', yesterday()), A('loss_description', 'Hit a pole in the dark, nobody else around.'), A('injuries', true)] } });
  assert.equal(r.body.question.id, 'vehicle_drivable');
  const s = await call(app, 'POST', `${base}/${id}/answers`, { token: claimant, body: { answers: [A('vehicle_drivable', false), A('other_party_involved', false)] } });
  assert.equal(s.body.question.id, 'driver_phone');
});

test('conversational prefill: suggestions carry provenance and need confirmation', async () => {
  const { body } = await start();
  const id = body.sessionId;
  const r = await call(app, 'POST', `${base}/${id}/narrative`, { token: claimant, body: { text: `Yesterday I was rear-ended on Main Street and my neck hurts. Date ${yesterday()}.` } });
  assert.equal(r.status, 200);
  const byQ = Object.fromEntries(r.body.suggestions.map((s) => [s.questionId, s]));
  assert.equal(byQ.loss_date.value, yesterday());
  assert.equal(byQ.injuries.value, true);
  assert.ok(byQ.loss_description);
  for (const s of r.body.suggestions) {
    assert.ok(['local', 'vertex-claude', 'vertex-gemini'].includes(s.ai.provider));
    assert.equal(typeof s.ai.model, 'string');
    assert.ok(s.ai.confidence > 0 && s.ai.confidence <= 1);
  }
  // Nothing stored until confirmed.
  assert.deepEqual((await call(app, 'GET', `${base}/${id}`, { token: claimant })).body.answers, {});
  const ok = await call(app, 'POST', `${base}/${id}/answers`, { token: claimant, body: { questionId: 'injuries', value: true, provenance: 'ai_extraction' } });
  assert.equal(ok.status, 200);
  const rec = (await call(app, 'GET', `${base}/${id}`, { token: claimant })).body.answers.injuries;
  assert.equal(rec.provenance.source, 'ai_extraction');
  assert.equal(rec.provenance.confirmedBy, 'cl-1');
  assert.equal(rec.confidence, byQ.injuries.ai.confidence);
  // Editing the value is a user answer, not an AI one.
  await call(app, 'POST', `${base}/${id}/answers`, { token: claimant, body: { questionId: 'loss_date', value: '2020-01-01', provenance: 'ai_extraction' } });
  assert.equal((await call(app, 'GET', `${base}/${id}`, { token: claimant })).body.answers.loss_date.provenance.source, 'user');
  assert.equal((await call(app, 'POST', `${base}/${id}/narrative`, { token: claimant, body: { text: '' } })).status, 400);
});

test('keyword fallback when the AI layer is absent or fails', async () => {
  const { keywordExtract } = await import('../../../src/modules/intake/conversation.js');
  const r = keywordExtract('A hailstorm dented my roof today. No one was hurt.', '2026-10-18');
  assert.equal(r.output.lossType, 'hail');
  assert.equal(r.output.lossDate, '2026-10-18');
  assert.equal(r.output.injuries, false);
  assert.equal(r.provider, 'local');
  assert.ok(r.confidence >= 0.5 && r.confidence < 1);
  assert.ok(keywordExtract('asdf', '2026-10-18').confidence < 0.2);
  // AI throws -> service still returns suggestions
  const t = app.intake();
  const orig = app.ctx.ai;
  app.ctx.ai = { run: async () => { throw new Error('down'); } };
  try {
    const s = await t.startSession({ lob: 'personal_auto', channel: 'claimant_web', actor: { type: 'user', id: 'cl-1', role: 'claimant' } });
    const step = await app.ctx.forTenant('tn-one').modules.intake.narrative(s.sessionId, 'My car was in a collision yesterday with no injuries at all.', { actor: { type: 'user', id: 'cl-1', role: 'claimant' } });
    assert.ok(step.suggestions?.length);
    assert.equal(step.suggestions[0].ai.model, 'intake-keywords-v1');
  } finally { app.ctx.ai = orig; }
});

test('claimant access is limited to own sessions; staff in tenant can read; other tenants cannot', async () => {
  const { body } = await start();
  const id = body.sessionId;
  const other = app.token(['claimant'], 'tn-one', 'cl-2');
  assert.equal((await call(app, 'GET', `${base}/${id}`, { token: other })).status, 404);
  assert.equal((await call(app, 'POST', `${base}/${id}/answers`, { token: other, body: A('injuries', true) })).status, 404);
  assert.equal((await call(app, 'GET', `${base}/${id}`, { token: csr })).status, 200);
  const foreign = app.token(['csr'], 'tn-two', 'csr-2');
  assert.equal((await call(app, 'GET', `${base}/${id}`, { token: foreign })).status, 404);
  const adjuster = app.token(['adjuster'], 'tn-one', 'adj-1');
  assert.equal((await call(app, 'GET', `${base}/${id}`, { token: adjuster })).status, 403);
});

test('PII answers are encrypted at rest and never logged or put in the audit trail', async () => {
  const { body } = await start();
  const secret = 'Zelda Quillfeather phone 555-0142';
  await call(app, 'POST', `${base}/${body.sessionId}/answers`, { token: claimant, body: A('loss_description', secret) });
  const dump = JSON.stringify(app.ctx.db.raw.prepare('SELECT * FROM intake_answers').all()) + JSON.stringify(app.ctx.db.raw.prepare('SELECT * FROM intake_sessions').all());
  assert.ok(!dump.includes('Zelda'));
  assert.ok(!JSON.stringify(app.ctx.audit.list('tn-one', {})).includes('Zelda'));
  const back = await call(app, 'GET', `${base}/${body.sessionId}`, { token: claimant });
  assert.equal(back.body.answers.loss_description.value, secret);
  assert.ok(app.ctx.bus.outbox('tn-one').every((e) => !JSON.stringify(e).includes('Zelda')));
});

test('sessions expire after the configured TTL', async () => {
  const { body } = await start();
  app.ctx.clock.advance(61 * 60000);
  try {
    const r = await call(app, 'POST', `${base}/${body.sessionId}/answers`, { token: claimant, body: A('injuries', true) });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'session_expired');
    assert.equal((await call(app, 'GET', `${base}/${body.sessionId}`, { token: claimant })).body.status, 'expired');
  } finally { app.ctx.clock.reset(); }
});

test('GET session conforms to IntakeSession.schema.json', async () => {
  const { body } = await start({ policyNumber: 'POL-100' });
  await call(app, 'POST', `${base}/${body.sessionId}/answers`, { token: claimant, body: A('injuries', false) });
  const s = (await call(app, 'GET', `${base}/${body.sessionId}`, { token: claimant })).body;
  const dir = path.join(root, 'architecture/contracts/domain');
  const schema = JSON.parse(fs.readFileSync(path.join(dir, 'IntakeSession.schema.json'), 'utf8'));
  assert.deepEqual(validate(schema, s, { resolve: fileResolver(dir) }).errors, []);
  assert.equal(s.questionSetId, 'auto-general');
  assert.equal(s.policyNumber, 'POL-100');
});

test('sample tenant helper is stable', () => {
  assert.equal(sampleTenant('x').tenantId, 'x');
});
