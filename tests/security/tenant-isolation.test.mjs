import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenApi, bootSecurityApp, findRoute, skipReason, concretePath, call, TENANT_A, TENANT_B } from './helpers.mjs';

const ops = parseOpenApi();
const key = (o) => `${o.method} ${o.path}`;
const hasParam = (o) => /\{\w+\}/.test(o.path);

test('isolation: tenant-B token cannot read tenant-A audit entries', async () => {
  const app = await bootSecurityApp();
  try {
    app.ctx.audit.record(TENANT_A, { actor: 'a-user', action: 'sec.marker.a', entityType: 'claim', entityId: 'clm_tenant_a_only' });
    app.ctx.audit.record(TENANT_B, { actor: 'b-user', action: 'sec.marker.b' });
    const b = await call(app, 'GET', '/api/v1/audit?entityId=clm_tenant_a_only', { token: app.tokenFor(TENANT_B, ['supervisor']) });
    assert.equal(b.status, 200);
    assert.deepEqual(b.json.items, []);
    const all = await call(app, 'GET', '/api/v1/audit?limit=1000', { token: app.tokenFor(TENANT_B, ['supervisor']) });
    assert.ok(all.json.items.every((e) => e.tenant_id === TENANT_B), 'only tenant B rows');
    assert.ok(!all.text.includes('sec.marker.a') && !all.text.includes('clm_tenant_a_only'));
    const a = await call(app, 'GET', '/api/v1/audit?entityId=clm_tenant_a_only', { token: app.tokenFor(TENANT_A, ['supervisor']) });
    assert.equal(a.json.items.length, 1, 'tenant A still sees its own entry');
  } finally { await app.close(); }
});

test('isolation: tenant override header and token tenant are enforced', async () => {
  const app = await bootSecurityApp();
  try {
    const url = '/api/v1/audit';
    const before = app.ctx.audit.list(TENANT_A, { limit: 1000 }).length;
    const h = { 'x-tenant-id': TENANT_A };
    const r = await call(app, 'GET', url, { token: app.tokenFor(TENANT_B, ['supervisor']), headers: h });
    assert.equal(r.status, 403, 'non platform_admin must not switch tenant');
    // A token for a tenant that does not exist must not read or create any tenant's data.
    const ghost = await call(app, 'GET', url, { token: app.tokenFor('sec-ghost-tenant', ['supervisor']) });
    assert.ok([200, 401, 403, 404].includes(ghost.status));
    if (ghost.status === 200) assert.deepEqual(ghost.json.items, []);
    assert.equal(app.ctx.audit.list(TENANT_A, { limit: 1000 }).length, before, 'no stray rows written into tenant A');
  } finally { await app.close(); }
});

test('isolation: store scoping hides tenant-A rows from tenant-B handles', async () => {
  const app = await bootSecurityApp();
  try {
    const { db } = app.ctx;
    db.migrate('sec-probe-iso', ['CREATE TABLE IF NOT EXISTS sec_iso (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, note TEXT)']);
    db.forTenant(TENANT_A).insert('sec_iso', { id: 'iso_a', note: 'alpha row' });
    assert.equal(db.forTenant(TENANT_B).get('SELECT * FROM sec_iso WHERE id = ?', 'iso_a'), undefined);
    assert.equal(db.forTenant(TENANT_B).all('SELECT * FROM sec_iso').length, 0);
    assert.equal(db.forTenant(TENANT_B).update('sec_iso', 'iso_a', { note: 'hijack' }), 0);
    assert.equal(db.forTenant(TENANT_B).run("DELETE FROM sec_iso WHERE id = 'iso_a'").changes, 0);
    assert.equal(db.forTenant(TENANT_A).get('SELECT note FROM sec_iso WHERE id = ?', 'iso_a').note, 'alpha row');
    assert.throws(() => db.system.all('SELECT * FROM sec_iso'), 'system handle must refuse tenant tables');
  } finally { await app.close(); }
});

