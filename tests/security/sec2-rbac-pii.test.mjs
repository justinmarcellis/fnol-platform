// S2-SEC-01: RBAC / object-level access / PII findings. Tests named SEC2-NNN assert the SECURE behaviour and are
// marked t.todo until the owning team fixes the finding (they run, and their failure is reported as TODO).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policies } from '../../src/modules/coverage/fixtures.mjs';
import { dumpText } from './helpers.mjs';
import { bootReal, call, createClaimWithPii, PII, T1, T2 } from './sec2-helpers.mjs';

test('SEC2-001: an agent token cannot read or modify another user\'s intake session', async (t) => {
  const app = await bootReal();
  try {
    const victim = app.as(T1, ['claimant'], 'sec2-victim');
    const agent = app.as(T1, ['agent'], 'sec2-rogue-agent');
    const start = await call(app, 'POST', '/api/v1/intake/sessions', { token: victim, body: { lob: 'personal_auto', channel: 'claimant_web' } });
    assert.equal(start.status, 201);
    const sid = start.json.sessionId;
    const answered = await call(app, 'POST', `/api/v1/intake/sessions/${sid}/answers`, { token: victim, body: { questionId: 'loss_date', value: '2026-10-01' } });
    assert.equal(answered.status, 200);
    const read = await call(app, 'GET', `/api/v1/intake/sessions/${sid}`, { token: agent });
    assert.ok([403, 404].includes(read.status), `agent read another user's session: ${read.status}`);
    const write = await call(app, 'POST', `/api/v1/intake/sessions/${sid}/answers`, { token: agent, body: { questionId: 'loss_date', value: '2026-09-01' } });
    assert.ok([403, 404].includes(write.status), `agent wrote to another user's session: ${write.status}`);
  } finally { await app.close(); }
});

test('SEC2-002: policy snapshots cached by coverage hold no plaintext x-pii (insured and driver names)', async (t) => {
  const app = await bootReal();
  try {
    await app.ctx.forTenant(T1).modules.coverage.seedPolicies(policies);
    const r = await call(app, 'GET', '/api/v1/policies/AUT-100001/snapshot?asOf=2026-10-01', { token: app.as(T1, ['csr'], 'sec2-csr') });
    assert.equal(r.status, 200, 'snapshot request should succeed for the test to be meaningful');
    const rows = app.ctx.db.raw.prepare('SELECT doc FROM policy_snapshots').all();
    assert.ok(rows.length > 0, 'a snapshot should have been cached');
    for (const row of rows) assert.ok(!row.doc.includes('Avery Testwell'), 'insured name is stored in plaintext in policy_snapshots.doc');
  } finally { await app.close(); }
});

test('SEC2-003: the integration role cannot read unmasked claim PII from the fake core receiver', async (t) => {
  const app = await bootReal();
  try {
    await createClaimWithPii(app, T1, 'A');
    const integ = app.as(T1, ['integration'], 'sec2-int');
    const viaClaims = await call(app, 'GET', '/api/v1/claims?limit=5', { token: integ });
    assert.ok(!viaClaims.text.includes(PII.A.email), 'precondition: integration is redacted on the claims API');
    const r = await call(app, 'GET', '/api/v1/integrations/fake-core/claims', { token: integ });
    assert.ok(r.status === 403 || (!r.text.includes(PII.A.email) && !r.text.includes(PII.A.phone)),
      `integration read unmasked PII through the fake core listing (status ${r.status})`);
  } finally { await app.close(); }
});

test('SEC2-004: claimant claim reads are projected and limited to the claim the claimant reported', async () => {
  const app = await bootReal();
  try {
    const id = await createClaimWithPii(app, T1, 'A'); // reportedBy.id is the csr sub below
    const csr = app.as(T1, ['csr'], 'sec2-csr');
    await call(app, 'POST', `/api/v1/claims/${id}/triage`, { token: csr, body: {} });
    await app.ctx.bus.drain();
    const owner = await call(app, 'GET', `/api/v1/claims/${id}`, { token: app.as(T1, ['claimant'], 'sec2-csr') });
    assert.equal(owner.status, 200);
    assert.ok(!owner.json.triage, 'triage block is visible to a claimant');
    assert.ok(!('fraudScore' in (owner.json.triage ?? {})) && !JSON.stringify(owner.json).includes('fraudScore'), 'fraudScore is visible to a claimant');
    assert.ok(!(owner.json.flags ?? []).includes('siu'), 'SIU flag is visible to a claimant');
    assert.ok(!owner.json.routing?.adjusterId, 'adjuster assignment detail is visible to a claimant');
    const other = await call(app, 'GET', `/api/v1/claims/${id}`, { token: app.as(T1, ['claimant'], 'sec2-any-claimant') });
    assert.equal(other.status, 404, 'an unrelated claimant can read the claim');
  } finally { await app.close(); }
});

