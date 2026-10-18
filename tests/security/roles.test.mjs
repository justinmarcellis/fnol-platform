import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenApi, bootSecurityApp, findRoute, skipReason, concretePath, call, TENANT_A } from './helpers.mjs';

const ops = parseOpenApi().filter((o) => !o.public);
const key = (o) => `${o.method} ${o.path}`;
const body = (o) => (['POST', 'PUT', 'PATCH'].includes(o.method) ? {} : undefined);

test('roles: no token gets 401, wrong role gets 403, allowed roles are never 401/403', async (t) => {
  const app = await bootSecurityApp();
  try {
    const issuable = app.ctx.auth.ROLES;
    for (const o of ops) {
      const route = findRoute(app, o);
      if (!route) { await t.test(key(o), { skip: skipReason(app, o) }, () => {}); continue; }
      await t.test(key(o), async () => {
        const url = concretePath(o.path);
        const none = await call(app, o.method, url, { body: body(o) });
        assert.equal(none.status, 401, 'no token must be 401');
        const bogus = await call(app, o.method, url, { token: 'not.a.token', body: body(o) });
        assert.equal(bogus.status, 401, 'garbage token must be 401');

        // A role is "wrong" only if neither the contract nor the registered route grants it.
        const granted = new Set([...o.roles, ...(route.opts.roles ?? []), 'platform_admin']);
        const wrong = issuable.filter((r) => !granted.has(r));
        for (const role of wrong) {
          const r = await call(app, o.method, url, { token: app.tokenFor(TENANT_A, [role]), body: body(o) });
          assert.equal(r.status, 403, `role ${role} must be 403, got ${r.status}`);
          assert.equal(r.json?.error?.code, 'role_denied');
        }
        for (const role of o.roles.filter((x) => issuable.includes(x))) {
          const r = await call(app, o.method, url, { token: app.tokenFor(TENANT_A, [role]), body: body(o) });
          assert.ok(r.status !== 401 && r.status !== 403, `documented role ${role} was refused with ${r.status}`);
        }
      });
    }
  } finally { await app.close(); }
});

test('roles: a token with roles outside the platform vocabulary cannot be minted or forged', async () => {
  const app = await bootSecurityApp();
  try {
    assert.throws(() => app.ctx.auth.issueToken({ sub: 'x', tenantId: TENANT_A, roles: ['root'] }));
    const good = app.tokenFor(TENANT_A, ['claimant']);
    const [h, p, s] = good.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), roles: ['platform_admin'] })).toString('base64url');
    const r = await call(app, 'GET', '/api/v1/audit', { token: `${h}.${forgedBody}.${s}` });
    assert.equal(r.status, 401, 'forged payload must fail signature check');
    const expired = app.ctx.auth.issueToken({ sub: 'x', tenantId: TENANT_A, roles: ['supervisor'], ttlSeconds: -10 });
    assert.equal((await call(app, 'GET', '/api/v1/audit', { token: expired })).status, 401, 'expired token must be 401');
  } finally { await app.close(); }
});
