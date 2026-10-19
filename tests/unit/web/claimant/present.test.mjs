// Presentation helpers and string tables for the S6-EXP-03 claimant redesign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, stageNumber, segmentFills, validateScalar, vehicleCard, displayAnswer, reviewRows, nextStepKey } from '../../../../src/web/claimant/present.js';
import { claimantStrings, makeTranslator } from '../../../../src/web/claimant/strings.js';

const t = makeTranslator('en');
const fmt = { date: (v) => `D(${v})`, dateTime: (v) => `DT(${v})`, money: (v) => `$${v}`, enumLabel: (v) => `E(${v})` };

test('stages: four steps, numbered from 1, unknown is 0', () => {
  assert.deepEqual(STAGES, ['details', 'questions', 'review', 'done']);
  assert.equal(stageNumber('details'), 1);
  assert.equal(stageNumber('done'), 4);
  assert.equal(stageNumber('welcome'), 0);
});

test('segmentFills: earlier steps full, later empty, questions follow progress with a visible minimum', () => {
  assert.deepEqual(segmentFills('details'), [100, 0, 0, 0]);
  assert.deepEqual(segmentFills('questions', 50), [100, 50, 0, 0]);
  assert.deepEqual(segmentFills('questions', 0), [100, 8, 0, 0]);
  assert.deepEqual(segmentFills('review'), [100, 100, 100, 0]);
  assert.deepEqual(segmentFills('done'), [100, 100, 100, 100]);
  assert.deepEqual(segmentFills('nope'), [0, 0, 0, 0]);
  assert.deepEqual(segmentFills('questions', 250), [100, 100, 0, 0]);
});

test('validateScalar: email, phone and number problems return a message key; empty and valid pass', () => {
  assert.equal(validateScalar('email', 'name@example.com'), '');
  assert.equal(validateScalar('email', 'name@'), 'claimant.guided.invalidEmail');
  assert.equal(validateScalar('phone', '(555) 010-0142'), '');
  assert.equal(validateScalar('phone', '12345'), 'claimant.guided.invalidPhone');
  assert.equal(validateScalar('number', '12.5'), '');
  assert.equal(validateScalar('currency', 'abc'), 'claimant.guided.invalidNumber');
  assert.equal(validateScalar('text', 'anything'), '');
  assert.equal(validateScalar('email', ''), '');
  assert.equal(validateScalar('email', undefined), '');
  for (const key of ['claimant.guided.invalidEmail', 'claimant.guided.invalidPhone', 'claimant.guided.invalidNumber']) {
    assert.ok(claimantStrings.en[key] && claimantStrings.es[key], key);
  }
});

test('vehicleCard: title from year make model, VIN last four parsed from the label', () => {
  const c = vehicleCard({ unitId: 'u1', label: '2024 Tamsin Compact (VIN ...7389)', answer: { year: 2024, make: 'Tamsin', model: 'Compact' } });
  assert.deepEqual(c, { title: '2024 Tamsin Compact', last4: '7389' });
  assert.deepEqual(vehicleCard({ unitId: 'u2', label: 'Van (VIN ...0001)', answer: {} }), { title: 'Van', last4: '0001' });
  assert.deepEqual(vehicleCard({ unitId: 'u3', label: 'u3' }), { title: 'u3', last4: '' });
});

test('displayAnswer: humanizes every value type and never shows raw tokens', () => {
  const d = (q, v) => displayAnswer(q, v, { t, locale: 'en', fmt });
  assert.equal(d({ type: 'boolean' }, true), 'Yes');
  assert.equal(d({ type: 'boolean' }, false), 'No');
  assert.equal(d({ type: 'disclosure' }, true), 'I have read and understand');
  assert.equal(d({ type: 'select', options: [{ value: 'rear_end', label: 'Rear-end collision' }] }, 'rear_end'), 'Rear-end collision');
  assert.equal(d({ type: 'select', options: [] }, 'not_listed'), 'E(not_listed)');
  assert.equal(d({ type: 'multiselect', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: { en: 'Bravo', es: 'Bravo!' } }] }, ['a', 'b']), 'Alpha, Bravo');
  assert.equal(d({ type: 'date' }, '2026-09-10'), 'D(2026-09-10)');
  assert.equal(d({ type: 'datetime' }, '2026-09-10T10:00'), 'DT(2026-09-10T10:00)');
  assert.equal(d({ type: 'currency' }, '250'), '$250');
  assert.equal(d({ type: 'text' }, 'hello'), 'hello');
  assert.equal(d({ type: 'text' }, ''), '');
  assert.equal(d({ type: 'text' }, undefined), '');
  assert.equal(d({ type: 'party' }, { firstName: 'Pat', lastName: 'Example', roles: ['third_party'], phone: '(555) 010-0142' }), 'Pat Example, E(third_party), (555) 010-0142');
  assert.equal(d({ type: 'vehicle' }, { year: 2022, make: 'Tamsin', model: 'Compact', licensePlate: 'ABC123' }), '2022 Tamsin Compact, ABC123');
  assert.equal(d({ type: 'address' }, { line1: '1 Example St', city: 'Springfield', state: 'WI', postalCode: '53000' }), '1 Example St, Springfield, WI 53000');
});

test('reviewRows: answers in order, empty text is flagged skipped', () => {
  const m = new Map([['a', { label: 'A?', text: 'Yes' }], ['b', { label: 'B?', text: '' }]]);
  assert.deepEqual(reviewRows(m), [{ label: 'A?', text: 'Yes', skipped: false }, { label: 'B?', text: '', skipped: true }]);
  assert.deepEqual(reviewRows(undefined), []);
});

test('nextStepKey and string tables: every claim status has a what-happens-next sentence in en and es', () => {
  assert.equal(nextStepKey('in_review'), 'claimant.next.in_review');
  assert.equal(nextStepKey(undefined), 'claimant.next.reported');
  for (const s of ['reported', 'validating', 'triaged', 'assigned', 'fast_tracked', 'in_review', 'pending_info', 'closed', 'withdrawn']) {
    assert.ok(claimantStrings.en[nextStepKey(s)], `en ${s}`);
    assert.ok(claimantStrings.es[nextStepKey(s)], `es ${s}`);
  }
});

test('en and es string tables have exactly the same keys, and es differs from en for visible copy', () => {
  const en = Object.keys(claimantStrings.en).sort();
  const es = Object.keys(claimantStrings.es).sort();
  assert.deepEqual(en, es);
  const same = en.filter((k) => claimantStrings.en[k] === claimantStrings.es[k] && /[a-z]{4,}/.test(claimantStrings.en[k]));
  assert.ok(same.length <= 6, `untranslated: ${same.join(', ')}`);
});
