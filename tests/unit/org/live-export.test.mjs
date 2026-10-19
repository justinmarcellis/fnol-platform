import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_DOC_BYTES, computeFeed } from '../../../org/live-export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('computeFeed returns the four record documents with generatedAt', () => {
  const { docs } = computeFeed();
  for (const n of ['board', 'rank', 'graph', 'events']) assert.ok(docs[n].generatedAt, n);
  assert.ok(docs.events.items.length > 0 && docs.graph.nodes.length > 0 && docs.board.tickets.length > 0);
});

test('the CLI writes metrics.json (computeMetrics + generatedAt) and every document is under 600 KB', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'live-export-'));
  const runsPath = path.join(ROOT, 'org', 'runs.json');
  const runsBefore = fs.readFileSync(runsPath, 'utf8'); // the CLI merges agent runs into this committed file
  try {
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'org', 'live-export.mjs'), '--out', out, '--transcripts', path.join(out, 'none')], { cwd: ROOT, stdio: 'pipe' });
  } finally { fs.writeFileSync(runsPath, runsBefore); }
  const names = fs.readdirSync(out).sort();
  assert.deepEqual(names, ['board.json', 'events.json', 'graph.json', 'metrics.json', 'rank.json']);
  for (const f of names) assert.ok(fs.statSync(path.join(out, f)).size < MAX_DOC_BYTES, `${f} under 600 KB`);
  const m = JSON.parse(fs.readFileSync(path.join(out, 'metrics.json'), 'utf8'));
  assert.ok(!Number.isNaN(Date.parse(m.generatedAt)));
  for (const k of ['tickets', 'cost', 'velocity', 'scorecards', 'forecast']) assert.ok(k in m, `metrics.${k}`);
  fs.rmSync(out, { recursive: true, force: true });
});

test('MAX_DOC_BYTES is 600 KB', () => assert.equal(MAX_DOC_BYTES, 600 * 1024));
