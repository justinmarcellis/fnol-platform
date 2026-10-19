import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminClient } from '../../../../src/web/admin/client.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url, 'http://x');
    const key = `${init.method} ${u.pathname.replace('/api/v1', '')}`;
    calls.push({ key, init, search: u.search });
    const r = routes[key] ?? { status: 404, body: { error: { code: 'not_found', message: 'nope' } } };
    const resp = typeof r === 'function' ? r(init) : r;
    return { ok: resp.status < 400, status: resp.status, headers: { get: (h) => resp.headers?.[h.toLowerCase()] ?? null }, text: async () => (resp.body === undefined ? '' : JSON.stringify(resp.body)) };
  };
  fn.calls = calls;
  return fn;
}
const mk = (routes) => { const f = fakeFetch(routes); return { f, c: createAdminClient({ getToken: () => 'tok', fetchImpl: f }) }; };
const cfg = { tenantId: 'demo', version: 2 };

test('loadConfig takes the version from the ETag and sends the bearer token', async () => {
  const { f, c } = mk({ 'GET /config': { status: 200, headers: { etag: '"5"' }, body: cfg } });
  const r = await c.loadConfig();
  assert.equal(r.version, 5);
  assert.equal(f.calls[0].init.headers['x-fnol-authorization'], 'Bearer tok');
});

test('save validates first, then PUTs with If-Match', async () => {
  const { f, c } = mk({
    'POST /config/validate': { status: 200, body: { valid: true, errors: [] } },
    'PUT /config': { status: 200, headers: { etag: '"3"' }, body: { ...cfg, version: 3 } },
  });
  const r = await c.save(cfg, 2);
  assert.equal(r.outcome, 'saved');
  assert.equal(r.version, 3);
  assert.deepEqual(f.calls.map((x) => x.key), ['POST /config/validate', 'PUT /config']);
  assert.equal(f.calls[1].init.headers['if-match'], '"2"');
});

test('save stops at validation errors without calling PUT', async () => {
  const { f, c } = mk({ 'POST /config/validate': { status: 200, body: { valid: false, errors: [{ path: '/branding/primaryColor', code: 'pattern', message: 'bad' }] } } });
  const r = await c.save(cfg, 2);
  assert.equal(r.outcome, 'invalid');
  assert.equal(r.report.errors[0].section, 'branding');
  assert.equal(f.calls.length, 1);
});

test('save maps 409 to conflict and 422 to invalid', async () => {
  const ok = { status: 200, body: { valid: true, errors: [] } };
  let { c } = mk({ 'POST /config/validate': ok, 'PUT /config': { status: 409, body: { error: { code: 'version_conflict', message: 'at version 4' } } } });
  const conflict = await c.save(cfg, 2);
  assert.equal(conflict.outcome, 'conflict');
  assert.match(conflict.message, /version 4/);
  ({ c } = mk({ 'POST /config/validate': ok, 'PUT /config': { status: 422, body: { valid: false, errors: [{ path: '/rules/0/when', message: 'm' }] } } }));
  const inv = await c.save(cfg, 2);
  assert.equal(inv.outcome, 'invalid');
  assert.equal(inv.report.errors[0].path, '/rules/0/when');
});

test('loadHistory falls back from versions to audit to unavailable on 404', async () => {
  let { c } = mk({ 'GET /config/versions': { status: 200, body: { items: [{ version: 2, actor: 'a' }, { version: 1, actor: 'b' }] } } });
  let h = await c.loadHistory();
  assert.equal(h.source, 'versions');
  assert.equal(h.rows[0].version, 2);
  ({ c } = mk({ 'GET /audit': { status: 200, body: { items: [{ action: 'tenant.config.updated', actor: 'z', details: { version: 4 } }] } } }));
  h = await c.loadHistory();
  assert.equal(h.source, 'audit');
  assert.equal(h.rows[0].version, 4);
  ({ c } = mk({}));
  h = await c.loadHistory();
  assert.deepEqual(h, { available: false, source: 'none', rows: [] });
});

test('loadKpis returns available:false on 404 and the body otherwise', async () => {
  let { c } = mk({});
  assert.equal((await c.loadKpis()).available, false);
  ({ c } = mk({ 'GET /kpis': { status: 200, body: { metrics: {} } } }));
  assert.deepEqual(await c.loadKpis(), { available: true, body: { metrics: {} } });
});

test('webhook calls hit the integrations endpoints', async () => {
  const { f, c } = mk({
    'GET /integrations/webhooks': { status: 200, body: { items: [{ id: 'w1' }] } },
    'POST /integrations/webhooks': { status: 201, body: { id: 'w2', secret: 's' } },
    'PATCH /integrations/webhooks/w2': { status: 200, body: { id: 'w2', active: false } },
    'DELETE /integrations/webhooks/w2': { status: 204 },
  });
  assert.equal((await c.listWebhooks()).items.length, 1);
  assert.equal((await c.createWebhook({ url: 'https://example.test/h', eventTypes: ['claim.created'] })).webhook.secret, 's');
  await c.setWebhookActive('w2', false);
  assert.equal(await c.deleteWebhook('w2'), true);
  assert.equal(JSON.parse(f.calls[1].init.body).active, true);
});

test('network failure throws a service_unavailable ApiError', async () => {
  const c = createAdminClient({ fetchImpl: async () => { throw new Error('down'); } });
  await assert.rejects(c.loadConfig(), (e) => e.code === 'service_unavailable' && e.status === 0);
});
