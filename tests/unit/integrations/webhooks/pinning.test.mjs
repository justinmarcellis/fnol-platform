// S3-INT-02: SEC2-007 (pinned connect), SEC2-015 (allowedHosts), SEC2-019 (IPv6 forms), redirects never followed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bootIntegrations, publish, allowHosts } from './helpers.mjs';
import { resolveAndPin, classifyAddress, checkAllowedHost, pinnedRequest, validateWebhookUrl } from '../../../../src/modules/integrations/webhooks/url-guard.mjs';
import { coreClaimsSuite } from '../../../../src/modules/integrations/adapters/core-claims-suite.mjs';

const deliveries = (app, id, tenant = 'alpha') => app.ctx.db.forTenant(tenant).all('SELECT * FROM webhook_deliveries WHERE subscription_id = ? ORDER BY seq', id);
const u = (s) => new URL(s);

function recordingTransport(status = 204) {
  const calls = [];
  const fn = async (req) => { calls.push(req); return { status, headers: {}, body: Buffer.alloc(0) }; };
  fn.calls = calls;
  return fn;
}

async function prodApp(hosts = ['hooks.partner.example']) {
  const app = await bootIntegrations({ devMode: false });
  allowHosts(app, hosts);
  return app;
}

test('the host is resolved once and the connection goes to the pinned address, never to a second answer', async () => {
  const app = await prodApp();
  try {
    let lookups = 0;
    const resolveHost = async () => (++lookups === 1 ? ['93.184.216.34'] : ['10.0.0.8']);
    const transport = recordingTransport();
    app.svc().worker.configure({ resolveHost, transport });
    const s = await app.svc().createSubscription({ url: 'https://hooks.partner.example/hook', eventTypes: ['claim.reported'] });
    await publish(app, 'claim.reported');
    assert.equal(lookups, 1);
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].address, '93.184.216.34');
    assert.equal(transport.calls[0].family, 4);
    assert.equal(transport.calls[0].url.hostname, 'hooks.partner.example'); // original host kept for Host/SNI
    assert.equal(deliveries(app, s.id)[0].status, 'succeeded');
  } finally { await app.close(); }
});

test('legacy fetch seam receives the pinned address and redirect: manual', async () => {
  const app = await prodApp();
  try {
    const calls = [];
    app.svc().worker.configure({
      resolveHost: async () => ['93.184.216.34'],
      fetch: async (url, init) => { calls.push({ url, init }); return { status: 204, body: null }; },
    });
    await app.svc().createSubscription({ url: 'https://hooks.partner.example/hook', eventTypes: ['claim.reported'] });
    await publish(app, 'claim.reported');
    assert.equal(calls[0].init.redirect, 'manual');
    assert.deepEqual(calls[0].init.dispatcher.pinned, { address: '93.184.216.34', family: 4 });
  } finally { await app.close(); }
});

test('mixed public/private answers are rejected and nothing is sent', async () => {
  const app = await prodApp();
  try {
    const transport = recordingTransport();
    app.svc().worker.configure({ resolveHost: async () => ['93.184.216.34', '169.254.169.254'], transport });
    const s = await app.svc().createSubscription({ url: 'https://hooks.partner.example/hook', eventTypes: ['claim.reported'] });
    await publish(app, 'claim.reported');
    assert.equal(transport.calls.length, 0);
    const [d] = deliveries(app, s.id);
    assert.equal(d.status, 'failed');
    assert.match(d.last_error, /^blocked:/);
  } finally { await app.close(); }
});

test('resolveAndPin classifies every address, including IPv6 and mapped forms', async () => {
  const pin = (answers, opts) => resolveAndPin(u('https://h.partner.example/'), { resolveHost: async () => answers, ...opts });
  assert.equal((await pin(['93.184.216.34'])).ok, true);
  assert.equal((await pin(['2606:4700::1111'])).family, 6);
  assert.equal((await pin(['93.184.216.34', '::ffff:7f00:1'])).ok, false);
  assert.equal((await pin(['::ffff:10.0.0.1'])).ok, false);
  assert.equal((await pin(['2606:4700::1111', 'fd00::1'])).ok, false);
  assert.equal((await pin([])).ok, false);
  assert.equal((await resolveAndPin(u('https://h.partner.example/'), { resolveHost: async () => { throw new Error('x'); } })).ok, false);
  assert.equal((await pin(['127.0.0.1'])).ok, false);
  // devMode loopback exception: loopback answers accepted only when allowed, and never mixed with public ones
  assert.equal((await pin(['127.0.0.1'], { allowLoopback: true })).ok, true);
  assert.equal((await pin(['127.0.0.1', '93.184.216.34'], { allowLoopback: true })).ok, false);
  assert.equal((await pin(['127.0.0.1', '10.0.0.1'], { allowLoopback: true })).ok, false);
  const lit = await resolveAndPin(u('http://127.0.0.1:9/x'), { allowLoopback: true });
  assert.equal(lit.address, '127.0.0.1');
});

