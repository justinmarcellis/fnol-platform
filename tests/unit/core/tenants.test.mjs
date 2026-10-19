import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../../../src/core/store.mjs';
import { createClock } from '../../../src/core/clock.mjs';
import { createAudit, migrations as auditMigrations } from '../../../src/core/audit.mjs';
import { createTenants, migrations as tenantMigrations } from '../../../src/core/tenants.mjs';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-tenants-'));
  const lines = [];
  const log = { info: (msg, f) => lines.push({ msg, ...f }), warn() {}, error() {}, debug() {} };
  const ctx = { clock: createClock(), log };
  ctx.db = createStore(':memory:');
  ctx.db.migrate('core.audit', auditMigrations);
  ctx.db.migrate('core.tenants', tenantMigrations);
  ctx.audit = createAudit(ctx);
  const tenants = createTenants(ctx, { tenantsDir: dir });
  const write = (name, obj) => fs.writeFileSync(path.join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
  return { dir, lines, tenants, write };
}

test('first boot applies and logs applied', () => {
  const { tenants, write, lines } = setup();
  write('a.json', { id: 'a', displayName: 'A', secret: 'x' });
  assert.deepEqual(tenants.loadDir(), ['a']);
  assert.equal(tenants.version('a'), 1);
  assert.equal(lines[0].msg, 'tenant config applied');
  assert.equal(lines[0].tenantId, 'a');
  assert.ok(!JSON.stringify(lines).includes('"x"'));
});

test('restart preserves console edit and still returns ids', () => {
  const { tenants, write, lines } = setup();
  write('a.json', { id: 'a', displayName: 'A', seedVersion: 1 });
  tenants.loadDir();
  tenants.put('a', { id: 'a', displayName: 'Edited', seedVersion: 1 }, 'console');
  lines.length = 0;
  assert.deepEqual(tenants.loadDir(), ['a']);
  assert.equal(tenants.get('a').displayName, 'Edited');
  assert.equal(tenants.version('a'), 2);
  assert.equal(lines[0].msg, 'tenant config skipped');
  assert.equal(lines[0].fileSeedVersion, 1);
  assert.equal(lines[0].storedSeedVersion, 1);
});

test('higher file seedVersion overwrites console edit', () => {
  const { tenants, write } = setup();
  write('a.json', { id: 'a', displayName: 'A', seedVersion: 1 });
  tenants.loadDir();
  tenants.put('a', { id: 'a', displayName: 'Edited', seedVersion: 1 }, 'console');
  write('a.json', { id: 'a', displayName: 'A2', seedVersion: 2 });
  tenants.loadDir();
  assert.equal(tenants.get('a').displayName, 'A2');
  assert.equal(tenants.version('a'), 3);
});

test('missing seedVersion is 0 on both sides', () => {
  const { tenants, write } = setup();
  write('a.json', { id: 'a', displayName: 'A' });
  tenants.loadDir();
  tenants.put('a', { id: 'a', displayName: 'Edited' }, 'console');
  tenants.loadDir();
  assert.equal(tenants.get('a').displayName, 'Edited');
  // edit dropped seedVersion: stored counts as 0, so file seedVersion 1 wins
  write('a.json', { id: 'a', displayName: 'A1', seedVersion: 1 });
  tenants.loadDir();
  assert.equal(tenants.get('a').displayName, 'A1');
});

test('id falls back to file name', () => {
  const { tenants, write } = setup();
  write('zed.json', { displayName: 'Z' });
  assert.deepEqual(tenants.loadDir(), ['zed']);
});

test('invalid file is still rejected', () => {
  const { tenants, write } = setup();
  tenants.addValidator((c) => (c.displayName ? [] : ['displayName required']));
  write('bad.json', { id: 'bad' });
  assert.throws(() => tenants.loadDir(), (e) => e.code === 'invalid_tenant_config');
  assert.equal(tenants.get('bad'), null);
});
