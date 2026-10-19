import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError, buildUrl } from '../../../../src/web/shared/api.js';

function fakeFetch(status, body, log = []) {
  return async (url, init) => {
    log.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

test('sends bearer header and JSON body, parses JSON', async () => {
  const log = [];
  const api = createApiClient({ getToken: async () => 'tok', fetchImpl: fakeFetch(200, { ok: 1 }, log) });
  const r = await api.post('/claims', { a: 1 });
  assert.deepEqual(r, { ok: 1 });
  assert.equal(log[0].url, '/api/v1/claims');
  assert.equal(log[0].init.headers['x-fnol-authorization'], 'Bearer tok');
  assert.equal(log[0].init.body, '{"a":1}');
  assert.equal(log[0].init.method, 'POST');
});

test('no token means no authorization header; query is encoded', async () => {
  const log = [];
  const api = createApiClient({ baseUrl: '/x/', fetchImpl: fakeFetch(200, {}, log) });
  await api.get('/a', { q: 'a b', skip: undefined });
  assert.equal(log[0].url, '/x/a?q=a+b');
  assert.equal(log[0].init.headers['x-fnol-authorization'], undefined);
  assert.equal(buildUrl('/b', 'c'), '/b/c');
});

test('error envelope becomes ApiError', async () => {
  const env = { error: { code: 'validation_failed', message: 'bad', details: [{ path: 'x', message: 'm' }], requestId: 'r1' } };
  const api = createApiClient({ fetchImpl: fakeFetch(422, env) });
  await assert.rejects(api.get('/c'), (e) => e instanceof ApiError && e.status === 422 && e.code === 'validation_failed' && e.requestId === 'r1' && e.details.length === 1 && e.message === 'bad');
});

test('network failure, 5xx and missing route map to service_unavailable', async () => {
  const boom = createApiClient({ fetchImpl: async () => { throw new TypeError('fail'); } });
  await assert.rejects(boom.get('/c'), (e) => e.code === 'service_unavailable' && e.status === 0);
  const five = createApiClient({ fetchImpl: fakeFetch(503, 'oops') });
  await assert.rejects(five.get('/c'), (e) => e.code === 'service_unavailable' && e.status === 503);
  const missing = createApiClient({ fetchImpl: fakeFetch(404, '<html>') });
  await assert.rejects(missing.get('/c'), (e) => e.code === 'service_unavailable');
  const real404 = createApiClient({ fetchImpl: fakeFetch(404, { error: { code: 'not_found', message: 'no' } }) });
  await assert.rejects(real404.get('/c'), (e) => e.code === 'not_found');
});

test('401 without envelope is unauthorized', async () => {
  const api = createApiClient({ fetchImpl: fakeFetch(401, '') });
  await assert.rejects(api.get('/c'), (e) => e.code === 'unauthorized');
});

test('upload sends multipart FormData without forcing content-type', async () => {
  const log = [];
  const api = createApiClient({ getToken: () => 't', fetchImpl: fakeFetch(201, { id: 'e1' }, log) });
  const r = await api.upload('/claims/c1/evidence', new Blob(['hi'], { type: 'text/plain' }), { kind: 'photo' });
  assert.deepEqual(r, { id: 'e1' });
  assert.ok(log[0].init.body instanceof FormData);
  assert.equal(log[0].init.body.get('kind'), 'photo');
  assert.ok(log[0].init.body.get('file'));
  assert.equal(log[0].init.headers['content-type'], undefined);
  assert.equal(log[0].init.headers['x-fnol-authorization'], 'Bearer t');
});

test('put, patch and del use the right methods', async () => {
  const log = [];
  const api = createApiClient({ fetchImpl: fakeFetch(200, {}, log) });
  await api.put('/a', {}); await api.patch('/a', {}); await api.del('/a');
  assert.deepEqual(log.map((l) => l.init.method), ['PUT', 'PATCH', 'DELETE']);
});
