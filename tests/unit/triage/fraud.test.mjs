import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTriageFacts } from '../../../src/modules/triage/facts.mjs';
import { deterministicIndicators, mergeFraud } from '../../../src/modules/triage/fraud.mjs';

const bundle = (loss = {}, claim = {}, extra = {}) => ({
  claim: { id: 'clm_1', lob: 'personal_auto', reportedAt: '2026-09-16T10:00:00Z', lossEvent: { lossDate: '2026-09-15', cause: 'collision', description: 'Synthetic narrative.', ...loss }, ...claim },
  parties: [], vehicles: [], ...extra,
});
const val = (o) => Object.fromEntries(Object.entries(o).map(([k, value]) => [k, { value, confidence: 0.9 }]));
const codes = (f) => deterministicIndicators(f).map((i) => i.code);
const facts = (b, accepted, policy) => buildTriageFacts({ bundle: b, accepted: val(accepted ?? {}), policy });
const policyFrom = (effectiveDate) => ({ period: { effectiveDate, expirationDate: '2027-01-01' } });

test('LOSS_NEAR_INCEPTION fires at 30 days and not at 31 or before inception', () => {
  assert.ok(codes(facts(bundle(), {}, policyFrom('2026-08-16'))).includes('LOSS_NEAR_INCEPTION')); // 30 days
  assert.ok(!codes(facts(bundle(), {}, policyFrom('2026-08-15'))).includes('LOSS_NEAR_INCEPTION')); // 31 days
  assert.ok(!codes(facts(bundle(), {}, policyFrom('2026-10-01'))).includes('LOSS_NEAR_INCEPTION')); // inception after loss
  assert.ok(!codes(facts(bundle())).includes('LOSS_NEAR_INCEPTION')); // unknown inception
  const [i] = deterministicIndicators(facts(bundle(), {}, policyFrom('2026-09-10')));
  assert.equal(i.code, 'LOSS_NEAR_INCEPTION');
  assert.match(i.reason, /5 day/);
  assert.ok(i.weight > 0 && i.weight <= 1);
});

test('LATE_REPORT fires when reported more than 14 days after the loss', () => {
  assert.ok(codes(facts(bundle({ lossDate: '2026-08-01' }))).includes('LATE_REPORT'));
  assert.ok(!codes(facts(bundle({ lossDate: '2026-09-02' }))).includes('LATE_REPORT')); // exactly 14
  assert.ok(codes(facts(bundle({ lossDate: '2026-09-01' }))).includes('LATE_REPORT')); // 15
});

test('NO_POLICE_REPORT_THEFT fires for theft without a police report only', () => {
  assert.ok(codes(facts(bundle({ cause: 'theft' }))).includes('NO_POLICE_REPORT_THEFT'));
  assert.ok(!codes(facts(bundle({ cause: 'theft', policeReport: { filed: true } }))).includes('NO_POLICE_REPORT_THEFT'));
  assert.ok(!codes(facts(bundle({ cause: 'theft' }, {}, {}), { policeReportNumber: 'PR-1234' })).includes('NO_POLICE_REPORT_THEFT'));
  assert.ok(!codes(facts(bundle({ cause: 'collision' }))).includes('NO_POLICE_REPORT_THEFT'));
});

test('PRIOR_CLAIMS fires at two or more prior claims', () => {
  assert.ok(!codes(buildTriageFacts({ bundle: bundle(), priorClaims: 1 })).includes('PRIOR_CLAIMS'));
  assert.ok(codes(buildTriageFacts({ bundle: bundle(), priorClaims: 2 })).includes('PRIOR_CLAIMS'));
  const w2 = deterministicIndicators(buildTriageFacts({ bundle: bundle(), priorClaims: 2 }))[0].weight;
  const w4 = deterministicIndicators(buildTriageFacts({ bundle: bundle(), priorClaims: 4 }))[0].weight;
  assert.ok(w4 > w2);
  assert.ok(codes(facts(bundle({}, {}, { priorClaims: [{}, {}, {}] }))).includes('PRIOR_CLAIMS')); // from bundle
});

test('NARRATIVE_EVIDENCE_MISMATCH fires when narrative and evidence damage areas disagree, or loss dates differ', () => {
  const b = (d) => bundle({ description: d });
  assert.ok(codes(facts(b('Another car hit the rear of my car.'), { damageAreas: ['front bumper', 'hood'] })).includes('NARRATIVE_EVIDENCE_MISMATCH'));
  assert.ok(!codes(facts(b('Another car hit the rear of my car.'), { damageAreas: ['rear bumper'] })).includes('NARRATIVE_EVIDENCE_MISMATCH'));
  assert.ok(!codes(facts(b('Another car hit the rear of my car.'))).includes('NARRATIVE_EVIDENCE_MISMATCH')); // no evidence yet
  assert.ok(codes(facts(b('A bump.'), { lossDate: '2026-08-30' })).includes('NARRATIVE_EVIDENCE_MISMATCH'));
});

test('ROUND_NUMBER_ESTIMATE fires for round estimates of at least 1000', () => {
  assert.ok(codes(facts(bundle(), { estimateTotal: 5000 })).includes('ROUND_NUMBER_ESTIMATE'));
  assert.ok(codes(facts(bundle(), { estimateTotal: '$3,500' })).includes('ROUND_NUMBER_ESTIMATE'));
  assert.ok(codes(facts(bundle(), { estimateTotal: { amount: 2000, currency: 'USD' } })).includes('ROUND_NUMBER_ESTIMATE'));
  assert.ok(!codes(facts(bundle(), { estimateTotal: 4872.19 })).includes('ROUND_NUMBER_ESTIMATE'));
  assert.ok(!codes(facts(bundle(), { estimateTotal: 500 })).includes('ROUND_NUMBER_ESTIMATE'));
});

test('a clean claim produces no indicators and facts carry no raw narrative', () => {
  const f = facts(bundle());
  assert.deepEqual(deterministicIndicators(f), []);
  assert.ok(!JSON.stringify(f).includes('Synthetic narrative'));
});

test('mergeFraud unions with AI indicators by code (max weight), normalizes point weights, caps score at 100', () => {
  const det = [{ code: 'LATE_REPORT', weight: 0.15, reason: 'det' }];
  const m = mergeFraud(det, { indicators: [{ code: 'LATE_REPORT', weight: 40, reason: 'ai' }, { code: 'AI_ONLY', weight: 0.3, reason: 'x' }, { code: 'LOW', weight: 0.05, reason: 'y' }] });
  assert.equal(m.indicators.find((i) => i.code === 'LATE_REPORT').weight, 0.4);
  assert.equal(m.indicators.find((i) => i.code === 'LATE_REPORT').reason, 'det');
  assert.equal(m.score, 75);
  assert.equal(m.referToSiu, true);
  const big = mergeFraud(Array.from({ length: 6 }, (_, i) => ({ code: `C${i}`, weight: 0.3, reason: 'r' })), null);
  assert.equal(big.score, 100);
  const keep = mergeFraud(det, { indicators: [{ code: 'LATE_REPORT', weight: 0.05 }] });
  assert.equal(keep.indicators[0].weight, 0.15);
  assert.deepEqual(mergeFraud([], null), { score: 0, indicators: [], referToSiu: false });
});
