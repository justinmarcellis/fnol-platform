import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call } from '../../../unit/core/helpers.mjs';
import { bootIntegrations, publish, startReceiver } from '../../../unit/integrations/webhooks/helpers.mjs';
import { verifySignature } from '../../../../src/modules/integrations/webhooks/signing.mjs';

const BASE = '/api/v1/integrations';

test('subscription CRUD over HTTP matches the openapi contract', async () => {
  const app = await bootIntegrations();
  try {
    const admin = app.token(['carrier_admin']);
    const created = await call(app, 'POST', `${BASE}/webhooks`, { token: admin, body: { url: 'http://127.0.0.1:9/h', eventTypes: ['claim.routed'], description: 'CRM' } });
    assert.equal(created.status, 201);
    assert.match(created.json.secret, /^whsec_/);
    assert.equal(created.json.tenantId, 'alpha');
    const id = created.json.id;

    const list = await call(app, 'GET', `${BASE}/webhooks`, { token: admin });
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 1);
    assert.equal(list.json.items[0].secret, undefined);
    assert.equal(list.text.includes(created.json.secret), false);

    const got = await call(app, 'GET', `${BASE}/webhooks/${id}`, { token: admin });
    assert.equal(got.status, 200);
    assert.equal(got.json.secret, undefined);

    const patched = await call(app, 'PATCH', `${BASE}/webhooks/${id}`, { token: admin, body: { active: false } });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.active, false);

    const rotated = await call(app, 'PATCH', `${BASE}/webhooks/${id}`, { token: admin, body: { rotateSecret: true } });
    assert.match(rotated.json.secret, /^whsec_/);
    assert.notEqual(rotated.json.secret, created.json.secret);

    const bad = await call(app, 'POST', `${BASE}/webhooks`, { token: admin, body: { url: 'http://example.org/x', eventTypes: ['claim.routed'] } });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.error.code, 'validation_failed');
    assert.equal((await call(app, 'POST', `${BASE}/webhooks`, { token: admin, body: { eventTypes: ['*'] } })).status, 422);

    const del = await call(app, 'DELETE', `${BASE}/webhooks/${id}`, { token: admin });
    assert.equal(del.status, 204);
    assert.equal((await call(app, 'GET', `${BASE}/webhooks/${id}`, { token: admin })).status, 404);
    assert.equal((await call(app, 'DELETE', `${BASE}/webhooks/${id}`, { token: admin })).status, 404);
  } finally { await app.close(); }
});

test('roles and tenancy are enforced', async () => {
  const app = await bootIntegrations();
  try {
    const admin = app.token(['carrier_admin']);
    const csr = app.token(['csr']);
    const betaAdmin = app.token(['carrier_admin'], 'beta');
    const { json: made } = await call(app, 'POST', `${BASE}/webhooks`, { token: admin, body: { url: 'http://127.0.0.1:9/h', eventTypes: ['*'] } });

    assert.equal((await call(app, 'GET', `${BASE}/webhooks`)).status, 401);
    const denied = await call(app, 'GET', `${BASE}/webhooks`, { token: csr });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, 'role_denied');
    assert.equal((await call(app, 'POST', `${BASE}/webhooks`, { token: csr, body: { url: 'http://127.0.0.1:9/h', eventTypes: ['*'] } })).status, 403);
    assert.equal((await call(app, 'GET', `${BASE}/outbox`, { token: csr })).status, 403);
    assert.equal((await call(app, 'GET', `${BASE}/outbox`, { token: app.token(['integration']) })).status, 200);

    // another tenant cannot see or touch it
    assert.deepEqual((await call(app, 'GET', `${BASE}/webhooks`, { token: betaAdmin })).json.items, []);
    assert.equal((await call(app, 'GET', `${BASE}/webhooks/${made.id}`, { token: betaAdmin })).status, 404);
    assert.equal((await call(app, 'PATCH', `${BASE}/webhooks/${made.id}`, { token: betaAdmin, body: { active: false } })).status, 404);
    assert.equal((await call(app, 'GET', `${BASE}/webhooks/${made.id}/deliveries`, { token: betaAdmin })).status, 404);
    const mismatch = await call(app, 'POST', `${BASE}/webhooks`, { token: admin, body: { tenantId: 'beta', url: 'http://127.0.0.1:9/h', eventTypes: ['*'] } });
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.json.error.code, 'tenant_mismatch');
  } finally { await app.close(); }
});

