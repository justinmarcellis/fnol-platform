import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../src/server.mjs';
import { demoData } from '../../../scripts/demo-data.mjs';
import * as synthetic from '../../synthetic/index.mjs';

const quiet = () => {};
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'demo-data-'));
const appFactory = (dir) => (o) => createApp({ ...o, dbPath: path.join(dir, 'fnol.db'), secretsDir: path.join(dir, 'secrets'), logLevel: 'silent' });

async function readState(dir) {
  const app = await appFactory(dir)({ port: 0 });
  try {
    const out = {};
    for (const t of app.ctx.tenants.list()) {
      const c = app.ctx.forTenant(t).modules.claims;
      const { items } = await c.listClaims({}, { limit: 200 });
      let notes = 0; let tasks = 0;
      for (const it of items) { notes += (await c.listNotes(it.id)).length; tasks += (await c.listTasks(it.id)).length; }
      out[t] = { items, notes, tasks, lobs: new Set(items.map((i) => i.lob)), statuses: new Set(items.map((i) => i.status)), ext: items.map((i) => i.externalRefs) };
    }
    return out;
  } finally { await app.close(); }
}

test('generates scenario-covering claims for both tenants and is idempotent', { timeout: 120000 }, async () => {
  const dir = mk();
  const r1 = await demoData({ createApp: appFactory(dir), log: quiet });
  assert.equal(r1.tenants.length, 2);
  assert.equal(r1.failed, 0, JSON.stringify(r1.failures));
  for (const t of r1.tenants) assert.ok(r1.perTenant[t].created >= 12, `${t} created ${r1.perTenant[t].created}`);

  const s1 = await readState(dir);
  for (const t of r1.tenants) {
    assert.ok(s1[t].items.length >= 12);
    assert.ok(s1[t].lobs.has('personal_auto'));
    assert.ok(s1[t].lobs.size >= 2, `lobs: ${[...s1[t].lobs]}`);
    assert.ok(s1[t].statuses.size >= 3, `statuses: ${[...s1[t].statuses]}`);
    assert.ok(s1[t].notes > 0 && s1[t].tasks > 0);
  }

  const r2 = await demoData({ createApp: appFactory(dir), log: quiet });
  assert.equal(r2.created, 0);
  assert.equal(r2.failed, 0);
  assert.equal(r2.existing, r1.created);
  const s2 = await readState(dir);
  for (const t of r1.tenants) {
    assert.equal(s2[t].items.length, s1[t].items.length);
    assert.equal(s2[t].notes, s1[t].notes);
  }
});

test('every scenario whose lob is enabled is generated per tenant', async () => {
  const seen = [];
  const dir = mk();
  const spy = { ...synthetic, generateScenario: (name, o) => { seen.push(`${o.tenantId}/${name}`); return synthetic.generateScenario(name, o); } };
  const r = await demoData({ createApp: appFactory(dir), importSynthetic: async () => spy, log: quiet, minPerTenant: 1 });
  for (const t of r.tenants) {
    const app = await appFactory(dir)({ port: 0 });
    const lobs = app.ctx.tenants.get(t).lobs.filter((l) => l.enabled !== false).map((l) => l.id);
    await app.close();
    for (const s of Object.values(synthetic.SCENARIOS)) {
      assert.equal(seen.includes(`${t}/${s.name}`), lobs.includes(s.lob), `${t}/${s.name}`);
    }
  }
});

test('a failing claim is logged and skipped without stopping the rest', { timeout: 120000 }, async () => {
  const dir = mk();
  const logs = [];
  const bad = { ...synthetic, generateScenario: (name, o) => {
    const s = synthetic.generateScenario(name, o);
    if (name === 'auto_glass_only') s.claimCreate = { ...s.claimCreate, lossEvent: undefined };
    return s;
  } };
  const r = await demoData({ createApp: appFactory(dir), importSynthetic: async () => bad, log: (m) => logs.push(m) });
  assert.ok(r.failed > 0);
  assert.ok(r.created > 0);
  assert.ok(r.failures.every((f) => f.scenario === 'auto_glass_only'));
  assert.ok(logs.some((l) => l.startsWith('fail ') && l.includes('auto_glass_only')));
  assert.ok(logs.some((l) => l.startsWith('demo-data summary:') && l.includes('failed')));
});

test('skips cleanly when synthetic data is unavailable', async () => {
  let created = false;
  const r = await demoData({ createApp: async () => { created = true; throw new Error('no'); }, importSynthetic: async () => { throw new Error('nope'); }, log: quiet });
  assert.equal(r.created, 0);
  assert.equal(created, false);
});
