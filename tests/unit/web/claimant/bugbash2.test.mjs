// S6-BUG-01 bug bash round 2: regression tests for S6-RA-08 (chat holder check and vehicle pick) and S6-RA-09 (question
// counter). Pure logic, no DOM; the browser side is covered in tests/ui/claimant.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeFlow } from '../../../../src/web/claimant/flow.js';
import { createChat } from '../../../../src/web/claimant/chat.js';
import { questionNumber, answeredCount } from '../../../../src/web/claimant/present.js';
import { progressText, makeTranslator } from '../../../../src/web/claimant/strings.js';
import { fakeApi, q } from './helpers.mjs';

const es = makeTranslator('es');
const t = makeTranslator('en');

/** A glass question set like the shipped tenants: the policy vehicle is an optional question ordered after the date. */
function glassApi() {
  const qs = [
    q('loss_date', { type: 'date', order: 10 }),
    q('glass_location', { type: 'select', order: 20, options: [{ value: 'windshield', label: 'Windshield' }] }),
    q('insured_vehicle', { type: 'vehicle', required: false, order: 36 }),
    q('photos', { type: 'media', required: false, order: 80 }),
    q('fraud_disclosure', { type: 'disclosure', order: 99 }),
  ];
  const answers = new Map();
  // Server-like step: next required question, unanswered optional ones, answered counts every answered question of the set.
  const stepNow = () => {
    const open = qs.filter((x) => !answers.has(x.id));
    const req = open.filter((x) => x.required);
    return {
      sessionId: 's1', done: req.length === 0, question: req[0] ?? null, optional: open.filter((x) => !x.required),
      progress: { answered: answers.size, requiredRemaining: req.length, percent: 0 },
    };
  };
  return fakeApi({
    'POST /intake/sessions': () => stepNow(),
    'POST /intake/sessions/s1/answers': (body) => { answers.set(body.questionId, body.value); return stepNow(); },
  });
}

const PICK = { year: 2023, make: 'Brightwell', model: 'Pickup 1500', policyVehicleId: 'veh-1' };

test('S6-RA-09: the vehicle picked from the policy is not counted as an answered or numbered question', async () => {
  const flow = createIntakeFlow({ api: glassApi() });
  await flow.start({ lob: 'personal_auto', lossType: 'glass', policyNumber: 'PA-XX-0000001' });
  assert.equal(flow.state.hasVehicleQuestion, true);
  await flow.setInsuredVehicle(PICK);
  let s = flow.state;
  assert.equal(s.pickedQuestionId, 'insured_vehicle');
  assert.equal(s.progress.answered, 1, 'the server counts the pick');
  assert.equal(s.question.id, 'loss_date');
  assert.equal(questionNumber(s), 1, 'first real question is question 1');
  assert.equal(answeredCount(s), 0);
  assert.equal(progressText(es, answeredCount(s), s.progress.requiredRemaining), '0 respondidas, faltan 3');
  await flow.answer('loss_date', '2026-10-10');
  s = flow.state;
  assert.equal(questionNumber(s), 2);
  assert.equal(answeredCount(s), 1);
  await flow.answer('glass_location', 'windshield');
  s = flow.state;
  assert.equal(s.question.id, 'photos');
  const photoN = questionNumber(s);
  assert.equal(photoN, 3);
  flow.skip('photos');
  s = flow.state;
  assert.equal(s.question.id, 'fraud_disclosure');
  assert.equal(questionNumber(s), 4, 'a skipped optional question keeps its own number');
  assert.notEqual(questionNumber(s), photoN);
  assert.equal(answeredCount(s), 2);
});

test('S6-RA-09: without the picker every question shown counts, the vehicle question included', async () => {
  const flow = createIntakeFlow({ api: glassApi() });
  await flow.start({ lob: 'personal_auto', lossType: 'glass' });
  await flow.answer('loss_date', '2026-10-10');
  await flow.answer('glass_location', 'windshield');
  // The vehicle question was asked in order (order 36) and answered by hand.
  let s = flow.state;
  assert.equal(questionNumber(s), 3);
  await flow.answer('insured_vehicle', { year: 2020, make: 'Typed', model: 'Car' });
  s = flow.state;
  assert.equal(s.pickedQuestionId, null);
  assert.equal(answeredCount(s), 3, 'a hand-typed vehicle is an answer the claimant gave');
  assert.equal(questionNumber(s), 4);
});

test('S6-RA-09: numbering falls back to the answered count when the history is not known', () => {
  assert.equal(questionNumber({ question: { id: 'x' }, history: [], progress: { answered: 2 } }), 3);
  assert.equal(answeredCount({ progress: { answered: 2 }, pickedQuestionId: 'insured_vehicle', answers: {} }), 2, 'a pick that did not stick is not subtracted');
  assert.equal(answeredCount({}), 0);
});

test('S6-RA-08: chat records the policy vehicle picked before the conversation, keeping the open question last', async () => {
  const flow = createIntakeFlow({ api: glassApi() });
  const chat = createChat({ flow, t });
  await flow.start({ lob: 'personal_auto', lossType: 'glass', policyNumber: 'PA-XX-0000001' });
  await flow.setInsuredVehicle(PICK);
  // The vehicle question is answered: the chat never asks it, so no manual vehicle sub-form follows.
  assert.equal(flow.state.optional.some((x) => x.id === 'insured_vehicle'), false);
  chat.recordPicked(flow.state.pickedQuestionId, '2023 Brightwell Pickup 1500');
  let m = chat.messages;
  assert.deepEqual(m.map((x) => [x.role, x.kind, x.questionId]), [
    ['assistant', 'question', 'insured_vehicle'], ['user', 'picked', 'insured_vehicle'], ['assistant', 'question', 'loss_date'],
  ]);
  assert.equal(m[0].text, 'Question insured_vehicle');
  assert.equal(m[1].text, '2023 Brightwell Pickup 1500');
  // Picking again (browser Back to the picker) replaces the answer instead of adding another pair.
  chat.recordPicked('insured_vehicle', '2021 Other Sedan');
  m = chat.messages;
  assert.equal(m.filter((x) => x.kind === 'picked').length, 1);
  assert.equal(m.find((x) => x.kind === 'picked').text, '2021 Other Sedan');
  // Nothing to record without a question or a label.
  chat.recordPicked(null, 'x'); chat.recordPicked('insured_vehicle', '');
  assert.equal(chat.messages.length, 3);
  // The chat goes on with the date question; later steps never ask for the vehicle.
  await chat.sendText('2026-10-10');
  assert.ok(!chat.messages.slice(3).some((x) => x.questionId === 'insured_vehicle'));
});

test('S6-RA-08: a chat note (for example a matched policy without vehicles) is an assistant note', async () => {
  const flow = createIntakeFlow({ api: glassApi() });
  const chat = createChat({ flow, t });
  await flow.start({ lob: 'personal_auto', lossType: 'glass' });
  chat.note('We found your policy.');
  chat.note('');
  const notes = chat.messages.filter((x) => x.kind === 'note');
  assert.deepEqual(notes.map((x) => [x.role, x.text]), [['assistant', 'We found your policy.']]);
});
