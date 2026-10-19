// S6-BUG-05 / DATA-5: agents (and claimants) list their own claims; agents also see claims on policies they produce.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootClaimsApp, call, claimInput } from './helpers.mjs';

let app;
let ids;
const actor = (role, id) => ({ type: 'user', id, role, roles: [role] });
before(async () => {
  app = await bootClaimsApp();
  const svc = app.claims();
  const byAgent = await svc.createClaim(claimInput({ channel: 'agent_portal', policyNumber: 'PA-WI-1000001' }), { actor: actor('agent', 'agt-1') });
  const onBook = await svc.createClaim(claimInput({ policyNumber: 'PA-WI-2000002' }), { actor: actor('csr', 'csr-1') });
  const other = await svc.createClaim(claimInput({ policyNumber: 'PA-WI-3000003' }), { actor: actor('csr', 'csr-1') });
  const own = await svc.createClaim(claimInput({ channel: 'claimant_web' }), { actor: actor('claimant', 'cl-1') });
  ids = { byAgent: byAgent.id, onBook: onBook.id, other: other.id, own: own.id };
});
after(async () => { await app.close(); });

test('GET /claims is open to the agent role: 200 with its own claims, projected', async () => {
  const r = await call(app, 'GET', '/api/v1/claims?limit=10&sort=-reportedAt', { token: app.token(['agent'], 'alpha', 'agt-1') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((c) => c.id), [ids.byAgent]);
  assert.equal(r.json.items[0].parties, undefined, 'claimant-safe projection');
  assert.equal(r.json.items[0].routing, undefined);
});

test('a claimant lists only the claims it reported', async () => {
  const r = await call(app, 'GET', '/api/v1/claims', { token: app.token(['claimant'], 'alpha', 'cl-1') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((c) => c.id), [ids.own]);
});

test('query parameters cannot widen a non-staff scope', async () => {
  const r = await call(app, 'GET', '/api/v1/claims?reportedById=csr-1', { token: app.token(['agent'], 'alpha', 'agt-1') });
  assert.deepEqual(r.json.items.map((c) => c.id), [ids.byAgent]);
});

test('service scope: reported by the caller or on one of its produced policies', async () => {
  const page = await app.claims().listClaims({ visibleTo: { reportedById: 'agt-1', policyNumbers: ['PA-WI-2000002'] } });
  assert.deepEqual(page.items.map((c) => c.id).sort(), [ids.byAgent, ids.onBook].sort());
});

test('staff listing is unchanged', async () => {
  const r = await call(app, 'GET', '/api/v1/claims', { token: app.token(['csr']) });
  assert.equal(r.json.items.length, 4);
});

test('an agent reading a claim it neither reported nor produces gets 404', async () => {
  const r = await call(app, 'GET', `/api/v1/claims/${ids.other}`, { token: app.token(['agent'], 'alpha', 'agt-1') });
  assert.equal(r.status, 404);
  const mine = await call(app, 'GET', `/api/v1/claims/${ids.byAgent}`, { token: app.token(['agent'], 'alpha', 'agt-1') });
  assert.equal(mine.status, 200);
});