test('end to end: a real bus event is POSTed to a real receiver with a valid signature, then retried until it succeeds', async () => {
  const receiver = await startReceiver((n) => (n < 3 ? 503 : 200));
  const app = await bootIntegrations();
  try {
    const admin = app.token(['carrier_admin']);
    const { json: s } = await call(app, 'POST', `${BASE}/webhooks`, { token: admin, body: { url: receiver.url, eventTypes: ['claim.reported', 'claim.routed'] } });
    app.ctx.clock.set(new Date('2026-03-01T12:00:00.000Z'));

    const evt = await publish(app, 'claim.reported', 'clm_e2e', { claimId: 'clm_e2e', lob: 'auto' });
    assert.equal(receiver.requests.length, 1);
    const r = receiver.requests[0];
    assert.equal(r.headers['x-fnol-event-id'], evt.id);
    assert.equal(r.headers['x-fnol-attempt'], '1');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.equal(verifySignature(s.secret, r.raw, r.headers['x-fnol-signature']), true);
    assert.equal(r.json.id, evt.id);
    assert.equal(r.json.tenantId, 'alpha');
    assert.equal(r.json.type, 'claim.reported');
    assert.equal(r.json.specversion, '1.0');

    // an unsubscribed type is not sent
    await publish(app, 'claim.note.added', 'clm_e2e', {});
    assert.equal(receiver.requests.length, 1);

    const worker = app.svc().worker;
    app.ctx.clock.advance(30e3);
    await worker.tick();
    app.ctx.clock.advance(120e3);
    await worker.tick();
    assert.equal(receiver.requests.length, 3);
    assert.deepEqual(receiver.requests.map((q) => q.headers['x-fnol-attempt']), ['1', '2', '3']);
    assert.equal(new Set(receiver.requests.map((q) => q.raw)).size, 1);

    const dl = await call(app, 'GET', `${BASE}/webhooks/${s.id}/deliveries`, { token: admin });
    assert.equal(dl.status, 200);
    assert.equal(dl.json.items.length, 1);
    assert.equal(dl.json.nextCursor, null);
    const d = dl.json.items[0];
    assert.equal(d.status, 'succeeded');
    assert.equal(d.attempt, 3);
    assert.equal(d.responseStatus, 200);
    assert.equal(d.eventId, evt.id);
    assert.equal(d.eventType, 'claim.reported');
  } finally { await app.close(); await receiver.close(); }
});

test('deliveries are cursor-paginated newest first', async () => {
  const receiver = await startReceiver(() => 200);
  const app = await bootIntegrations();
  try {
    const admin = app.token(['carrier_admin']);
    const { json: s } = await call(app, 'POST', `${BASE}/webhooks`, { token: admin, body: { url: receiver.url, eventTypes: ['*'] } });
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await publish(app, 'claim.reported', `clm_${i}`)).id);

    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const q = `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await call(app, 'GET', `${BASE}/webhooks/${s.id}/deliveries?${q}`, { token: admin });
      assert.equal(r.status, 200);
      assert.ok(r.json.items.length <= 2);
      seen.push(...r.json.items.map((d) => d.eventId));
      cursor = r.json.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.deepEqual(seen, [...ids].reverse());

    assert.equal((await call(app, 'GET', `${BASE}/webhooks/${s.id}/deliveries?cursor=garbage`, { token: admin })).status, 400);
    assert.equal((await call(app, 'GET', `${BASE}/webhooks/${s.id}/deliveries?limit=0`, { token: admin })).status, 400);
    assert.equal((await call(app, 'GET', `${BASE}/webhooks/${s.id}/deliveries?limit=500`, { token: admin })).json.items.length, 5);
  } finally { await app.close(); await receiver.close(); }
});

test('GET /integrations/outbox lists published events with filters and sequence paging', async () => {
  const app = await bootIntegrations();
  try {
    const admin = app.token(['carrier_admin']);
    const e1 = await publish(app, 'claim.reported', 'clm_a');
    const e2 = await publish(app, 'claim.routed', 'clm_a');
    const e3 = await publish(app, 'claim.reported', 'clm_b');
    await publish(app, 'claim.reported', 'clm_x', {}, 'beta');

    const all = await call(app, 'GET', `${BASE}/outbox`, { token: admin });
    assert.equal(all.status, 200);
    assert.deepEqual(all.json.items.map((i) => i.event.id), [e1.id, e2.id, e3.id]);
    assert.deepEqual(all.json.items.map((i) => i.sequence), [1, 2, 3]);
    assert.equal(all.json.nextSequence, 3);
    const item = all.json.items[0];
    assert.equal(item.event.tenantId, 'alpha');
    assert.equal(item.event.type, 'claim.reported');
    assert.match(item.event.source, /^\/tenants\/alpha\/modules\/[a-z]+$/);
    assert.equal(typeof item.publishedAt, 'string');
    assert.ok(['pending', 'dispatched', 'failed'].includes(item.dispatch.status));
    assert.equal(item.dispatch.status, 'dispatched');

    const byType = await call(app, 'GET', `${BASE}/outbox?type=claim.reported`, { token: admin });
    assert.deepEqual(byType.json.items.map((i) => i.event.id), [e1.id, e3.id]);
    const bySubject = await call(app, 'GET', `${BASE}/outbox?subject=clm_a`, { token: admin });
    assert.deepEqual(bySubject.json.items.map((i) => i.event.id), [e1.id, e2.id]);

    const p1 = await call(app, 'GET', `${BASE}/outbox?limit=2`, { token: admin });
    assert.deepEqual(p1.json.items.map((i) => i.sequence), [1, 2]);
    const p2 = await call(app, 'GET', `${BASE}/outbox?limit=2&afterSequence=${p1.json.nextSequence}`, { token: admin });
    assert.deepEqual(p2.json.items.map((i) => i.event.id), [e3.id]);
    const p3 = await call(app, 'GET', `${BASE}/outbox?afterSequence=${p2.json.nextSequence}`, { token: admin });
    assert.deepEqual(p3.json.items, []);
    assert.equal(p3.json.nextSequence, 3);

    assert.equal((await call(app, 'GET', `${BASE}/outbox?afterSequence=abc`, { token: admin })).status, 400);
    // tenant isolation
    const beta = await call(app, 'GET', `${BASE}/outbox`, { token: app.token(['carrier_admin'], 'beta') });
    assert.equal(beta.json.items.length, 1);
    assert.equal(beta.json.items[0].event.tenantId, 'beta');
  } finally { await app.close(); }
});