test('isolation: tenant-B token gets 404/403 for tenant-A resources on every registered {id} route', async (t) => {
  const app = await bootSecurityApp();
  try {
    for (const o of ops.filter((x) => hasParam(x) && !x.public)) {
      const route = findRoute(app, o);
      if (!route) { await t.test(key(o), { skip: skipReason(app, o) }, () => {}); continue; }
      await t.test(key(o), async (t2) => {
        // Prefer a role the registered route really accepts and the auth layer can issue.
        const role = [...(route.opts.roles ?? []), ...o.roles].find((r) => app.ctx.auth.ROLES.includes(r));
        if (!role) return t2.skip(`no issuable role for ${key(o)} (documented ${o.roles.join(',')}; see contract-change on roles missing from ctx.auth.ROLES)`);
        const token = app.tokenFor(TENANT_B, [role]);
        const r = await call(app, o.method, concretePath(o.path, (n) => `tenant_a_${n}`), { token, body: ['POST', 'PUT', 'PATCH'].includes(o.method) ? {} : undefined });
        // A collection route nested under a missing/foreign parent may answer 200 with an empty list; that leaks nothing.
        if (r.status === 200 && o.method === 'GET' && Array.isArray(r.json?.items) && r.json.items.length === 0) return;
        assert.ok([403, 404].includes(r.status) || (r.status >= 400 && r.status < 500 && r.status !== 401), `expected 403/404-class refusal, got ${r.status}`);
        assert.notEqual(r.status, 200, `tenant B got 200 with body ${r.text.slice(0, 120)}`);
      });
    }
  } finally { await app.close(); }
});

test('isolation: a claim created by tenant A is invisible to tenant B', async (t) => {
  const app = await bootSecurityApp();
  try {
    const post = ops.find((o) => o.method === 'POST' && o.path === '/claims');
    if (!post || !findRoute(app, post)) return t.skip(skipReason(app, post ?? { module: 'claims', method: 'POST', path: '/claims' }));
    const created = await call(app, 'POST', '/api/v1/claims', {
      token: app.tokenFor(TENANT_A, ['csr']),
      body: { lob: 'personal_auto', lossEvent: { lossDate: '2026-01-02', cause: 'collision', description: 'Isolation probe, synthetic.' } },
    });
    if (created.status !== 201 || !created.json?.id) return t.skip(`could not create a claim with the probe body (status ${created.status}); update this test to the ClaimCreate shape`);
    const id = created.json.id;
    const b = await call(app, 'GET', `/api/v1/claims/${id}`, { token: app.tokenFor(TENANT_B, ['csr']) });
    assert.ok([403, 404].includes(b.status), `got ${b.status}`);
    const list = await call(app, 'GET', '/api/v1/claims', { token: app.tokenFor(TENANT_B, ['csr']) });
    assert.ok(!list.text.includes(id), 'tenant B list must not include the tenant A claim');
    const a = await call(app, 'GET', `/api/v1/claims/${id}`, { token: app.tokenFor(TENANT_A, ['csr']) });
    assert.equal(a.status, 200);
  } finally { await app.close(); }
});

test('isolation: documents of a tenant-A claim are invisible to tenant B (seeded, not just empty)', async (t) => {
  const app = await bootSecurityApp();
  try {
    if (!app.ctx.moduleNames.includes('evidence') || !app.ctx.moduleNames.includes('claims')) return t.skip('evidence/claims modules not both registered');
    const created = await call(app, 'POST', '/api/v1/claims', {
      token: app.tokenFor(TENANT_A, ['csr']),
      body: { lob: 'personal_auto', lossEvent: { lossDate: '2026-01-02', cause: 'collision', description: 'Doc isolation probe, synthetic.' } },
    });
    if (created.status !== 201) return t.skip(`could not create claim (${created.status})`);
    const id = created.json.id;
    const up = await call(app, 'POST', `/api/v1/claims/${id}/documents`, {
      token: app.tokenFor(TENANT_A, ['csr']),
      body: { kind: 'photo', filename: 'probe.png', contentType: 'image/png', contentBase64: Buffer.from('synthetic-bytes').toString('base64') },
    });
    if (up.status !== 201) return t.skip(`could not upload document (${up.status})`);
    const docId = up.json.id;
    const tb = app.tokenFor(TENANT_B, ['csr']);
    const list = await call(app, 'GET', `/api/v1/claims/${id}/documents`, { token: tb });
    assert.ok(!list.text.includes(docId) && !list.text.includes('probe.png'), 'tenant B list must not show the tenant A document');
    for (const suffix of ['', '/content']) {
      const r = await call(app, 'GET', `/api/v1/claims/${id}/documents/${docId}${suffix}`, { token: tb });
      assert.ok([403, 404].includes(r.status), `documents${suffix} got ${r.status}`);
    }
    const own = await call(app, 'GET', `/api/v1/claims/${id}/documents`, { token: app.tokenFor(TENANT_A, ['csr']) });
    assert.ok(own.text.includes(docId), 'tenant A still sees its own document');
  } finally { await app.close(); }
});
