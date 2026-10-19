import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testArgs, parseTap } from '../../../dashboard/quality-report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('testArgs mirrors package.json scripts.test globs, not the tests/ directory', () => {
  const script = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.test;
  const expected = [...script.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]).filter((t) => t !== 'node');
  const args = testArgs();
  assert.ok(!args.includes('tests/'));
  assert.equal(args.filter((a) => a.includes('*')).length, expected.filter((a) => a.includes('*')).length);
  assert.deepEqual(args.filter((a) => a !== '--test-reporter=tap'), expected);
  assert.ok(args.includes('--test-reporter=tap'));
  assert.ok(args.indexOf('--test-reporter=tap') < args.findIndex((a) => a.includes('*')));
});

test('parseTap reads summary counts', () => {
  const r = parseTap('# tests 10\n# pass 9\n# fail 1\n');
  assert.deepEqual([r.testsTotal, r.testsPassed, r.testsFailed, r.buildGreen], [10, 9, 1, false]);
});

test('STRATEGY.md posts escaped defects as type blocker', () => {
  const t = readFileSync(join(ROOT, 'tests', 'STRATEGY.md'), 'utf8');
  assert.ok(t.includes('post quality blocker'));
  assert.ok(!t.includes('post quality defect'));
});
