// Regression for INC-1 (threat-model R1/R3): the tenant scope must not be bypassable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../../src/core/store.mjs';

test('tenant scope rejects quoted, qualified and tenant_id-changing SQL', () => {
  const db = createStore(':memory:');
  db.migrate('t', ['CREATE TABLE claims (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, v TEXT)']);
  const a = db.forTenant('a');
  const b = db.forTenant('b');
  a.insert('claims', { id: 'c1', v: 'secret' });
  for (const sql of ['SELECT * FROM "claims"', 'SELECT * FROM `claims`', 'SELECT * FROM [claims]', 'SELECT * FROM main.claims', 'SELECT * FROM main . "claims"', 'DELETE FROM "claims"', 'UPDATE main.claims SET v = 1']) {
    assert.throws(() => b.all(sql), /not allowed/, sql);
  }
  assert.throws(() => b.run("UPDATE claims SET tenant_id = 'b'"), /tenant_id/);
  assert.throws(() => a.update('claims', 'c1', { tenant_id: 'b' }), /tenant_id/);
  assert.equal(b.all('SELECT * FROM claims').length, 0);
  assert.equal(a.all('SELECT c.id FROM claims c WHERE c.v = ?', 'secret').length, 1);
  db.close();
});

test('tenant-bound ctx.db exposes no raw handle or system store', async () => {
  const { createTenantBinder } = await import('../../../src/core/tenant-context.mjs');
  const db = createStore(':memory:');
  const tctx = createTenantBinder({ db, tenants: { get: () => null }, bus: {}, audit: {}, crypto: {} }, new Map())('a');
  assert.equal(tctx.db.raw, undefined);
  assert.equal(tctx.db.system, undefined);
  assert.equal(tctx.db.forTenant, undefined);
  db.close();
});
