// Writes org/quality.json from TAP / node --test output.
// Usage: node dashboard/quality-report.mjs [output-file]   (no argument: runs tests/ with the TAP reporter)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Parse TAP text into counts. Prefers the summary lines "# tests N", "# pass N", "# fail N". */
export function parseTap(text) {
  const grab = (k) => { const m = text.match(new RegExp(`^# ${k} (\\d+)`, 'm')); return m ? Number(m[1]) : null; };
  let total = grab('tests'), passed = grab('pass'), failed = grab('fail');
  if (total === null) {
    // Fallback: count top-level (unindented) result lines.
    passed = (text.match(/^ok \d+/gm) ?? []).length;
    failed = (text.match(/^not ok \d+/gm) ?? []).length;
    total = passed + failed;
  }
  failed ??= total - (passed ?? 0);
  passed ??= total - failed;
  return { testsTotal: total, testsPassed: passed, testsFailed: failed, buildGreen: failed === 0 && total > 0 };
}

/** Write org/quality.json (or `out`). */
export function writeReport(text, out = join(ROOT, 'org', 'quality.json'), at = new Date().toISOString()) {
  const r = { ...parseTap(text), at };
  writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
  return r;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  let text;
  if (file) {
    if (!existsSync(file)) { console.error(`no such file: ${file}`); process.exit(1); }
    text = readFileSync(file, 'utf8');
  } else {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', 'tests/'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    text = r.stdout ?? '';
  }
  console.log(JSON.stringify(writeReport(text)));
}
