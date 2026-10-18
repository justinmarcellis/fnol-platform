// S2-SEC-01: webhook delivery, SSRF guard and adapter target findings. SEC2-NNN tests assert the SECURE
// behaviour and are t.todo until fixed; unmarked tests are regression guards for controls that hold today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateWebhookUrl, checkResolvedHost, classifyAddress } from '../../src/modules/integrations/webhooks/url-guard.mjs';
import { sign, verifySignature, buildHeaders } from '../../src/modules/integrations/webhooks/signing.mjs';
import { ROOT } from './helpers.mjs';
import { bootReal, call, T1 } from './sec2-helpers.mjs';

/** Create a subscription on `host` and deliver one event through the real worker with a recording fetch. */
async function deliverOnce(app, { host = 'hooks.example.test', resolveHost, status = 204, headers = {} } = {}) {
  const tctx = app.ctx.forTenant(T1);
  const sub = await tctx.modules.integrations.createSubscription({ url: `https://${host}/hook`, eventTypes: ['claim.updated'] }, { actor: 'sec2' });
  const calls = [];
  tctx.modules.integrations.worker.configure({
    resolveHost: resolveHost ?? (async () => ['93.184.216.34']),
    fetch: async (url, init) => { calls.push({ url, init }); return { status, headers: new Map(Object.entries(headers)), body: null }; },
  });
  tctx.bus.publish('claim.updated', 'clm_sec2', { claimId: 'clm_sec2', change: 'probe' });
  await app.ctx.bus.drain();
  return { sub, calls, tctx };
}

test('SEC2-007: webhook delivery connects to the address it validated (no DNS rebinding window)', async (t) => {
  t.todo('SEC2-007: checkResolvedHost resolves once, then global fetch resolves again; the connection is not pinned to the validated IP');
  const app = await bootReal();
  try {
    const { calls } = await deliverOnce(app);
    assert.equal(calls.length, 1, 'one delivery attempt expected');
    const { url, init } = calls[0];
    const pinned = init.dispatcher !== undefined || new URL(url).hostname === '93.184.216.34';
    assert.ok(pinned, 'fetch was called with the hostname and no pinned dispatcher, so it resolves DNS a second time');
  } finally { await app.close(); }
});

test('SEC2-019: IPv6 transition-mechanism literals that embed private IPv4 are classified private', async (t) => {
  t.todo('SEC2-019: 6to4 (2002::/16), NAT64 local-use (64:ff9b:1::/48), SIIT (::ffff:0:a.b.c.d), Teredo and site-local literals are classified public');
  for (const ip of ['2002:7f00:1::', '2002:a9fe:a9fe::', '64:ff9b:1::a9fe:a9fe', '::ffff:0:7f00:1', 'fec0::1']) {
    assert.notEqual(classifyAddress(ip), 'public', `${ip} is classified public`);
  }
});

test('SEC2-020: webhook deliveries carry a signed timestamp so receivers can enforce a replay window', async (t) => {
  t.todo('SEC2-020: the signature covers the body only; no timestamp header or documented tolerance (body time is the only freshness signal)');
  const h = buildHeaders({ secret: 'whsec_x', body: '{}', eventId: 'e', eventType: 'claim.updated', deliveryId: 'd', attempt: 1 });
  const names = Object.keys(h).map((k) => k.toLowerCase());
  assert.ok(names.some((n) => n.includes('timestamp')), 'no timestamp header in delivery');
});

