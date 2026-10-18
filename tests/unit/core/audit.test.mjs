import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, call } from './helpers.mjs';

test('audit: chain verifies, per-tenant chains, filters via API', async () => {
  const app = await bootApp();
  const { audit } = app.ctx;
  try {
    audit.record('alpha', { actor: 'u1', action: 'claim.created', entityType: 'claim', entityId: 'clm_1', details: { a: 1 } });
    audit.record('alpha', { actor: 'u2', action: 'claim.updated', entityType: 'claim', entityId: 'clm_1' });
    audit.record('beta', { actor: 'u9', action: 'claim.created', entityType: 'claim', entityId: 'clm_2' });
    const base = audit.list('alpha', { order: 'asc' }).filter((e) => e.action.startsWith('claim'));
    assert.deepEqual(base.map((e) => e.action), ['claim.created', 'claim.updated']);
    assert.equal(base[0].prev_hash.length, 64);
    assert.equal(base[1].prev_hash, base[0].hash);
    assert.deepEqual(audit.verify('alpha'), { ok: true, brokenAt: null, count: audit.list('alpha').length });
    assert.equal(audit.verify('beta').ok, true);

    const sup = app.token(['supervisor'], 'alpha');
    const r = await call(app, 'GET', '/api/v1/audit?actor=u2&verify=true', { token: sup });
    assert.equal(r.status, 200);
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.verification.ok, true);
    const r2 = await call(app, 'GET', '/api/v1/audit?entityType=claim&entityId=clm_2', { token: sup });
    assert.equal(r2.json.items.length, 0, 'tenant alpha cannot see beta entries');
  } finally { await app.close(); }
});

test('audit: append-only triggers and tamper detection', async () => {
  const app = await bootApp();
  const { audit, db } = app.ctx;
  try {
    for (let i = 0; i < 3; i++) audit.record('alpha', { actor: 'u', action: `a${i}`, details: { i } });
    assert.throws(() => db.raw.exec("UPDATE audit_log SET actor = 'evil'"), /append-only/);
    assert.throws(() => db.raw.exec('DELETE FROM audit_log'), /append-only/);
    // An attacker with file access removes the trigger and edits a row.
    db.raw.exec('DROP TRIGGER audit_log_no_update');
    const seq = audit.list('alpha', { order: 'asc' })[1].seq;
    db.raw.exec(`UPDATE audit_log SET actor = 'evil' WHERE tenant_id = 'alpha' AND seq = ${seq}`);
    assert.deepEqual({ ...audit.verify('alpha') }.brokenAt, seq);
    assert.equal(audit.verify('alpha').ok, false);
    assert.equal(audit.verify('beta').ok, true);
  } finally { await app.close(); }
});