test('SEC2-017: auditor and integration roles do not see decrypted names in coverage or extraction responses', async (t) => {
  t.todo('SEC2-017: GET /claims/{id}/coverage and /documents/{id}/extraction return insured names and pii:true fields to auditor/integration');
  const app = await bootReal();
  try {
    await app.ctx.forTenant(T1).modules.coverage.seedPolicies(policies);
    const id = await createClaimWithPii(app, T1, 'A', { policyNumber: 'AUT-100001' });
    const csr = app.as(T1, ['csr'], 'sec2-csr');
    await call(app, 'POST', `/api/v1/claims/${id}/coverage/verify`, { token: csr });
    const cov = await call(app, 'GET', `/api/v1/claims/${id}/coverage`, { token: app.as(T1, ['auditor'], 'sec2-aud') });
    assert.equal(cov.status, 200);
    assert.ok(JSON.stringify(cov.json.policy ?? {}).length > 2, 'precondition: a policy snapshot is returned');
    assert.ok(!JSON.stringify(cov.json.policy ?? {}).includes('Avery Testwell'), 'auditor sees named insureds');
    const doc = await call(app, 'POST', `/api/v1/claims/${id}/documents`, {
      token: csr, body: { filename: 'pr.txt', kind: 'police_report', contentType: 'text/plain', contentBase64: Buffer.from('Police report no: PR-12345\nCited: Mallory Fictionton').toString('base64') },
    });
    await app.ctx.bus.drain();
    for (const role of ['auditor', 'integration']) {
      const ex = await call(app, 'GET', `/api/v1/claims/${id}/documents/${doc.json.id}/extraction`, { token: app.as(T1, [role], 'sec2-x') });
      assert.ok(!ex.text.includes('Fictionton'), `${role} sees pii:true extraction values`);
    }
  } finally { await app.close(); }
});

test('SEC2-008: free-text status reasons do not travel in events (outbox / webhooks)', async (t) => {
  const app = await bootReal();
  try {
    const id = await createClaimWithPii(app, T1, 'A');
    const r = await call(app, 'POST', `/api/v1/claims/${id}/status`, {
      token: app.as(T1, ['supervisor'], 'sec2-sup'), body: { to: 'withdrawn', reason: `${PII.A.fullName} phoned from ${PII.A.phone}` },
    });
    assert.equal(r.status, 200);
    await app.ctx.bus.drain();
    const events = app.ctx.db.raw.prepare("SELECT event FROM outbox WHERE type = 'claim.status.changed'").all().map((x) => x.event).join('\n');
    assert.ok(!events.includes(PII.A.fullName) && !events.includes(PII.A.phone), 'free-text reason with PII is in the outbox event');
  } finally { await app.close(); }
});

