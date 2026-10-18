import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeFlow } from '../../../../src/web/claimant/flow.js';
import { createChat, coerceAnswer } from '../../../../src/web/claimant/chat.js';
import { makeTranslator } from '../../../../src/web/claimant/strings.js';
import { fakeApi, step, q } from './helpers.mjs';

const t = makeTranslator('en');
const ai = { provider: 'local', model: 'rules-1', confidence: 0.82, explanation: 'From your narrative' };

function setup() {
  const answers = [];
  const api = fakeApi({
    'POST /intake/sessions': step({ question: q('what_happened', { type: 'longtext', text: 'What happened?' }), suggestions: [{ questionId: 'loss_type', value: 'collision', ai }] }),
    'POST /intake/sessions/:id/answers': (body) => {
      answers.push(body);
      return step({ done: true, question: null, progress: { answered: 2, requiredRemaining: 0, percent: 100 } });
    }
  });
  const flow = createIntakeFlow({ api });
  const chat = createChat({ flow, t });
  return { api, flow, chat, answers };
}

test('transcript shows assistant question then free-text answer', async () => {
  const { flow, chat, answers } = setup();
  await flow.start({ lob: 'personal_auto' });
  assert.equal(chat.messages[0].role, 'assistant');
  assert.equal(chat.messages[0].text, 'What happened?');
  await chat.sendText('I was rear-ended');
  assert.deepEqual(answers[0], { questionId: 'what_happened', value: 'I was rear-ended' });
  const roles = chat.messages.map((m) => m.role);
  assert.ok(roles.includes('user'));
  assert.equal(chat.messages.at(-1).kind, 'done');
});

test('AI prefill appears as pending suggestion with provenance and can be confirmed', async () => {
  const { flow, chat, answers } = setup();
  await flow.start({ lob: 'personal_auto' });
  const sg = chat.messages.find((m) => m.kind === 'suggestion');
  assert.equal(sg.status, 'pending');
  assert.equal(sg.ai.provider, 'local');
  assert.equal(sg.ai.explanation, 'From your narrative');
  assert.equal(answers.length, 0, 'not sent until confirmed');
  await chat.confirmSuggestion('loss_type');
  assert.deepEqual(answers[0], { questionId: 'loss_type', value: 'collision' });
  assert.equal(chat.messages.find((m) => m.kind === 'suggestion').status, 'confirmed');
});

test('AI prefill can be edited before saving', async () => {
  const { flow, chat, answers } = setup();
  await flow.start({ lob: 'personal_auto' });
  await chat.editSuggestion('loss_type', 'hit and run');
  assert.deepEqual(answers[0], { questionId: 'loss_type', value: 'hit and run' });
  assert.equal(chat.messages.find((m) => m.kind === 'suggestion').status, 'edited');
});

test('coerceAnswer handles types without calling the API', () => {
  assert.deepEqual(coerceAnswer({ type: 'number' }, '$1,200'), { ok: true, value: 1200 });
  assert.equal(coerceAnswer({ type: 'number' }, 'lots').code, 'badNumber');
  assert.deepEqual(coerceAnswer({ type: 'boolean' }, 'Yes'), { ok: true, value: true });
  assert.deepEqual(coerceAnswer({ type: 'boolean' }, 'sí'), { ok: true, value: true });
  const sel = { type: 'select', options: [{ value: 'rear', label: { en: 'Rear end' } }] };
  assert.deepEqual(coerceAnswer(sel, 'rear end'), { ok: true, value: 'rear' });
  assert.equal(coerceAnswer(sel, 'side').code, 'pickOne');
  assert.equal(coerceAnswer({ type: 'text' }, '   ').code, 'empty');
});

test('invalid select text yields a clarifying message and no API call', async () => {
  const api = fakeApi({ 'POST /intake/sessions': step({ question: q('side', { type: 'select', options: [{ value: 'l', label: 'Left' }] }) }) });
  const flow = createIntakeFlow({ api });
  const chat = createChat({ flow, t });
  await flow.start({ lob: 'personal_auto' });
  await chat.sendText('nope');
  assert.equal(api.calls.filter((c) => c.path.endsWith('/answers')).length, 0);
  assert.match(chat.messages.at(-1).text, /Left/);
});