test('SEC2-021: /healthz does not list module names or tenant counts to anonymous callers', async (t) => {
  t.todo('SEC2-021: public /healthz returns ctx.moduleNames and the tenant count');
  const app = await bootReal();
  try {
    const r = await call(app, 'GET', '/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['ok']);
  } finally { await app.close(); }
});

// ---- controls that hold today (regression guards) -------------------------------------------------------

test('sec2: validateWebhookUrl blocks loopback, private, link-local, metadata, mapped, numeric and credentialed targets', () => {
  const blocked = [
    'http://example.com/', 'https://localhost/', 'https://foo.localhost/', 'https://127.0.0.1/', 'https://0.0.0.0/', 'https://[::1]/', 'https://[::]/',
    'https://10.0.0.5/', 'https://172.16.0.1/', 'https://192.168.1.1/', 'https://169.254.169.254/', 'https://100.64.0.1/', 'https://metadata.google.internal/',
    'https://metadata/', 'https://[::ffff:7f00:1]/', 'https://[::ffff:a9fe:a9fe]/', 'https://[64:ff9b::7f00:1]/', 'https://[fd00:ec2::254]/', 'https://[fe80::1]/',
    'https://2130706433/', 'https://0x7f.1/', 'https://017700000001/', 'https://user:pw@example.com/', 'https://example.com@127.0.0.1/', 'ftp://example.com/', 'file:///etc/passwd',
    'https://printer.local/', 'https://intranet.corp/', 'not a url', '',
  ];
  for (const u of blocked) assert.equal(validateWebhookUrl(u, { devMode: false }).ok, false, `${u} should be rejected`);
  assert.equal(validateWebhookUrl('https://hooks.example.com/path?x=1', { devMode: false }).ok, true);
});

test('sec2: delivery-time DNS check refuses hostnames that resolve to private addresses (including mixed answers)', async () => {
  assert.match(await checkResolvedHost(new URL('https://a.example.com/'), async () => ['10.0.0.5']), /private/);
  assert.match(await checkResolvedHost(new URL('https://a.example.com/'), async () => ['93.184.216.34', '127.0.0.1']), /private/);
  assert.match(await checkResolvedHost(new URL('https://a.example.com/'), async () => ['::ffff:169.254.169.254']), /private/);
  assert.match(await checkResolvedHost(new URL('https://a.example.com/'), async () => { throw new Error('nx'); }), /resolved/);
  assert.equal(await checkResolvedHost(new URL('https://a.example.com/'), async () => ['93.184.216.34']), null);
});

test('sec2: webhook delivery blocks rebinding answers, never follows redirects, and signs the exact body', async () => {
  const app = await bootReal();
  try {
    const blockedRun = await deliverOnce(app, { host: 'rebind.example.test', resolveHost: async () => ['169.254.169.254'] });
    assert.equal(blockedRun.calls.length, 0, 'no request may be sent to a host that resolves to a private address');
    const rows = app.ctx.db.raw.prepare('SELECT status, last_error FROM webhook_deliveries').all();
    assert.ok(rows.some((r) => r.status === 'failed' && /blocked/.test(r.last_error)), 'blocked delivery is recorded as failed');
  } finally { await app.close(); }
  const app2 = await bootReal();
  try {
    const { calls, sub } = await deliverOnce(app2, { status: 302, headers: { location: 'https://169.254.169.254/latest' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual', 'redirects must not be followed');
    const tctx = app2.ctx.forTenant(T1);
    const secretRow = tctx.db.get('SELECT secret_enc FROM webhook_subscriptions WHERE id = ?', sub.id);
    const secret = tctx.crypto.decryptPii(secretRow.secret_enc);
    assert.equal(calls[0].init.headers['X-FNOL-Signature'], sign(secret, calls[0].init.body), 'signature covers the exact bytes sent');
    assert.equal(JSON.parse(calls[0].init.body).tenantId, T1);
    const row = app2.ctx.db.raw.prepare('SELECT status FROM webhook_deliveries').get();
    assert.notEqual(row.status, 'succeeded', 'a 3xx is not a success');
  } finally { await app2.close(); }
});

test('sec2: webhook signatures verify in constant time and reject tampering, truncation and wrong secrets', () => {
  const body = JSON.stringify({ id: 'evt_1' });
  const sig = sign('whsec_a', body);
  assert.equal(verifySignature('whsec_a', body, sig), true);
  assert.equal(verifySignature('whsec_a', body, `sha256=${sig}`), true);
  assert.equal(verifySignature('whsec_b', body, sig), false);
  assert.equal(verifySignature('whsec_a', `${body} `, sig), false);
  assert.equal(verifySignature('whsec_a', body, sig.slice(0, -2)), false);
  assert.equal(verifySignature('whsec_a', body, undefined), false);
  const src = fs.readFileSync(path.join(ROOT, 'src/modules/integrations/webhooks/signing.mjs'), 'utf8');
  assert.match(src, /timingSafeEqual/);
});

test('sec2: webhook and adapter routes require admin roles and secrets are shown once', async () => {
  const app = await bootReal();
  try {
    for (const role of ['csr', 'adjuster', 'claimant', 'agent', 'auditor']) {
      const r = await call(app, 'POST', '/api/v1/integrations/webhooks', { token: app.as(T1, [role], 'sec2-x'), body: { url: 'https://hooks.example.test/x', eventTypes: ['claim.reported'] } });
      assert.equal(r.status, 403, `${role} must not create webhooks`);
    }
    const adm = app.as(T1, ['tenant_admin'], 'sec2-adm');
    const created = await call(app, 'POST', '/api/v1/integrations/webhooks', { token: adm, body: { url: 'https://hooks.example.test/x', eventTypes: ['claim.reported'] } });
    assert.equal(created.status, 201);
    assert.match(created.json.secret, /^whsec_/);
    const again = await call(app, 'GET', `/api/v1/integrations/webhooks/${created.json.id}`, { token: adm });
    assert.equal(again.json.secret, undefined, 'secret is not returned after creation');
    assert.ok(!JSON.stringify(app.ctx.db.raw.prepare('SELECT secret_enc FROM webhook_subscriptions').all()).includes(created.json.secret), 'secret stored encrypted');
    const bad = await call(app, 'POST', '/api/v1/integrations/webhooks', { token: adm, body: { url: 'https://169.254.169.254/', eventTypes: ['claim.reported'] } });
    assert.equal(bad.status, 422);
    const pii = await call(app, 'POST', '/api/v1/integrations/webhooks', { token: adm, body: { url: 'https://hooks.example.test/x', eventTypes: ['claim.reported'], tenantId: 'other' } });
    assert.equal(pii.status, 403, 'body tenantId mismatch is refused');
  } finally { await app.close(); }
});
