/**
 * Route role matrix guard (REQ-19, IMP-8).
 *
 * The openapi role matrix (x-roles, x-module, security: []) is snapshotted in tests/security/routes.snapshot.json.
 * When an operation changes, the snapshot test fails and prints the exact added / removed / changed operations.
 * After reviewing the security impact, refresh the snapshot with ONE line:
 *
 *   FNOL_REFRESH_ROUTES=1 node --test --disable-warning=ExperimentalWarning tests/security/routes.test.mjs
 *
 * Programmatic refresh: `import { refreshSnapshot } from './routes.test.mjs'; refreshSnapshot();`
 *   refreshSnapshot(file?, list?) regenerates the snapshot from parseOpenApi() (sorted by op, two-space JSON,
 *   trailing newline), writes it only when the content changes, and returns { file, changed, count }.
 *
 * Importing this module only defines helpers. It writes nothing unless refreshSnapshot() is called or
 * FNOL_REFRESH_ROUTES=1 is set. Note that importing a test file also registers its tests in the importing runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENAPI_PATH, API_BASE, parseOpenApi, bootSecurityApp, findRoute, skipReason } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.join(HERE, 'routes.snapshot.json');
const REFRESH_CMD = 'FNOL_REFRESH_ROUTES=1 node --test --disable-warning=ExperimentalWarning tests/security/routes.test.mjs';
const key = (o) => `${o.method} ${o.path}`;
const ops = parseOpenApi();

/** Role matrix derived from openapi, sorted by operation key. */
export function currentMatrix(list = parseOpenApi()) {
  return list
    .map((o) => ({ op: key(o), roles: o.roles, module: o.module, public: o.public }))
    .sort((a, b) => a.op.localeCompare(b.op));
}

/** Compare a snapshot with the current matrix. Returns added / removed / changed operations. */
export function matrixDiff(snap, now) {
  const snapBy = new Map(snap.map((s) => [s.op, s]));
  const nowBy = new Map(now.map((s) => [s.op, s]));
  const added = now.filter((s) => !snapBy.has(s.op));
  const removed = snap.filter((s) => !nowBy.has(s.op));
  const changed = [];
  for (const n of now) {
    const s = snapBy.get(n.op);
    if (!s) continue;
    const parts = [];
    if (JSON.stringify(s.roles) !== JSON.stringify(n.roles)) parts.push(`roles ${JSON.stringify(s.roles)} -> ${JSON.stringify(n.roles)}`);
    if (s.module !== n.module) parts.push(`module ${s.module} -> ${n.module}`);
    if (s.public !== n.public) parts.push(`public ${s.public} -> ${n.public}`);
    if (parts.length) changed.push({ op: n.op, parts });
  }
  return { added, removed, changed };
}

const describeOp = (s) => `roles=${JSON.stringify(s.roles)} module=${s.module} public=${s.public}`;

/** Human-readable drift report, one line per difference, or an empty array when nothing drifted. */
export function formatDrift(snap, now) {
  const { added, removed, changed } = matrixDiff(snap, now);
  const lines = [];
  for (const a of added) lines.push(`+ added    ${a.op}  ${describeOp(a)}`);
  for (const r of removed) lines.push(`- removed  ${r.op}  ${describeOp(r)}`);
  for (const c of changed) lines.push(`~ changed  ${c.op}: ${c.parts.join('; ')}`);
  if (lines.length === 0 && JSON.stringify(snap) !== JSON.stringify(now)) {
    lines.push('~ order    snapshot entries are not sorted by op');
  }
  return lines;
}

/**
 * Regenerate the snapshot from openapi (sorted, two-space JSON, trailing newline).
 * Writes only when the content differs, so a no-op refresh leaves the file untouched.
 * @param {string} [file] snapshot path (default tests/security/routes.snapshot.json)
 * @param {object[]} [list] parsed operations (default parseOpenApi())
 * @returns {{ file: string, changed: boolean, count: number }}
 */
