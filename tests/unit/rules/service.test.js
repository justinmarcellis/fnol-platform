import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootRulesApp, call, schemaErrors } from './helpers.mjs';
import { store, reset, putClaim, putTriage, putCoverage, makeClaim, makeTriage, makeCoverage } from './fakes.mjs';

let app;
before(async () => { app = await bootRulesApp(); });
after(async () => { await app.close(); });
beforeEach(() => reset());

const A = 'aurelia';
const routed = (t = A) => app.ctx.bus.outbox(t).filter((r) => r.type === 'claim.routed').map((r) => JSON.parse(r.event));
const seed = (tenant, claimOver = {}, triageOver = {}, outcome = 'covered') => {
  const c = putClaim(tenant, makeClaim(claimOver));
  putTriage(tenant, c.id, makeTriage(c.id, triageOver));
  putCoverage(tenant, c.id, makeCoverage(c.id, outcome));
  return c;
};
const glass = (tenant = A) => seed(tenant, { lossEvent: { lossDate: '2026-09-15', cause: 'glass', injuriesReported: false } });

test('evaluateCondition is exposed on the service and is pure', () => {
  const r = app.rules();
  assert.equal(typeof r.evaluateCondition, 'function');
  assert.equal(r.evaluateCondition({ fact: 'loss.cause', op: 'eq', value: 'glass' }, { loss: { cause: 'glass' } }).result, true);
  assert.equal(app.ctx.modules.rules.evaluateCondition, r.evaluateCondition, 'root instance exposes the same pure function');
});

test('validateRules is callable by config through ctx.modules.rules', () => {
  const rules = app.ctx.modules.rules;
  assert.deepEqual(rules.validateRules(app.tenantConfig(A).rules).errors, []);
  assert.equal(rules.validateRules([{ id: 'X', stage: 'routing', when: { fact: 'loss.a', op: 'zap' }, then: [{ type: 'fast_track' }] }]).valid, false);
});

test('evaluate({stage}) fires triage rules from facts and reports a trace', async () => {
  const facts = { claim: { lob: 'personal_auto' }, loss: { injuriesReported: true, cause: 'collision' }, answers: { vehicle_drivable: false } };
  const out = await app.rules().evaluate({ stage: 'triage', facts });
  assert.deepEqual(out.fired.map((f) => f.ruleId), ['TR-INJURY-SEV']);
  // ADR-003: injury and drivability are scored by triage itself, so tenant rules no longer add severity for them.
  assert.deepEqual(out.actions.filter((a) => a.type === 'add_severity'), []);
  assert.deepEqual(out.actions.filter((a) => a.type === 'set_complexity').map((a) => a.complexity), ['high']);
  assert.equal(out.trace.length, 1);
  assert.ok(out.trace.every((t) => t.matched && t.leaves.length));
  const k = await app.rules('kestrel').evaluate({ stage: 'triage', facts: { ...facts, answers: { prior_damage: true } } });
  assert.deepEqual(k.fired.map((f) => f.ruleId), ['TR-INJURY-SEV', 'TR-PRIOR-DAMAGE']);
  assert.deepEqual(k.actions.filter((a) => a.type === 'add_severity').map((a) => a.points), [10], 'tenant-specific escalations keep add_severity');
  const home = await app.rules().evaluate({ stage: 'triage', facts: { claim: { lob: 'homeowners' }, loss: { injuriesReported: false }, answers: { home_livable: false } } });
  assert.deepEqual(home.fired.map((f) => f.ruleId), ['TR-HOME-UNLIVABLE'], 'appliesTo.lobs filters rules');
});

test('route: glass claim is fast tracked with a schema-valid decision and claim.routed', async () => {
  const c = glass();
  const d = await app.rules().route(c.id);
  assert.deepEqual(schemaErrors('RoutingDecision', d), []);
  assert.equal(d.outcome, 'fast_tracked');
  assert.equal(d.fastTrack, true);
  assert.equal(d.queue, 'fast_track');
  assert.equal(d.adjusterId, 'adj-aur-101');
  assert.deepEqual(d.ruleIds, ['RT-FT-GLASS', 'RT-AUTO-DEFAULT']);
  assert.ok(d.reasons.some((r) => /fast track approved/.test(r)));
  assert.equal(d.triageResultId, 'tri_00000000000000000001');
  const evts = routed().filter((e) => e.data.claimId === c.id);
  assert.equal(evts.length, 1);
  assert.deepEqual(evts[0].data, { claimId: c.id, decisionId: d.id, outcome: 'fast_tracked', queue: 'fast_track', adjusterId: 'adj-aur-101', ruleIds: d.ruleIds });
  assert.equal(evts[0].subject, c.id);
  assert.deepEqual(await app.rules().getRoutingDecision(c.id), d);
});