test('SEC2-019: IPv6 transition forms are not public', () => {
  for (const ip of ['2002:7f00:1::', '2002:a9fe:a9fe::', '64:ff9b:1::a9fe:a9fe', '::ffff:0:7f00:1', '::ffff:0:808:808', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fec0::1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a00:1', '3fff::1', '4000::1']) {
    assert.notEqual(classifyAddress(ip), 'public', ip);
  }
  for (const ip of ['2606:4700::1111', '2a00:1450:4001::200e', '64:ff9b::808:808', '::ffff:8.8.8.8']) {
    assert.equal(classifyAddress(ip), 'public', ip);
  }
});

test('allowedHosts: create/update enforce the tenant list; empty list denies in production', async () => {
  const app = await bootIntegrations({ devMode: false });
  try {
    const body = (url) => ({ url, eventTypes: ['*'] });
    await assert.rejects(app.svc().createSubscription(body('https://hooks.partner.example/x')), (e) => e.status === 422 && /allowed/.test(e.message));
    allowHosts(app, ['hooks.partner.example', '*.cdn.example']);
    const ok = await app.svc().createSubscription(body('https://hooks.partner.example/x'));
    await app.svc().createSubscription(body('https://a.cdn.example/x'));
    await assert.rejects(app.svc().createSubscription(body('https://evil.example.com/x')), (e) => e.status === 422);
    await assert.rejects(app.svc().createSubscription(body('https://cdn.example/x')), (e) => e.status === 422); // wildcard excludes the apex
    await assert.rejects(app.svc().createSubscription(body('https://hooks.partner.example.evil.test/x')), (e) => e.status === 422);
    await assert.rejects(app.svc().updateSubscription(ok.id, { url: 'https://evil.example.com/x' }), (e) => e.status === 422);
    assert.equal((await app.svc().updateSubscription(ok.id, { url: 'https://b.cdn.example/y' })).url, 'https://b.cdn.example/y');
  } finally { await app.close(); }
});

test('allowedHosts: delivery refuses a stored subscription whose host is no longer allowed', async () => {
  const app = await prodApp(['hooks.partner.example']);
  try {
    const transport = recordingTransport();
    app.svc().worker.configure({ resolveHost: async () => ['93.184.216.34'], transport });
    const s = await app.svc().createSubscription({ url: 'https://hooks.partner.example/x', eventTypes: ['claim.reported'] });
    allowHosts(app, []);
    await publish(app, 'claim.reported');
    assert.equal(transport.calls.length, 0);
    assert.match(deliveries(app, s.id)[0].last_error, /^blocked: no allowed/);
    allowHosts(app, ['other.example']);
    await publish(app, 'claim.reported', 'clm_2');
    assert.match(deliveries(app, s.id)[1].last_error, /^blocked: host is not in/);
  } finally { await app.close(); }
});

test('allowedHosts: devMode with an empty list allows, and loopback works through a non-empty list', async () => {
  assert.equal(checkAllowedHost('hooks.partner.example', [], { devMode: true }), null);
  assert.equal(checkAllowedHost('hooks.partner.example', undefined, { devMode: false })?.length > 0, true);
  assert.equal(checkAllowedHost('127.0.0.1', ['hooks.partner.example'], { devMode: true, loopback: true }), null);
  assert.ok(checkAllowedHost('evil.example', ['hooks.partner.example'], { devMode: true }));
  assert.ok(checkAllowedHost('HOOKS.partner.example.', ['hooks.PARTNER.example'], { devMode: false }) === null);
  const app = await bootIntegrations(); // devMode default in tests
  try {
    const s = await app.svc().createSubscription({ url: 'http://127.0.0.1:9/hook', eventTypes: ['claim.reported'] });
    const transport = recordingTransport();
    app.svc().worker.configure({ transport });
    await publish(app, 'claim.reported');
    assert.equal(transport.calls[0].address, '127.0.0.1');
    assert.equal(deliveries(app, s.id)[0].status, 'succeeded');
  } finally { await app.close(); }
});

test('a 3xx response is a failed delivery and is never followed', async () => {
  const app = await prodApp();
  try {
    const transport = recordingTransport(302);
    app.svc().worker.configure({ resolveHost: async () => ['93.184.216.34'], transport });
    const s = await app.svc().createSubscription({ url: 'https://hooks.partner.example/x', eventTypes: ['claim.reported'] });
    await publish(app, 'claim.reported');
    assert.equal(transport.calls.length, 1);
    const [d] = deliveries(app, s.id);
    assert.equal(d.status, 'pending'); // retried like any failure
    assert.equal(d.last_error, 'redirect_302');
  } finally { await app.close(); }
});

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) }));
  });
}

