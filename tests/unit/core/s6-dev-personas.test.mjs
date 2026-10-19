// S6-BUG-05: personas tell a coherent demo story (DATA-3, CLAIMANT-7, DATA-4, CSR-9, DATA-9, ADJUSTER-19).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';
import { generatePolicies } from '../../synthetic/index.mjs';
import { enrichPolicy, demoAgent, producedByAgent } from '../../../scripts/demo-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let app;
let dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-s6-personas-'));
  app = await createApp({ dbPath: path.join(dir, 't.db'), port: 0, secretsDir: path.join(dir, 's'), tenantsDir: path.join(ROOT, 'tenants'), logLevel: 'silent', devMode: true });
  for (const tenantId of ['aurelia-mutual', 'kestrel-point']) {
    const cfg = app.ctx.tenants.get(tenantId);
    const all = [];
    for (const lob of cfg.lobs) {
      // Homeowners and commercial numbers sort before PA-: the persona must still be the personal auto holder.
      all.push(...generatePolicies({ tenantId, lob: lob.id, count: 8, seed: 42, state: lob.states[0] })
        .map((p) => enrichPolicy(p, { tenantId, produce: producedByAgent(p.policyNumber) })));
    }
    await app.ctx.forTenant(tenantId).modules.coverage.seedPolicies(all);
  }
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const personas = async () => (await (await fetch(`${app.url}/api/v1/dev/personas`)).json()).tenants;

test('each claimant persona is an individual on a personal auto policy with 2-3 vehicles, hint carries lob', async () => {
  for (const t of await personas()) {
    const c = t.personas.find((p) => p.role === 'claimant');
    assert.equal(c.hint.lob, 'personal_auto', t.id);
    assert.match(c.hint.policyNumber, /^PA-[A-Z]{2}-\d{7}$/);
    assert.doesNotMatch(c.hint.lastName, /[()]/, 'a real-looking last name');
    assert.ok(c.displayName.endsWith(c.hint.lastName));
    assert.match(c.note, /personal auto policy .* \([23] vehicles\)/);
    const snap = await app.ctx.forTenant(t.id).modules.coverage.getPolicySnapshot({ policyNumber: c.hint.policyNumber, asOf: '2026-10-01' });
    assert.ok(snap.vehicles.length >= 2 && snap.vehicles.length <= 3);
    assert.ok(snap.vehicles.some((v) => v.garagingPostalCode === c.hint.zip), 'the hint ZIP passes the holder check');
  }
});

test('the agent persona is the producer of seeded policies', async () => {
  for (const t of await personas()) {
    const a = t.personas.find((p) => p.role === 'agent');
    assert.equal(a.userId, demoAgent(t.id).agentId);
    assert.equal(a.displayName, demoAgent(t.id).name);
    assert.match(a.note, /^Producer of \d+ seeded policies/);
    const produced = await app.ctx.forTenant(t.id).modules.coverage.producedPolicyNumbers(a.userId);
    assert.ok(produced.length > 0);
  }
});

test('enrichPolicy gives every policy a phone with a local area code and varied ZIPs', () => {
  const pols = generatePolicies({ tenantId: 'kestrel-point', lob: 'personal_auto', count: 20, seed: 42, state: 'MI' }).map((p) => enrichPolicy(p, { tenantId: 'kestrel-point' }));
  for (const p of pols) assert.match(p.namedInsureds[0].phone, /^\((313|616)\) 555-01\d\d$/);
  const zips = new Set(pols.map((p) => p.vehicles[0].garagingPostalCode));
  assert.ok(zips.size >= 4, `varied ZIPs: ${[...zips]}`);
  const fleet = enrichPolicy(generatePolicies({ tenantId: 'kestrel-point', lob: 'commercial_auto', count: 1, seed: 1, state: 'MI' })[0], { tenantId: 'kestrel-point', produce: true });
  assert.equal(fleet.namedInsureds[0].kind, 'organization');
  assert.equal(fleet.producer.agentId, demoAgent('kestrel-point').agentId);
});