test('round-robin cycles adjusters and persists the cursor across service instances', async () => {
  const picks = [];
  for (let i = 0; i < 3; i++) picks.push((await app.rules().route(glass().id)).adjusterId);
  // the previous test used 101, so the cycle continues 102, 101, 102
  assert.deepEqual(picks, ['adj-aur-102', 'adj-aur-101', 'adj-aur-102']);
  const row = app.ctx.db.forTenant(A).get('SELECT last_adjuster_id FROM queue_cursors WHERE queue_id = ?', 'fast_track');
  assert.equal(row.last_adjuster_id, 'adj-aur-102');
  assert.equal(app.ctx.db.forTenant('other').get('SELECT * FROM queue_cursors WHERE queue_id = ?', 'fast_track'), undefined, 'cursors are per tenant');
});

test('injury goes to the injury queue (least loaded), flags the claim and denies fast track', async () => {
  const c = seed(A, { lossEvent: { lossDate: '2026-09-15', cause: 'collision', injuriesReported: true } }, { severityScore: 8 });
  const d = await app.rules().route(c.id);
  assert.equal(d.queue, 'injury');
  assert.equal(d.fastTrack, false);
  assert.equal(d.outcome, 'assigned');
  assert.equal(d.adjusterId, 'adj-aur-401');
  assert.ok(d.ruleIds.includes('RT-INJURY-01'));
  assert.ok(d.reasons.some((r) => /fast track denied \(injury\)/.test(r)));
  assert.deepEqual(store.claims.get(`${A}:${c.id}`).flags, ['injury']);
  const next = seed(A, { lossEvent: { lossDate: '2026-09-15', cause: 'collision', injuriesReported: true } });
  assert.equal((await app.rules().route(next.id)).adjusterId, 'adj-aur-402', 'least loaded picks the adjuster with fewer claims');
});

test('high fraud refers to SIU: manual queue means no adjuster, with a flag and a task', async () => {
  const c = seed(A, {}, { fraud: { score: 65, indicators: [] } });
  const d = await app.rules().route(c.id);
  assert.equal(d.queue, 'siu');
  assert.equal(d.adjusterId, undefined);
  assert.deepEqual(schemaErrors('RoutingDecision', d), []);
  const mine = store.calls.filter((x) => x.args[0] === c.id);
  assert.ok(mine.some((x) => x.fn === 'addFlag' && x.args[1] === 'siu'));
  const task = mine.find((x) => x.fn === 'addTask');
  assert.equal(task.args[1].type, 'siu_referral');
  assert.equal(task.opts.sourceRuleId, 'RT-SIU-01');
});

test('post-routing rules add tasks with due dates', async () => {
  const c = seed(A, { answers: { other_party_involved: true } });
  await app.rules().route(c.id);
  const task = store.calls.find((x) => x.fn === 'addTask' && x.args[0] === c.id);
  assert.equal(task.args[1].type, 'subrogation_review');
  assert.equal(task.args[1].queue, 'auto_physical_damage');
  assert.ok(Date.parse(task.args[1].dueAt) > Date.now(), 'dueAt is in the future');
  assert.ok(store.claims.get(`${A}:${c.id}`).flags.includes('subrogation_candidate'));
});

test('fast track requires covered coverage even when a rule asks for it', async () => {
  const c = seed(A, { lossEvent: { lossDate: '2026-09-15', cause: 'glass' } }, {}, 'needs_review');
  const d = await app.rules().route(c.id);
  assert.equal(d.fastTrack, false);
  assert.notEqual(d.queue, 'fast_track');
  assert.equal(d.queue, 'auto_physical_damage');
});

test('route is idempotent per source event: same decision, one claim.routed, cursor advances once', async () => {
  const c = glass();
  const before = app.ctx.db.forTenant(A).get('SELECT last_adjuster_id AS a FROM queue_cursors WHERE queue_id = ?', 'fast_track').a;
  const d1 = await app.rules().route(c.id, { sourceEventId: 'evt_replay0001' });
  const d2 = await app.rules().route(c.id, { sourceEventId: 'evt_replay0001' });
  assert.deepEqual(d2, d1);
  assert.equal(routed().filter((e) => e.data.claimId === c.id).length, 1);
  const after = app.ctx.db.forTenant(A).get('SELECT last_adjuster_id AS a FROM queue_cursors WHERE queue_id = ?', 'fast_track').a;
  assert.notEqual(after, before);
  assert.equal(after, d1.adjusterId);
  assert.equal(store.calls.filter((x) => x.fn === 'addTask' && x.args[0] === c.id).length, 0);
});

