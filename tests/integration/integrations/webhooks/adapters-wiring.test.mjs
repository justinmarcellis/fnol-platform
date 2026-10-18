import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from '../../../unit/core/helpers.mjs';
import { bootIntegrations } from '../../../unit/integrations/webhooks/helpers.mjs';

// Local stub of the S1-INT-03 adapter service interface: createAdapterService(ctx) -> { listAdapters, previewMapping, pushClaim, routes, init }.
const STUB = `
export const migrations = ['CREATE TABLE IF NOT EXISTS stub_sync (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL)'];
export function createAdapterService(ctx) {
  return {
    async listAdapters() { return [{ id: 'stub-core', port: 'claims', format: 'acord-aligned-json', enabled: true }]; },
    async previewMapping(adapterId, claimId) {
      if (adapterId !== 'stub-core') throw new ctx.AppError('not_found', 'Adapter not found', 404);
      return { adapterId, format: 'acord-aligned-json', payload: { claimId, tenant: ctx.tenant?.id ?? null }, unmapped: [], warnings: [] };
    },
    async pushClaim(adapterId, claimId, opts) { return { externalId: 'CC-1', status: 'sent', actor: opts?.actor?.id ?? null }; },
    routes(router) {
      router.get('/api/v1/integrations/stub-extra', (req, res) => res.json(200, { ok: true, tenant: req.ctx.tenant.id }), { roles: ['carrier_admin'] });
    },
    init(root) { root.__adapterInit = (root.__adapterInit ?? 0) + 1; },
  };
}
`;

test('adapters service is composed via guarded dynamic import and exposed through routes', async () => {
  const app = await bootIntegrations({ adaptersSource: STUB });
  try {
    const admin = app.token(['carrier_admin'], 'alpha', 'admin-1');
    const list = await call(app, 'GET', '/api/v1/integrations/adapters', { token: admin });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.items, [{ id: 'stub-core', port: 'claims', format: 'acord-aligned-json', enabled: true }]);

    const prev = await call(app, 'GET', '/api/v1/integrations/adapters/stub-core/preview/clm_1', { token: admin });
    assert.equal(prev.status, 200);
    assert.deepEqual(prev.json.payload, { claimId: 'clm_1', tenant: 'alpha' });
    assert.equal((await call(app, 'GET', '/api/v1/integrations/adapters/nope/preview/clm_1', { token: admin })).status, 404);

    const push = await call(app, 'POST', '/api/v1/integrations/adapters/stub-core/push/clm_1', { token: admin });
    assert.equal(push.status, 202);
    assert.deepEqual(push.json, { externalId: 'CC-1', status: 'sent', actor: 'admin-1' });

    const extra = await call(app, 'GET', '/api/v1/integrations/stub-extra', { token: admin });
    assert.deepEqual(extra.json, { ok: true, tenant: 'alpha' });

    assert.equal((await call(app, 'GET', '/api/v1/integrations/adapters', { token: app.token(['csr']) })).status, 403);
    assert.equal(app.ctx.__adapterInit, 1);
    assert.ok(app.ctx.db.raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'stub_sync'").get(), 'adapter migrations are applied');
  } finally { await app.close(); }
});

test('the module loads and serves empty adapter routes when ./adapters/index.mjs is absent', async () => {
  const app = await bootIntegrations();
  try {
    const admin = app.token(['carrier_admin']);
    const list = await call(app, 'GET', '/api/v1/integrations/adapters', { token: admin });
    assert.deepEqual(list.json, { items: [] });
    assert.equal((await call(app, 'GET', '/api/v1/integrations/adapters/x/preview/clm_1', { token: admin })).status, 404);
    assert.equal((await call(app, 'POST', '/api/v1/integrations/adapters/x/push/clm_1', { token: admin })).status, 404);
  } finally { await app.close(); }
});

test('a broken adapters module is not silently swallowed', async () => {
  await assert.rejects(bootIntegrations({ adaptersSource: 'export const x = ;' }), /SyntaxError|Unexpected/);
});
