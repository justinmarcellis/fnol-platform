import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, call } from './helpers.mjs';

test('auth accepts Authorization or X-Fnol-Authorization and rejects bad tokens in either', async () => {
  const app = await bootApp();
  try {
    const tok = app.token(['supervisor']);
    const a = await call(app, 'GET', '/api/v1/audit', { token: tok });
    const b = await call(app, 'GET', '/api/v1/audit', { headers: { 'x-fnol-authorization': `Bearer ${tok}` } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    for (const name of ['authorization', 'x-fnol-authorization']) {
      const bad = await call(app, 'GET', '/api/v1/audit', { headers: { [name]: 'Bearer garbage' } });
      assert.equal(bad.status, 401, name);
      assert.equal(bad.json.error.code, 'invalid_token');
    }
    const none = await call(app, 'GET', '/api/v1/audit');
    assert.equal(none.status, 401);
    // Authorization wins when both are present.
    const both = await call(app, 'GET', '/api/v1/audit', { token: 'garbage', headers: { 'x-fnol-authorization': `Bearer ${tok}` } });
    assert.equal(both.status, 401);
  } finally { await app.close(); }
});
