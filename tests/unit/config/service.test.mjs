import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateTenantConfig, changedSections, createService } from '../../../src/modules/config/service.js';

const load = (n) => JSON.parse(fs.readFileSync(new URL(`../../../tenants/${n}.json`, import.meta.url), 'utf8'));
const base = () => load('aurelia-mutual');
const codes = (r) => r.errors.map((e) => e.code);

// Local fake of rules.validateRules (S1-WFL-02 owns the real one).
const fakeRules = (impl) => ({ validateRules: impl ?? ((rules) => ({ valid: true, errors: [], seen: rules.length })) });

test('valid config passes; warns when the rules module is absent', () => {
  const r = validateTenantConfig(base());
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => /rules module not available/.test(w.message)));
  const withRules = validateTenantConfig(base(), { rules: fakeRules() });
  assert.equal(withRules.valid, true);
  assert.ok(!withRules.warnings.some((w) => /rules module/.test(w.message)));
});

test('schema errors are reported with paths', () => {
  const c = base();
  delete c.displayName;
  c.branding.primaryColor = 'green';
  const r = validateTenantConfig(c, { rules: fakeRules() });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === '/displayName' && e.code === 'required'));
  assert.ok(r.errors.some((e) => e.path === '/branding/primaryColor'));
});

test('non-object input is rejected', () => {
  assert.equal(validateTenantConfig(null).valid, false);
  assert.equal(validateTenantConfig([]).valid, false);
});

test('invalid rule conditions: errors from rules.validateRules are surfaced', () => {
  const rules = fakeRules(() => ({ valid: false, errors: [{ path: '/rules/0/when', code: 'unknown_op', message: 'unknown operator "zap"' }, 'second problem'] }));
  const r = validateTenantConfig(base(), { rules });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === '/rules/0/when' && e.code === 'unknown_op'));
  assert.ok(r.errors.some((e) => e.code === 'invalid_rule' && e.message === 'second problem'));
});

test('invalid rule conditions: a throwing validateRules becomes an error, not a crash', () => {
  const r = validateTenantConfig(base(), { rules: fakeRules(() => { throw new Error('boom'); }) });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /boom/.test(e.message)));
});

test('invalid rule conditions: schema rejects malformed condition shapes without the rules module', () => {
  const c = base();
  c.rules[0].when = { fact: 'bogus.path', op: 'eq', value: 1 };
  const r = validateTenantConfig(c, { rules: fakeRules() });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path.startsWith('/rules/0/when')));
});

test('duplicate question ids within a set are rejected', () => {
  const c = base();
  c.questionSets[0].questions.push({ ...c.questionSets[0].questions[0] });
  const r = validateTenantConfig(c, { rules: fakeRules() });
  assert.ok(codes(r).includes('duplicate_question_id'));
});

test('the same question id with different types across sets is rejected', () => {
  const c = base();
  c.questionSets[1].questions.find((x) => x.id === 'injuries').type = 'text';
  assert.ok(codes(validateTenantConfig(c, { rules: fakeRules() })).includes('question_type_conflict'));
});

test('showIf referencing an unknown question is rejected', () => {
  const c = base();
  c.questionSets[0].questions[5].showIf = { fact: 'answers.no_such_question', op: 'eq', value: true };
  assert.ok(codes(validateTenantConfig(c, { rules: fakeRules() })).includes('unknown_question'));
});

test('select questions need options', () => {
  const c = base();
  delete c.questionSets[1].questions.find((x) => x.id === 'glass_location').options;
  assert.ok(codes(validateTenantConfig(c, { rules: fakeRules() })).includes('missing_options'));
});

test('timers referencing unknown states or statuses are rejected', () => {
  const c = base();
  c.timers[0].state = 'MI'; // Aurelia serves WI and IL only
  c.timers[1].stopOn = { toStatus: ['not_a_status'] };
  const r = validateTenantConfig(c, { rules: fakeRules() });
  assert.ok(codes(r).includes('unknown_state'));
  assert.ok(codes(r).includes('unknown_status'));
});

test('timers for a LOB that does not serve the state are rejected', () => {
  const c = base();
  c.lobs[1].states = ['WI'];
  c.timers.find((t) => t.id === 'IL-ACK').lobs = ['homeowners'];
  assert.ok(codes(validateTenantConfig(c, { rules: fakeRules() })).includes('state_not_served'));
});

test('unlabelled timers produce a warning, not an error', () => {
  const c = base();
  c.timers[0].citation = 'WI rule 123';
  const r = validateTenantConfig(c, { rules: fakeRules() });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => /illustrative/i.test(w.message)));
});

