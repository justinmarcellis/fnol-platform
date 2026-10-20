// Demo journey: the claimant reads the notes an adjuster shared with them (GET /claims/{id}/messages), and nothing else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootClaimsApp, call, claimInput } from './helpers.mjs';

let app;
let id;
const actor = (role, uid) => ({ type: 'user', id: uid, role, roles: [role] });
before(async () => {
  app = await bootClaimsApp();
  const svc = app.claims();
  id = (await svc.createClaim(claimInput({ channel: 'claimant_web' }), { actor: actor('claimant', 'cl-1') })).id;
  await svc.addNote(id, { body: 'Internal: check prior losses.', category: 'general', visibility: 'internal' }, { actor: actor('adjuster', 'adj-1') });
  await svc.addNote(id, { body: 'Information requested: Photos of the damage.', category: 'contact', visibility: 'shared_with_claimant' }, { actor: actor('adjuster', 'adj-1') });
});
after(async () => { await app.close(); });

test('the reporting claimant sees only shared notes, without the author', async () => {
  const r = await call(app, 'GET', `/api/v1/claims/${id}/messages`, { token: app.token(['claimant'], 'alpha', 'cl-1') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((m) => m.body), ['Information requested: Photos of the damage.']);
  assert.equal(r.json.items[0].author, undefined);
  assert.ok(r.json.items[0].at);
});

test('another claimant gets the uniform 404', async () => {
  const r = await call(app, 'GET', `/api/v1/claims/${id}/messages`, { token: app.token(['claimant'], 'alpha', 'cl-2') });
  assert.equal(r.status, 404);
});