export function refreshSnapshot(file = SNAPSHOT, list = parseOpenApi()) {
  const matrix = currentMatrix(list);
  const next = JSON.stringify(matrix, null, 2) + '\n';
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (prev === next) return { file, changed: false, count: matrix.length };
  fs.writeFileSync(file, next);
  return { file, changed: true, count: matrix.length };
}

if (process.env.FNOL_REFRESH_ROUTES === '1') {
  const r = refreshSnapshot();
  console.log(`routes snapshot ${r.changed ? 'refreshed' : 'already current'}: ${r.count} operations (${path.relative(process.cwd(), r.file)})`);
}

test('openapi: every operation declares x-roles and x-module', () => {
  assert.ok(ops.length > 0, 'parser found no operations');
  const text = fs.readFileSync(OPENAPI_PATH, 'utf8');
  const pathsSection = text.split(/^paths:\s*$/m)[1].split(/^\S/m)[0];
  const declared = (pathsSection.match(/^ {6}operationId:/gm) ?? []).length;
  assert.equal(ops.length, declared, 'parser and operationId count disagree');
  for (const o of ops) {
    assert.ok(o.hasRoles, `${key(o)} has no x-roles`);
    assert.ok(o.module, `${key(o)} has no x-module`);
    // Non-public operations must name at least one role.
    if (!o.public) assert.ok(o.roles.length > 0, `${key(o)} is authenticated but lists no roles`);
  }
});

test('openapi: role matrix has not drifted from the checked-in snapshot', () => {
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const now = currentMatrix(ops);
  const lines = formatDrift(snap, now);
  if (lines.length === 0) return;
  const { added, removed, changed } = matrixDiff(snap, now);
  assert.fail([
    `openapi role matrix differs from tests/security/routes.snapshot.json`,
    `  ${added.length} added, ${removed.length} removed, ${changed.length} changed`,
    ...lines.map((l) => `  ${l}`),
    'Review the security impact of each line (x-roles, x-module, public), then refresh the snapshot with one line:',
    `  ${REFRESH_CMD}`,
  ].join('\n'));
});

test('routes: each operation is either registered (with auth) or skipped with a reason', async (t) => {
  const app = await bootSecurityApp();
  try {
    let registered = 0;
    for (const o of ops) {
      const route = findRoute(app, o);
      if (!route) { await t.test(`${key(o)}`, { skip: skipReason(app, o) }, () => {}); continue; }
      registered++;
      await t.test(`${key(o)} registered`, () => {
        if (o.public) assert.equal(!!route.opts.public, true, `${key(o)} should be public`);
        else assert.equal(!!route.opts.public, false, `${key(o)} is documented as authenticated but registered public`);
      });
    }
    t.diagnostic(`${registered}/${ops.length} documented operations are registered under ${API_BASE}`);
  } finally { await app.close(); }
});

// Known contract gaps are reported as todo (visible, non-fatal) so the suite stays green on the current tree.
test('contract: documented roles are all issuable by ctx.auth', async () => {
  const app = await bootSecurityApp();
  try {
    const known = new Set(app.ctx.auth.ROLES);
    const unknown = [...new Set(ops.flatMap((o) => o.roles))].filter((r) => !known.has(r));
    assert.deepEqual(unknown, []);
  } finally { await app.close(); }
});

test('contract: registered route roles match documented x-roles', async () => {
  const app = await bootSecurityApp();
  try {
    const diffs = [];
    for (const o of ops) {
      const r = findRoute(app, o);
      if (!r || o.public) continue;
      const have = [...(r.opts.roles ?? [])].sort().join(',');
      const want = [...o.roles].sort().join(',');
      if (have !== want) diffs.push(`${key(o)} registered=[${have}] documented=[${want}]`);
    }
    assert.deepEqual(diffs, []);
  } finally { await app.close(); }
});
