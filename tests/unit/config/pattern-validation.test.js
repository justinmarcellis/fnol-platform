import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../../src/modules/config/validator.js';
import { isSafePattern as intakeIsSafe } from '../../../src/modules/intake/security.js';
import { isSafePattern } from '../../../src/core/safe-pattern.mjs';

const schema = { type: 'object' };

test('validator rejects an unsafe validation.pattern with a path-naming error', () => {
  const doc = { questionSets: [{ questions: [{ id: 'q', validation: { pattern: '(a|aa)+$' } }] }] };
  const r = validate(schema, doc);
  assert.equal(r.valid, false);
  assert.equal(r.errors[0].code, 'unsafe_pattern');
  assert.equal(r.errors[0].path, '/questionSets/0/questions/0/validation/pattern');
});

test('validator rejects an unsafe rule matches value and accepts safe ones', () => {
  const bad = validate(schema, { rules: [{ when: { fact: 'claim.x', op: 'matches', value: '(a+)+' } }] });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].path, '/rules/0/when/value');
  const good = validate(schema, { rules: [{ when: { fact: 'claim.x', op: 'matches', value: '^\\d{5}$' } }], q: { validation: { pattern: '^[A-Z]{2}\\d{4}$' } } });
  assert.equal(good.valid, true, JSON.stringify(good.errors));
});

test('intake security isSafePattern is the shared checker', () => {
  assert.equal(intakeIsSafe, isSafePattern);
});
