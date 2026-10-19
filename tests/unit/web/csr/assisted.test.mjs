import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistedIntake, scriptedPrompt, claimLink, CSR_CHANNEL } from '../../../../src/web/csr/assisted.js';
import { makeT } from '../../../../src/web/csr/strings.js';
import { fakeApi, FakeApiError, step, q } from './helpers.mjs';

const t = makeT('en');

function intakeApi(extra = {}) {
  const steps = [
    step({ question: q('loss_date', { type: 'date', help: 'Ask for the date the loss happened.' }) }),
    step({ question: q('what_happened', { text: { en: 'What happened?', es: 'Que paso?' }, help: { en: 'Let the caller talk first.' } }), progress: { answered: 1, requiredRemaining: 2, percent: 33 } }),
    step({ done: true, progress: { answered: 2, requiredRemaining: 0, percent: 100 } }),
  ];
  let i = 0;
  return fakeApi({
    'POST /intake/sessions': () => steps[i],
    'POST /intake/sessions/:id/answers': () => steps[++i],
    'POST /intake/sessions/:id/submit': { id: 'clm_1', claimNumber: 'NWD-2026-000001', status: 'reported' },
    ...extra,
  });
}

test('start sends channel csr_phone with policyNumber and lob', async () => {
  const api = intakeApi();
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  assert.deepEqual(api.calls[0].body, { lob: 'personal_auto', channel: CSR_CHANNEL, locale: 'en', policyNumber: 'AUT-100001' });
  assert.equal(CSR_CHANNEL, 'csr_phone');
  assert.equal(f.state.phase, 'asking');
});

test('side panel lists missing required items and how many more are unlisted', async () => {
  const f = createAssistedIntake({ api: intakeApi(), t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  assert.deepEqual(f.state.missing, [{ id: 'loss_date', text: 'Question loss_date' }]);
  assert.equal(f.state.unlisted, 2);
  await f.answer('loss_date', '2026-10-01');
  assert.deepEqual(f.state.missing.map((m) => m.id), ['what_happened']);
  assert.equal(f.state.unlisted, 1);
  await f.answer('what_happened', 'Rear ended');
  assert.deepEqual(f.state.missing, []);
  assert.equal(f.state.unlisted, 0);
  assert.equal(f.state.phase, 'ready');
});

test('uses server-provided missing[] when present', async () => {
  const api = fakeApi({ 'POST /intake/sessions': step({ question: q('a'), missing: [{ questionId: 'a', text: 'A' }, { questionId: 'b', text: { en: 'B item' } }], progress: { answered: 0, requiredRemaining: 2, percent: 0 } }) });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'P-1' });
  assert.deepEqual(f.state.missing.map((m) => m.text), ['A', 'B item']);
  assert.equal(f.state.unlisted, 0);
});

test('scripted prompt comes from question text and help text', async () => {
  const f = createAssistedIntake({ api: intakeApi(), t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  assert.equal(f.state.script.ask, 'Please ask the caller: "Question loss_date"');
  assert.equal(f.state.script.help, 'Guidance: Ask for the date the loss happened.');
  await f.answer('loss_date', '2026-10-01');
  assert.match(f.state.script.text, /What happened\?.*Let the caller talk first\./);
  assert.equal(scriptedPrompt(q('x'), { t }).help, '');
  assert.equal(scriptedPrompt(null, { t }).text, t('csr.script.done'));
  assert.match(scriptedPrompt(q('x', { text: { en: 'E', es: 'Ese' } }), { t: makeT('es'), locale: 'es' }).ask, /Ese/);
});

test('answer posts questionId/value to the session', async () => {
  const api = intakeApi();
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  await f.answer('loss_date', '2026-10-01');
  assert.equal(api.calls[1].path, '/intake/sessions/s1/answers');
  assert.deepEqual(api.calls[1].body, { questionId: 'loss_date', value: '2026-10-01' });
});

test('submit shows claim number, link, and reuses one Idempotency-Key', async () => {
  let n = 0;
  const api = intakeApi({ 'POST /intake/sessions/:id/submit': () => { if (n++ === 0) throw new FakeApiError(0, 'service_unavailable'); return { id: 'clm_1', claimNumber: 'NWD-2026-000001' }; } });
  const f = createAssistedIntake({ api, t, clock: { now: () => 5 }, random: () => 0.5 });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  await f.answer('loss_date', 'x'); await f.answer('what_happened', 'y');
  assert.equal(await f.submit(), null);
  assert.equal(f.state.phase, 'unavailable');
  const claim = await f.retry();
  assert.equal(claim.claimNumber, 'NWD-2026-000001');
  assert.equal(f.state.phase, 'submitted');
  const keys = api.calls.filter((c) => c.path.endsWith('/submit')).map((c) => c.opts.headers['Idempotency-Key']);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(claimLink(claim), '/csr?claim=clm_1');
  assert.equal(claimLink(null), '');
});

test('submit is refused until the server says done', async () => {
  const api = intakeApi();
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  assert.equal(await f.submit(), null);
  assert.equal(api.calls.filter((c) => c.path.endsWith('/submit')).length, 0);
});

test('unavailable on start (missing endpoint) then retry recovers', async () => {
  let up = false;
  const api = fakeApi({ 'POST /intake/sessions': () => { if (!up) throw new FakeApiError(404, 'route_not_found'); return step({ question: q('a') }); } });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'P-1' });
  assert.equal(f.state.phase, 'unavailable');
  up = true;
  await f.retry();
  assert.equal(f.state.phase, 'asking');
});

test('validation error (422) keeps the question and is not "unavailable"', async () => {
  const api = intakeApi({ 'POST /intake/sessions/:id/answers': () => { throw new FakeApiError(422, 'validation_failed', 'bad date'); } });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  await f.answer('loss_date', 'nope');
  assert.equal(f.state.phase, 'asking');
  assert.equal(f.state.error.code, 'validation_failed');
});
