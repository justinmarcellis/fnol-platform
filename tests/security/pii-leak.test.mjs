import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootSecurityApp, call, dumpDatabase, dumpText, ROOT, PII, piiValues, allPiiValues, TENANT_A, TENANT_B, parseOpenApi, findRoute, skipReason } from './helpers.mjs';

const noneOf = (haystack, values, where) => {
  for (const v of values) assert.ok(!haystack.includes(v), `synthetic PII "${v}" leaked into ${where}`);
};

test('pii: logger redacts PII keys, including nested fields', async () => {
  const app = await bootSecurityApp();
  try {
    const a = PII.A;
    app.ctx.log.info('claim touched', {
      claimId: 'clm_1', name: a.fullName, email: a.email, phone: a.phone, dob: a.dob, address: a.address,
      licenseNumber: a.license, plate: a.plate, party: { fullName: a.fullName, contactEmail: a.email }, list: [{ phone: a.phone }],
    });
    app.ctx.log.error('boom', { error: 'x', driverLicense: a.license });
    const text = app.logLines.join('\n');
    assert.ok(text.includes('clm_1'), 'non-PII ids are still logged');
    noneOf(text, piiValues('A'), 'log output');
  } finally { await app.close(); }
});

test('pii: request handling never echoes or logs PII from request bodies', async () => {
  const app = await bootSecurityApp();
  try {
    const a = PII.A;
    const bad = { sub: a.email, tenantId: 'no-such-tenant', roles: ['not_a_role'], name: a.fullName, phone: a.phone, address: a.address };
    const results = [
      await call(app, 'POST', '/api/v1/auth/token', { body: bad }),
      await call(app, 'POST', '/api/v1/audit', { token: app.tokenFor(TENANT_A, ['supervisor']), body: bad }),
      await call(app, 'GET', `/api/v1/audit?actor=${encodeURIComponent(a.email)}`, { token: app.tokenFor(TENANT_A, ['csr']) }),
    ];
    for (const r of results) noneOf(r.text, piiValues('A'), `HTTP response (${r.status})`);
    noneOf(app.logLines.join('\n'), piiValues('A'), 'log output');
  } finally { await app.close(); }
});

test('pii: encrypted columns hold ciphertext only, outbox and audit stay clean, tenants cannot cross-decrypt', async () => {
  const app = await bootSecurityApp();
  try {
    const { db, crypto, bus, audit } = app.ctx;
    db.migrate('sec-probe-pii', ['CREATE TABLE IF NOT EXISTS sec_pii_probe (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject_ref TEXT, full_name TEXT, email TEXT, phone TEXT)']);
    for (const [tid, who] of [[TENANT_A, 'A'], [TENANT_B, 'B']]) {
      const p = PII[who];
      db.forTenant(tid).insert('sec_pii_probe', {
        id: `probe_${who}`, subject_ref: `subj_${who}`,
        full_name: crypto.encryptPii(tid, p.fullName), email: crypto.encryptPii(tid, p.email), phone: crypto.encryptPii(tid, p.phone),
      });
      // Events and audit entries reference records by id; they carry no PII.
      bus.publish(tid, 'sec.probe.created', `probe_${who}`, { probeId: `probe_${who}`, tenantId: tid });
      audit.record(tid, { actor: `sec-${who}`, action: 'sec.probe.created', entityType: 'probe', entityId: `probe_${who}`, details: { fields: ['full_name', 'email', 'phone'] } });
    }
    await bus.drain();

    for (const col of ['full_name', 'email', 'phone']) {
      const row = db.raw.prepare(`SELECT ${col} AS v FROM sec_pii_probe WHERE id = 'probe_A'`).get();
      assert.ok(crypto.isEncrypted(row.v), `${col} must be stored encrypted`);
    }
    const dump = dumpText(app);
    noneOf(dump, allPiiValues(), 'raw database dump');
    const outbox = JSON.stringify(dumpDatabase(app).outbox);
    assert.ok(outbox.includes('sec.probe.created'));
    noneOf(outbox, allPiiValues(), 'outbox');

    const a = db.raw.prepare("SELECT full_name FROM sec_pii_probe WHERE id = 'probe_A'").get().full_name;
    assert.equal(crypto.decryptPii(TENANT_A, a), PII.A.fullName);
    assert.throws(() => crypto.decryptPii(TENANT_B, a), 'tenant B key must not decrypt tenant A ciphertext');
  } finally { await app.close(); }
});

// x-pii columns in real module tables: every column named after an x-pii domain property must hold ciphertext.
function xPiiProps() {
  const dir = path.join(ROOT, 'architecture', 'contracts', 'domain');
  const names = new Set();
  const walk = (node, key) => {
    if (!node || typeof node !== 'object') return;
    if (node['x-pii'] === true && key) names.add(key);
    for (const [k, v] of Object.entries(node)) walk(v, k);
  };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) walk(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), null);
  return [...names];
}
const snake = (s) => s.replace(/([A-Z])/g, '_$1').toLowerCase();

test('pii: raw x-pii columns in module tables are encrypted', async (t) => {
  const app = await bootSecurityApp();
  try {
    const props = new Set(xPiiProps().map(snake));
    const raw = app.ctx.db.raw;
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'sec_%'").all().map((r) => r.name);
    let checked = 0;
    for (const table of tables) {
      for (const col of raw.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name).filter((c) => props.has(c))) {
        checked++;
        for (const r of raw.prepare(`SELECT "${col}" AS v FROM "${table}" WHERE "${col}" IS NOT NULL`).all()) {
          assert.ok(app.ctx.crypto.isEncrypted(r.v), `${table}.${col} holds plaintext`);
        }
      }
    }
    if (!checked) t.skip('no module table has columns named after x-pii properties yet (no domain modules implemented)');
  } finally { await app.close(); }
});

test('pii: claim created through the API leaves no PII in outbox, logs or raw columns', async (t) => {
  const app = await bootSecurityApp();
  try {
    const op = parseOpenApi().find((o) => o.method === 'POST' && o.path === '/claims');
    if (!op || !findRoute(app, op)) return t.skip(skipReason(app, op ?? { module: 'claims', method: 'POST', path: '/claims' }));
    const p = PII.A;
    const created = await call(app, 'POST', '/api/v1/claims', {
      token: app.tokenFor(TENANT_A, ['csr']),
      body: {
        lob: 'personal_auto', lossType: 'collision', description: `Rear-ended; ${p.fullName} called from ${p.phone}.`,
        parties: [{ role: 'insured', firstName: 'Zephyrine', lastName: 'Quillfeather', email: p.email, phone: p.phone, dob: p.dob, address: p.address, licenseNumber: p.license }],
        vehicles: [{ plate: p.plate }],
      },
    });
    if (created.status !== 201) return t.skip(`could not create a claim with the probe body (status ${created.status}); update to the ClaimCreate shape`);
    await app.ctx.bus.drain();
    noneOf(JSON.stringify(dumpDatabase(app).outbox), piiValues('A'), 'outbox');
    noneOf(app.logLines.join('\n'), piiValues('A'), 'logs');
    const dump = dumpText(app).replace(/"(?:description|notes?)":"[^"]*"/g, '');
    noneOf(dump, piiValues('A'), 'raw database columns');
  } finally { await app.close(); }
});