test('auto-routes on claim.triaged, and only re-routes when the outcome changes', async () => {
  const c = glass();
  app.ctx.bus.publish(A, 'claim.triaged', c.id, { claimId: c.id, triageResultId: 'tri_00000000000000000001', attempt: 1 });
  await app.ctx.bus.drain();
  const d1 = await app.rules().getRoutingDecision(c.id);
  assert.equal(d1.outcome, 'fast_tracked');
  assert.equal(routed().filter((e) => e.data.claimId === c.id).length, 1);

  // claims moves the claim on; a re-triage with the same outcome changes nothing
  store.claims.get(`${A}:${c.id}`).status = 'fast_tracked';
  app.ctx.bus.publish(A, 'claim.triaged', c.id, { claimId: c.id, attempt: 2 });
  await app.ctx.bus.drain();
  assert.equal((await app.rules().getRoutingDecision(c.id)).id, d1.id);
  assert.equal(routed().filter((e) => e.data.claimId === c.id).length, 1);

  // new triage finds injuries: the outcome changes, so it re-routes
  store.claims.get(`${A}:${c.id}`).lossEvent.injuriesReported = true;
  app.ctx.bus.publish(A, 'claim.triaged', c.id, { claimId: c.id, attempt: 3 });
  await app.ctx.bus.drain();
  const d3 = await app.rules().getRoutingDecision(c.id);
  assert.notEqual(d3.id, d1.id);
  assert.equal(d3.queue, 'injury');
  assert.equal(routed().filter((e) => e.data.claimId === c.id).length, 2);
});

test('claim.triaged is ignored for claims past routing and rejected while still validating', async () => {
  const done = seed(A, { status: 'in_review' });
  app.ctx.bus.publish(A, 'claim.triaged', done.id, { claimId: done.id });
  await app.ctx.bus.drain();
  assert.equal(await app.rules().getRoutingDecision(done.id), null);

  const early = seed(A, { status: 'validating' });
  await assert.rejects(app.rules().onClaimTriaged({ id: 'evt_x', data: { claimId: early.id } }), (e) => e.code === 'claim_not_ready' && e.status === 409);
});

test('rule changes apply without restart', async () => {
  const c1 = seed(A, { lossEvent: { lossDate: '2026-09-15', cause: 'collision' } });
  assert.equal((await app.rules().route(c1.id)).queue, 'auto_physical_damage');
  const cfg = app.tenantConfig(A);
  cfg.rules.find((r) => r.id === 'RT-AUTO-DEFAULT').then[0].queue = 'injury';
  app.ctx.tenants.put(A, cfg, 'test');
  const c2 = seed(A, { lossEvent: { lossDate: '2026-09-15', cause: 'collision' } });
  assert.equal((await app.rules().route(c2.id)).queue, 'injury');
  cfg.rules = cfg.rules.filter((r) => r.id !== 'RT-AUTO-DEFAULT');
  cfg.defaultQueue = 'property';
  app.ctx.tenants.put(A, cfg, 'test');
  const c3 = seed(A, { lossEvent: { lossDate: '2026-09-15', cause: 'collision' } });
  const d3 = await app.rules().route(c3.id);
  assert.equal(d3.queue, 'property');
  assert.notEqual(d3.rulesetVersion, (await app.rules().getRoutingDecision(c1.id)).rulesetVersion);
});

test('a rule routing to an unknown queue is a 422, not a bad decision', async () => {
  const cfg = app.tenantConfig('other');
  cfg.rules.find((r) => r.id === 'RT-AUTO-DEFAULT').then[0].queue = 'no_such_queue';
  app.ctx.tenants.put('other', cfg, 'test');
  const c = seed('other');
  await assert.rejects(app.rules('other').route(c.id), (e) => e.status === 422 && e.code === 'routing_misconfigured');
});

test('tenant isolation: decisions and cursors never cross tenants', async () => {
  const c = seed('kestrel', { riskState: 'WI' });
  const d = await app.rules('kestrel').route(c.id);
  assert.equal(d.tenantId, 'kestrel');
  assert.equal(await app.rules(A).getRoutingDecision(c.id), null);
  await assert.rejects(app.rules(A).route(c.id), (e) => e.status === 404);
});

