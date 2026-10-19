import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';
import { fixturePolicies } from '../../../src/modules/coverage/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dirs = [];
const apps = [];

async function boot(devMode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-personas-'));
  dirs.push(dir);
  const app = await createApp({ dbPath: path.join(dir, 't.db'), port: 0, secretsDir: path.join(dir, 's'), tenantsDir: path.join(ROOT, 'tenants'), logLevel: 'silent', devMode });
  apps.push(app);
  return app;
}
after(async () => { for (const a of apps) await a.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

let seeded;
before(async () => {
  seeded = await boot(true);
  const t = seeded.ctx.forTenant('aurelia-mutual');
  await t.modules.coverage.seedPolicies(fixturePolicies);
  const claims = t.modules.claims;
  const mk = async (key, adjusterId) => {
    const c = await claims.createClaim({ lob: 'personal_auto', channel: 'csr_phone', riskState: 'IL', policyNumber: 'AUT-100001', idempotencyKey: key,
      lossEvent: { lossDate: '2026-09-10', cause: 'collision', description: 'Synthetic.' } }, { actor: 'test' });
    ids.push([c.id, adjusterId]);
  };
  const ids = [];
  await mk('k1', 'adj-busy'); await mk('k2', 'adj-busy'); await mk('k3', 'adj-quiet');
  await seeded.ctx.bus.drain(); // let the routing pipeline finish, then pin ownership
  for (const [id, adj] of ids) {
    t.db.run('UPDATE claims SET adjuster_id = ?, status = ? WHERE id = ?', adj, 'in_review', id);
    t.db.run('UPDATE adjuster_inbox SET adjuster_id = ?, status = ? WHERE claim_id = ?', adj, 'in_review', id);
  }
});

test('404 when devMode is false', async () => {
  const app = await boot(false);
  const r = await fetch(`${app.url}/api/v1/dev/personas`);
  assert.equal(r.status, 404);
});

test('lists six personas per tenant derived from seeded data', async () => {
  const r = await fetch(`${seeded.url}/api/v1/dev/personas`);
  assert.equal(r.status, 200);
  const { tenants } = await r.json();
  assert.ok(tenants.length >= 2);
  const a = tenants.find((x) => x.id === 'aurelia-mutual');
  assert.deepEqual(a.personas.map((p) => p.role), ['claimant', 'csr', 'agent', 'adjuster', 'supervisor', 'carrier_admin']);
  for (const p of a.personas) { assert.ok(p.id && p.displayName && p.role && p.app && p.path); }
  const apps = Object.fromEntries(a.personas.map((p) => [p.role, p.app]));
  assert.deepEqual(apps, { claimant: '/', csr: '/csr', agent: '/csr', adjuster: '/adjuster', supervisor: '/adjuster', carrier_admin: '/admin' });
});

test('claimant is a named insured with policy number, last name and ZIP hint', async () => {
  const { tenants } = await (await fetch(`${seeded.url}/api/v1/dev/personas`)).json();
  const c = tenants.find((x) => x.id === 'aurelia-mutual').personas.find((p) => p.role === 'claimant');
  assert.match(c.hint.policyNumber, /^[A-Z]{2,5}-\d+/);
  assert.match(c.hint.zip, /^\d{5}$/);
  assert.ok(c.displayName.endsWith(c.hint.lastName));
});

test('adjuster persona is the one owning the most claims', async () => {
  const { tenants } = await (await fetch(`${seeded.url}/api/v1/dev/personas`)).json();
  const adj = tenants.find((x) => x.id === 'aurelia-mutual').personas.find((p) => p.role === 'adjuster');
  assert.equal(adj.userId, 'adj-busy');
});

test('response never carries tokens or secrets', async () => {
  const text = await (await fetch(`${seeded.url}/api/v1/dev/personas`)).text();
  assert.doesNotMatch(text, /token|secret|password|eyJ/i);
});
