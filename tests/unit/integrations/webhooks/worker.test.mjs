import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntegrations, publish, fakeFetch, allowHosts } from './helpers.mjs';
import { verifySignature } from '../../../../src/modules/integrations/webhooks/signing.mjs';

const HOUR = 3600e3;
const sub = (extra = {}) => ({ url: 'http://127.0.0.1:9/hook', eventTypes: ['claim.reported'], ...extra });
const deliveries = (app, id, tenant = 'alpha') => app.ctx.db.forTenant(tenant).all('SELECT * FROM webhook_deliveries WHERE subscription_id = ? ORDER BY seq', id);

async function setup(opts = {}, ...script) {
  const app = await bootIntegrations(opts);
  const fetch = fakeFetch(...script);
  app.svc().worker.configure({ fetch });
  return { app, fetch };
}

test('delivers the envelope with a verifiable HMAC signature', async () => {
  const { app, fetch } = await setup({}, 200);
  try {
    const s = await app.svc().createSubscription(sub());
    const evt = await publish(app, 'claim.reported', 'clm_100', { claimId: 'clm_100' });
    assert.equal(fetch.calls.length, 1);
    const call = fetch.calls[0];
    assert.equal(call.url, 'http://127.0.0.1:9/hook');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'manual');
    assert.equal(call.headers['X-FNOL-Event-Id'], evt.id);
    assert.equal(call.headers['X-FNOL-Event-Type'], 'claim.reported');
    // the signature is HMAC-SHA256(secret, exact bytes sent)
    assert.equal(verifySignature(s.secret, call.body, call.headers['X-FNOL-Signature']), true);
    assert.equal(verifySignature('wrong', call.body, call.headers['X-FNOL-Signature']), false);
    const body = JSON.parse(call.body);
    assert.equal(body.id, evt.id);
    assert.equal(body.type, 'claim.reported');
    assert.equal(body.tenantId, 'alpha');
    assert.equal(body.subject, 'clm_100');
    assert.match(body.source, /^\/tenants\/alpha\/modules\/[a-z]+$/);
    assert.deepEqual(body.data, { claimId: 'clm_100' });
    const [d] = deliveries(app, s.id);
    assert.equal(d.status, 'succeeded');
    assert.equal(d.attempt, 1);
    assert.equal(d.response_status, 200);
    assert.equal(d.next_attempt_at, null);
  } finally { await app.close(); }
});

test('filters by eventTypes, wildcard, active flag and tenant', async () => {
  const { app, fetch } = await setup({}, 204);
  try {
    const only = await app.svc().createSubscription(sub({ eventTypes: ['claim.routed'] }));
    const star = await app.svc().createSubscription(sub({ eventTypes: ['*'] }));
    const off = await app.svc().createSubscription(sub({ eventTypes: ['*'], active: false }));
    const other = await app.svc('beta').createSubscription(sub({ eventTypes: ['*'] }));
    await publish(app, 'claim.reported');
    assert.equal(deliveries(app, only.id).length, 0);
    assert.equal(deliveries(app, star.id).length, 1);
    assert.equal(deliveries(app, off.id).length, 0);
    assert.equal(deliveries(app, other.id, 'beta').length, 0);
    await publish(app, 'claim.routed');
    assert.equal(deliveries(app, only.id).length, 1);
    assert.equal(deliveries(app, star.id).length, 2);
    await publish(app, 'tenant.config.updated', 'alpha', {});
    assert.equal(deliveries(app, star.id).length, 3);
    assert.equal(fetch.calls.length, 4);
  } finally { await app.close(); }
});

