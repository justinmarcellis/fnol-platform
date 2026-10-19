// S6-BUG-01 bug bash round 1: regression tests for the claimant defects (CLAIMANT-3..19, DATA-15). Pure logic, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeFlow, orderQuestions } from '../../../../src/web/claimant/flow.js';
import { createChat, coerceAnswer, parseNaturalDate, looksLikeNarrative } from '../../../../src/web/claimant/chat.js';
import {
  friendlyErrorKey, lobOffersChannel, lobUsesVehicles, lobForPolicy, plausiblePolicyNumber, localizeDisclosures, validateScalar, displayAnswer, reviewRows,
} from '../../../../src/web/claimant/present.js';
import { mergeStageTimes, buildTimeline } from '../../../../src/web/claimant/status.js';
import { checkPolicyHolder } from '../../../../src/web/claimant/structured.js';
import { makeTranslator, progressText, pluralKey, claimantStrings } from '../../../../src/web/claimant/strings.js';
import { MAX_BYTES } from '../../../../src/web/claimant/upload.js';
import { fakeApi, FakeApiError, step, q } from './helpers.mjs';

const t = makeTranslator('en');
const es = makeTranslator('es');

// ---------------------------------------------------------------- CLAIMANT-4: optional questions
const homeSteps = () => {
  const date = q('loss_date', { type: 'date', order: 10 });
  const cause = q('loss_cause', { type: 'select', order: 45, options: [{ value: 'water_plumbing', label: 'Plumbing leak' }] });
  const areas = q('damaged_areas', { type: 'multiselect', required: false, order: 50, options: [{ value: 'kitchen', label: 'Kitchen' }] });
  const stopped = q('water_source_stopped', { type: 'boolean', required: false, order: 55 });
  const est = q('estimated_damage', { type: 'currency', required: false, order: 60 });
  const disc = q('fraud_disclosure', { type: 'disclosure', order: 99 });
  return { date, cause, areas, stopped, est, disc };
};

function homeApi() {
  const { date, cause, areas, stopped, est, disc } = homeSteps();
  const answered = new Set();
  const build = () => {
    const req = [date, cause, disc].filter((x) => !answered.has(x.id));
    const opt = [areas, ...(answered.has('loss_cause') ? [stopped] : []), est].filter((x) => !answered.has(x.id));
    // the server marks requiredness only in step.question/step.optional; the static flag can be false (requiredIf)
    return step({ question: req[0] ? { ...req[0], required: false } : null, optional: opt, done: req.length === 0, missing: req.map((x) => ({ questionId: x.id, text: `Text ${x.id}` })) });
  };
  return fakeApi({
    'POST /intake/sessions': () => build(),
    'POST /intake/sessions/:id/answers': (body) => { if (body.value === null || body.value === undefined) return Promise.reject(new FakeApiError(422, 'validation_failed', '1 answer(s) were not accepted')); answered.add(body.questionId); return build(); },
  });
}

test('CLAIMANT-4: optional questions from step.optional are asked in `order` and can be skipped without a request', async () => {
  const api = homeApi();
  const flow = createIntakeFlow({ api });
  await flow.start({ lob: 'homeowners' });
  assert.equal(flow.state.question.id, 'loss_date');
  assert.equal(flow.state.question.required, true, 'step.question is required by contract (requiredIf included)');
  await flow.answer('loss_date', '2026-10-01');
  assert.equal(flow.state.question.id, 'loss_cause', 'required #45 comes before optional #50');
  await flow.answer('loss_cause', 'water_plumbing');
  assert.equal(flow.state.question.id, 'damaged_areas');
  assert.equal(flow.state.question.required, false);
  const before = api.calls.length;
  assert.equal(flow.skip('damaged_areas'), true);
  assert.equal(api.calls.length, before, 'skip sends nothing (an empty value is a 422 by contract)');
  assert.equal(flow.state.question.id, 'water_source_stopped', 'shown once cause = water_plumbing');
  await flow.answer('water_source_stopped', true);
  assert.equal(flow.state.question.id, 'estimated_damage');
  flow.skip('estimated_damage');
  assert.equal(flow.state.question.id, 'fraud_disclosure');
  assert.equal(flow.skip('fraud_disclosure'), false, 'required questions cannot be skipped');
  await flow.answer('fraud_disclosure', true);
  assert.equal(flow.state.phase, 'ready');
  assert.deepEqual(flow.state.skipped.sort(), ['damaged_areas', 'estimated_damage']);
});

