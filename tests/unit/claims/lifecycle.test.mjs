import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITIONS, checkTransition, isLegal } from '../../../src/modules/claims/lifecycle.mjs';
import { bootClaimsApp, claimInput, user, SYSTEM } from './helpers.mjs';

const STATUSES = Object.keys(TRANSITIONS);

test('transition table matches overview.md section 7', () => {
  const legal = [
    'reported>validating', 'reported>withdrawn', 'validating>triaged', 'validating>withdrawn', 'triaged>assigned', 'triaged>fast_tracked',
    'triaged>withdrawn', 'assigned>in_review', 'assigned>withdrawn', 'fast_tracked>in_review', 'fast_tracked>closed', 'fast_tracked>withdrawn',
    'in_review>pending_info', 'in_review>closed', 'in_review>withdrawn', 'pending_info>in_review', 'pending_info>withdrawn', 'closed>in_review',
  ];
  const actual = [];
  for (const f of STATUSES) for (const t of STATUSES) if (isLegal(f, t)) actual.push(`${f}>${t}`);
  assert.deepEqual(actual.sort(), legal.sort());
  assert.deepEqual(TRANSITIONS.withdrawn, {});
});

test('roles gate each transition', () => {
  const ok = (f, t, a, o) => checkTransition(f, t, a, o) === null;
  assert.ok(ok('reported', 'validating', SYSTEM));
  assert.ok(!ok('reported', 'validating', user('adjuster')));
  assert.ok(ok('assigned', 'in_review', user('adjuster')));
  assert.ok(!ok('assigned', 'in_review', user('csr')));
  assert.ok(!ok('assigned', 'in_review', SYSTEM));
  assert.ok(ok('fast_tracked', 'in_review', SYSTEM));
  assert.ok(ok('triaged', 'withdrawn', user('csr')));
  assert.ok(!ok('assigned', 'withdrawn', user('csr')));
  assert.ok(ok('assigned', 'withdrawn', user('supervisor')));
  assert.ok(ok('closed', 'in_review', user('supervisor')));
  assert.ok(!ok('closed', 'in_review', user('adjuster')));
  assert.ok(ok('in_review', 'closed', user('adjuster'), { closeReason: 'paid' }));
  assert.ok(ok('assigned', 'in_review', user('platform_admin')));
});

test('closing needs a valid closeReason; illegal moves are 409', () => {
  assert.equal(checkTransition('in_review', 'closed', user('adjuster')).code, 'close_reason_required');
  assert.equal(checkTransition('in_review', 'closed', user('adjuster'), { closeReason: 'bogus' }).code, 'invalid_close_reason');
  assert.deepEqual(checkTransition('reported', 'closed', user('supervisor'), { closeReason: 'paid' }).status, 409);
  assert.equal(checkTransition('withdrawn', 'in_review', user('supervisor')).code, 'invalid_transition');
  assert.equal(checkTransition('triaged', 'nonsense', SYSTEM).code, 'invalid_status');
});

test('service enforces lifecycle end to end, records history, audit and events', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  assert.equal(c.status, 'reported');
  assert.match(c.claimNumber, /^ALP-2026-000001$/);
  await app.ctx.bus.drain();
  assert.equal((await svc.getClaim(c.id)).status, 'validating', 'claims consumes its own claim.reported');

  await assert.rejects(svc.changeStatus(c.id, { to: 'in_review', actor: user('adjuster') }), { code: 'invalid_transition', status: 409 });

  await app.emit('claim.coverage.verified', c.id, { verificationId: 'cov_00000001', outcome: 'covered' });
  await app.emit('claim.triaged', c.id, { triageResultId: 'tri_00000001', attempt: 1, severityScore: 42, complexity: 'medium', fraudScore: 5, subrogation: false });
  assert.equal((await svc.getClaim(c.id)).status, 'triaged');
  await app.emit('claim.routed', c.id, { decisionId: 'rte_00000001', outcome: 'assigned', queue: 'auto_physical_damage', adjusterId: 'adj1', ruleIds: [] });
  const assigned = await svc.getClaim(c.id);
  assert.equal(assigned.status, 'assigned');
  assert.deepEqual(assigned.routing, { decisionId: 'rte_00000001', queue: 'auto_physical_damage', adjusterId: 'adj1', fastTrack: false });

  await assert.rejects(svc.changeStatus(c.id, { to: 'in_review', actor: user('csr') }), { code: 'forbidden', status: 403 });
  await assert.rejects(svc.changeStatus(c.id, { to: 'in_review', expectedVersion: 1, actor: user('adjuster') }), { code: 'version_conflict', status: 409 });
  const r = await svc.changeStatus(c.id, { to: 'in_review', expectedVersion: assigned.version, actor: user('adjuster') });
  assert.equal(r.status, 'in_review');
  await svc.changeStatus(c.id, { to: 'pending_info', reason: 'waiting on photos', actor: user('adjuster') });
  await svc.changeStatus(c.id, { to: 'in_review', actor: user('adjuster') });
  await assert.rejects(svc.changeStatus(c.id, { to: 'closed', actor: user('adjuster') }), { code: 'close_reason_required', status: 422 });
  const closed = await svc.changeStatus(c.id, { to: 'closed', closeReason: 'paid', actor: user('adjuster') });
  assert.equal(closed.closeReason, 'paid');
  assert.ok(closed.closedAt);
  await assert.rejects(svc.changeStatus(c.id, { to: 'in_review', actor: user('adjuster') }), { code: 'forbidden' });
  const reopened = await svc.changeStatus(c.id, { to: 'in_review', actor: user('supervisor') });
  assert.equal(reopened.closedAt, undefined);

  // every hop has a history row, an audit entry and a claim.status.changed event
  await app.ctx.bus.drain();
  const hist = app.ctx.db.forTenant('alpha').all('SELECT from_status, to_status FROM claim_status_history WHERE claim_id = ? ORDER BY seq', c.id);
  assert.deepEqual(hist.map((h) => `${h.from_status}>${h.to_status}`),
    ['null>reported', 'reported>validating', 'validating>triaged', 'triaged>assigned', 'assigned>in_review', 'in_review>pending_info', 'pending_info>in_review', 'in_review>closed', 'closed>in_review']);
  const evts = app.ctx.bus.outbox('alpha').map((o) => JSON.parse(o.event)).filter((e) => e.type === 'claim.status.changed');
  assert.equal(evts.length, hist.length - 1);
  assert.deepEqual(evts.at(-1).data, { claimId: c.id, from: 'closed', to: 'in_review', version: reopened.version, actor: { type: 'user', id: 'u1', role: 'supervisor' } });
  const audits = app.tctx().audit.list({ action: 'claim.status.changed', limit: 100 });
  assert.equal(audits.length, hist.length - 1);
  assert.ok(app.ctx.audit.verify('alpha').ok);
});

test('a late claim.triaged on a withdrawn claim does not resurrect it', async (t) => {
  const app = await bootClaimsApp();
  t.after(() => app.close());
  const svc = app.claims();
  const c = await svc.createClaim(claimInput(), { actor: user('csr') });
  await app.ctx.bus.drain();
  await svc.changeStatus(c.id, { to: 'withdrawn', actor: user('csr') });
  await app.emit('claim.triaged', c.id, { triageResultId: 'tri_00000002', attempt: 1, severityScore: 10, complexity: 'low', fraudScore: 0, subrogation: false });
  assert.equal((await svc.getClaim(c.id)).status, 'withdrawn');
});
