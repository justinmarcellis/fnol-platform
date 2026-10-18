import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafePattern, runPattern } from '../../../src/modules/intake/security.js';
import { validateAnswer } from '../../../src/modules/intake/questions.js';

const unsafe = ['(a+)+$', '^(a+)+$', 'a+*', 'a**', '^a*a*a*a*a*a*b', '.*.*x', 'a*b?a*c', '(a?){1,50}a{30}', '(a?){30}a{30}', '(a|a)*', '(a|b)+c', '(x+x+)+y', '(\\d+)*$', '(a)\\1', '(?=a)a', 'x'.repeat(201), '(', 'a)', '[a'];
const safe = ['^\\+?[0-9 ().-]{7,20}$', '^\\d{5}(-\\d{4})?$', '^[A-Z]{2}-\\d{3,4}$', '^[A-Za-z0-9 -]+$', '^CLM-\\d+$', '.*foo.*', '^(\\d{3}-){2}\\d{4}$', '^(?:AB|CD)\\d{4}$', '^\\w+@\\w+\\.com$'];

test('unsafe patterns are rejected', () => {
  for (const p of unsafe) assert.equal(isSafePattern(p), false, p.slice(0, 30));
});

test('ordinary patterns still pass', () => {
  for (const p of safe) assert.equal(isSafePattern(p), true, p);
});

test('unsafe patterns are skipped without hanging; safe ones are enforced', () => {
  const q = (pattern) => ({ id: 'x', type: 'text', validation: { pattern } });
  const t0 = Date.now();
  assert.equal(validateAnswer(q('^a*a*a*a*a*a*b'), 'a'.repeat(120)), null);
  assert.equal(validateAnswer(q('(a?){30}a{30}'), 'a'.repeat(30)), null);
  assert.ok(Date.now() - t0 < 500);
  assert.match(validateAnswer(q('^\\d{5}$'), 'abcde'), /format/i);
  assert.equal(validateAnswer(q('^\\d{5}$'), '12345'), null);
});

test('input to a pattern question is capped at 200 characters', () => {
  const q = { id: 'x', type: 'text', validation: { pattern: '^[a-z]+$', maxLength: 1000 } };
  assert.equal(validateAnswer(q, 'a'.repeat(200)), null);
  assert.match(validateAnswer(q, 'a'.repeat(201)), /format/i);
});

test('evaluation is time-boxed: a catastrophic regex is cut off', () => {
  const re = /^(a+)+$/;
  const t0 = Date.now();
  assert.equal(runPattern(re, `${'a'.repeat(60)}!`, 50), null);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
  assert.equal(runPattern(/^\d+$/, '123'), true);
  assert.equal(runPattern(/^\d+$/, 'x'), false);
});
