import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decideRouting, fastTrackDenials, fastTrackSettings, defaultQueueFor } from '../../../src/modules/rules/routing.js';
import { validateRules, runRules, filterRules } from '../../../src/modules/rules/engine.js';
import { loadTenant } from './helpers.mjs';

const config = {
  fastTrack: { enabled: true, maxSeverity: 20, maxFraudScore: 10, maxEstimate: { amount: 1000, currency: 'USD' }, queue: 'fast_track' },
  queues: [{ id: 'fast_track' }, { id: 'auto', lobs: ['personal_auto'] }, { id: 'home', lobs: ['homeowners'] }, { id: 'injury' }],
};
const triage = { severityScore: 10, fraud: { score: 2 }, fastTrackEligible: true };
const covered = { outcome: 'covered' };
const act = (ruleId, type, extra = {}) => ({ ruleId, type, ...extra });
const decide = (actions, over = {}) => decideRouting({ actions, config, lob: 'personal_auto', triage, coverage: covered, ...over });

test('first route_queue wins (lowest priority number); default queue is used when no rule routes', () => {
  assert.equal(decide([act('A', 'route_queue', { queue: 'injury' }), act('B', 'route_queue', { queue: 'auto' })]).queue, 'injury');
  const d = decide([]);
  assert.equal(d.queue, 'auto');
  assert.ok(d.reasons.some((r) => /default queue auto/.test(r)));
  assert.equal(defaultQueueFor(config, 'homeowners'), 'home');
  assert.equal(defaultQueueFor({ ...config, defaultQueue: 'injury' }, 'homeowners'), 'injury');
});

test('approved fast track routes to the fast-track queue even when a later default rule routes elsewhere', () => {
  const d = decide([act('FT', 'fast_track'), act('FT', 'route_queue', { queue: 'fast_track' }), act('DEF', 'route_queue', { queue: 'auto' })]);
  assert.equal(d.fastTrack, true);
  assert.equal(d.queue, 'fast_track');
  assert.ok(d.reasons.some((r) => /fast track approved/.test(r)));
});

test('deny_fast_track beats fast_track and records the reason', () => {
  const d = decide([act('FT', 'fast_track'), act('FT', 'route_queue', { queue: 'fast_track' }), act('INJ', 'deny_fast_track', { reason: 'injury' })]);
  assert.equal(d.fastTrack, false);
  assert.equal(d.queue, 'auto', 'fast_track queue skipped, falls back to default');
  assert.ok(d.reasons.some((r) => /fast track denied \(injury\)/.test(r)));
});

test('guards block fast track: severity, fraud, estimate, coverage, triage flag, tenant switch', () => {
  const ft = [act('FT', 'fast_track')];
  const reasons = (over) => decide(ft, over).reasons.join(' | ');
  assert.equal(decide(ft, { triage: { ...triage, severityScore: 21 } }).fastTrack, false);
  assert.match(reasons({ triage: { ...triage, severityScore: 21 } }), /severity 21 above fast-track limit 20/);
  assert.match(reasons({ triage: { ...triage, fraud: { score: 11 } } }), /fraud score 11 above/);
  assert.match(reasons({ estimate: { amount: 1500 } }), /estimate 1500 above fast-track limit 1000/);
  assert.match(reasons({ coverage: { outcome: 'needs_review' } }), /coverage outcome is needs_review/);
  assert.match(reasons({ coverage: null }), /unverified/);
  assert.match(reasons({ triage: { ...triage, fastTrackEligible: false } }), /not fast-track eligible/);
  assert.match(reasons({ triage: null }), /no triage result/);
  assert.equal(decide(ft, { config: { ...config, fastTrack: { ...config.fastTrack, enabled: false } } }).fastTrack, false);
  assert.equal(decide(ft, { estimate: { amount: 1000 } }).fastTrack, true, 'limits are inclusive');
});

test('explicit adjuster assignment is passed through', () => {
  assert.equal(decide([act('X', 'assign_adjuster', { adjusterId: 'adj-1' })]).adjusterId, 'adj-1');
});

test('fast track settings take schema defaults', () => {
  assert.deepEqual(fastTrackDenials({ settings: fastTrackSettings({}), triage: { severityScore: 26, fraud: { score: 0 } }, coverage: covered }), ['severity 26 above fast-track limit 25']);
});

