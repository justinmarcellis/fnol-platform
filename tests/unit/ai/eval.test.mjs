import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, mkdtemp, readFile as rf } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEval, loadGolden, renderReport, writeReport, scoreCase, aggregate, setCounts, GOLDEN_DIR } from '../../../src/ai/eval.mjs';
import { TASKS } from '../../../src/ai/schemas.mjs';

const tiny = [
  { task: 'severity', cases: [
    { id: 's1', input: { facts: { lossType: 'glass', glassOnly: true } }, expected: { band: 'low' }, recorded: { 'vertex-claude': { output: { score: 10, band: 'low', drivers: [] }, confidence: 0.9, explanation: '' } } },
    { id: 's2', input: { facts: { lossType: 'fire', estimateTotal: 22000 } }, expected: { band: 'low' }, recorded: { 'vertex-claude': { output: { score: 999, band: 'low', drivers: [] }, confidence: 0.9, explanation: '' } } },
  ] },
  { task: 'subrogation', cases: [
    { id: 'u1', input: { facts: { lossType: 'collision', atFaultParty: 'other party' } }, expected: { flag: true } },
    { id: 'u2', input: { facts: { lossType: 'glass' } }, expected: { flag: false } },
  ] },
  { task: 'extract_document', cases: [
    { id: 'd1', input: { kind: 'estimate', text: 'Repair Shop: Lakeside Collision Center\nEstimate Total: $4,190.55\nContact: Taylor Brooks 555-010-1234' }, pii: ['Taylor Brooks', '555-010-1234'], expected: { fields: { estimateTotal: 4190.55, repairShop: 'Lakeside Collision Center' } },
      recorded: { 'vertex-claude': { output: { kind: 'estimate', needsReview: false, fields: [{ name: 'estimateTotal', value: 4190.55, confidence: 0.9 }] }, confidence: 0.9, explanation: '' } } },
  ] },
];

test('scoring primitives: set counts, band, flag', () => {
  assert.deepEqual(setCounts(['a', 'b', 'c'], ['b', 'c', 'd']), { tp: 2, pred: 3, exp: 3 });
  const m = aggregate('extract_document', [scoreCase('extract_document', { fields: [{ name: 'vin', value: 'X1', confidence: 1 }, { name: 'lossDate', value: '2026-01-01', confidence: 1 }] }, { fields: { vin: 'x1', estimateTotal: 5 } })]);
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 0.5);
  assert.equal(scoreCase('severity', { band: 'high' }, { band: 'severe' }).near, true);
  assert.equal(scoreCase('severity', null, { band: 'low' }).hit, false);
  assert.equal(scoreCase('fraud_signals', { score: 55, indicators: [] }, { flag: true, indicators: [] }).hit, true);
  assert.equal(scoreCase('subrogation', { flag: true }, { flag: false }).hit, false);
});

test('runEval on a tiny golden set: local scores, recorded vertex replay, guard fallback', async () => {
  const r = await runEval({ golden: tiny });
  assert.deepEqual(Object.keys(r.providers), ['local', 'vertex-claude']);
  const local = r.providers.local.tasks;
  assert.equal(local.severity.cases, 2);
  assert.equal(local.severity.bandAccuracy, 0.5); // glass -> low (hit), fire -> severe (miss)
  assert.equal(local.subrogation.flagAccuracy, 1);
  assert.equal(local.extract_document.recall, 1);
  const v = r.providers['vertex-claude'];
  assert.equal(v.recorded, true);
  assert.equal(v.tasks.severity.cases, 2);
  assert.equal(v.tasks.severity.invalid, 1, 'out-of-range recorded score is rejected by the guard');
  assert.equal(v.tasks.severity.bandAccuracy, 0.5);
  assert.equal(v.tasks.extract_document.precision, 1);
  assert.equal(v.tasks.extract_document.recall, 0.5);
  assert.equal(v.pii.leaks, 0, 'no known PII string reached the cloud provider');
  assert.ok(v.pii.placeholders > 0);
  assert.equal(v.tasks.subrogation, undefined, 'no recordings, not scored');
});

test('runEval is deterministic', async () => {
  const a = await runEval({ golden: tiny });
  const b = await runEval({ golden: tiny });
  assert.deepEqual(a, b);
  assert.equal(renderReport(a, { date: '2026-01-01' }), renderReport(b, { date: '2026-01-01' }));
});

test('golden fixtures: one valid file per task, synthetic only, schema-valid recordings', async () => {
  const files = (await readdir(GOLDEN_DIR)).filter((f) => f.endsWith('.json'));
  assert.deepEqual(files.map((f) => f.replace('.json', '')).sort(), [...TASKS].sort());
  const golden = await loadGolden();
  const blob = (await Promise.all(files.map((f) => readFile(join(GOLDEN_DIR, f), 'utf8')))).join('\n');
  for (const g of golden) {
    assert.equal(g.synthetic, true);
    assert.ok(g.cases.length >= 2, `${g.task} has cases`);
    for (const c of g.cases) assert.ok(c.id && c.input && c.expected, `${g.task}/${c.id}`);
  }
  assert.ok(!/@(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}/i.test(blob), 'only example.com emails');
  assert.ok(!/\b\d{3}-\d{2}-\d{4}\b/.test(blob.replace(/123-45-6789/g, '')), 'only the documented fake SSN');
  assert.ok(!/\b(?!555)\d{3}[-.]\d{3}[-.]\d{4}\b/.test(blob), 'phones use the 555 fictional range');
});

test('runEval on the real golden set covers every task and leaks no PII', async () => {
  const r = await runEval();
  for (const t of TASKS) assert.ok(r.providers.local.tasks[t], `local scored ${t}`);
  for (const p of Object.values(r.providers).filter((x) => x.recorded)) assert.equal(p.pii.leaks, 0);
  assert.ok(r.providers.local.tasks.fraud_signals.flagAccuracy >= 0.8);
});

test('writeReport writes a markdown doc with method and per-task table', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-eval-'));
  const docPath = join(dir, 'ai-evaluation.md');
  await writeReport({ docPath, date: '2026-01-02', golden: tiny });
  const md = await rf(docPath, 'utf8');
  assert.match(md, /^# AI evaluation/);
  assert.match(md, /## Method/);
  assert.match(md, /on 2026-01-02/);
  assert.match(md, /\| severity \| 2 \|/);
  assert.match(md, /vertex-claude \(recorded fakes\)/);
});
