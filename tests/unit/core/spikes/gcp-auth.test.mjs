import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenProvider, gcpFetch } from '../../../../src/core/gcp-auth.mjs';

const SECRET = 'ya29.synthetic-secret-token';
const mk = (responses) => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); const r = responses.shift(); if (r instanceof Error) throw r; return r; };
  return { calls, fetch };
};
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });

test('fetches from metadata server with header, caches until near expiry, then refreshes', async () => {
  let t = 1_000_000;
  const { calls, fetch } = mk([json(200, { access_token: 'a', expires_in: 3600 }), json(200, { access_token: 'b', expires_in: 3600 })]);
  const p = createTokenProvider({ fetch, env: {}, now: () => t });
  assert.equal(await p.getToken(), 'a');
  assert.equal(await p.getToken(), 'a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
  assert.equal(calls[0].init.headers['Metadata-Flavor'], 'Google');
  t += 3600_000 - 30_000; // inside skew window
  assert.equal(await p.getToken(), 'b');
  assert.equal(calls.length, 2);
});

test('env override token and metadata host', async () => {
  const { calls, fetch } = mk([]);
  assert.equal(await createTokenProvider({ fetch, env: { GCP_ACCESS_TOKEN: 'local' } }).getToken(), 'local');
  assert.equal(calls.length, 0);
  const m = mk([json(200, { access_token: 'x', expires_in: 60 })]);
  await createTokenProvider({ fetch: m.fetch, env: { GCE_METADATA_HOST: 'meta.example.test' } }).getToken();
  assert.match(m.calls[0].url, /^http:\/\/meta\.example\.test\//);
});

test('concurrent callers share one request', async () => {
  const { calls, fetch } = mk([json(200, { access_token: 'a', expires_in: 3600 })]);
  const p = createTokenProvider({ fetch, env: {} });
  assert.deepEqual(await Promise.all([p.getToken(), p.getToken()]), ['a', 'a']);
  assert.equal(calls.length, 1);
});

test('errors carry no token or body', async () => {
  const bad = { ok: false, status: 500, json: async () => ({ access_token: SECRET }) };
  await assert.rejects(createTokenProvider({ fetch: mk([bad]).fetch, env: {} }).getToken(), (e) => e.code === 'token_http' && !e.message.includes(SECRET));
  await assert.rejects(createTokenProvider({ fetch: mk([json(200, { access_token: SECRET })]).fetch, env: {} }).getToken(), (e) => e.code === 'token_invalid' && !e.message.includes(SECRET));
  await assert.rejects(createTokenProvider({ fetch: mk([new Error(`boom ${SECRET}`)]).fetch, env: {} }).getToken(), (e) => e.code === 'token_unreachable' && !e.message.includes(SECRET));
});

test('gcpFetch adds bearer and retries once on 401 after invalidate', async () => {
  const tp = mk([json(200, { access_token: 'old', expires_in: 3600 }), json(200, { access_token: 'new', expires_in: 3600 })]);
  const provider = createTokenProvider({ fetch: tp.fetch, env: {} });
  const api = mk([{ ok: false, status: 401 }, { ok: true, status: 200 }]);
  const res = await gcpFetch('https://example.test/x', { method: 'POST', headers: { A: '1' } }, { tokenProvider: provider, fetch: api.fetch });
  assert.equal(res.status, 200);
  assert.equal(api.calls[0].init.headers.Authorization, 'Bearer old');
  assert.equal(api.calls[1].init.headers.Authorization, 'Bearer new');
  assert.equal(api.calls[1].init.headers.A, '1');
});
