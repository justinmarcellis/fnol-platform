import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_KEY, groupPersonas, personaTarget, saveSession, readSession, clearSession, consumePersonaToken, claimantHint, switchPersona, loadPersonas,
} from '../../../../src/web/shared/personas.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const P = (role, app, extra = {}) => ({ id: `t:${role}`, userId: `dev-${role}`, displayName: `N ${role}`, role, roles: [role], app, path: app, ...extra });

test('groupPersonas orders by app and skips empty groups', () => {
  const g = groupPersonas([P('adjuster', '/adjuster'), P('claimant', '/'), P('supervisor', '/adjuster')]);
  assert.deepEqual(g.map((x) => x.app), ['/', '/adjuster']);
  assert.equal(g[1].personas.length, 2);
});

test('personaTarget: claimant carries tenant, others their app', () => {
  assert.equal(personaTarget(P('claimant', '/'), 'kestrel-point'), '/?tenant=kestrel-point');
  assert.equal(personaTarget(P('carrier_admin', '/admin'), 'x'), '/admin');
});

test('saveSession mirrors the token to the app key and clears the previous session', () => {
  const st = mem();
  st.setItem('csr.token', 'old');
  assert.equal(saveSession(st, { token: 'tok', tenantId: 'a', persona: P('adjuster', '/adjuster') }), true);
  assert.equal(st.getItem('adjuster.token'), 'tok');
  assert.equal(st.getItem('csr.token'), null);
  assert.equal(readSession(st).tenantId, 'a');
  assert.equal(consumePersonaToken('/adjuster', st).token, 'tok');
  assert.equal(consumePersonaToken('/csr', st), null);
  clearSession(st);
  assert.equal(readSession(st), null);
  assert.equal(st.getItem('adjuster.token'), null);
});

test('storage failures are swallowed', () => {
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(readSession(bad), null);
  assert.equal(saveSession(bad, { token: 't', tenantId: 'a', persona: P('csr', '/csr') }), false);
});

test('claimantHint returns the holder-check hint only for a claimant session', () => {
  const st = mem();
  saveSession(st, { token: 't', tenantId: 'a', persona: P('claimant', '/', { hint: { policyNumber: 'AUT-1', lastName: 'Testwell', zip: '60601' } }) });
  assert.equal(claimantHint(st).zip, '60601');
  saveSession(st, { token: 't', tenantId: 'a', persona: P('csr', '/csr') });
  assert.equal(claimantHint(st), null);
});

test('switchPersona mints a token with the persona identity and stores it', async () => {
  const st = mem();
  let body;
  const api = { post: async (path, b) => { assert.equal(path, '/auth/token'); body = b; return { token: 'minted' }; } };
  const r = await switchPersona(api, { tenantId: 'a', persona: P('agent', '/csr', { userId: 'agent-7' }), storage: st });
  assert.equal(body.tenantId, 'a');
  assert.equal(body.userId, 'agent-7');
  assert.deepEqual(body.roles, ['agent']);
  assert.equal(r.url, '/csr');
  assert.equal(st.getItem('csr.token'), 'minted');
  assert.ok(st.getItem(SESSION_KEY));
  await assert.rejects(switchPersona({ post: async () => ({}) }, { tenantId: 'a', persona: P('csr', '/csr'), storage: st }), /token/);
});

test('loadPersonas tolerates a malformed body', async () => {
  assert.deepEqual(await loadPersonas({ get: async () => ({}) }), { tenants: [] });
  assert.equal((await loadPersonas({ get: async (p) => (p === '/dev/personas' ? { tenants: [{ id: 'a' }] } : null) })).tenants.length, 1);
});
