import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntegrations } from './helpers.mjs';

const input = (extra = {}) => ({ url: 'http://127.0.0.1:9/hook', eventTypes: ['claim.reported'], ...extra });

test('create returns the secret once and stores it encrypted', async () => {
  const app = await bootIntegrations();
  try {
    const svc = app.svc();
    const created = await svc.createSubscription(input({ description: 'Partner feed' }), { actor: { id: 'u1' } });
    assert.match(created.secret, /^whsec_/);
    assert.equal(created.tenantId, 'alpha');
    assert.equal(created.active, true);
    assert.equal(created.description, 'Partner feed');
    assert.deepEqual(created.retryPolicy, { maxAttempts: 5, backoff: 'exponential' });
    assert.match(created.secretRef, /^webhook_subscriptions\//);

    // never returned again
    assert.equal((await svc.getSubscription(created.id)).secret, undefined);
    assert.equal((await svc.listSubscriptions())[0].secret, undefined);
    assert.equal(JSON.stringify(await svc.listSubscriptions()).includes(created.secret), false);

    // encrypted at rest
    const row = app.ctx.db.forTenant('alpha').get('SELECT secret_enc, doc FROM webhook_subscriptions WHERE id = ?', created.id);
    assert.match(row.secret_enc, /^enc:v1:/);
    assert.equal(row.secret_enc.includes(created.secret), false);
    assert.equal(row.doc.includes(created.secret), false);
    assert.equal(app.tctx().crypto.decryptPii(row.secret_enc), created.secret);

    // not in the audit trail either
    const audit = app.ctx.audit.list('alpha', { action: 'webhook.created' });
    assert.equal(audit.length, 1);
    assert.equal(JSON.stringify(audit).includes(created.secret), false);
  } finally { await app.close(); }
});

test('subscriptions match WebhookSubscription.schema.json property names', async () => {
  const app = await bootIntegrations();
  try {
    const sub = await app.svc().getSubscription((await app.svc().createSubscription(input())).id);
    const allowed = new Set(['id', 'tenantId', 'url', 'description', 'eventTypes', 'active', 'secretRef', 'retryPolicy', 'createdAt', 'updatedAt']);
    for (const k of Object.keys(sub)) assert.ok(allowed.has(k), k);
    for (const k of ['id', 'tenantId', 'url', 'eventTypes', 'active']) assert.ok(k in sub, k);
  } finally { await app.close(); }
});

test('validation: urls, event types, unknown fields, tenant mismatch', async () => {
  const app = await bootIntegrations();
  try {
    const svc = app.svc();
    const fails = async (inp, status, code) => {
      await assert.rejects(svc.createSubscription(inp), (e) => e.status === status && (!code || e.code === code), JSON.stringify(inp));
    };
    await fails(input({ url: 'http://example.org/x' }), 422, 'validation_failed');
    await fails(input({ url: 'http://10.0.0.1/x' }), 422);
    await fails(input({ url: 'file:///etc/passwd' }), 422);
    await fails(input({ eventTypes: [] }), 422);
    await fails(input({ eventTypes: ['claims.reported'] }), 422);
    await fails(input({ eventTypes: ['claim.Reported'] }), 422);
    await fails(input({ eventTypes: 'claim.reported' }), 422);
    await fails(input({ active: 'yes' }), 422);
    await fails(input({ bogus: 1 }), 422);
    await fails(input({ retryPolicy: { maxAttempts: 99 } }), 422);
    await fails(input({ tenantId: 'beta' }), 403, 'tenant_mismatch');
    await fails(null, 422);
    const ok = await svc.createSubscription(input({ tenantId: 'alpha', eventTypes: ['*', 'claim.routed', 'tenant.config.updated', '*'] }));
    assert.deepEqual(ok.eventTypes, ['*', 'claim.routed', 'tenant.config.updated']);
  } finally { await app.close(); }
});

test('production mode rejects loopback targets', async () => {
  const app = await bootIntegrations({ devMode: false });
  try {
    await assert.rejects(app.svc().createSubscription(input()), (e) => e.status === 422);
    const ok = await app.svc().createSubscription({ url: 'https://hooks.partner.example/fnol', eventTypes: ['*'] });
    assert.equal(ok.url, 'https://hooks.partner.example/fnol');
  } finally { await app.close(); }
});

test('update patches fields, rotates the secret once, and audits without secrets', async () => {
  const app = await bootIntegrations();
  try {
    const svc = app.svc();
    const created = await svc.createSubscription(input());
    const patched = await svc.updateSubscription(created.id, { active: false, eventTypes: ['*'], description: 'paused' });
    assert.equal(patched.active, false);
    assert.deepEqual(patched.eventTypes, ['*']);
    assert.equal(patched.secret, undefined);
    assert.ok(patched.updatedAt >= created.updatedAt);

    const rotated = await svc.updateSubscription(created.id, { rotateSecret: true });
    assert.match(rotated.secret, /^whsec_/);
    assert.notEqual(rotated.secret, created.secret);
    const row = app.ctx.db.forTenant('alpha').get('SELECT secret_enc FROM webhook_subscriptions WHERE id = ?', created.id);
    assert.equal(app.tctx().crypto.decryptPii(row.secret_enc), rotated.secret);
    assert.equal((await svc.getSubscription(created.id)).secret, undefined);

    await assert.rejects(svc.updateSubscription(created.id, { url: 'http://example.org/x' }), (e) => e.status === 422);
    await assert.rejects(svc.updateSubscription('whk_missing', { active: true }), (e) => e.status === 404);
    const audit = JSON.stringify(app.ctx.audit.list('alpha', {}));
    assert.equal(audit.includes(rotated.secret), false);
    assert.ok(audit.includes('webhook.updated'));
  } finally { await app.close(); }
});

test('delete removes the subscription and tenants are isolated', async () => {
  const app = await bootIntegrations();
  try {
    const a = await app.svc('alpha').createSubscription(input());
    assert.deepEqual(await app.svc('beta').listSubscriptions(), []);
    await assert.rejects(app.svc('beta').getSubscription(a.id), (e) => e.status === 404);
    await assert.rejects(app.svc('beta').updateSubscription(a.id, { active: false }), (e) => e.status === 404);
    await assert.rejects(app.svc('beta').deleteSubscription(a.id), (e) => e.status === 404);
    await assert.rejects(app.svc('beta').listDeliveries(a.id), (e) => e.status === 404);
    await app.svc('alpha').deleteSubscription(a.id);
    assert.deepEqual(await app.svc('alpha').listSubscriptions(), []);
    await assert.rejects(app.svc('alpha').deleteSubscription(a.id), (e) => e.status === 404);
  } finally { await app.close(); }
});

test('adapter functions degrade gracefully when the adapters service is absent', async () => {
  const app = await bootIntegrations();
  try {
    assert.deepEqual(await app.svc().listAdapters(), []);
    await assert.rejects(app.svc().previewMapping('x', 'clm_1'), (e) => e.status === 404);
    await assert.rejects(app.svc().pushClaim('x', 'clm_1', {}), (e) => e.status === 404);
  } finally { await app.close(); }
});
