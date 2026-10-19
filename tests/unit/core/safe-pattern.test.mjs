import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isSafePattern, matchWithBudget, compileSafePattern, MAX_PATTERN_INPUT } from '../../../src/core/safe-pattern.mjs';

const pathological = ['(a|aa)+$', '(a|a)*b', '(\\w|\\d)+x$', '(a+)+', '^a*a*a*a*a*a*b', '.*.*.*.*.*x', '(a?){30}a{30}'];
const malformed = ['', '(', 'a)', '[a', 'a+*', 'a**', '(a)\\1', '\\k<x>', '(?=a)a', '(?<n>a)', 'a{51}', 'a{1,51}', 'x'.repeat(201), '*a', 'a{2,1}', '(\\d+)*$', '(x+x+)+y'];
const fine = ['^\\+?[0-9 ().-]{7,20}$', '^\\d{5}(-\\d{4})?$', '^[A-Z]{2}-\\d{3,4}$', '^[A-Za-z0-9 -]+$', '^CLM-\\d+$', '.*foo.*', '^(\\d{3}-){2}\\d{4}$', '^(?:AB|CD)\\d{4}$', '^\\w+@\\w+\\.com$'];

test('pathological patterns are rejected quickly', () => {
  for (const p of pathological) {
    const t0 = performance.now();
    assert.equal(isSafePattern(p), false, p);
    assert.ok(performance.now() - t0 < 50, p);
  }
});

test('malformed and out-of-grammar patterns are rejected', () => {
  for (const p of malformed) assert.equal(isSafePattern(p), false, p.slice(0, 30));
  for (const p of [null, undefined, 5, {}]) assert.equal(isSafePattern(p), false);
});

test('ordinary patterns are accepted', () => {
  for (const p of fine) assert.equal(isSafePattern(p), true, p);
});

test('every pattern in tenants/*.json is accepted', () => {
  const found = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (typeof n.pattern === 'string' && n.validation === undefined && Object.keys(n).length === 1) found.push(n.pattern);
    if (n.validation && typeof n.validation.pattern === 'string') found.push(n.validation.pattern);
    if (n.op === 'matches' && typeof n.value === 'string') found.push(n.value);
    Object.values(n).forEach(walk);
  };
  for (const f of fs.readdirSync(new URL('../../../tenants/', import.meta.url)).filter((x) => x.endsWith('.json'))) {
    walk(JSON.parse(fs.readFileSync(new URL(`../../../tenants/${f}`, import.meta.url), 'utf8')));
  }
  for (const p of found) assert.equal(isSafePattern(p), true, p);
});

test('matchWithBudget caps input at 200 chars and never matches unsafe patterns', () => {
  assert.equal(matchWithBudget('^\\d+$', '123'), true);
  assert.equal(matchWithBudget('^\\d+$', 'x'), false);
  assert.equal(matchWithBudget('^a+$', 'a'.repeat(MAX_PATTERN_INPUT)), true);
  assert.equal(matchWithBudget('^a+$', 'a'.repeat(MAX_PATTERN_INPUT + 1)), false);
  assert.equal(matchWithBudget('(a+)+$', 'aaa'), false);
  assert.equal(matchWithBudget('^a$', 5), false);
});

test('matchWithBudget time-boxes a vetted-by-caller catastrophic RegExp', () => {
  const t0 = Date.now();
  assert.equal(matchWithBudget(/^(a+)+$/, `${'a'.repeat(60)}!`, { maxInput: 100, timeoutMs: 50 }), null);
  assert.ok(Date.now() - t0 < 2000);
});

test('compileSafePattern returns a RegExp or null', () => {
  assert.ok(compileSafePattern('^a$') instanceof RegExp);
  assert.equal(compileSafePattern('(a+)+'), null);
});
