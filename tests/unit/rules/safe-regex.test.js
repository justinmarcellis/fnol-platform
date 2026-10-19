import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, validateCondition, isSafeRegex } from '../../../src/modules/rules/condition.js';

test('isSafeRegex delegates to the shared checker (SEC2-013)', () => {
  for (const p of ['(a|aa)+$', '(a|a)*b', '(\\w|\\d)+x$', '(a+)+', '(a?){30}a{30}', '(a)\\1', '(?=x)x']) assert.equal(isSafeRegex(p), false, p);
  assert.equal(isSafeRegex('^[A-Z]{2}\\d{4}$'), true);
});

test('validateCondition rejects an unsafe matches value, naming the path', () => {
  const r = validateCondition({ fact: 'claim.description', op: 'matches', value: '(a|aa)+$' }, '/when');
  assert.ok(r.some((e) => e.path === '/when/value' && e.code === 'invalid_value'), JSON.stringify(r));
});

test('evaluation: safe patterns match, unsafe ones are false without hanging, long input is capped', () => {
  const facts = { claim: { description: 'AB1234', long: 'a'.repeat(300), evil: `${'a'.repeat(40)}!` } };
  const m = (fact, value) => evaluateCondition({ fact, op: 'matches', value }, facts).result;
  assert.equal(m('claim.description', '^[A-Z]{2}\\d{4}$'), true);
  assert.equal(m('claim.description', '^\\d+$'), false);
  const t0 = Date.now();
  assert.equal(m('claim.evil', '(a|aa)+$'), false);
  assert.ok(Date.now() - t0 < 50);
  assert.equal(m('claim.long', '^a+$'), false);
});
