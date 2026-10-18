import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSprint, closeSprint } from '../../../org/sprint.mjs';

const tickets = [
  { id: 'A', sprint: 2, points: 3, status: 'done', spend: { usd: 0.5 }, review: { firstPass: true, reworkCount: 0 } },
  { id: 'B', sprint: 2, points: 5, status: 'done', spend: { usd: 1.5 }, review: { firstPass: false, reworkCount: 1 } },
  { id: 'C', sprint: 2, points: 8, status: 'in_progress', spend: { usd: 1 } },
  { id: 'D', sprint: 3, points: 13, status: 'ready' },
];
const tmp = () => mkdtempSync(join(tmpdir(), 'sprint-'));
const read = (dir, n) => JSON.parse(readFileSync(join(dir, `sprint-${n}.json`), 'utf8'));

test('planSprint sums points and preserves existing fields', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'sprint-2.json'), JSON.stringify({ number: 2, goal: 'g', status: 'active', startedAt: 'x', targets: { budgetUsd: 9 }, retro: { went_well: ['a'] } }));
  const s = planSprint(2, { tickets, dir });
  assert.equal(s.committedPoints, 16);
  assert.deepEqual(s.committed, ['A', 'B', 'C']);
  const f = read(dir, 2);
  assert.equal(f.goal, 'g'); assert.equal(f.status, 'active'); assert.equal(f.startedAt, 'x');
  assert.deepEqual(f.targets, { budgetUsd: 9, committedPoints: 16 });
  assert.deepEqual(f.retro, { went_well: ['a'] });
});

test('planSprint creates a missing file and handles empty sprints', () => {
  const dir = tmp();
  assert.equal(planSprint(7, { tickets, dir }).committedPoints, 0);
  assert.equal(read(dir, 7).status, 'planned');
});

test('closeSprint writes review metrics and keeps retro', () => {
  const dir = tmp();
  planSprint(2, { tickets, dir });
  const f = read(dir, 2); f.retro = { went_badly: ['x'] }; f.review = { shipped: ['thing'] };
  writeFileSync(join(dir, 'sprint-2.json'), JSON.stringify(f));
  const s = closeSprint(2, { tickets, quality: { testsTotal: 40, testsPassed: 38 }, dir });
  assert.equal(s.status, 'closed');
  assert.deepEqual(s.review, {
    shipped: ['thing'], completedPoints: 8, committedPoints: 16, usd: 3, pointsPerDollar: 2.7,
    firstPassAcceptance: 0.5, reworkRate: 0.5, testPassRate: 0.95, testsPassed: '38/40',
  });
  assert.deepEqual(read(dir, 2).retro, { went_badly: ['x'] });
  assert.ok(read(dir, 2).closedAt);
});

test('closeSprint guards divide-by-zero and missing quality', () => {
  const dir = tmp();
  const s = closeSprint(9, { tickets: [], quality: null, dir });
  assert.equal(s.review.pointsPerDollar, null);
  assert.equal(s.review.firstPassAcceptance, null);
  assert.equal(s.review.testPassRate, null);
});
