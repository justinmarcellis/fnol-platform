import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, validateCondition, resolveFact, ConditionError, OPERATORS, isSafeRegex } from '../../../src/modules/rules/condition.js';

const facts = {
  loss: { cause: 'glass', injuriesReported: false, lossDate: '2026-09-15', note: 'Cracked Windshield on I-94' },
  triage: { severityScore: 12, fraud: { score: 40 } },
  vehicles: [{ drivable: true, make: 'A' }, { drivable: false, make: 'B' }],
  parties: [{ role: 'insured' }, { role: 'claimant' }, { role: 'witness' }],
  answers: { tags: ['a', 'b'], zero: 0, nothing: null },
  now: '2026-09-20T12:00:00Z',
};
const leaf = (fact, op, value) => ({ fact, op, ...(value === undefined ? {} : { value }) });
const run = (c, f = facts) => evaluateCondition(c, f);

test('every operator is covered by a positive and a negative case', () => {
  const cases = [
    ['eq', leaf('loss.cause', 'eq', 'glass'), leaf('loss.cause', 'eq', 'hail')],
    ['ne', leaf('loss.cause', 'ne', 'hail'), leaf('loss.cause', 'ne', 'glass')],
    ['in', leaf('loss.cause', 'in', ['glass', 'hail']), leaf('loss.cause', 'in', ['hail'])],
    ['nin', leaf('loss.cause', 'nin', ['hail']), leaf('loss.cause', 'nin', ['glass'])],
    ['gt', leaf('triage.severityScore', 'gt', 11), leaf('triage.severityScore', 'gt', 12)],
    ['gte', leaf('triage.severityScore', 'gte', 12), leaf('triage.severityScore', 'gte', 13)],
    ['lt', leaf('triage.severityScore', 'lt', 13), leaf('triage.severityScore', 'lt', 12)],
    ['lte', leaf('triage.severityScore', 'lte', 12), leaf('triage.severityScore', 'lte', 11)],
    ['between', leaf('triage.severityScore', 'between', [12, 20]), leaf('triage.severityScore', 'between', [13, 20])],
    ['exists', leaf('loss.cause', 'exists'), leaf('loss.nope', 'exists')],
    ['missing', leaf('loss.nope', 'missing'), leaf('loss.cause', 'missing')],
    ['contains', leaf('answers.tags', 'contains', 'b'), leaf('answers.tags', 'contains', 'z')],
    ['matches', leaf('loss.cause', 'matches', '^gl.+s$'), leaf('loss.cause', 'matches', '^hail')],
    ['any_eq', leaf('vehicles[*].drivable', 'any_eq', false), leaf('vehicles[*].make', 'any_eq', 'Z')],
    ['count_gte', leaf('parties', 'count_gte', 3), leaf('parties', 'count_gte', 4)],
    ['within_days', leaf('loss.lossDate', 'within_days', 7), leaf('loss.lossDate', 'within_days', 2)],
  ];
  assert.deepEqual(cases.map((c) => c[0]).sort(), [...OPERATORS].sort());
  for (const [op, yes, no] of cases) {
    assert.equal(run(yes).result, true, `${op} should match`);
    assert.equal(run(no).result, false, `${op} should not match`);
  }
});

test('trace entries carry fact, op, value, actual and result', () => {
  const { result, trace } = run({ all: [leaf('loss.cause', 'eq', 'glass'), leaf('triage.severityScore', 'lt', 10)] });
  assert.equal(result, false);
  assert.deepEqual(trace, [
    { fact: 'loss.cause', op: 'eq', value: 'glass', actual: 'glass', result: true },
    { fact: 'triage.severityScore', op: 'lt', value: 10, actual: 12, result: false },
  ]);
});

test('combinators short-circuit, so skipped leaves are not traced', () => {
  const all = run({ all: [leaf('loss.cause', 'eq', 'hail'), leaf('loss.cause', 'eq', 'glass')] });
  assert.equal(all.trace.length, 1);
  const any = run({ any: [leaf('loss.cause', 'eq', 'glass'), leaf('loss.cause', 'eq', 'hail')] });
  assert.equal(any.result, true);
  assert.equal(any.trace.length, 1);
});

test('not inverts the result and keeps the leaf trace', () => {
  const r = run({ not: leaf('loss.cause', 'eq', 'glass') });
  assert.equal(r.result, false);
  assert.equal(r.trace[0].result, true);
});

test('boolean constants need no trace', () => {
  assert.deepEqual(run(true), { result: true, trace: [] });
  assert.deepEqual(run(false), { result: false, trace: [] });
});