test('pinnedRequest connects to the pinned address with the original Host and does not request a redirect Location', async () => {
  const target = await listen((req, res) => { target.hits.push(req.url); res.writeHead(200).end('final'); });
  target.hits = [];
  const redirector = await listen((req, res) => {
    redirector.seen = { host: req.headers.host, body: '' };
    req.on('data', (c) => { redirector.seen.body += c; });
    req.on('end', () => res.writeHead(302, { location: `http://127.0.0.1:${target.port}/stolen` }).end());
  });
  try {
    const res = await pinnedRequest({
      url: u(`http://hooks.partner.example:${redirector.port}/hook?x=1`), address: '127.0.0.1', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}',
    });
    assert.equal(res.status, 302);
    assert.equal(redirector.seen.host, `hooks.partner.example:${redirector.port}`);
    assert.equal(redirector.seen.body, '{"a":1}');
    assert.deepEqual(target.hits, []); // Location was never requested
  } finally { await target.close(); await redirector.close(); }
});

test('pinnedRequest times out', async () => {
  const hang = await listen(() => {});
  try {
    await assert.rejects(pinnedRequest({ url: u(`http://x.example:${hang.port}/`), address: '127.0.0.1', timeoutMs: 50 }), (e) => e.name === 'AbortError');
  } finally { await hang.close(); }
});

test('claims-port send: pinned address is used, 3xx fails without following, unpinned http target is refused', async () => {
  const calls = [];
  const transport = async (req) => { calls.push(req); return { status: 200, headers: {}, body: Buffer.from('{"coreClaimNumber":"C-9"}') }; };
  const target = { kind: 'http', url: 'https://core.partner.example/claims', pinned: { address: '93.184.216.34', family: 4 }, transport };
  assert.equal((await coreClaimsSuite.send({ a: 1 }, target)).externalId, 'C-9');
  assert.equal(calls[0].address, '93.184.216.34');
  assert.equal(calls[0].url.hostname, 'core.partner.example');

  const redirecting = async () => ({ status: 307, headers: { location: 'http://127.0.0.1/' }, body: Buffer.alloc(0) });
  await assert.rejects(coreClaimsSuite.send({}, { ...target, transport: redirecting }), /redirect/);

  const fetchCalls = [];
  const fetch303 = async (url, init) => { fetchCalls.push(init); return { status: 303, json: async () => ({}) }; };
  await assert.rejects(coreClaimsSuite.send({}, { kind: 'http', url: 'http://x.test', fetch: fetch303 }), /redirect/);
  assert.equal(fetchCalls[0].redirect, 'manual');
  assert.equal(fetchCalls.length, 1);

  await assert.rejects(coreClaimsSuite.send({}, { kind: 'http', url: 'https://core.partner.example/claims' }), /pinned/);
});

test('validateWebhookUrl still gates loopback by devMode', () => {
  assert.equal(validateWebhookUrl('http://127.0.0.1:1/x', { devMode: true }).loopback, true);
  assert.equal(validateWebhookUrl('http://127.0.0.1:1/x', { devMode: false }).ok, false);
});