test('CLAIMANT-4: a done session with optional questions left asks them before review', async () => {
  const api = fakeApi({ 'POST /intake/sessions': step({ done: true, question: null, optional: [q('photos', { type: 'media', required: false, order: 80 })] }) });
  const flow = createIntakeFlow({ api });
  await flow.start({ lob: 'personal_auto' });
  assert.equal(flow.state.phase, 'asking');
  assert.equal(flow.state.question.id, 'photos');
  flow.skip('photos');
  assert.equal(flow.state.phase, 'ready');
});

test('orderQuestions sorts by order, required first on ties', () => {
  const list = orderQuestions([q('b', { order: 50, required: false }), q('a', { order: 50 }), q('c', { order: 10, required: false })]);
  assert.deepEqual(list.map((x) => x.id), ['c', 'a', 'b']);
});

// ---------------------------------------------------------------- CLAIMANT-11: back and edit
test('CLAIMANT-11: back() re-opens the previous question with its answer; answering it returns to the open question', async () => {
  const api = homeApi();
  const flow = createIntakeFlow({ api });
  await flow.start({ lob: 'homeowners' });
  assert.equal(flow.state.canGoBack, false);
  await flow.answer('loss_date', '2026-10-01');
  assert.equal(flow.state.canGoBack, true);
  assert.equal(flow.back(), true);
  assert.equal(flow.state.question.id, 'loss_date');
  assert.equal(flow.state.editing, 'loss_date');
  assert.equal(flow.state.answers.loss_date, '2026-10-01', 'previous answer offered for change');
  await flow.answer('loss_date', '2026-09-30');
  assert.equal(flow.state.editing, null);
  assert.equal(flow.state.question.id, 'loss_cause');
  await flow.answer('loss_cause', 'water_plumbing');
  flow.skip('damaged_areas'); await flow.answer('water_source_stopped', false); flow.skip('estimated_damage'); await flow.answer('fraud_disclosure', true);
  assert.equal(flow.state.phase, 'ready');
  // review Edit
  assert.equal(flow.edit('loss_cause'), true);
  assert.equal(flow.state.phase, 'asking');
  assert.equal(flow.state.question.id, 'loss_cause');
  flow.cancelEdit();
  assert.equal(flow.state.phase, 'ready');
  // back from the review goes to the last question shown
  assert.equal(flow.back(), true);
  assert.equal(flow.state.question.id, 'fraud_disclosure');
});

// ---------------------------------------------------------------- CLAIMANT-5: chat
test('CLAIMANT-5: parseNaturalDate reads the dates people type', () => {
  const today = '2026-10-19'; // a Monday
  assert.equal(parseNaturalDate('2026-10-18', today), '2026-10-18');
  assert.equal(parseNaturalDate('yesterday', today), '2026-10-18');
  assert.equal(parseNaturalDate('Ayer', today), '2026-10-18');
  assert.equal(parseNaturalDate('today', today), '2026-10-19');
  assert.equal(parseNaturalDate('3 days ago', today), '2026-10-16');
  assert.equal(parseNaturalDate('10/18/2026', today), '2026-10-18');
  assert.equal(parseNaturalDate('10/18', today), '2026-10-18');
  assert.equal(parseNaturalDate('October 18, 2026', today), '2026-10-18');
  assert.equal(parseNaturalDate('Oct 18', today), '2026-10-18');
  assert.equal(parseNaturalDate('18 de octubre', today), '2026-10-18');
  assert.equal(parseNaturalDate('December 24', today), '2025-12-24', 'no year and in the future means last year');
  assert.equal(parseNaturalDate('last Friday', today), '2026-10-16');
  assert.equal(parseNaturalDate('2026-02-30', today), null);
  assert.equal(parseNaturalDate('sometime', today), null);
});

test('CLAIMANT-5: coerceAnswer accepts natural dates, sends structured types to the form, skip words skip optional questions', () => {
  assert.deepEqual(coerceAnswer(q('loss_date', { type: 'date' }), 'yesterday', { today: '2026-10-19' }), { ok: true, value: '2026-10-18' });
  assert.deepEqual(coerceAnswer(q('loss_date', { type: 'date' }), 'later', { today: '2026-10-19' }), { ok: false, code: 'badDate' });
  assert.deepEqual(coerceAnswer(q('other_party_info', { type: 'party' }), 'Sam Quill, other driver'), { ok: false, code: 'useForm' });
  assert.deepEqual(coerceAnswer(q('photos', { type: 'media', required: false }), 'skip'), { ok: true, skip: true });
  assert.equal(coerceAnswer(q('loss_date', { type: 'date' }), 'skip').ok, false, 'required questions are not skipped');
  assert.equal(looksLikeNarrative(q('loss_date', { type: 'date' }), 'Yesterday around 5pm another car rear-ended me'), true);
  assert.equal(looksLikeNarrative(q('loss_description', { type: 'longtext' }), 'Yesterday around 5pm another car rear-ended me'), false);
});

