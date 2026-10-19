import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devLogin, isDevMode } from '../../../../src/web/shared/devlogin.js';

test('refuses outside dev mode', async () => {
  const api = { post: async () => { throw new Error('should not call'); } };
  await assert.rejects(devLogin(api, { tenant: 'a', role: 'csr' }, { dev: false }), /dev mode/);
});

test('posts tenant and role to /auth/token', async () => {
  let call;
  const api = { post: async (p, b) => { call = [p, b]; return { token: 't' }; } };
  const r = await devLogin(api, { tenant: 'tenant-a', role: 'adjuster' }, { dev: true });
  assert.equal(r.token, 't');
  assert.equal(call[0], '/auth/token');
  assert.equal(call[1].tenantId, 'tenant-a');
  assert.deepEqual(call[1].roles, ['adjuster']);
  await assert.rejects(devLogin(api, { tenant: '' , role: 'x' }, { dev: true }), /required/);
});

test('isDevMode detects localhost and explicit flag', () => {
  assert.equal(isDevMode({ location: { hostname: 'localhost' } }), true);
  assert.equal(isDevMode({ location: { hostname: 'claims.example.test' } }), false);
  assert.equal(isDevMode({ __FNOL_DEV__: true, location: { hostname: 'x' } }), true);
  assert.equal(isDevMode({ __FNOL_DEV__: false, location: { hostname: 'localhost' } }), false);
});

test('devLogin sends explicit roles when given (persona login)', async () => {
  let body;
  const api = { post: async (_p, b) => { body = b; return { token: 't' }; } };
  await devLogin(api, { tenant: 'tenant-a', role: 'carrier_admin', roles: ['carrier_admin', 'tenant_admin'], userId: 'u1', name: 'Pat' }, { dev: true });
  assert.deepEqual(body.roles, ['carrier_admin', 'tenant_admin']);
  assert.equal(body.userId, 'u1');
  assert.equal(body.displayName, 'Pat');
});
