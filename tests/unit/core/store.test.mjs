import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../../src/core/store.mjs';

function setup() {
  const db = createStore(':memory:');
  db.migrate('t', [
    { sql: 'CREATE TABLE things (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT, meta TEXT, n INTEGER)', tenantTables: ['things'] },
    'CREATE TABLE notes (id TEXT PRIMARY KEY, thing_id TEXT, body TEXT, tenant_id TEXT)',
    'CREATE TABLE lookup (code TEXT PRIMARY KEY, label TEXT)',
  ]);
  return db;
}

test('store: tenant isolation on get/all/update/delete', () => {
  const db = setup();
  const a = db.forTenant('A');
  const b = db.forTenant('B');
  a.insert('things', { id: 'th_1', name: 'alpha thing', meta: { k: 1 }, n: 1 });
  b.insert('things', { id: 'th_2', name: 'beta thing', n: 2 });
  assert.equal(a.get('SELECT * FROM things WHERE id = ?', 'th_2'), undefined);
  assert.equal(a.all('SELECT * FROM things').length, 1);
  assert.equal(a.all('SELECT * FROM things WHERE n = 1 OR n = 2').length, 1);
  assert.equal(a.get('SELECT t.name FROM things t WHERE t.id = ?', 'th_1').name, 'alpha thing');
  assert.equal(b.all('SELECT * FROM things ORDER BY id LIMIT 5').length, 1);
  assert.equal(a.update('things', 'th_2', { name: 'hacked' }), 0);
  assert.equal(b.get('SELECT name FROM things WHERE id = ?', 'th_2').name, 'beta thing');
  assert.equal(a.run('UPDATE things SET name = ? WHERE id = ? OR 1=1', 'x', 'nope').changes, 1);
  assert.equal(b.get('SELECT name FROM things').name, 'beta thing');
  assert.equal(a.run('DELETE FROM things').changes, 1);
  assert.equal(b.all('SELECT * FROM things').length, 1);
  assert.deepEqual(db.parseJson(b.get('SELECT meta FROM things').meta, 'dflt'), 'dflt');
});

test('store: JSON values, joins and transactions', () => {
  const db = setup();
  const a = db.forTenant('A');
  const b = db.forTenant('B');
  a.insert('things', { id: 'th_1', name: 'n', meta: { k: [1, 2] } });
  b.insert('things', { id: 'th_9', name: 'n' });
  a.insert('notes', { id: 'no_1', thing_id: 'th_1', body: 'hi' });
  b.insert('notes', { id: 'no_2', thing_id: 'th_9', body: 'other' });
  assert.deepEqual(db.parseJson(a.get('SELECT meta FROM things').meta), { k: [1, 2] });
  const rows = a.all('SELECT t.id, o.body FROM things t JOIN notes o ON o.thing_id = t.id');
  assert.deepEqual(rows, [{ id: 'th_1', body: 'hi' }]);
  assert.throws(() => a.transaction(() => {
    a.insert('things', { id: 'th_2', name: 'rolled back' });
    throw new Error('boom');
  }), /boom/);
  assert.equal(a.all('SELECT * FROM things').length, 1);
  a.transaction(() => {
    a.insert('things', { id: 'th_3', name: 'kept' });
    assert.throws(() => a.transaction(() => { a.insert('things', { id: 'th_4' }); throw new Error('inner'); }));
  });
  assert.deepEqual(a.all('SELECT id FROM things ORDER BY id').map((r) => r.id), ['th_1', 'th_3']);
});

test('store: unscoped queries on tenant tables throw; system tables allowed', () => {
  const db = setup();
  assert.ok(db.isTenantTable('notes'), 'tables with tenant_id column auto-register');
  assert.throws(() => db.system.all('SELECT * FROM things'), /Unscoped query/);
  assert.throws(() => db.system.run('DELETE FROM notes'), /Unscoped/);
  assert.throws(() => db.system.insert('things', { id: 'x' }), /Unscoped/);
  assert.throws(() => db.forTenant('A').run("INSERT INTO things (id, tenant_id) VALUES ('x','B')"), /insert\(/);
  assert.throws(() => db.forTenant('A').insert('lookup', { code: 'x' }), /not a registered tenant table/);
  assert.throws(() => db.forTenant('A').all('SELECT * FROM things, notes'), /Comma joins/);
  assert.throws(() => db.forTenant(''), /tenantId/);
  db.system.insert('lookup', { code: 'c', label: 'L' });
  assert.equal(db.system.get('SELECT label FROM lookup WHERE code = ?', 'c').label, 'L');
  assert.ok(db.id('clm').startsWith('clm_'));
  assert.notEqual(db.id('clm'), db.id('clm'));
});
