// S2-ITG-01: severity bands, platform calibration, theft late-report weighting and suggestedReserve (ADR-003).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bandFor, bandCuts, calibrationAdjustments, computeSeverity, CALIBRATION, DEFAULT_CUTS } from '../../../src/modules/triage/severity.mjs';
import { buildTriageFacts } from '../../../src/modules/triage/facts.mjs';
import { deterministicIndicators, mergeFraud } from '../../../src/modules/triage/fraud.mjs';
import { bootTriageApp, triageErrors } from './helpers.mjs';
import { reset, putClaim, setFacts, makeAi } from './fakes.mjs';

test('default bands are 0-24 minor, 25-49 moderate, 50-74 major, 75-100 severe', () => {
  assert.deepEqual([...DEFAULT_CUTS], [25, 50, 75]);
  const cases = [[0, 'minor'], [24, 'minor'], [25, 'moderate'], [49, 'moderate'], [50, 'major'], [74, 'major'], [75, 'severe'], [100, 'severe']];
  for (const [score, band] of cases) assert.equal(bandFor(score), band, `score ${score}`);
});

test('bandCuts accepts TenantConfig.severityBands objects and arrays; invalid input falls back to defaults', () => {
  assert.deepEqual(bandCuts({ moderate: 20, major: 45, severe: 70 }), [20, 45, 70]);
  assert.deepEqual(bandCuts([30, 60, 90]), [30, 60, 90]);
  assert.deepEqual(bandCuts({ major: 55 }), [25, 55, 75], 'missing keys use defaults');
  assert.deepEqual(bandCuts({ moderate: 60, major: 50, severe: 75 }), [25, 50, 75], 'non-ascending cuts are rejected');
  assert.deepEqual(bandCuts(undefined), [25, 50, 75]);
  assert.equal(bandFor(22, { moderate: 20, major: 45, severe: 70 }), 'moderate');
});

test('calibration adds points for cues the AI pass does not see, once each', () => {
  assert.deepEqual(calibrationAdjustments({}), []);
  const pts = (f) => calibrationAdjustments(f).reduce((s, c) => s + c.points, 0);
  assert.equal(pts({ vehicleNotDrivable: true }), CALIBRATION.vehicleNotDrivable);
  assert.equal(pts({ totalLossIndicated: true, vehicleNotDrivable: true }), CALIBRATION.totalLossIndicated, 'total loss supersedes not-drivable');
  assert.equal(pts({ dwellingUninhabitable: true }), CALIBRATION.dwellingUninhabitable);
  assert.equal(pts({ lob: 'commercial_auto' }), CALIBRATION.commercialLine);
  const s = computeSeverity({ score: 50, drivers: ['fire loss'] }, [], { dwellingUninhabitable: true });
  assert.equal(s.score, 80);
  assert.equal(s.band, 'severe');
  assert.deepEqual(s.factors.map((f) => f.name), ['ai_severity', 'calibration']);
  const withRule = computeSeverity({ score: 36 }, [10], { lob: 'commercial_auto', vehicleNotDrivable: true });
  assert.equal(withRule.score, 64);
  assert.deepEqual(withRule.factors.map((f) => f.name), ['ai_severity', 'calibration', 'calibration', 'rule_add_severity']);
});

test('facts expose PII-free calibration cues and read a rear-end narrative as subrogation', () => {
  const bundle = (over = {}) => ({
    claim: { lob: 'personal_auto', lossEvent: { cause: 'collision', description: over.text ?? '' } },
    parties: [], vehicles: over.vehicles ?? [], properties: over.properties ?? [],
  });
  const towed = buildTriageFacts({ bundle: bundle({ vehicles: [{ role: 'insured', drivable: true, towed: true }] }) });
  assert.equal(towed.vehicleNotDrivable, true);
  assert.equal(towed.totalLossIndicated, false);
  const stolen = buildTriageFacts({ bundle: bundle({ vehicles: [{ role: 'insured', drivable: false, damageAreas: ['total'] }] }) });
  assert.equal(stolen.totalLossIndicated, true);
  assert.equal(stolen.vehicleNotDrivable, false);
  const other = buildTriageFacts({ bundle: bundle({ vehicles: [{ role: 'third_party', drivable: false }] }) });
  assert.equal(other.vehicleNotDrivable, false, 'only the insured vehicle counts');
  const fire = buildTriageFacts({ bundle: bundle({ properties: [{ habitable: false }] }) });
  assert.equal(fire.dwellingUninhabitable, true);
  const rear = buildTriageFacts({ bundle: bundle({ text: 'I was stopped at the light when the car behind me hit me hard.' }) });
  assert.equal(rear.narrative.rearEndedByOther, true);
  const self = buildTriageFacts({ bundle: bundle({ text: 'I rear-ended the car in front of me.' }) });
  assert.equal(self.narrative.rearEndedByOther, false);
  assert.ok(!JSON.stringify(rear).includes('stopped at the light'), 'no free text in facts');
});

test('a theft reported more than 7 days late is weighted as a stronger fraud cue than a late collision', () => {
  const theft = deterministicIndicators({ cause: 'theft', daysToReport: 12, policeReportFiled: true });
  assert.deepEqual(theft.map((i) => [i.code, i.weight]), [['LATE_REPORT', 0.35]]);
  assert.deepEqual(deterministicIndicators({ cause: 'theft', daysToReport: 5, policeReportFiled: true }), []);
  assert.deepEqual(deterministicIndicators({ cause: 'collision', daysToReport: 12 }), [], 'collision uses the 14-day threshold');
  assert.deepEqual(deterministicIndicators({ cause: 'collision', daysToReport: 20 }).map((i) => i.weight), [0.15]);
  const merged = mergeFraud([...theft, { code: 'NARRATIVE_EVIDENCE_MISMATCH', weight: 0.2, reason: 'x' }], { indicators: [{ code: 'LATE_REPORT', weight: 15 }] });
  assert.equal(merged.score, 55, 'deterministic theft weight beats the generic AI weight');
});

let app; let ai; let seq = 0; let ID = '';
before(async () => { ai = makeAi(); app = await bootTriageApp(ai); });
after(async () => { await app.close(); });
beforeEach(() => { ID = `clm_${String(++seq).padStart(20, '9')}`; reset(); ai.fail = false; app.ctx.ai = ai; });

test('runTriage applies calibration, sets suggestedReserve from the accepted estimate and stays schema-valid', async () => {
  putClaim('alpha', { id: ID, vehicles: [{ id: 'veh_1', role: 'insured', drivable: false, towed: true }] });
  setFacts('alpha', ID, { estimateTotal: 1850 });
  const r = await app.triage().runTriage(ID);
  assert.deepEqual(triageErrors(r), []);
  assert.equal(r.severityScore, 30 + CALIBRATION.vehicleNotDrivable);
  assert.ok(r.factors.some((f) => f.name === 'calibration'));
  assert.deepEqual(r.suggestedReserve, { amount: 1850, currency: 'USD' });
});

test('runTriage reads band cut-offs from TenantConfig.severityBands', async () => {
  putClaim('beta', { id: ID });
  const before = await app.triage('beta').runTriage(ID);
  assert.equal(before.severityBand, 'moderate', 'score 30 is moderate under the default 25/50/75 bands');
  app.ctx.tenants.put('beta', { id: 'beta', displayName: 'beta Example', severityBands: { moderate: 10, major: 30, severe: 90 } }, 'test');
  const after = await app.triage('beta').runTriage(ID, { force: true });
  assert.equal(after.severityBand, 'major');
});