function chatApi() {
  const date = q('loss_date', { type: 'date', order: 10 });
  const party = q('other_party_info', { type: 'party', order: 60 });
  const sugg = [{ questionId: 'loss_date', value: '2026-10-18', ai: { provider: 'local', model: 'm1', confidence: 0.7, explanation: 'Date cue' } }];
  let answered = 0;
  return fakeApi({
    'POST /intake/sessions': step({ question: date }),
    'POST /intake/sessions/:id/narrative': step({ question: date, suggestions: sugg }),
    'POST /intake/sessions/:id/answers': (body) => {
      if (body.questionId === 'loss_date' && !/^\d{4}-\d{2}-\d{2}$/.test(body.value)) {
        const e = new FakeApiError(422, 'validation_failed', '1 answer(s) were not accepted');
        e.errors = [{ questionId: 'loss_date', message: 'Enter a valid date (YYYY-MM-DD).' }];
        return Promise.reject(e);
      }
      answered += 1;
      return answered === 1 ? step({ question: party }) : step({ done: true, question: null });
    },
  });
}

test('CLAIMANT-5: a story goes to the narrative endpoint; suggestions carry provider, model, confidence, explanation', async () => {
  const api = chatApi();
  const flow = createIntakeFlow({ api });
  const chat = createChat({ flow, t, today: () => '2026-10-19' });
  await flow.start({ lob: 'personal_auto' });
  const res = await chat.sendText('Yesterday around 5pm another car rear-ended me at a light.');
  assert.equal(res.narrative, true);
  const narrativeCall = api.calls.find((c) => c.path.endsWith('/narrative'));
  assert.ok(narrativeCall, 'narrative endpoint called');
  assert.ok(!api.calls.some((c) => c.path.endsWith('/answers')), 'the story is not posted as the loss_date value');
  const sg = chat.messages.find((m) => m.kind === 'suggestion');
  assert.deepEqual(Object.keys(sg.ai).sort(), ['confidence', 'explanation', 'model', 'provider']);
  await chat.confirmSuggestion('loss_date');
  assert.deepEqual(api.calls.at(-1).body, { questionId: 'loss_date', value: '2026-10-18', provenance: 'ai_extraction' });
  assert.equal(flow.state.question.id, 'other_party_info');
  // the party question cannot be typed; it is answered from the sub-form value
  const typed = await chat.sendText('Sam Quill, other driver');
  assert.equal(typed.code, 'useForm');
  await chat.sendValue({ lastName: 'Quill', firstName: 'Sam', roles: ['third_party'], kind: 'person' }, 'Sam Quill');
  assert.equal(flow.state.phase, 'ready');
});

test('CLAIMANT-5: server errors appear once per send, never re-added, and the generic API message is not shown', async () => {
  const api = chatApi();
  const flow = createIntakeFlow({ api });
  const chat = createChat({ flow, t, today: () => '2026-10-19' });
  await flow.start({ lob: 'personal_auto' });
  // bypass client coercion to force a server 422 twice
  await flow.answer('loss_date', 'not-a-date');
  await flow.answer('loss_date', 'still-not');
  await chat.sendText('later'); // client-side message
  const errors = chat.messages.filter((m) => m.kind === 'error').map((m) => m.text);
  assert.equal(errors.filter((e) => /YYYY-MM-DD/.test(e)).length, 2, `one server message per failed send: ${errors.join(' | ')}`);
  assert.ok(!errors.some((e) => /answer\(s\)/.test(e)), 'no "1 answer(s) were not accepted"');
  assert.equal(errors.filter((e) => e === t('claimant.chat.badDate')).length, 1);
});

test('CLAIMANT-5: skip in chat moves past an optional question', async () => {
  const api = fakeApi({ 'POST /intake/sessions': step({ question: null, done: true, optional: [q('photos', { type: 'media', required: false })] }) });
  const flow = createIntakeFlow({ api });
  const chat = createChat({ flow, t });
  await flow.start({ lob: 'personal_auto' });
  assert.equal(flow.state.question.id, 'photos');
  const res = await chat.sendText('skip');
  assert.equal(res.skip, true);
  assert.equal(flow.state.phase, 'ready');
});

