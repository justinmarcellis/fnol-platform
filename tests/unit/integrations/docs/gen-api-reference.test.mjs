import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BEGIN, END, run, mergeDocument } from '../../../../architecture/contracts/tools/gen-api-reference.mjs';
import { parseYaml } from '../../../../architecture/contracts/tools/yaml-lite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TOOL = path.join(ROOT, 'architecture/contracts/tools/gen-api-reference.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-docs-'));
const cli = (...args) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', TOOL, ...args], { encoding: 'utf8' });

test('creates the reference from the template with every operation and the hand-written sections', () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'api-reference.md');
    const r = run({ out });
    assert.equal(r.created, true);
    const md = fs.readFileSync(out, 'utf8');
    const spec = parseYaml(fs.readFileSync(path.join(ROOT, 'architecture/contracts/openapi.yaml'), 'utf8'));
    for (const [p, item] of Object.entries(spec.paths)) {
      for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
        if (item[m]) assert.ok(md.includes(`#### ${m.toUpperCase()} ${p}\n`), `${m} ${p}`);
      }
    }
    for (const h of ['## Authentication', '## Tenancy', '## Errors', '## Events and webhooks', '## Pagination']) assert.ok(md.includes(`\n${h}\n`), h);
    // signature example, in Node
    assert.match(md, /createHmac\('sha256'/);
    assert.match(md, /X-FNOL-Signature/);
    assert.match(md, /timingSafeEqual/);
    // generated content: webhook operations, schemas, events and domain objects
    assert.match(md, /Operation `createWebhook`/);
    assert.match(md, /### Schema: OutboxRecord/);
    assert.match(md, /### claim\.reported/);
    assert.match(md, /## Domain objects/);
    assert.match(md, /`WebhookSubscription`/);
    assert.equal(md.split(BEGIN).length, 2);
    assert.equal(md.split(END).length, 2);
    assert.doesNotMatch(md, /undefined|\[object/);
    assert.ok(md.indexOf('## Pagination') < md.indexOf(BEGIN), 'hand-written sections come before the generated block');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('is deterministic and idempotent', () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'a.md');
    run({ out });
    const first = fs.readFileSync(out, 'utf8');
    const again = run({ out });
    assert.equal(again.changed, false);
    assert.equal(fs.readFileSync(out, 'utf8'), first);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('preserves hand-written edits and rebuilds only the generated block', () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'a.md');
    run({ out });
    let md = fs.readFileSync(out, 'utf8');
    md = md.replace('## Authentication\n', '## Authentication\n\nHAND-WRITTEN-MARKER-1: contact the platform team for SSO.\n');
    md = md.replace('## Pagination\n', '## Pagination\n\nHAND-WRITTEN-MARKER-2\n');
    md = `${md.slice(0, md.indexOf(BEGIN))}## Extra custom section\n\nHAND-WRITTEN-MARKER-3\n\n${md.slice(md.indexOf(BEGIN))}`;
    md = md.replace(BEGIN, `${BEGIN}\n\nSTALE GENERATED TEXT that must disappear`);
    md += '\nTrailing hand-written footer after the block.\n';
    fs.writeFileSync(out, md);

    const r = run({ out });
    assert.equal(r.changed, true);
    const after = fs.readFileSync(out, 'utf8');
    for (const m of ['HAND-WRITTEN-MARKER-1', 'HAND-WRITTEN-MARKER-2', 'HAND-WRITTEN-MARKER-3', 'Trailing hand-written footer after the block.']) assert.ok(after.includes(m), m);
    assert.ok(!after.includes('STALE GENERATED TEXT'));
    // text outside the markers is byte-identical
    const outside = (s) => [s.slice(0, s.indexOf(BEGIN)), s.slice(s.indexOf(END) + END.length)];
    assert.deepEqual(outside(after), outside(md));
    assert.match(after, /### Schema: OutboxRecord/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('--check exits 1 when stale or missing and 0 when current; writes nothing', () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'a.md');
    const missing = cli('--check', '--out', out);
    assert.equal(missing.status, 1);
    assert.equal(fs.existsSync(out), false);

    assert.equal(cli('--out', out).status, 0);
    assert.equal(cli('--check', '--out', out).status, 0);

    fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace('### Schema: Delivery', '### Schema: Delivery (tampered)'));
    const stale = cli('--check', '--out', out);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /out of date/);
    assert.match(fs.readFileSync(out, 'utf8'), /tampered/, '--check must not rewrite the file');
    assert.equal(cli('--out', out).status, 0);
    assert.equal(cli('--check', '--out', out).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a spec change shows up in the output and trips --check', () => {
  const dir = tmp();
  try {
    const contracts = path.join(ROOT, 'architecture/contracts');
    const spec = path.join(dir, 'openapi.yaml');
    fs.cpSync(path.join(contracts, 'domain'), path.join(dir, 'domain'), { recursive: true });
    fs.cpSync(path.join(contracts, 'events'), path.join(dir, 'events'), { recursive: true });
    const base = fs.readFileSync(path.join(contracts, 'openapi.yaml'), 'utf8');
    fs.writeFileSync(spec, base);
    const out = path.join(dir, 'a.md');
    assert.equal(cli('--spec', spec, '--out', out).status, 0);
    assert.equal(cli('--spec', spec, '--out', out, '--check').status, 0);
    fs.writeFileSync(spec, base.replace('operationId: listOutbox', 'operationId: listOutboxRenamed'));
    assert.equal(cli('--spec', spec, '--out', out, '--check').status, 1);
    assert.equal(cli('--spec', spec, '--out', out).status, 0);
    assert.match(fs.readFileSync(out, 'utf8'), /listOutboxRenamed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refuses to overwrite a file that has no generated markers', () => {
  const dir = tmp();
  try {
    const out = path.join(dir, 'a.md');
    fs.writeFileSync(out, '# my own doc\n');
    const r = cli('--out', out);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /GENERATED/);
    assert.equal(fs.readFileSync(out, 'utf8'), '# my own doc\n');
    assert.throws(() => mergeDocument(`${BEGIN}\n${BEGIN}\n${END}`, 'x'), /exactly one/);
    assert.equal(cli('--bogus').status, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the committed docs/api-reference.md has the generated markers and hand-written sections', () => {
  const md = fs.readFileSync(path.join(ROOT, 'docs/api-reference.md'), 'utf8');
  assert.equal(md.split(BEGIN).length, 2);
  assert.equal(md.split(END).length, 2);
  for (const h of ['## Authentication', '## Tenancy', '## Errors', '## Events and webhooks', '## Pagination']) assert.ok(md.includes(`\n${h}\n`), h);
  assert.match(md, /Verifying the signature/);
});