test('a missing fact makes comparisons false except missing and ne', () => {
  for (const op of ['eq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'matches', 'any_eq', 'count_gte', 'within_days', 'exists']) {
    const value = op === 'in' || op === 'nin' ? ['x'] : op === 'between' ? [1, 2] : 1;
    assert.equal(run(leaf('loss.nope', op, value)).result, false, op);
  }
  assert.equal(run(leaf('loss.nope', 'ne', 'x')).result, true);
  assert.equal(run(leaf('loss.nope', 'missing')).result, true);
  assert.equal(run(leaf('answers.nothing', 'missing')).result, true, 'null counts as missing');
  assert.equal(run(leaf('answers.zero', 'exists')).result, true, 'zero is present');
  assert.equal(run(leaf('answers.zero', 'eq', 0)).result, true);
});

test('no type coercion: strings do not equal numbers and non-dates do not compare', () => {
  assert.equal(run(leaf('triage.severityScore', 'eq', '12')).result, false);
  assert.equal(run(leaf('loss.cause', 'gt', 'a')).result, false);
  assert.equal(run(leaf('triage.severityScore', 'gt', '5')).result, false);
});

test('ISO dates compare as dates; between is inclusive', () => {
  assert.equal(run(leaf('loss.lossDate', 'lt', '2026-09-16')).result, true);
  assert.equal(run(leaf('loss.lossDate', 'gte', '2026-09-15')).result, true);
  assert.equal(run(leaf('loss.lossDate', 'between', ['2026-09-15', '2026-09-30'])).result, true);
  assert.equal(run(leaf('triage.severityScore', 'between', [12, 12])).result, true);
});

test('projection and indexing', () => {
  assert.deepEqual(resolveFact(facts, 'vehicles[*].make'), ['A', 'B']);
  assert.equal(resolveFact(facts, 'vehicles[1].make'), 'B');
  assert.equal(resolveFact(facts, 'vehicles[5].make'), undefined);
  assert.equal(resolveFact(facts, 'triage.fraud.score'), 40);
  assert.equal(resolveFact({}, 'vehicles[*].make'), undefined);
  assert.equal(run(leaf('vehicles[*].make', 'exists')).result, true);
  assert.equal(run(leaf('vehicles[*].colour', 'exists')).result, false);
  assert.equal(run(leaf('vehicles', 'count_gte', 2)).result, true);
});

test('contains: array membership and case-insensitive substring', () => {
  assert.equal(run(leaf('loss.note', 'contains', 'windshield')).result, true);
  assert.equal(run(leaf('loss.note', 'contains', 'sedan')).result, false);
  assert.equal(run(leaf('loss.cause', 'contains', 5)).result, false);
});

test('within_days: against now, or against another fact via { of, days }', () => {
  assert.equal(run(leaf('loss.lossDate', 'within_days', 6)).result, true);
  assert.equal(run(leaf('loss.lossDate', 'within_days', 5)).result, false);
  assert.equal(run(leaf('loss.lossDate', 'within_days', { of: 'loss.lossDate', days: 0 })).result, true);
  assert.equal(run(leaf('loss.lossDate', 'within_days', 5), { loss: { lossDate: '2026-09-15' } }).result, false, 'no now fact');
});

test('matches only runs safe, short patterns', () => {
  assert.equal(isSafeRegex('^a+$'), true);
  assert.equal(isSafeRegex('(a+)+$'), false);
  assert.equal(isSafeRegex('(?=x)x'), false);
  assert.equal(isSafeRegex('(a)\\1'), false);
  assert.equal(isSafeRegex('x'.repeat(201)), false);
  assert.equal(isSafeRegex('('), false);
  assert.equal(run(leaf('loss.cause', 'matches', '(g+)+')).result, false);
});

test('evaluation is pure: facts are not mutated and results repeat', () => {
  const snap = JSON.stringify(facts);
  const c = { all: [leaf('vehicles[*].drivable', 'any_eq', true), leaf('loss.cause', 'in', ['glass'])] };
  const a = run(c);
  assert.equal(JSON.stringify(facts), snap);
  assert.deepEqual(run(c), a);
});

test('malformed conditions throw ConditionError', () => {
  assert.throws(() => run(leaf('loss.cause', 'zap', 1)), (e) => e instanceof ConditionError && e.code === 'invalid_condition');
  assert.throws(() => run({ all: 'x' }), ConditionError);
  assert.throws(() => run(null), ConditionError);
  assert.throws(() => run({ fact: 'loss.cause' }), ConditionError);
});

test('validateCondition reports paths and codes', () => {
  assert.deepEqual(validateCondition(leaf('loss.cause', 'eq', 'x'), '/w'), []);
  assert.deepEqual(validateCondition(true), []);
  const codes = (c) => validateCondition(c, '/w').map((e) => `${e.path}:${e.code}`);
  assert.deepEqual(codes(leaf('loss.cause', 'zap', 1)), ['/w/op:unknown_op']);
  assert.deepEqual(codes(leaf('bogus.x', 'eq', 1)), ['/w/fact:unknown_fact_root']);
  assert.deepEqual(codes({ all: [] }), ['/w/all:invalid_condition']);
  assert.deepEqual(codes({ any: [true, leaf('loss.cause', 'in', 'x')] }), ['/w/any/1/value:invalid_value']);
  assert.deepEqual(codes(leaf('loss.cause', 'between', [1])), ['/w/value:invalid_value']);
  assert.deepEqual(codes(leaf('loss.cause', 'matches', '(a+)+')), ['/w/value:invalid_value']);
  assert.deepEqual(codes(leaf('loss.cause', 'count_gte', 'x')), ['/w/value:invalid_value']);
  assert.deepEqual(codes(leaf('loss.cause', 'within_days', { of: 'loss.x', days: 'x' })), ['/w/value:invalid_value']);
  assert.deepEqual(codes({ not: leaf('loss.cause', 'zap') }), ['/w/not/op:unknown_op']);
  assert.deepEqual(codes('nope'), ['/w:invalid_condition']);
});
