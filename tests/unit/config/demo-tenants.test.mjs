// S2-ITG-01: demo tenant calibration (ADR-003). Aurelia STP for glass and small home water, Kestrel commercial auto
// question set and never-fast-track commercial routing, default severity bands, no double-counted severity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateTenantConfig } from '../../../src/modules/config/service.js';
import { validateRules, runRules, filterRules } from '../../../src/modules/rules/engine.js';
import { decideRouting } from '../../../src/modules/rules/routing.js';

const load = (n) => JSON.parse(fs.readFileSync(new URL(`../../../tenants/${n}.json`, import.meta.url), 'utf8'));
const A = load('aurelia-mutual');
const K = load('kestrel-point');

/** Fact document shaped like rules.buildFacts output, with only what the demo rules read. */
const facts = ({ lob = 'personal_auto', cause, injuries = false, triage = {}, coverage = 'covered', answers = {} } = {}) => ({
  claim: { lob, riskState: lob === 'homeowners' ? 'WI' : 'MI' },
  loss: { cause, injuriesReported: injuries, fatality: false },
  coverage: { outcome: coverage },
  triage: { severityScore: 5, severityBand: 'minor', fraud: { score: 0 }, fastTrackEligible: true, subrogation: { flag: false }, ...triage },
  answers,
});

/** Route a fact document through a tenant's routing rules and the pure decision logic. */
function route(config, f) {
  const rules = filterRules(config.rules, { stage: 'routing', lob: f.claim.lob, state: f.claim.riskState, lossType: f.loss.cause, at: '2026-10-01' });
  const { actions, fired } = runRules(rules, f);
  const d = decideRouting({ actions, config, lob: f.claim.lob, triage: f.triage, coverage: f.coverage, estimate: f.triage.suggestedReserve });
  return { ...d, fired: fired.map((x) => x.ruleId) };
}

for (const [name, cfg] of [['aurelia-mutual', A], ['kestrel-point', K]]) {
  test(`${name} validates with the real rule validator`, () => {
    const r = validateTenantConfig(cfg, { rules: { validateRules } });
    assert.equal(r.valid, true, JSON.stringify(r.errors, null, 1));
  });

  test(`${name}: default severity bands 25/50/75 (0-24 minor, 25-49 moderate, 50-74 major, 75-100 severe)`, () => {
    assert.deepEqual(cfg.severityBands, { moderate: 25, major: 50, severe: 75 });
  });

  test(`${name}: triage rules do not re-add severity the platform already scores (injury, drivability, habitability)`, () => {
    const dup = cfg.rules.filter((r) => r.stage === 'triage' && r.then.some((a) => a.type === 'add_severity')
      && /injur|drivable|livable|habitable/.test(JSON.stringify(r.when)));
    assert.deepEqual(dup.map((r) => r.id), []);
  });
}

test('Aurelia fast-tracks a covered glass-only claim', () => {
  const d = route(A, facts({ cause: 'glass', triage: { suggestedReserve: { amount: 413, currency: 'USD' } } }));
  assert.equal(d.fastTrack, true);
  assert.equal(d.queue, 'fast_track');
  assert.ok(d.fired.includes('RT-FT-GLASS'));
});

test('Aurelia fast-tracks home water under $2,500 from the triage reserve or the intake answer, and nothing else', () => {
  const water = (over = {}) => facts({ lob: 'homeowners', cause: 'water_plumbing', ...over });
  const small = route(A, water({ triage: { suggestedReserve: { amount: 1100, currency: 'USD' } } }));
  assert.equal(small.fastTrack, true);
  assert.equal(small.queue, 'fast_track');
  assert.ok(small.fired.includes('RT-FT-HOME-SMALL'));
  assert.equal(route(A, water({ answers: { estimated_damage: 1800, home_livable: true } })).fastTrack, true);
  assert.equal(route(A, water({ triage: { suggestedReserve: { amount: 3100, currency: 'USD' } } })).fastTrack, false, 'over $2,500');
  assert.equal(route(A, water()).fastTrack, false, 'no estimate yet');
  assert.equal(route(A, water({ answers: { estimated_damage: 900, home_livable: false } })).fastTrack, false, 'home not livable');
  assert.equal(route(A, water({ triage: { severityScore: 40, suggestedReserve: { amount: 900, currency: 'USD' } } })).fastTrack, false, 'too severe');
  const fire = route(A, facts({ lob: 'homeowners', cause: 'fire', triage: { suggestedReserve: { amount: 900, currency: 'USD' } } }));
  assert.equal(fire.fastTrack, false, 'only water losses take the small-home lane');
  assert.equal(fire.queue, 'property');
});

test('Kestrel glass STP no longer needs a prior_damage answer, and prior damage still blocks it', () => {
  assert.equal(route(K, facts({ cause: 'glass' })).fastTrack, true);
  assert.equal(route(K, facts({ cause: 'glass', answers: { prior_damage: true } })).fastTrack, false);
});

test('Kestrel commercial_auto question set covers fleet, compliance, cargo and recovery questions', () => {
  const set = K.questionSets.find((s) => s.lob === 'commercial_auto');
  assert.ok(set);
  const ids = set.questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, 'question ids are unique');
  for (const id of ['loss_date', 'loss_description', 'unit_number', 'driver_is_employee', 'injuries', 'dot_recordable', 'cargo_involved',
    'hazmat_involved', 'vehicle_drivable', 'police_report_number', 'other_party_involved', 'other_party_insurer', 'fraud_disclosure']) {
    assert.ok(ids.includes(id), id);
  }
  const orders = set.questions.map((q) => q.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'questions are in order');
  assert.ok(set.questions.find((q) => q.id === 'driver_employee_ref').pii, 'employee reference is PII');
});

test('Kestrel never fast-tracks commercial auto, even when triage marks the claim eligible', () => {
  const ca = (over = {}) => facts({ lob: 'commercial_auto', cause: 'collision', ...over });
  const d = route(K, ca());
  assert.equal(d.fastTrack, false);
  assert.equal(d.queue, 'commercial_auto_claims');
  assert.ok(d.fired.includes('RT-CA-NO-STP'));
  assert.ok(d.reasons.some((r) => /never fast tracked/.test(r)));
  // Even an extra fast_track request is overruled by the commercial denial.
  const forced = decideRouting({ actions: [{ type: 'fast_track', ruleId: 'X' }, ...runRules(filterRules(K.rules, { stage: 'routing', lob: 'commercial_auto' }), ca()).actions], config: K, lob: 'commercial_auto', triage: ca().triage, coverage: ca().coverage });
  assert.equal(forced.fastTrack, false);
  const hazmat = route(K, ca({ answers: { hazmat_involved: true } }));
  assert.equal(hazmat.queue, 'commercial_specialty');
  assert.equal(hazmat.fastTrack, false);
  assert.ok(!K.queues.find((q) => q.id === K.fastTrack.queue).lobs.includes('commercial_auto'));
  const subro = filterRules(K.rules, { stage: 'post_routing', lob: 'commercial_auto' });
  assert.deepEqual(runRules(subro, ca({ triage: { subrogation: { flag: true } } })).fired.map((f) => f.ruleId), ['PR-SUBRO-CA']);
});