test('runRules fires matching rules in order, honours stopOnMatch and survives a malformed rule', () => {
  const rules = [
    { id: 'R-1', when: true, then: [{ type: 'add_flag', flag: 'a' }] },
    { id: 'R-BAD', when: { fact: 'loss.x', op: 'zap', value: 1 }, then: [{ type: 'add_flag', flag: 'b' }] },
    { id: 'R-2', stopOnMatch: true, when: { fact: 'loss.cause', op: 'eq', value: 'glass' }, then: [{ type: 'add_flag', flag: 'c' }] },
    { id: 'R-3', when: true, then: [{ type: 'add_flag', flag: 'd' }] },
  ];
  const r = runRules(rules, { loss: { cause: 'glass' } });
  assert.deepEqual(r.fired.map((f) => f.ruleId), ['R-1', 'R-2']);
  assert.deepEqual(r.actions.map((a) => `${a.ruleId}:${a.flag}`), ['R-1:a', 'R-2:c']);
  assert.match(r.trace.find((t) => t.ruleId === 'R-BAD').error, /unknown operator/);
  assert.equal(r.trace.length, 3);
});

test('filterRules applies stage, appliesTo, dates, enabled and priority order', () => {
  const rules = [
    { id: 'B', stage: 'routing', priority: 20, when: true, then: [] },
    { id: 'A', stage: 'routing', priority: 20, when: true, then: [] },
    { id: 'C', stage: 'routing', priority: 5, when: true, then: [] },
    { id: 'OFF', stage: 'routing', enabled: false, when: true, then: [] },
    { id: 'TRI', stage: 'triage', when: true, then: [] },
    { id: 'HOME', stage: 'routing', appliesTo: { lobs: ['homeowners'] }, when: true, then: [] },
    { id: 'FUT', stage: 'routing', appliesTo: { effectiveFrom: '2030-01-01' }, when: true, then: [] },
    { id: 'WI', stage: 'routing', appliesTo: { states: ['WI'], lossTypes: ['glass'] }, when: true, then: [] },
  ];
  const ids = (q) => filterRules(rules, { stage: 'routing', at: '2026-09-01', ...q }).map((r) => r.id);
  assert.deepEqual(ids({ lob: 'personal_auto' }), ['C', 'A', 'B']);
  assert.deepEqual(ids({ lob: 'homeowners', state: 'WI', lossType: 'glass' }), ['C', 'A', 'B', 'HOME', 'WI']);
});

test('validateRules accepts the seeded tenant rules', () => {
  for (const t of ['aurelia-mutual', 'kestrel-point']) {
    const r = validateRules(loadTenant(t).rules);
    assert.deepEqual(r.errors, [], t);
    assert.equal(r.valid, true);
  }
});

test('validateRules reports bad ids, stages, conditions and actions with paths', () => {
  const good = { id: 'RT-OK-01', stage: 'routing', when: true, then: [{ type: 'route_queue', queue: 'q' }] };
  const r = validateRules([
    good,
    { ...good },
    { id: 'RT-BAD-STAGE', stage: 'nope', when: true, then: [{ type: 'fast_track' }] },
    { id: 'RT-BAD-OP', stage: 'routing', when: { fact: 'loss.cause', op: 'zap', value: 1 }, then: [{ type: 'fast_track' }] },
    { id: 'RT-BAD-ACT', stage: 'routing', when: true, then: [{ type: 'teleport' }, { type: 'route_queue' }] },
    { id: 'RT-NO-THEN', stage: 'routing', when: true, then: [] },
    { id: 'IN-ROUTE', stage: 'intake', when: true, then: [{ type: 'route_queue', queue: 'q' }] },
  ]);
  assert.equal(r.valid, false);
  const has = (path, code) => assert.ok(r.errors.some((e) => e.path === path && e.code === code), `${path} ${code}: ${JSON.stringify(r.errors)}`);
  has('/rules/1/id', 'duplicate_id');
  has('/rules/2/stage', 'invalid_stage');
  has('/rules/3/when/op', 'unknown_op');
  has('/rules/4/then/0/type', 'unknown_action');
  has('/rules/4/then/1/queue', 'missing_action_field');
  has('/rules/5/then', 'invalid_rule');
  has('/rules/6/then/0/type', 'action_stage_mismatch');
  assert.equal(validateRules('x').valid, false);
});

test('routes match the openapi routing paths', () => {
  const spec = fs.readFileSync(new URL('../../../architecture/contracts/openapi.yaml', import.meta.url), 'utf8');
  const block = spec.slice(spec.indexOf('/claims/{claimId}/routing:'));
  assert.match(block, /operationId: routeClaim/);
  assert.match(block, /operationId: getRoutingDecision/);
  assert.equal((block.match(/x-module: rules/g) ?? []).length >= 2, true);
});