// ---------------------------------------------------------------- CLAIMANT-3: plain-language errors
test('CLAIMANT-3: API error codes map to plain-language, localized messages with the support phone', () => {
  assert.equal(friendlyErrorKey({ code: 'unsupported_channel' }), 'claimant.error.notOnline');
  assert.equal(friendlyErrorKey({ code: 'no_question_set' }), 'claimant.error.notOnline');
  assert.equal(friendlyErrorKey({ code: 'validation_failed' }), 'claimant.guided.fixErrors');
  assert.equal(friendlyErrorKey({ code: 'something_new' }), 'claimant.error.retry');
  assert.equal(friendlyErrorKey(null), 'claimant.error.retry');
  const msg = t(friendlyErrorKey({ code: 'unsupported_channel' }), { phone: '(555) 010-0177' });
  assert.match(msg, /Online reporting is not available for this policy type\. Call us at \(555\) 010-0177/);
  assert.doesNotMatch(msg, /claimant_web|commercial_auto/);
  assert.match(es('claimant.error.notOnline', { phone: 'X' }), /no está disponible/);
  for (const key of Object.keys(claimantStrings.en)) assert.ok(claimantStrings.es[key], `es translation for ${key}`);
});

test('CLAIMANT-3: lines that do not list the claimant_web channel are not offered online', () => {
  assert.equal(lobOffersChannel({ id: 'commercial_auto', enabled: true, channels: ['csr_phone', 'api'] }, 'claimant_web'), false);
  assert.equal(lobOffersChannel({ id: 'homeowners', enabled: true, channels: ['claimant_web'] }, 'claimant_web'), true);
  assert.equal(lobOffersChannel({ id: 'x', enabled: true }, 'claimant_web'), true, 'no channel list means every channel');
  assert.equal(lobOffersChannel({ id: 'x', enabled: false }, 'claimant_web'), false);
});

// ---------------------------------------------------------------- CLAIMANT-6 / DATA-15 / CLAIMANT-16
test('CLAIMANT-6: the holder check tells a matched holder with no vehicles apart from a failed match', async () => {
  const ok = await checkPolicyHolder(fakeApi({ 'GET /intake/sessions/:id/policy-vehicles': [] }), 's1', { lastName: 'Lockhart', zip: '60002' });
  assert.deepEqual(ok, { ok: true, vehicles: [] });
  const miss = await checkPolicyHolder(fakeApi({ 'GET /intake/sessions/:id/policy-vehicles': () => Promise.reject(new FakeApiError(404, 'not_found', 'Policy vehicles not found')) }), 's1', { lastName: 'X', zip: '00000' });
  assert.deepEqual(miss, { ok: false, reason: 'not_matched' });
  const down = await checkPolicyHolder(fakeApi({}), 's1', { lastName: 'X', zip: '00000' });
  assert.deepEqual(down, { ok: false, reason: 'unavailable' });
});

test('DATA-15: the vehicle step only applies when the question set asks for a vehicle', async () => {
  const home = createIntakeFlow({ api: homeApi() });
  await home.start({ lob: 'homeowners', policyNumber: 'HO-IL-1030185' });
  assert.equal(home.state.hasVehicleQuestion, false);
  const auto = createIntakeFlow({ api: fakeApi({ 'POST /intake/sessions': step({ question: q('loss_date', { type: 'date' }), optional: [q('insured_vehicle', { type: 'vehicle', required: false })] }) }) });
  await auto.start({ lob: 'personal_auto', policyNumber: 'PA-IL-1000001' });
  assert.equal(auto.state.hasVehicleQuestion, true);
  assert.equal(lobUsesVehicles({ id: 'homeowners', acordLobCd: 'HOME' }), false);
  assert.equal(lobUsesVehicles({ id: 'personal_auto', acordLobCd: 'AUTOP' }), true);
  assert.doesNotMatch(t('claimant.start.policyHelpGeneral'), /vehicle/i);
});

test('CLAIMANT-16: implausible policy numbers are caught when entered; the failed match names the policy', () => {
  assert.equal(plausiblePolicyNumber('ZZ-999'), false);
  assert.equal(plausiblePolicyNumber('HO-IL-1030185'), true);
  assert.equal(plausiblePolicyNumber(''), true, 'the field is optional');
  assert.match(t('claimant.holder.failed', { policy: 'PA-IL-1' }), /PA-IL-1/);
});

