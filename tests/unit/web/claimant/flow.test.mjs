import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeFlow, isUnavailable } from '../../../../src/web/claimant/flow.js';
import { fakeApi, FakeApiError, step, q } from './helpers.mjs';

function intakeApi(extra = {}) {
  const queue = [step({ question: q('loss_date', { type: 'date' }) }), step({ question: q('what_happened', { type: 'longtext' }), progress: { answered: 1, requiredRemaining: 1, percent: 50 } }), step({ done: true, question: null, progress: { answered: 2, requiredRemaining: 0, percent: 100 } })];
  return fakeApi({
    'POST /intake/sessions': () => queue[0],
    'POST /intake/sessions/:id/answers': () => queue.shift() && queue[0],
    'POST /intake/sessions/:id/submit': { id: 'c1', claimNumber: 'AUR-2026-000001', status: 'reported' },
    ...extra
  });
}

test('guided state machine: start -> ask one at a time -> ready -> submitted', async () => {
  const api = intakeApi();
  const flow = createIntakeFlow({ api, clock: { now: () => 1 }, random: () => 0.5 });
  const phases = [];
  flow.subscribe((s) => phases.push(s.phase));
  await flow.start({ lob: 'personal_auto', locale: 'en' });
  assert.deepEqual(api.calls[0].body, { lob: 'personal_auto', channel: 'claimant_web', locale: 'en' });
  assert.equal(flow.state.phase, 'asking');
  assert.equal(flow.state.question.id, 'loss_date');
  await flow.answer('loss_date', '2026-10-01');
  assert.deepEqual(api.calls.at(-1).body, { questionId: 'loss_date', value: '2026-10-01' });
  assert.equal(flow.state.question.id, 'what_happened');
  assert.equal(flow.state.progress.percent, 50);
  await flow.answer('what_happened', 'Rear ended');
  assert.equal(flow.state.phase, 'ready');
  assert.equal(flow.state.question, null);
  const claim = await flow.submit();
  assert.equal(claim.claimNumber, 'AUR-2026-000001');
  assert.equal(flow.state.phase, 'submitted');
  assert.ok(phases.includes('starting') && phases.includes('submitting'));
});

test('client never evaluates showIf: question shown is exactly what server returns', async () => {
  const api = fakeApi({
    'POST /intake/sessions': step({ question: q('a', { showIf: { eq: ['answers.zzz', 1] } }) })
  });
  const flow = createIntakeFlow({ api });
  await flow.start({ lob: 'personal_auto' });
  assert.equal(flow.state.question.id, 'a');
});

test('validation errors keep the same question and expose errors', async () => {
  const api = fakeApi({
    'POST /intake/sessions': step({ question: q('a') }),
    'POST /intake/sessions/:id/answers': step({ question: q('a'), errors: [{ questionId: 'a', message: 'Too short' }] })
  });
  const flow = createIntakeFlow({ api });
  await flow.start({ lob: 'personal_auto' });
  await flow.answer('a', 'x');
  assert.equal(flow.state.question.id, 'a');
  assert.equal(flow.state.errors[0].message, 'Too short');
});

test('submit sends a stable Idempotency-Key reused on retry', async () => {
  let fail = true;
  const api = intakeApi({
    'POST /intake/sessions/:id/submit': () => {
      if (fail) throw new FakeApiError(0, 'service_unavailable', 'down');
      return { id: 'c1', claimNumber: 'AUR-1', status: 'reported' };
    }
  });
  const flow = createIntakeFlow({ api, random: () => 0.25 });
  await flow.start({ lob: 'personal_auto' });
  await flow.answer('loss_date', 'x'); await flow.answer('what_happened', 'y');
  await flow.submit();
  assert.equal(flow.state.phase, 'unavailable');
  fail = false;
  await flow.retry();
  const submits = api.calls.filter((c) => c.path.endsWith('/submit'));
  assert.equal(submits.length, 2);
  assert.ok(submits[0].opts.headers['Idempotency-Key']);
  assert.equal(submits[0].opts.headers['Idempotency-Key'], submits[1].opts.headers['Idempotency-Key']);
  assert.equal(flow.state.phase, 'submitted');
});

test('unavailable state on start, then retry recovers', async () => {
  let up = false;
  const api = fakeApi({ 'POST /intake/sessions': () => { if (!up) throw new FakeApiError(404, 'service_unavailable', 'x'); return step({ question: q('a') }); } });
  const flow = createIntakeFlow({ api });
  await flow.start({ lob: 'personal_auto' });
  assert.equal(flow.state.phase, 'unavailable');
  assert.equal(flow.hasPendingRetry(), true);
  up = true;
  await flow.retry();
  assert.equal(flow.state.phase, 'asking');
  assert.equal(flow.hasPendingRetry(), false);
});

test('non-availability errors (422) do not enter unavailable', async () => {
  const api = fakeApi({
    'POST /intake/sessions': step({ question: q('a') }),
    'POST /intake/sessions/:id/answers': () => { throw new FakeApiError(422, 'validation_failed', 'bad'); }
  });
  const flow = createIntakeFlow({ api });
  await flow.start({ lob: 'personal_auto' });
  await flow.answer('a', 'x');
  assert.equal(flow.state.phase, 'asking');
  assert.equal(flow.state.error.code, 'validation_failed');
});

test('isUnavailable classifies errors', () => {
  assert.equal(isUnavailable(new FakeApiError(503, 'x')), true);
  assert.equal(isUnavailable(new FakeApiError(0, 'service_unavailable')), true);
  assert.equal(isUnavailable(new FakeApiError(409, 'conflict')), false);
  assert.equal(isUnavailable(new TypeError('fetch failed')), true);
});

test('real server 404 envelope (code not_found) on start is unavailable, with retry', async () => {
  let up = false;
  const api = fakeApi({ 'POST /intake/sessions': () => { if (!up) throw new FakeApiError(404, 'not_found', 'Not found'); return step({ question: q('a') }); } });
  const flow = createIntakeFlow({ api });
  await flow.start({ lob: 'auto' });
  assert.equal(flow.state.phase, 'unavailable');
  up = true;
  await flow.retry();
  assert.equal(flow.state.phase, 'asking');
});

test('isUnavailable: not_found 404 unavailable unless session-scoped', () => {
  assert.equal(isUnavailable(new FakeApiError(404, 'not_found', 'Not found')), true);
  assert.equal(isUnavailable(new FakeApiError(404, 'not_found', 'Not found'), { sessionScoped: true }), false);
});