test('SEC2-016: a note cannot claim AI provenance through the request body', async (t) => {
  const app = await bootReal();
  try {
    const id = await createClaimWithPii(app, T1, 'A');
    const r = await call(app, 'POST', `/api/v1/claims/${id}/notes`, {
      token: app.as(T1, ['csr'], 'sec2-csr'), body: { body: 'hello', ai: { provider: 'forged', model: 'forged', confidence: 1 } },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.ai, undefined, 'client-supplied ai provenance was stored');
  } finally { await app.close(); }
});

// ---- controls that hold today (regression guards, not todo) ---------------------------------------------

test('sec2: tenant B cannot read or change tenant A claims, documents, webhooks, intake sessions or routing', async () => {
  const app = await bootReal();
  try {
    const id = await createClaimWithPii(app, T1, 'A');
    const doc = await call(app, 'POST', `/api/v1/claims/${id}/documents`, {
      token: app.as(T1, ['csr'], 'sec2-csr'), body: { filename: 'a.txt', contentType: 'text/plain', contentBase64: Buffer.from('Police report no: PR-12345').toString('base64') },
    });
    assert.equal(doc.status, 201);
    const wh = await call(app, 'POST', '/api/v1/integrations/webhooks', { token: app.as(T1, ['tenant_admin'], 'sec2-adm'), body: { url: 'https://hooks.example.test/x', eventTypes: ['claim.reported'] } });
    assert.equal(wh.status, 201);
    const sess = await call(app, 'POST', '/api/v1/intake/sessions', { token: app.as(T1, ['csr'], 'sec2-csr'), body: { lob: 'personal_auto', channel: 'csr_phone' } });
    assert.equal(sess.status, 201);
    const b = (roles) => app.as(T2, roles, 'sec2-attacker');
    const probes = [
      ['GET', `/api/v1/claims/${id}`, ['csr']],
      ['GET', `/api/v1/claims/${id}/notes`, ['csr']],
      ['GET', `/api/v1/claims/${id}/documents/${doc.json.id}`, ['csr']],
      ['GET', `/api/v1/claims/${id}/documents/${doc.json.id}/content`, ['csr']],
      ['GET', `/api/v1/claims/${id}/triage`, ['csr']],
      ['GET', `/api/v1/claims/${id}/coverage`, ['csr']],
      ['GET', `/api/v1/adjuster/claims/${id}/view`, ['adjuster']],
      ['GET', `/api/v1/integrations/webhooks/${wh.json.id}`, ['tenant_admin']],
      ['PATCH', `/api/v1/integrations/webhooks/${wh.json.id}`, ['tenant_admin'], { active: false }],
      ['DELETE', `/api/v1/integrations/webhooks/${wh.json.id}`, ['tenant_admin']],
      ['GET', `/api/v1/intake/sessions/${sess.json.sessionId}`, ['csr']],
      ['POST', `/api/v1/claims/${id}/status`, ['supervisor'], { to: 'withdrawn' }],
      ['POST', `/api/v1/claims/${id}/routing`, ['supervisor'], {}],
      ['POST', `/api/v1/integrations/adapters/core-claims-suite/push/${id}`, ['tenant_admin'], {}],
    ];
    for (const [m, u, roles, body] of probes) {
      const r = await call(app, m, u, { token: b(roles), body });
      assert.equal(r.status, 404, `${m} ${u.replace(id, '<claim>')} should be 404 for another tenant, got ${r.status}`);
    }
    const spoof = await call(app, 'POST', '/api/v1/claims', { token: b(['csr']), body: { tenantId: T1, lob: 'personal_auto', lossEvent: { lossDate: '2026-10-01', cause: 'collision', description: 'd' } } });
    assert.equal(spoof.status, 403, 'tenantId in a body must not select the tenant');
    const hdr = await call(app, 'GET', `/api/v1/claims/${id}`, { token: b(['supervisor']), headers: { 'x-tenant-id': T1 } });
    assert.equal(hdr.status, 403, 'X-Tenant-Id is platform_admin only');
    const still = await call(app, 'GET', `/api/v1/claims/${id}`, { token: app.as(T1, ['csr'], 'sec2-csr') });
    assert.equal(still.status, 200);
    assert.notEqual(still.json.status, 'withdrawn', 'cross-tenant status change must not apply');
  } finally { await app.close(); }
});

test('sec2: events and the outbox carry no PII for the claim, evidence and coverage flows', async () => {
  const app = await bootReal();
  try {
    await app.ctx.forTenant(T1).modules.coverage.seedPolicies(policies);
    const id = await createClaimWithPii(app, T1, 'A');
    await call(app, 'POST', `/api/v1/claims/${id}/notes`, { token: app.as(T1, ['csr'], 'sec2-csr'), body: { body: `${PII.A.fullName} said ${PII.A.phone}` } });
    await call(app, 'POST', `/api/v1/claims/${id}/documents`, {
      token: app.as(T1, ['csr'], 'sec2-csr'),
      body: { filename: 'pr.txt', kind: 'police_report', contentType: 'text/plain', contentBase64: Buffer.from(`Police report no: PR-12345\nCited: ${PII.A.fullName}`).toString('base64') },
    });
    await app.ctx.bus.drain();
    const outbox = JSON.stringify(app.ctx.db.raw.prepare('SELECT event FROM outbox').all());
    for (const v of [PII.A.fullName, PII.A.phone, PII.A.email, PII.A.address, PII.A.dob]) assert.ok(!outbox.includes(v), `outbox leaks ${v}`);
    const audit = JSON.stringify(app.ctx.db.raw.prepare('SELECT details FROM audit_log').all());
    for (const v of [PII.A.fullName, PII.A.phone, PII.A.email]) assert.ok(!audit.includes(v), `audit_log leaks ${v}`);
    assert.ok(!app.logLines.join('\n').includes(PII.A.fullName), 'logs leak the name');
    // Claims, notes and evidence extractions are encrypted at rest.
    const rest = dumpText(app);
    for (const v of [PII.A.fullName, PII.A.phone, PII.A.email]) assert.ok(!rest.includes(v), `database holds plaintext ${v}`);
  } finally { await app.close(); }
});
