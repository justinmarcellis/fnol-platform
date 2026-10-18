import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootSecurityApp, call, TENANT_A, TENANT_B } from './helpers.mjs';

function seed(app) {
  const { audit } = app.ctx;
  for (let i = 0; i < 4; i++) audit.record(TENANT_A, { actor: 'sec-a', action: `sec.a.${i}`, entityType: 'claim', entityId: `clm_a_${i}`, details: { i } });
  for (let i = 0; i < 3; i++) audit.record(TENANT_B, { actor: 'sec-b', action: `sec.b.${i}`, details: { i } });
}

test('audit chain: verify ok for both tenants, via API too', async () => {
  const app = await bootSecurityApp();
  try {
    seed(app);
    for (const tid of [TENANT_A, TENANT_B]) {
      const v = app.ctx.audit.verify(tid);
      assert.equal(v.ok, true, `${tid} chain`);
      assert.equal(v.brokenAt, null);
      assert.ok(v.count >= 3);
      const r = await call(app, 'GET', '/api/v1/audit?verify=true', { token: app.tokenFor(tid, ['supervisor']) });
      assert.equal(r.status, 200);
      assert.equal(r.json.verification.ok, true);
    }
    const rows = app.ctx.audit.list(TENANT_A, { order: 'asc' });
    rows.forEach((r, i) => { if (i) assert.equal(r.prev_hash, rows[i - 1].hash, 'rows link to their predecessor'); });
  } finally { await app.close(); }
});

test('audit chain: append-only triggers block update and delete', async () => {
  const app = await bootSecurityApp();
  try {
    seed(app);
    const raw = app.ctx.db.raw;
    assert.throws(() => raw.exec("UPDATE audit_log SET actor = 'evil'"), /append-only/);
    assert.throws(() => raw.exec('DELETE FROM audit_log'), /append-only/);
    assert.equal(app.ctx.audit.verify(TENANT_A).ok, true);
  } finally { await app.close(); }
});

test('audit chain: field tamper is rejected and stays inside the tampered tenant', async () => {
  const app = await bootSecurityApp();
  try {
    seed(app);
    const raw = app.ctx.db.raw;
    raw.exec('DROP TRIGGER audit_log_no_update'); // attacker with file access
    raw.prepare('UPDATE audit_log SET actor = ? WHERE tenant_id = ? AND seq = 2').run('evil', TENANT_A);
    const v = app.ctx.audit.verify(TENANT_A);
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 2);
    assert.equal(app.ctx.audit.verify(TENANT_B).ok, true, 'other tenant chain unaffected');
    const r = await call(app, 'GET', '/api/v1/audit?verify=true', { token: app.tokenFor(TENANT_A, ['supervisor']) });
    assert.equal(r.json.verification.ok, false, 'API reports the broken chain');
  } finally { await app.close(); }
});

test('audit chain: deleted row, rewritten hash and re-linked rows are rejected', async () => {
  const cases = {
    'row deletion': (raw) => { raw.exec('DROP TRIGGER audit_log_no_delete'); raw.prepare('DELETE FROM audit_log WHERE tenant_id = ? AND seq = 2').run(TENANT_A); },
    'details rewrite': (raw) => { raw.exec('DROP TRIGGER audit_log_no_update'); raw.prepare("UPDATE audit_log SET details = '{\"i\":99}' WHERE tenant_id = ? AND seq = 3").run(TENANT_A); },
    'hash overwrite': (raw) => { raw.exec('DROP TRIGGER audit_log_no_update'); raw.prepare("UPDATE audit_log SET hash = ? WHERE tenant_id = ? AND seq = 4").run('0'.repeat(64), TENANT_A); },
    'truncated tail then forged append': (raw) => {
      raw.exec('DROP TRIGGER audit_log_no_delete'); raw.exec('DROP TRIGGER audit_log_no_update');
      raw.prepare('UPDATE audit_log SET prev_hash = ? WHERE tenant_id = ? AND seq = 3').run('f'.repeat(64), TENANT_A);
    },
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const app = await bootSecurityApp();
    try {
      seed(app);
      tamper(app.ctx.db.raw);
      const v = app.ctx.audit.verify(TENANT_A);
      assert.equal(v.ok, false, name);
      assert.ok(Number.isInteger(v.brokenAt), `${name}: brokenAt reported`);
      assert.equal(app.ctx.audit.verify(TENANT_B).ok, true, `${name}: tenant B intact`);
    } finally { await app.close(); }
  }
});

test('audit chain: only audit-reading roles can query /audit', async () => {
  const app = await bootSecurityApp();
  try {
    for (const role of ['claimant', 'agent', 'csr', 'adjuster', 'integration']) {
      const r = await call(app, 'GET', '/api/v1/audit', { token: app.tokenFor(TENANT_A, [role]) });
      assert.equal(r.status, 403, role);
    }
    assert.equal((await call(app, 'GET', '/api/v1/audit')).status, 401);
  } finally { await app.close(); }
});
