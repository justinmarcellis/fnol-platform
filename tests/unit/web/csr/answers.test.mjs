import test from 'node:test';
import assert from 'node:assert/strict';
import { coerceAnswer, disclosureAccepted, isDisclosure, fieldType } from '../../../../src/web/csr/answers.js';
import { renderMissing, panelModel } from '../../../../src/web/csr/panel.js';
import { createAssistedIntake } from '../../../../src/web/csr/assisted.js';
import { makeT } from '../../../../src/web/csr/strings.js';
import { fakeApi, step, q } from './helpers.mjs';

const t = makeT('en');
const disc = { id: 'fraud_disclosure', type: 'disclosure', required: true };

test('disclosure answers coerce to boolean, never a string', () => {
  assert.equal(isDisclosure(disc), true);
  for (const v of [true, 'true', 'on']) assert.strictEqual(coerceAnswer(disc, v), true);
  for (const v of [false, '', 'false', undefined, 'Synthetic text']) assert.strictEqual(coerceAnswer(disc, v), false);
  assert.equal(disclosureAccepted(disc, true), true);
  assert.equal(disclosureAccepted(disc, false), false);
});

test('other types keep their coercion', () => {
  assert.strictEqual(coerceAnswer({ type: 'boolean' }, 'true'), true);
  assert.strictEqual(coerceAnswer({ type: 'boolean' }, 'false'), false);
  assert.strictEqual(coerceAnswer({ type: 'number' }, '250'), 250);
  assert.strictEqual(coerceAnswer({ type: 'text' }, 'hi'), 'hi');
  assert.equal(fieldType('phone'), 'tel');
  assert.equal(fieldType('disclosure'), 'text');
});

test('the submitted disclosure answer reaches the API as boolean true', async () => {
  const api = fakeApi({
    'POST /intake/sessions': step({ question: disc }),
    'POST /intake/sessions/s1/answers': step({ done: true }),
  });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  await f.answer(disc.id, coerceAnswer(disc, true));
  const sent = api.calls.at(-1).body;
  assert.deepEqual(sent, { questionId: 'fraud_disclosure', value: true });
  assert.strictEqual(sent.value, true);
});

// Minimal DOM stand-in.
function fakeDoc() {
  const mk = () => ({ children: [], attrs: {}, textContent: '', appendChild(c) { this.children.push(c); }, setAttribute(k, v) { this.attrs[k] = v; } });
  const ul = mk();
  Object.defineProperty(ul, 'textContent', { get() { return ''; }, set() { ul.children.length = 0; } });
  return { doc: { createElement: mk }, ul };
}

test('missing[] entries render in the panel and update after each answer', async () => {
  const api = fakeApi({
    'POST /intake/sessions': step({ question: q('a'), missing: [{ questionId: 'a', text: 'Loss date' }, { questionId: 'b', text: 'What happened' }], progress: { answered: 0, requiredRemaining: 2, percent: 0 } }),
    'POST /intake/sessions/s1/answers': step({ question: q('b'), missing: [{ questionId: 'b', text: 'What happened' }], progress: { answered: 1, requiredRemaining: 1, percent: 50 } }),
  });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'AUT-100001' });
  const { doc, ul } = fakeDoc();
  renderMissing(doc, ul, f.state, t);
  assert.deepEqual(ul.children.map((li) => li.textContent), ['Loss date', 'What happened']);
  assert.equal(ul.children[0].attrs['aria-current'], 'true');
  assert.equal(ul.children[1].attrs['aria-current'], undefined);
  await f.answer('a', 'x');
  renderMissing(doc, ul, f.state, t);
  assert.deepEqual(ul.children.map((li) => li.textContent), ['What happened']);
  assert.equal(ul.children[0].attrs['aria-current'], 'true');
});

test('empty panel says nothing is missing; unlisted count is reported', () => {
  const none = panelModel({ missing: [], unlisted: 0 }, t);
  assert.equal(none.empty, true);
  const { doc, ul } = fakeDoc();
  renderMissing(doc, ul, { missing: [], unlisted: 0 }, t);
  assert.equal(ul.children[0].textContent, t('csr.panel.none'));
  assert.match(panelModel({ missing: [], unlisted: 2 }, t).moreText, /2/);
});
