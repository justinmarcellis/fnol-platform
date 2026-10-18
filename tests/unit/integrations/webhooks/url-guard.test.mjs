import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWebhookUrl, isPrivateAddress, checkResolvedHost } from '../../../../src/modules/integrations/webhooks/url-guard.mjs';

const prod = (u) => validateWebhookUrl(u, { devMode: false });
const dev = (u) => validateWebhookUrl(u, { devMode: true });

test('production accepts public https and rejects everything else', () => {
  assert.equal(prod('https://hooks.partner.example/fnol').ok, true);
  for (const bad of [
    'http://hooks.partner.example/fnol',
    'ftp://hooks.partner.example/x',
    'https://user:pw@hooks.partner.example/x',
    'https://localhost/x',
    'https://app.localhost/x',
    'https://127.0.0.1/x',
    'https://127.1/x',
    'https://2130706433/x',
    'https://0x7f.0.0.1/x',
    'https://10.1.2.3/x',
    'https://172.16.0.9/x',
    'https://172.31.255.255/x',
    'https://192.168.1.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/x',
    'https://0.0.0.0/x',
    'https://[::1]/x',
    'https://[::]/x',
    'https://[fd00::1]/x',
    'https://[fe80::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::ffff:10.0.0.1]/x',
    'https://metadata.google.internal/x',
    'https://intranet/x',
    'https://printer.local/x',
    'not a url',
    '',
  ]) {
    const r = prod(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.reason, bad);
  }
});

test('public addresses are allowed, including IPv4 just outside private ranges', () => {
  for (const ok of ['https://8.8.8.8/x', 'https://172.15.0.1/x', 'https://172.32.0.1/x', 'https://100.63.0.1/x', 'https://[2001:db8::1]/x']) {
    assert.equal(prod(ok).ok, true, ok);
  }
});

test('dev mode allows loopback over http but still blocks other private ranges and plain http elsewhere', () => {
  assert.equal(dev('http://127.0.0.1:4000/hook').ok, true);
  assert.equal(dev('http://localhost:4000/hook').ok, true);
  assert.equal(dev('http://[::1]:4000/hook').ok, true);
  assert.equal(dev('http://10.0.0.5/hook').ok, false);
  assert.equal(dev('http://hooks.partner.example/hook').ok, false);
  assert.equal(dev('https://169.254.169.254/x').ok, false);
});

test('isPrivateAddress covers mapped and NAT64 forms', () => {
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true);
  assert.equal(isPrivateAddress('64:ff9b::a00:1'), true);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
});

test('checkResolvedHost blocks hostnames that resolve to private addresses', async () => {
  const url = new URL('https://rebind.partner.example/x');
  assert.equal(await checkResolvedHost(url, async () => ['93.184.216.34']), null);
  assert.match(await checkResolvedHost(url, async () => ['93.184.216.34', '10.0.0.7']), /private/);
  assert.match(await checkResolvedHost(url, async () => { throw new Error('nx'); }), /resolved/);
  assert.equal(await checkResolvedHost(new URL('https://8.8.8.8/x'), async () => { throw new Error('unused'); }), null);
});
