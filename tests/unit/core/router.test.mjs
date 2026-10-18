import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, call } from './helpers.mjs';

test('router: params, query, body, roles, public, error envelope', async () => {
  const app = await bootApp();
  const { router } = app.ctx;
  router.get('/t/:id/items/:n', (req, res) => res.json(200, { params: req.params, query: req.query }), { public: true });
  router.post('/t/echo', (req, res) => res.json(201, req.body), { roles: ['csr'] });
  router.get('/t/boom', () => { throw new Error('secret internals'); }, { public: true });
  router.get('/t/teapot', () => { throw new app.ctx.HttpError(418, 'teapot', 'I am a teapot'); }, { public: true });
  try {
    let r = await call(app, 'GET', '/t/a%20b/items/7?x=1&y=2&y=3');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { params: { id: 'a b', n: '7' }, query: { x: '1', y: ['2', '3'] } });

    r = await call(app, 'POST', '/t/echo', { body: { a: 1 } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'unauthorized');

    r = await call(app, 'POST', '/t/echo', { token: app.token(['claimant']), body: { a: 1 } });
    assert.equal(r.status, 403);

    r = await call(app, 'POST', '/t/echo', { token: app.token(['csr']), body: { a: 1 } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, { a: 1 });

    r = await call(app, 'POST', '/t/echo', { token: app.token(['csr']), headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 201); // empty body allowed

    const bad = await fetch(app.url + '/t/echo', { method: 'POST', headers: { authorization: `Bearer ${app.token(['csr'])}` }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'invalid_json');

    r = await call(app, 'GET', '/t/boom');
    assert.equal(r.status, 500);
    assert.equal(r.json.error.message, 'Internal server error');

    r = await call(app, 'GET', '/t/teapot');
    assert.deepEqual(r.json, { error: { code: 'teapot', message: 'I am a teapot' } });

    r = await call(app, 'GET', '/api/v1/nothing');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'not_found');
  } finally { await app.close(); }
});

test('router: oversized body rejected with 413', async () => {
  const app = await bootApp();
  app.ctx.router.post('/t/big', (req, res) => res.json(200, {}), { public: true });
  try {
    const r = await fetch(app.url + '/t/big', { method: 'POST', body: 'x'.repeat(15 * 1024 * 1024 + 10) }).catch((e) => e);
    if (r instanceof Response) assert.equal(r.status, 413);
    else assert.ok(r); // connection reset by server is also an acceptable rejection
  } finally { await app.close(); }
});
