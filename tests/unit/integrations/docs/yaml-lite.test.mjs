import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../../../../architecture/contracts/tools/yaml-lite.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('block maps, sequences, scalars and comments', () => {
  const doc = parseYaml(`
# leading comment
a: 1
b: 'it''s'   # trailing comment
c: "tab\\there"
d: true
e: ~
f: 1.5
g: 1.0.0
list:
  - one
  - two: 2
    three: 3
  -
    nested: yes
empty:
tail: end
`);
  assert.deepEqual(doc, {
    a: 1, b: "it's", c: 'tab\there', d: true, e: null, f: 1.5, g: '1.0.0',
    list: ['one', { two: 2, three: 3 }, { nested: 'yes' }], empty: null, tail: 'end',
  });
});

test('sequences at the same indent as their key, and quoted keys', () => {
  assert.deepEqual(parseYaml("k:\n- a\n- b\n'200': ok\n/p/{id}: x\n"), { k: ['a', 'b'], '200': 'ok', '/p/{id}': 'x' });
});

test('flow collections, nesting, multi-line flow and hash inside quotes', () => {
  const doc = parseYaml(`
x: { $ref: '#/components/schemas/Page', n: [a, b, { c: d }] }
y: [1, 'two', "three"]
z: {
  p: 1,
  q: [x, y]
}
empty: []
none: {}
`);
  assert.deepEqual(doc.x, { $ref: '#/components/schemas/Page', n: ['a', 'b', { c: 'd' }] });
  assert.deepEqual(doc.y, [1, 'two', 'three']);
  assert.deepEqual(doc.z, { p: 1, q: ['x', 'y'] });
  assert.deepEqual(doc.empty, []);
  assert.deepEqual(doc.none, {});
});

test('lenient: unquoted prose with commas inside a flow mapping stays one string', () => {
  const doc = parseYaml('p: { type: string, description: For claimant tokens, the claims this user may see. }\n');
  assert.equal(doc.p.type, 'string');
  assert.equal(doc.p.description, 'For claimant tokens, the claims this user may see.');
});

test('block scalars keep newlines (|) or fold them (>)', () => {
  const doc = parseYaml(`
lit: |
  line one
    indented
  line three
fold: >-
  folded
  text
after: 1
`);
  assert.equal(doc.lit, 'line one\n  indented\nline three\n');
  assert.equal(doc.fold, 'folded text');
  assert.equal(doc.after, 1);
});

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

// Raw-text reads of the contract, independent of the parser under test. Counts are derived from the file itself.
function rawScalar(text, re, what) {
  const m = re.exec(text);
  assert.ok(m, `openapi.yaml has no ${what}`);
  return m[1];
}

test('parses the real openapi.yaml', () => {
  const text = fs.readFileSync(path.join(ROOT, 'architecture/contracts/openapi.yaml'), 'utf8');
  const doc = parseYaml(text);

  // Version: read the raw line under info:, check semver shape, and check the parser agrees with the raw text.
  const infoBlock = /^info:\s*$([\s\S]*?)^\S/m.exec(text);
  assert.ok(infoBlock, 'openapi.yaml has no top-level info block');
  const rawVersion = rawScalar(infoBlock[1], /^ {2}version:\s*['"]?([^'"\s]+)['"]?\s*$/m, 'info.version');
  assert.match(rawVersion, SEMVER, `info.version "${rawVersion}" is not semver`);
  assert.equal(doc.info.version, rawVersion, 'parser disagrees with raw info.version');

  assert.equal(doc.openapi, rawScalar(text, /^openapi:\s*['"]?([^'"\s]+)['"]?\s*$/m, 'openapi version line'));
  assert.match(doc.openapi, /^3\.\d+\.\d+$/);

  // Counts: floors come from the raw file (operationId lines under paths:), not from literals.
  const pathsSection = /^paths:\s*$([\s\S]*?)^\S/m.exec(text)?.[1] ?? '';
  const rawPathCount = (pathsSection.match(/^ {2}\/\S*:\s*$/gm) ?? []).length;
  const rawOpCount = (pathsSection.match(/^ {6}operationId:/gm) ?? []).length;
  assert.ok(rawOpCount > 0, 'raw openapi.yaml declares no operationIds under paths');
  assert.equal(Object.keys(doc.paths).length, rawPathCount, 'parsed path count differs from raw path keys');

  const create = doc.paths['/integrations/webhooks'].post;
  assert.equal(create.operationId, 'createWebhook');
  assert.deepEqual(create['x-roles'], ['tenant_admin', 'carrier_admin']);
  assert.deepEqual(create.requestBody.content['application/json'].schema.required, ['url', 'eventTypes']);
  const outboxParams = doc.paths['/integrations/outbox'].get.parameters;
  assert.ok(outboxParams.some((p) => p.$ref === '#/components/parameters/Limit'), 'outbox list does not reference the Limit parameter');
  assert.equal(doc.components.parameters.Limit.schema.maximum, 200);
  assert.match(doc.info.description, /Base path `\/api\/v1`/);
  // every operation has an operationId, a module and roles (or is explicitly public)
  const ops = [];
  for (const [p, item] of Object.entries(doc.paths)) for (const m of ['get', 'post', 'put', 'patch', 'delete']) if (item[m]) ops.push([`${m} ${p}`, item[m]]);
  assert.equal(ops.length, rawOpCount, 'parsed operation count differs from raw operationId count');
  for (const [name, op] of ops) {
    assert.ok(op.operationId, name);
    assert.ok(op['x-module'], name);
    assert.ok(Array.isArray(op['x-roles']), name);
  }
});
