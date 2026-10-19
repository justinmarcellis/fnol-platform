// Backend-agnostic store conformance suite (S5-PLT-01). A backend passes when every case passes against
// its StorePort (see src/core/store-port.mjs). Keep SQL portable: ANSI types, no PRAGMA, no rowid.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MIGRATION = {
  sql: `CREATE TABLE IF NOT EXISTS conf_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE (tenant_id, sku)
);
CREATE TABLE IF NOT EXISTS conf_sys (id TEXT PRIMARY KEY, label TEXT NOT NULL);`,
  systemTables: ['conf_sys'],
};

/**
 * @param {string} name backend label
 * @param {() => Promise<import('../../../src/core/store-port.mjs').StorePort>} makeStore fresh, empty store per call
 */
export function runStoreConformance(name, makeStore) {
  async function fresh() {
    const port = await makeStore();
    await port.migrate('conf', [MIGRATION]);
    return port;
  }
  /** Run body with a fresh store and always close it. */
  const withStore = (body) => async () => {
    const port = await fresh();
    try { await body(port); } finally { await port.close(); }
  };
  const item = (id, sku, extra = {}) => ({ id, sku, name: `Item ${sku}`, qty: 1, ...extra });

  describe(`store conformance: ${name}`, () => {
    it('inserts and reads back by id, forcing tenant_id', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      const out = await a.insert('conf_items', item('i1', 'S1', { tenant_id: 't_beta' }));
      assert.equal(out.tenant_id, 't_alpha');
      const row = await a.getById('conf_items', 'i1');
      assert.equal(row.sku, 'S1');
      assert.equal(row.tenant_id, 't_alpha');
      assert.equal(await a.getById('conf_items', 'missing'), undefined);
    }));

    it('lists with where, orderBy, limit and offset; counts', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      await a.insert('conf_items', item('i1', 'S1', { qty: 3 }));
      await a.insert('conf_items', item('i2', 'S2', { qty: 1 }));
      await a.insert('conf_items', item('i3', 'S3', { qty: 2, note: 'x' }));
      assert.deepEqual((await a.list('conf_items', { orderBy: 'qty' })).map((r) => r.id), ['i2', 'i3', 'i1']);
      assert.deepEqual((await a.list('conf_items', { orderBy: 'qty DESC', limit: 2 })).map((r) => r.id), ['i1', 'i3']);
      assert.deepEqual((await a.list('conf_items', { orderBy: 'qty', limit: 1, offset: 1 })).map((r) => r.id), ['i3']);
      assert.deepEqual((await a.list('conf_items', { where: { qty: 2 } })).map((r) => r.id), ['i3']);
      assert.deepEqual((await a.list('conf_items', { where: { note: null }, orderBy: 'id' })).map((r) => r.id), ['i1', 'i2']);
      assert.equal(await a.count('conf_items'), 3);
      assert.equal(await a.count('conf_items', { qty: 1 }), 1);
      await assert.rejects(a.list('conf_items; DROP TABLE conf_items'), /Invalid identifier/);
    }));

    it('updates and deletes, reporting affected rows', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      await a.insert('conf_items', item('i1', 'S1'));
      assert.equal(await a.update('conf_items', 'i1', { qty: 9, note: 'edited' }), 1);
      assert.equal((await a.getById('conf_items', 'i1')).qty, 9);
      assert.equal(await a.update('conf_items', 'nope', { qty: 1 }), 0);
      assert.equal(await a.delete('conf_items', 'i1'), 1);
      assert.equal(await a.delete('conf_items', 'i1'), 0);
      assert.equal(await a.count('conf_items'), 0);
    }));

    it('runs parameterized SQL through get/all/run', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      await a.insert('conf_items', item('i1', 'S1', { qty: 5 }));
      const r = await a.get('SELECT qty FROM conf_items WHERE sku = ?', 'S1');
      assert.equal(r.qty, 5);
      const rows = await a.all('SELECT id FROM conf_items WHERE qty >= ? ORDER BY id', 1);
      assert.deepEqual(rows.map((x) => x.id), ['i1']);
      const w = await a.run('UPDATE conf_items SET qty = ? WHERE id = ?', 6, 'i1');
      assert.equal(w.changes, 1);
    }));

    it('scopes every operation to the bound tenant', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      const b = port.forTenant('t_beta');
      await a.insert('conf_items', item('i1', 'S1'));
      await b.insert('conf_items', item('i2', 'S1')); // same sku in another tenant is fine
      assert.equal(await b.getById('conf_items', 'i1'), undefined);
      assert.equal(await b.update('conf_items', 'i1', { qty: 99 }), 0);
      assert.equal(await b.delete('conf_items', 'i1'), 0);
      assert.deepEqual((await b.list('conf_items')).map((r) => r.id), ['i2']);
      assert.equal(await b.count('conf_items'), 1);
      assert.equal((await b.all('SELECT id FROM conf_items')).length, 1);
      assert.equal(await b.run('DELETE FROM conf_items').then((r) => r.changes), 1);
      const left = await a.getById('conf_items', 'i1');
      assert.equal(left.qty, 1, 'tenant alpha row untouched');
    }));

    it('rejects tenant_id in an update patch and leaves the row unchanged', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      await a.insert('conf_items', item('i1', 'S1'));
      await assert.rejects(a.update('conf_items', 'i1', { tenant_id: 't_beta' }), /tenant_id cannot be changed/);
      assert.equal((await a.getById('conf_items', 'i1')).tenant_id, 't_alpha');
    }));

    it('enforces unique constraints per tenant', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      await a.insert('conf_items', item('i1', 'S1'));
      await assert.rejects(a.insert('conf_items', item('i2', 'S1')), /unique|duplicate/i);
      await assert.rejects(a.insert('conf_items', item('i1', 'S9')), /unique|duplicate|primary/i);
      assert.equal(await a.count('conf_items'), 1);
    }));

    it('system handle reads and writes non-tenant tables', withStore(async (port) => {
      await port.system.insert('conf_sys', { id: 's1', label: 'one' });
      assert.equal((await port.system.getById('conf_sys', 's1')).label, 'one');
      assert.equal(await port.system.update('conf_sys', 's1', { label: 'two' }), 1);
      assert.equal(await port.system.count('conf_sys'), 1);
      await assert.rejects(port.system.insert('conf_items', item('i1', 'S1')), /tenant table/i);
    }));

    it('commits a transaction and returns the callback value', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      const out = await a.transaction(async (tx) => {
        await tx.insert('conf_items', item('i1', 'S1'));
        await tx.update('conf_items', 'i1', { qty: 7 });
        return 'done';
      });
      assert.equal(out, 'done');
      assert.equal((await a.getById('conf_items', 'i1')).qty, 7);
    }));

    it('rolls back every write when the callback throws', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      await a.insert('conf_items', item('keep', 'K'));
      await assert.rejects(a.transaction(async (tx) => {
        await tx.insert('conf_items', item('i1', 'S1'));
        await tx.update('conf_items', 'keep', { qty: 42 });
        throw new Error('boom');
      }), /boom/);
      assert.equal(await a.getById('conf_items', 'i1'), undefined);
      assert.equal((await a.getById('conf_items', 'keep')).qty, 1);
      await a.insert('conf_items', item('i2', 'S2')); // store still usable after rollback
    }));

    it('rolls back on a constraint violation inside the transaction', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      await a.insert('conf_items', item('i1', 'S1'));
      await assert.rejects(a.transaction(async (tx) => {
        await tx.insert('conf_items', item('i2', 'S2'));
        await tx.insert('conf_items', item('i3', 'S1'));
      }), /unique|duplicate/i);
      assert.equal(await a.count('conf_items'), 1);
    }));

    it('treats a nested transaction as a savepoint', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      await a.transaction(async (tx) => {
        await tx.insert('conf_items', item('outer', 'O'));
        await assert.rejects(tx.transaction(async (inner) => {
          await inner.insert('conf_items', item('inner', 'I'));
          throw new Error('inner fail');
        }), /inner fail/);
      });
      assert.ok(await a.getById('conf_items', 'outer'));
      assert.equal(await a.getById('conf_items', 'inner'), undefined);
    }));

    it('keeps concurrent top-level transactions isolated', withStore(async (port) => {
      const a = port.forTenant('t_alpha');
      const t1 = a.transaction(async (tx) => {
        await tx.insert('conf_items', item('i1', 'S1'));
        await new Promise((r) => setTimeout(r, 15));
        throw new Error('t1 fails');
      });
      const t2 = a.transaction(async (tx) => { await tx.insert('conf_items', item('i2', 'S2')); });
      const [r1] = await Promise.allSettled([t1, t2]);
      assert.equal(r1.status, 'rejected');
      assert.deepEqual((await a.list('conf_items')).map((r) => r.id), ['i2']);
    }));

    it('migrate is idempotent', withStore(async (port) => {
      await port.migrate('conf', [MIGRATION]);
      await port.forTenant('t_alpha').insert('conf_items', item('i1', 'S1'));
      await port.migrate('conf', [MIGRATION]);
      assert.equal(await port.forTenant('t_alpha').count('conf_items'), 1);
    }));
  });
}
