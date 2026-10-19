import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSmoke } from '../../../scripts/smoke.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/smoke.mjs');

test('smoke: script exits 0 after one claim end to end', () => {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /claim created clm_/);
  assert.match(r.stdout, /smoke: PASS/);
});

test('smoke: fails (rejects) when the server cannot start', async () => {
  await assert.rejects(runSmoke({ serverPath: '/nonexistent/server.mjs', timeoutMs: 5000 }), /did not become healthy/);
});
