// S2-ITG-01: routing falls back to the tenant default queue when a rule names no queue, and a bare tenant
// (no queues, no routing rules, like the e2e-demo harness tenant) routes with the platform defaults.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { decideRouting, defaultQueueFor, knownQueues, platformDefaultActions, PLATFORM_DEFAULT_QUEUE } from '../../../src/modules/rules/routing.js';
import { bootRulesApp, schemaErrors } from './helpers.mjs';
import { reset, putClaim, putTriage, putCoverage, makeClaim, makeTriage, makeCoverage } from './fakes.mjs';

const config = {
  defaultQueue: 'home',
  fastTrack: { enabled: true, maxSeverity: 20, maxFraudScore: 10, queue: 'fast_track' },
  queues: [{ id: 'fast_track' }, { id: 'auto', lobs: ['personal_auto'] }, { id: 'home', lobs: ['homeowners'] }],
};
const triage = { severityScore: 10, fraud: { score: 2 }, fastTrackEligible: true };
const covered = { outcome: 'covered' };
const act = (ruleId, type, extra = {}) => ({ ruleId, type, ...extra });

test('a route_queue action that names no queue falls back to the tenant defaultQueue', () => {
  const d = decideRouting({ actions: [act('R1', 'route_queue')], config, lob: 'personal_auto', triage, coverage: covered });
  assert.equal(d.queue, 'home');
  assert.ok(d.reasons.some((r) => /R1: route_queue names no queue/.test(r)));
  assert.ok(d.reasons.includes('default queue home'));
  assert.ok(!d.reasons.some((r) => /undefined/.test(r)));
  const named = decideRouting({ actions: [act('R1', 'route_queue', { queue: '' }), act('R2', 'route_queue', { queue: 'auto' })], config, lob: 'personal_auto', triage, coverage: covered });
  assert.equal(named.queue, 'auto', 'a later rule that names a queue still wins over the fallback');
});

test('without defaultQueue the LOB queue is used; with no queues at all the platform default applies', () => {
  const { defaultQueue, ...noDefault } = config;
  assert.equal(defaultQueue, 'home');
  assert.equal(defaultQueueFor(noDefault, 'personal_auto'), 'auto');
  assert.equal(defaultQueueFor({}, 'personal_auto'), PLATFORM_DEFAULT_QUEUE);
  assert.equal(defaultQueueFor({ defaultQueue: 'intake_desk' }, 'homeowners'), 'intake_desk');
  assert.deepEqual(knownQueues({}), [PLATFORM_DEFAULT_QUEUE, 'fast_track']);
  assert.deepEqual(knownQueues(config), ['fast_track', 'auto', 'home']);
  const d = decideRouting({ actions: [act('R1', 'route_queue')], config: {}, lob: 'homeowners', triage, coverage: covered });
  assert.equal(d.queue, PLATFORM_DEFAULT_QUEUE);
});

test('platform default STP fast tracks only triage-eligible claims, and the fast-track guard still applies', () => {
  assert.deepEqual(platformDefaultActions({ fastTrackEligible: false }), []);
  assert.deepEqual(platformDefaultActions(null), []);
  const actions = platformDefaultActions(triage);
  assert.deepEqual(actions, [{ type: 'fast_track', ruleId: 'PLATFORM-STP-DEFAULT' }]);
  const ok = decideRouting({ actions, config: {}, lob: 'personal_auto', triage, coverage: covered });
  assert.equal(ok.fastTrack, true);
  assert.equal(ok.queue, 'fast_track');
  const blocked = decideRouting({ actions, config: {}, lob: 'personal_auto', triage, coverage: { outcome: 'not_covered' } });
  assert.equal(blocked.fastTrack, false);
  assert.equal(blocked.queue, PLATFORM_DEFAULT_QUEUE);
});

let app;
before(async () => {
  app = await bootRulesApp({
    extraTenants: {
      bare: { id: 'bare', displayName: 'Bare Demo Mutual (fictional)' },
      nameless: {
        id: 'nameless', displayName: 'Nameless Queue Mutual (fictional)', defaultQueue: 'desk',
        queues: [{ id: 'desk', adjusters: ['adj-n-1', 'adj-n-2'], assignment: 'round_robin' }],
        rules: [{ id: 'RT-NO-QUEUE', name: 'Routes without naming a queue', stage: 'routing', priority: 10, when: true, then: [{ type: 'route_queue' }] }],
      },
    },
  });
});
after(async () => { await app.close(); });
beforeEach(() => reset());

const seed = (tenant, claimOver = {}, triageOver = {}, outcome = 'covered') => {
  const c = putClaim(tenant, makeClaim(claimOver));
  putTriage(tenant, c.id, makeTriage(c.id, triageOver));
  putCoverage(tenant, c.id, makeCoverage(c.id, outcome));
  return c;
};

test('route: a rule that names no queue lands in the tenant default queue with an adjuster', async () => {
  const c = seed('nameless', {}, { fastTrackEligible: false, severityScore: 40, severityBand: 'moderate' });
  const d = await app.rules('nameless').route(c.id);
  assert.deepEqual(schemaErrors('RoutingDecision', d), []);
  assert.equal(d.queue, 'desk');
  assert.equal(d.outcome, 'assigned');
  assert.equal(d.adjusterId, 'adj-n-1');
  assert.deepEqual(d.ruleIds, ['RT-NO-QUEUE']);
});

test('route: a bare tenant (no queues, no rules) routes to the platform default queue or fast track', async () => {
  const c = seed('bare', {}, { fastTrackEligible: false, severityScore: 40, severityBand: 'moderate' });
  const d = await app.rules('bare').route(c.id);
  assert.deepEqual(schemaErrors('RoutingDecision', d), []);
  assert.equal(d.queue, PLATFORM_DEFAULT_QUEUE);
  assert.equal(d.fastTrack, false);
  assert.equal(d.adjusterId, undefined);
  const g = seed('bare', { lossEvent: { lossDate: '2026-09-15', cause: 'glass', injuriesReported: false } });
  const ft = await app.rules('bare').route(g.id);
  assert.equal(ft.outcome, 'fast_tracked');
  assert.equal(ft.queue, 'fast_track');
  assert.deepEqual(ft.ruleIds, ['PLATFORM-STP-DEFAULT']);
  const evts = app.ctx.bus.outbox('bare').filter((r) => r.type === 'claim.routed');
  assert.equal(evts.length, 2);
});

test('route: platform default STP does not apply to a tenant that has its own routing rules', async () => {
  const c = seed('nameless');
  const d = await app.rules('nameless').route(c.id);
  assert.equal(d.fastTrack, false, 'nameless has routing rules and none asks for fast track');
  assert.equal(d.queue, 'desk');
});