// ---------------------------------------------------------------- CLAIMANT-17
test('CLAIMANT-17: the policy prefix preselects the line of business', () => {
  const lobs = [{ id: 'personal_auto', acordLobCd: 'AUTOP' }, { id: 'homeowners', acordLobCd: 'HOME' }];
  assert.equal(lobForPolicy('HO-IL-1030185', lobs), 'homeowners');
  assert.equal(lobForPolicy('pa-wi-1000001', lobs), 'personal_auto');
  assert.equal(lobForPolicy('CA-MI-1421980', lobs), null, 'not offered');
  assert.equal(lobForPolicy('', lobs), null);
  assert.equal(lobForPolicy('HO-IL-1', [{ id: 'home', acordLobCd: 'HOME' }]), 'home', 'falls back to the ACORD code');
});

// ---------------------------------------------------------------- CLAIMANT-12
test('CLAIMANT-12: notices are re-localized from the tenant config; unknown text is kept', () => {
  const warn = { WI: { en: 'Illustrative notice (WI): x.', es: 'Aviso ilustrativo (WI): x.' }, MI: 'Plain notice (MI).' };
  assert.deepEqual(localizeDisclosures(['Illustrative notice (WI): x.', 'Plain notice (MI).', 'Other'], warn, 'es'), ['Aviso ilustrativo (WI): x.', 'Plain notice (MI).', 'Other']);
  assert.equal(t('claimant.role'), 'Claimant');
  assert.equal(es('claimant.role'), 'Reclamante');
});

test('CLAIMANT-12: local validation catches date and range problems in the screen language before the server does', () => {
  const date = q('loss_date', { type: 'date', validation: { notInFuture: true } });
  assert.equal(validateScalar('date', '2026-12-01', date, { today: '2026-10-19' }), 'claimant.guided.futureDate');
  assert.equal(validateScalar('date', '2026-10-01', date, { today: '2026-10-19' }), '');
  assert.equal(validateScalar('currency', '-5', q('e', { type: 'currency', validation: { min: 0 } })), 'claimant.guided.tooSmall');
});

// ---------------------------------------------------------------- CLAIMANT-14 / 19
test('CLAIMANT-14: a one-language welcome text exists without the Spanish promise', () => {
  assert.doesNotMatch(t('claimant.welcome.ledeOneLang'), /Spanish/);
  assert.match(t('claimant.welcome.lede'), /Spanish/);
});

test('CLAIMANT-19: progress text handles singular and plural', () => {
  assert.equal(progressText(es, 1, 5), '1 respondida, faltan 5');
  assert.equal(progressText(es, 2, 1), '2 respondidas, falta 1');
  assert.equal(progressText(t, 1, 1), '1 answered, 1 to go');
  assert.equal(pluralKey('x', 1), 'x.one');
  assert.equal(pluralKey('x', 0), 'x.other');
});

// ---------------------------------------------------------------- CLAIMANT-15
test('CLAIMANT-15: steps passed between two status checks keep a time; completed steps show it', () => {
  let times = mergeStageTimes({}, { status: 'validating', reportedAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T10:00:01Z' });
  assert.deepEqual(times, { reported: '2026-10-19T10:00:00Z', validating: '2026-10-19T10:00:01Z' });
  times = mergeStageTimes(times, { status: 'assigned', reportedAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T10:00:03Z' });
  assert.equal(times.validating, '2026-10-19T10:00:01Z', 'an observed time is kept');
  assert.equal(times.triaged, '2026-10-19T10:00:03Z');
  assert.equal(times.assigned, '2026-10-19T10:00:03Z');
  const items = buildTimeline({ status: 'assigned', reportedAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T10:00:03Z' }, t, times);
  for (const i of items.filter((x) => x.state === 'done')) assert.ok(i.at, `${i.id} has a time`);
  assert.equal(items.find((i) => i.state === 'current').id, 'assigned');
});

// ---------------------------------------------------------------- media answers and review
test('CLAIMANT-4: media answers read as a file count in the review; review rows keep their question id', () => {
  const photos = q('photos', { type: 'media' });
  assert.equal(displayAnswer(photos, [{ fileName: 'a.png' }, { fileName: 'b.png' }], { t }), '2 files selected');
  assert.equal(displayAnswer(q('x', { type: 'text' }), false, { t }), 'No', 'a boolean from an unseen question reads as Yes/No');
  assert.deepEqual(reviewRows([{ id: 'photos', label: 'Photos', text: '' }]), [{ id: 'photos', label: 'Photos', text: '', skipped: true }]);
  assert.equal(MAX_BYTES, 10 * 1024 * 1024, 'client limit matches the evidence service limit');
});
