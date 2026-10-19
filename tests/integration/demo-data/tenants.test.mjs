// S6-BUG-05: demo tenant configs (CLAIMANT-1, DATA-2, CLAIMANT-13, ADMIN-20, ADMIN-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const load = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tenants', `${id}.json`), 'utf8'));
const tenants = { aurelia: load('aurelia-mutual'), kestrel: load('kestrel-point') };

test('CLAIMANT-1 / DATA-2: personal auto accepts claimant_web in every tenant, so each claimant persona can start a claim', () => {
  for (const [id, cfg] of Object.entries(tenants)) {
    assert.ok(cfg.lobs.find((l) => l.id === 'personal_auto').channels.includes('claimant_web'), id);
  }
  // Tenant difference kept: Kestrel fleets report commercial auto by phone or API.
  assert.deepEqual(tenants.kestrel.lobs.find((l) => l.id === 'commercial_auto').channels, ['csr_phone', 'api']);
});

test('CLAIMANT-13: Spanish tenant text is accented and questions open with ¿', () => {
  const es = [];
  (function walk(o) { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'es' && typeof v === 'string') es.push(v); else walk(v); } })(tenants.aurelia);
  const unaccented = /\b(Colision|Dano|danos|danado|Cuando|Cuentenos|sucedio|vehiculo|poliza|informacion|demostracion|presento|rompio|Sotano|Bano|cerro|causo|plomeria|Via rapida)\b/;
  for (const s of es) assert.doesNotMatch(s, unaccented, s);
  for (const s of es.filter((x) => x.endsWith('?'))) assert.ok(s.startsWith('¿'), s);
  assert.ok(es.includes('Colisión') && es.includes('Daño de cristales') && es.includes('¿Cuándo se rompió el cristal?'));
});

test('ADMIN-20: question order values are unique and increase in list order; the police report is asked without an injury', () => {
  for (const [id, cfg] of Object.entries(tenants)) {
    for (const set of cfg.questionSets) {
      const orders = set.questions.map((q) => q.order);
      assert.equal(new Set(orders).size, orders.length, `${id}/${set.id} duplicates: ${orders}`);
      assert.deepEqual([...orders].sort((a, b) => a - b), orders, `${id}/${set.id} out of sequence: ${orders}`);
    }
  }
  const police = tenants.aurelia.questionSets.find((s) => s.id === 'auto-general').questions.find((q) => q.id === 'police_report');
  assert.equal(police.showIf, undefined);
});

test('ADMIN-21: the policy number format matches the seeded policies (LL-SS-NNNNNNN)', () => {
  for (const cfg of Object.values(tenants)) {
    const fmt = cfg.integrations.policyPort.settings.policyNumberFormat;
    assert.equal(fmt, 'LL-SS-#######');
    const re = new RegExp(`^${fmt.replace(/L/g, '[A-Z]').replace(/S/g, '[A-Z]').replace(/#/g, '\\d')}$`);
    for (const n of ['HO-IL-1030185', 'PA-IL-6671841', 'CA-MI-1421980']) assert.match(n, re);
  }
});

test('DATA-9: the demo adjuster works several desks in each tenant', () => {
  const desks = (cfg, id) => cfg.queues.filter((q) => (q.adjusters ?? []).includes(id)).length;
  assert.ok(desks(tenants.aurelia, 'adj-aur-201') >= 3);
  assert.ok(desks(tenants.kestrel, 'adj-kpt-202') >= 3);
});
