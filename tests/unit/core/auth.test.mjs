import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, call } from './helpers.mjs';

test('auth: dev token endpoint issues usable token with claims', async () => {
  const app = await bootApp();
  try {
    const r = await call(app, 'POST', '/api/v1/auth/token', { body: { tenantId: 'alpha', sub: 'sup1', roles: ['supervisor'], name: 'Sam Super' } });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.claims).sort(), ['exp', 'name', 'roles', 'sub', 'tenantId']);
    const a = await call(app, 'GET', '/api/v1/audit', { token: r.json.token });
    assert.equal(a.status, 200);
    const bad = await call(app, 'POST', '/api/v1/auth/token', { body: { tenantId: 'alpha', sub: 'x', roles: ['wizard'] } });
    assert.equal(bad.status, 400);
  } finally { await app.close(); }
});

test('auth: bad signature, malformed, expired, role denied', async () => {
  const app = await bootApp();
  try {
    const good = app.token(['supervisor']);
    const [h, b, s] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'u1', tenantId: 'alpha', roles: ['platform_admin'], exp: 9999999999 })).toString('base64url');
    for (const t of [`${h}.${forged}.${s}`, `${h}.${b}.AAAA`, 'garbage']) {
      const r = await call(app, 'GET', '/api/v1/audit', { token: t });
      assert.equal(r.status, 401, t);
      assert.equal(r.json.error.code, 'invalid_token');
    }
    app.ctx.clock.advance(9 * 3600 * 1000);
    const expired = await call(app, 'GET', '/api/v1/audit', { token: good });
    assert.equal(expired.status, 401);
    assert.equal(expired.json.error.code, 'token_expired');
    app.ctx.clock.reset();

    const denied = await call(app, 'GET', '/api/v1/audit', { token: app.token(['claimant']) });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, 'role_denied');
  } finally { await app.close(); }
});

test('auth: req.tenant from token; X-Tenant-Id only for platform_admin', async () => {
  const app = await bootApp();
  app.ctx.router.get('/t/who', (req, res) => res.json(200, { tenant: req.tenant.id, user: req.user.sub }));
  try {
    let r = await call(app, 'GET', '/t/who', { token: app.token(['csr'], 'alpha') });
    assert.equal(r.json.tenant, 'alpha');
    r = await call(app, 'GET', '/t/who', { token: app.token(['csr'], 'alpha'), headers: { 'x-tenant-id': 'beta' } });
    assert.equal(r.status, 403);
    r = await call(app, 'GET', '/t/who', { token: app.token(['platform_admin'], 'alpha'), headers: { 'x-tenant-id': 'beta' } });
    assert.equal(r.json.tenant, 'beta');
  } finally { await app.close(); }
});

test('auth: token endpoint disabled outside dev mode', async () => {
  const app = await bootApp({ devMode: false });
  try {
    const r = await call(app, 'POST', '/api/v1/auth/token', { body: { tenantId: 'alpha', sub: 'x', roles: ['csr'] } });
    assert.equal(r.status, 404);
  } finally { await app.close(); }
});
