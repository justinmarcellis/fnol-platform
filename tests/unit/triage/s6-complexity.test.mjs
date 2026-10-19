// S6-BUG-05 / ADJUSTER-18: a major or severe loss is never "low" complexity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeComplexity } from '../../../src/modules/triage/complexity.mjs';

const base = { partyCount: 1, vehiclesInvolved: 1, injuries: false, fatality: false, coverage: { outcome: 'covered', failedChecks: [] } };

test('severity band raises complexity: major is at least medium, severe adds two points', () => {
  assert.equal(computeComplexity(base, [], { band: 'minor' }).complexity, 'low');
  assert.equal(computeComplexity(base, [], { band: 'moderate' }).complexity, 'low');
  const major = computeComplexity(base, [], { band: 'major' });
  assert.equal(major.complexity, 'medium');
  assert.ok(major.reasons.includes('severity is major'));
  assert.equal(computeComplexity(base, [], { band: 'severe' }).complexity, 'medium');
  assert.equal(computeComplexity({ ...base, injuries: true }, [], { band: 'severe' }).complexity, 'high');
});

test('without a severity argument the old behaviour holds', () => {
  assert.equal(computeComplexity(base).complexity, 'low');
  assert.equal(computeComplexity({ ...base, injuries: true }).complexity, 'medium');
});