test('failures retry with exponential backoff recorded in webhook_deliveries, then give up', async () => {
  const clock = (await import('../../../../src/core/clock.mjs')).createClock?.();
  const { app, fetch } = await setup(clock ? { clock } : {}, 500, new Error('connect ECONNREFUSED'), 503, 502, 500);
  try {
    const s = await app.svc().createSubscription(sub());
    app.ctx.clock.set(new Date('2026-01-01T00:00:00.000Z'));
    await publish(app, 'claim.reported');
    const t0 = app.ctx.clock.now().getTime();
    let [d] = deliveries(app, s.id);
    assert.equal(d.attempt, 1);
    assert.equal(d.status, 'pending');
    assert.equal(d.response_status, 500);
    assert.equal(d.last_error, 'http_500');
    assert.equal(d.next_attempt_at, new Date(t0 + 30e3).toISOString());

    // not due yet: tick is a no-op
    app.ctx.clock.advance(29e3);
    assert.deepEqual(await app.svc().worker.tick(), { attempted: 0 });
    assert.equal(fetch.calls.length, 1);

    // attempt 2 (network error) -> next in 2 minutes
    app.ctx.clock.advance(1e3);
    assert.deepEqual(await app.svc().worker.tick(), { attempted: 1 });
    [d] = deliveries(app, s.id);
    assert.equal(d.attempt, 2);
    assert.equal(d.response_status, null);
    assert.match(d.last_error, /ECONNREFUSED/);
    assert.equal(d.next_attempt_at, new Date(app.ctx.clock.now().getTime() + 120e3).toISOString());

    // attempt 3 -> +10 minutes, attempt 4 -> +1 hour
    app.ctx.clock.advance(120e3);
    await app.svc().worker.tick();
    [d] = deliveries(app, s.id);
    assert.equal(d.attempt, 3);
    assert.equal(d.next_attempt_at, new Date(app.ctx.clock.now().getTime() + 600e3).toISOString());
    app.ctx.clock.advance(600e3);
    await app.svc().worker.tick();
    [d] = deliveries(app, s.id);
    assert.equal(d.attempt, 4);
    assert.equal(d.next_attempt_at, new Date(app.ctx.clock.now().getTime() + HOUR).toISOString());

    // attempt 5 is the last one: status failed, nothing scheduled
    app.ctx.clock.advance(HOUR);
    await app.svc().worker.tick();
    [d] = deliveries(app, s.id);
    assert.equal(d.attempt, 5);
    assert.equal(d.status, 'failed');
    assert.equal(d.next_attempt_at, null);
    app.ctx.clock.advance(24 * HOUR);
    assert.deepEqual(await app.svc().worker.tick(), { attempted: 0 });
    assert.equal(fetch.calls.length, 5);
    assert.equal(deliveries(app, s.id).length, 1);

    // attempt counter and id header evolve per attempt; body is byte-identical on every retry
    assert.deepEqual(fetch.calls.map((c) => c.headers['X-FNOL-Attempt']), ['1', '2', '3', '4', '5']);
    assert.equal(new Set(fetch.calls.map((c) => c.body)).size, 1);
  } finally { await app.close(); }
});

test('a retry that succeeds ends the sequence', async () => {
  const { app, fetch } = await setup({}, 500, 200);
  try {
    const s = await app.svc().createSubscription(sub());
    await publish(app, 'claim.reported');
    app.ctx.clock.advance(31e3);
    await app.svc().worker.tick();
    const [d] = deliveries(app, s.id);
    assert.equal(d.status, 'succeeded');
    assert.equal(d.attempt, 2);
    assert.equal(d.response_status, 200);
    app.ctx.clock.advance(HOUR);
    assert.deepEqual(await app.svc().worker.tick(), { attempted: 0 });
    assert.equal(fetch.calls.length, 2);
  } finally { await app.close(); }
});

test('respects the per-subscription retryPolicy.maxAttempts', async () => {
  const { app, fetch } = await setup({}, 500);
  try {
    const s = await app.svc().createSubscription(sub({ retryPolicy: { maxAttempts: 2 } }));
    await publish(app, 'claim.reported');
    app.ctx.clock.advance(31e3);
    await app.svc().worker.tick();
    const [d] = deliveries(app, s.id);
    assert.equal(d.status, 'failed');
    assert.equal(d.attempt, 2);
    assert.equal(fetch.calls.length, 2);
  } finally { await app.close(); }
});