test('rule actions must reference known queues, adjusters, questions and timers', () => {
  const c = base();
  c.rules[4].then.push({ type: 'route_queue', queue: 'ghost' });
  c.rules[4].then.push({ type: 'assign_adjuster', adjusterId: 'nobody' });
  c.rules[4].then.push({ type: 'require_question', questionId: 'nope' });
  c.rules[4].then.push({ type: 'start_timer', timerId: 'T-NOPE' });
  const r = validateTenantConfig(c, { rules: fakeRules() });
  for (const code of ['unknown_queue', 'unknown_adjuster', 'unknown_question', 'unknown_timer']) assert.ok(codes(r).includes(code), code);
});

test('duplicate ids for rules, queues, timers, lobs and question sets are rejected', () => {
  const c = base();
  c.rules.push({ ...c.rules[0] });
  c.queues.push({ ...c.queues[0] });
  c.timers.push({ ...c.timers[0] });
  c.lobs.push({ ...c.lobs[0] });
  c.questionSets.push({ ...c.questionSets[0] });
  const r = validateTenantConfig(c, { rules: fakeRules() });
  assert.equal(codes(r).filter((x) => x === 'duplicate_id').length, 5);
});

test('webhooks cannot include PII; cascade provider needs entries', () => {
  const c = base();
  c.notifications.webhooks.includePii = true;
  c.ai.cascade = [];
  const r = validateTenantConfig(c, { rules: fakeRules() });
  assert.ok(codes(r).includes('const') || codes(r).includes('pii_not_allowed'));
  assert.ok(codes(r).includes('missing_cascade'));
});

test('fastTrack.queue must exist', () => {
  const c = base();
  c.fastTrack.queue = 'ghost';
  assert.ok(codes(validateTenantConfig(c, { rules: fakeRules() })).includes('unknown_queue'));
});

test('changedSections reports differing top-level sections', () => {
  const a = base();
  const b = base();
  b.branding.primaryColor = '#000000';
  b.timers = [];
  b.displayName = 'Renamed';
  assert.deepEqual(changedSections(a, b).sort(), ['branding', 'other', 'timers']);
  assert.deepEqual(changedSections(a, a), []);
});

// ---- read helpers against an in-memory fake ctx
function fakeCtx(cfg) {
  const store = new Map([['t1', { cfg, version: 1 }]]);
  return {
    tenant: { id: 't1' },
    AppError: class extends Error { constructor(code, msg, status) { super(msg); this.code = code; this.status = status; } },
    clock: { now: () => new Date('2026-06-01T00:00:00Z'), nowIso: () => '2026-06-01T00:00:00.000Z' },
    tenants: { get: (id) => store.get(id)?.cfg ?? null, version: (id) => store.get(id)?.version ?? 0 },
    modules: {},
  };
}

test('getQuestionSet prefers the most specific set and throws not_found', () => {
  const svc = createService(fakeCtx(base()));
  assert.equal(svc.getQuestionSet({ lob: 'personal_auto', lossType: 'glass' }).id, 'auto-glass');
  assert.equal(svc.getQuestionSet({ lob: 'personal_auto', lossType: 'collision' }).id, 'auto-general');
  assert.equal(svc.getQuestionSet({ lob: 'homeowners' }).id, 'home-general');
  assert.throws(() => svc.getQuestionSet({ lob: 'marine' }), (e) => e.code === 'not_found');
});

test('getRules filters by stage, appliesTo and effective dates, sorted by priority', () => {
  const c = base();
  c.rules.push({ id: 'RT-FUTURE', stage: 'routing', priority: 1, when: true, then: [{ type: 'add_flag', flag: 'x' }], appliesTo: { effectiveFrom: '2027-01-01' } });
  const svc = createService(fakeCtx(c));
  const homeWi = svc.getRules({ stage: 'routing', lob: 'homeowners', state: 'WI' });
  assert.ok(homeWi.length >= 3);
  assert.ok(homeWi.every((r) => r.stage === 'routing'));
  assert.ok(!homeWi.some((r) => r.id === 'RT-AUTO-DEFAULT'));
  assert.ok(!homeWi.some((r) => r.id === 'RT-FUTURE'));
  assert.deepEqual(homeWi.map((r) => r.priority), [...homeWi.map((r) => r.priority)].sort((x, y) => x - y));
  assert.ok(svc.getRules({ stage: 'routing', lob: 'homeowners', at: '2027-02-01' }).some((r) => r.id === 'RT-FUTURE'));
});

test('getTimerDefinitions, getQueues and getPublicConfig', () => {
  const svc = createService(fakeCtx(base()));
  assert.deepEqual(svc.getTimerDefinitions({ state: 'IL', lob: 'personal_auto' }).map((t) => t.id).sort(), ['IL-ACK', 'IL-CONTACT', 'IL-DECIDE']);
  assert.ok(svc.getQueues().length >= 4);
  const pub = svc.getPublicConfig();
  assert.deepEqual(Object.keys(pub).sort(), ['branding', 'displayName', 'lobs', 'locales', 'tenantId']);
});
