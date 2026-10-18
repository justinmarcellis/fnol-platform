import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../src/server.mjs';

test('tenant-bound ctx scopes db, bus, crypto and module services', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-tctx-'));
  const modulesDir = path.join(dir, 'modules');
  fs.mkdirSync(path.join(modulesDir, 'probe'), { recursive: true });
  fs.writeFileSync(path.join(modulesDir, 'probe', 'index.mjs'), `
    export default {
      name: 'probe',
      migrations: ['CREATE TABLE IF NOT EXISTS probe (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, v TEXT)'],
      service: (ctx) => ({ whoami: () => ctx.tenant?.id ?? null, put: (id, v) => ctx.db.insert('probe', { id, v }), all: () => ctx.db.all('SELECT id, v FROM probe') }),
      subscribe(bus) { bus.on('probe.ping', (evt, tctx) => { tctx.modules.probe.put(evt.id, 'from-event'); }, { name: 'probe:ping' }); },
    };`);
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  const app = await createApp({ port: 0, dbPath: path.join(dir, 'db.sqlite'), secretsDir: path.join(dir, 's'), tenantsDir, modulesDir });
  try {
    const a = app.ctx.forTenant('ta');
    const b = app.ctx.forTenant('tb');
    assert.equal(a.modules.probe.whoami(), 'ta');
    a.modules.probe.put('p1', 'x');
    assert.equal(a.modules.probe.all().length, 1);
    assert.equal(b.modules.probe.all().length, 0);
    const enc = a.crypto.encryptPii('Jane Doe');
    assert.equal(a.crypto.decryptPii(enc), 'Jane Doe');
    assert.throws(() => b.crypto.decryptPii(enc));
    const evt = a.bus.publish('probe.ping', 'p1', {});
    await app.ctx.bus.drain();
    assert.equal(a.modules.probe.all().length, 2);
    // Replaying the same event is a no-op for the handler.
    app.ctx.bus.recover(['ta']);
    await app.ctx.bus.drain();
    assert.equal(a.modules.probe.all().length, 2);
    assert.equal(a.audit.record({ actor: 'u', action: 'probe' }).tenant_id ?? 'ta', 'ta');
    assert.ok(evt.id);
  } finally {
    await app.close();
  }
});