test('idempotent per (subscription, event): replays never create or send duplicates', async () => {
  const { app, fetch } = await setup({}, 200);
  try {
    const s = await app.svc().createSubscription(sub());
    const evt = await publish(app, 'claim.reported');
    assert.equal(fetch.calls.length, 1);
    // direct re-invocation of the handler (replay after crash) and bus recovery
    await app.svc().worker.handleEvent(evt, app.tctx());
    app.ctx.db.forTenant('alpha').run("UPDATE outbox SET status = 'pending'");
    app.ctx.bus.recover(['alpha']);
    await app.ctx.bus.drain();
    assert.equal(fetch.calls.length, 1);
    assert.equal(deliveries(app, s.id).length, 1);
    // a second event does create a second delivery
    await publish(app, 'claim.reported', 'clm_2');
    assert.equal(deliveries(app, s.id).length, 2);
    // the unique index backs the pre-check
    assert.throws(() => app.ctx.db.forTenant('alpha').insert('webhook_deliveries', {
      id: 'whd_dup', subscription_id: s.id, event_id: evt.id, event_type: evt.type, attempt: 0, status: 'pending', at: 'x',
    }), /UNIQUE/);
  } finally { await app.close(); }
});

test('a deactivated or deleted subscription stops retrying', async () => {
  const { app, fetch } = await setup({}, 500);
  try {
    const a = await app.svc().createSubscription(sub());
    const b = await app.svc().createSubscription(sub());
    await publish(app, 'claim.reported');
    assert.equal(fetch.calls.length, 2);
    await app.svc().updateSubscription(a.id, { active: false });
    await app.svc().deleteSubscription(b.id);
    app.ctx.clock.advance(31e3);
    await app.svc().worker.tick();
    assert.equal(fetch.calls.length, 2);
    assert.equal(deliveries(app, a.id)[0].last_error, 'subscription_inactive');
    assert.equal(deliveries(app, b.id)[0].last_error, 'subscription_deleted');
    assert.equal(deliveries(app, a.id)[0].status, 'failed');
  } finally { await app.close(); }
});

test('timeouts abort the request and are retried', async () => {
  const app = await bootIntegrations();
  try {
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    app.svc().worker.configure({ fetch: hang, timeoutMs: 20 });
    const s = await app.svc().createSubscription(sub());
    await publish(app, 'claim.reported');
    const [d] = deliveries(app, s.id);
    assert.equal(d.status, 'pending');
    assert.equal(d.last_error, 'timeout');
  } finally { await app.close(); }
});

test('SSRF: production blocks private targets even if one is already stored, and DNS rebinding', async () => {
  const { app, fetch } = await setup({ devMode: false }, 200);
  try {
    allowHosts(app, ['*.partner.example', '169.254.169.254', '127.0.0.1']);
    app.svc().worker.configure({ resolveHost: async (h) => (h === 'rebind.partner.example' ? ['10.0.0.8'] : ['93.184.216.34']) });
    const t = app.ctx.db.forTenant('alpha');
    const mk = (id, url) => t.insert('webhook_subscriptions', {
      id, url, event_types: ['*'], active: 1, secret_enc: app.tctx().crypto.encryptPii('whsec_x'), doc: { createdAt: 'x', updatedAt: 'x' },
    });
    mk('whk_private', 'https://169.254.169.254/latest');
    mk('whk_loop', 'http://127.0.0.1:8080/x');
    mk('whk_rebind', 'https://rebind.partner.example/x');
    mk('whk_ok', 'https://hooks.partner.example/x');
    await publish(app, 'claim.reported');
    assert.deepEqual(fetch.calls.map((c) => c.url), ['https://hooks.partner.example/x']);
    for (const id of ['whk_private', 'whk_loop', 'whk_rebind']) {
      const [d] = deliveries(app, id);
      assert.equal(d.status, 'failed', id);
      assert.match(d.last_error, /^blocked:/, id);
      assert.equal(d.attempt, 1);
    }
    assert.equal(deliveries(app, 'whk_ok')[0].status, 'succeeded');
  } finally { await app.close(); }
});

test('payload carries no secrets and the log never contains the secret', async () => {
  const { app, fetch } = await setup({}, 200);
  try {
    const s = await app.svc().createSubscription(sub());
    await publish(app, 'claim.reported');
    assert.equal(fetch.calls[0].body.includes(s.secret), false);
    const dump = JSON.stringify(app.ctx.db.forTenant('alpha').all('SELECT * FROM webhook_deliveries'));
    assert.equal(dump.includes(s.secret), false);
  } finally { await app.close(); }
});