test('HTTP: POST routes a claim, GET returns the latest decision, matching the openapi paths', async () => {
  const c = glass();
  const sup = app.token(['supervisor']);
  assert.equal((await call(app, 'GET', `/api/v1/claims/${c.id}/routing`, { token: sup })).status, 404);
  const post = await call(app, 'POST', `/api/v1/claims/${c.id}/routing`, { token: app.token(['adjuster']) });
  assert.equal(post.status, 200, post.text);
  assert.deepEqual(schemaErrors('RoutingDecision', post.json), []);
  const get = await call(app, 'GET', `/api/v1/claims/${c.id}/routing`, { token: app.token(['csr']) });
  assert.equal(get.status, 200);
  assert.deepEqual(get.json, post.json);
  assert.equal((await call(app, 'GET', `/api/v1/claims/${c.id}/routing`, { token: app.token(['claimant']) })).status, 403);
  assert.equal((await call(app, 'GET', `/api/v1/claims/${c.id}/routing`)).status, 401);
  assert.equal((await call(app, 'POST', `/api/v1/claims/${c.id}/routing`, { token: app.token(['csr']) })).status, 403);
  assert.equal((await call(app, 'GET', `/api/v1/claims/${c.id}/routing`, { token: app.token(['csr'], 'kestrel') })).status, 404, 'other tenant sees nothing');
});

test('HTTP errors use the { error: { code, message } } envelope', async () => {
  const missing = await call(app, 'POST', '/api/v1/claims/clm_nonexistent000/routing', { token: app.token(['supervisor']) });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');
  const early = seed(A, { status: 'reported' });
  const conflict = await call(app, 'POST', `/api/v1/claims/${early.id}/routing`, { token: app.token(['supervisor']) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'invalid_state');
});

test('supervisor override: skips rules, records who and why, publishes override=true', async () => {
  const c = glass();
  const body = { override: { queue: 'siu', adjusterId: 'adj-aur-501', reason: 'Prior fraud pattern known to supervisor' } };
  const bad = await call(app, 'POST', `/api/v1/claims/${c.id}/routing`, { token: app.token(['adjuster']), body });
  assert.equal(bad.status, 403, 'adjusters cannot override');
  const noReason = await call(app, 'POST', `/api/v1/claims/${c.id}/routing`, { token: app.token(['supervisor']), body: { override: { queue: 'siu' } } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.json.error.code, 'invalid_override');
  const unknown = await call(app, 'POST', `/api/v1/claims/${c.id}/routing`, { token: app.token(['supervisor']), body: { override: { queue: 'nope', reason: 'x' } } });
  assert.equal(unknown.status, 422);

  const ok = await call(app, 'POST', `/api/v1/claims/${c.id}/routing`, { token: app.token(['supervisor'], A, 'sup-1'), body });
  assert.equal(ok.status, 200, ok.text);
  const d = ok.json;
  assert.deepEqual(schemaErrors('RoutingDecision', d), []);
  assert.equal(d.queue, 'siu');
  assert.equal(d.adjusterId, 'adj-aur-501');
  assert.deepEqual(d.ruleIds, []);
  assert.deepEqual(d.override, { by: { type: 'user', id: 'sup-1', role: 'supervisor' }, reason: 'Prior fraud pattern known to supervisor' });
  const evt = routed().find((e) => e.data.decisionId === d.id);
  assert.equal(evt.data.override, true);
  const audit = app.ctx.audit.list(A, { action: 'claim.routing.overridden' });
  assert.ok(audit.length >= 1);

  const ft = await call(app, 'POST', `/api/v1/claims/${c.id}/routing`, { token: app.token(['supervisor']), body: { override: { fastTrack: true, reason: 'goodwill' } } });
  assert.equal(ft.json.outcome, 'fast_tracked');
  assert.equal(ft.json.queue, 'fast_track');
});

test('decisions and events carry no PII', async () => {
  const c = seed(A, { parties: [{ role: 'insured', firstName: 'Sample', lastName: 'Person', email: 'sample@example.test' }] });
  const d = await app.rules().route(c.id);
  const blob = JSON.stringify([d, routed().map((e) => e.data)]);
  assert.ok(!/Sample|Person|example\.test/.test(blob));
});

test('works without the config module by reading the live tenant config', async () => {
  const bare = await bootRulesApp({ withConfig: false });
  try {
    const c = putClaim('aurelia', makeClaim({ lossEvent: { lossDate: '2026-09-15', cause: 'glass' } }));
    putTriage('aurelia', c.id, makeTriage(c.id));
    putCoverage('aurelia', c.id, makeCoverage(c.id));
    const d = await bare.rules().route(c.id);
    assert.equal(d.outcome, 'fast_tracked');
    assert.deepEqual(schemaErrors('RoutingDecision', d), []);
  } finally { await bare.close(); }
});
