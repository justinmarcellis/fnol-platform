import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TASKS, hasRequiredShape } from '../../../../src/ai/schemas.mjs';
import createLocal from '../../../../src/ai/providers/local.mjs';

const fx = (n) => readFileSync(new URL(`../../../fixtures/ai/${n}`, import.meta.url), 'utf8');
const p = createLocal({}, {});
const field = (out, name) => out.fields.find((f) => f.name === name);

test('local is available and reports its name', async () => {
  assert.equal(p.name, 'local');
  assert.equal(await p.available(), true);
});

test('police report extraction', async () => {
  const r = await p.run('extract_document', { text: fx('police-report.txt'), filename: 'report.txt' });
  assert.equal(r.output.kind, 'police_report');
  assert.equal(field(r.output, 'policeReportNumber').value, 'SC-2026-004417');
  assert.equal(field(r.output, 'lossDate').value, '2026-03-09');
  assert.equal(field(r.output, 'vin').value, '1HGCM82633A004352');
  assert.match(field(r.output, 'citedParty').value, /Unit 2/);
  assert.ok(field(r.output, 'damageAreas').value.includes('rear'));
  assert.equal(field(r.output, 'policeReportNumber').confidence, 0.9);
  assert.ok(field(r.output, 'policeReportNumber').provenance.snippet.includes('SC-2026-004417'));
  assert.equal(r.confidence, 0.9);
});

test('repair estimate extraction', async () => {
  const r = await p.run('extract_document', { text: fx('repair-estimate.txt'), filename: 'est.txt' });
  assert.equal(r.output.kind, 'estimate');
  assert.equal(field(r.output, 'estimateTotal').value, 4190.55);
  assert.equal(field(r.output, 'repairShop').value, 'Lakeside Collision Center');
  assert.ok(field(r.output, 'damageAreas').value.includes('bumper'));
  assert.equal(r.confidence, 0.9);
});

test('empty document yields low confidence and review', async () => {
  const r = await p.run('extract_document', { text: 'hello', filename: 'x.txt' });
  assert.equal(r.confidence, 0.2);
  assert.equal(r.output.needsReview, true);
});

test('rear-end narrative: other party at fault', async () => {
  const r = await p.run('extract_narrative', { text: fx('narrative-rear-end.txt') });
  assert.equal(r.output.lossType, 'collision');
  assert.equal(r.output.atFault, 'other');
  assert.equal(r.output.lossDate, '2026-03-09');
  assert.ok(r.output.cues.includes('rear_end'));
  assert.equal(r.output.injuries, false);
  assert.equal(r.confidence, 0.9);
});

test('injury narrative', async () => {
  const r = await p.run('extract_narrative', { text: fx('narrative-injury.txt') });
  assert.equal(r.output.injuries, true);
  for (const c of ['whiplash', 'ambulance', 'hospital']) assert.ok(r.output.injuryCues.includes(c), c);
  assert.ok(r.output.cues.includes('injury'));
  assert.equal(r.output.lossDate, '2026-04-02');
});

test('glass-only narrative', async () => {
  const r = await p.run('extract_narrative', { text: fx('narrative-glass.txt') });
  assert.equal(r.output.lossType, 'glass');
  assert.ok(r.output.cues.includes('glass_only'));
  assert.equal(r.output.injuries, false);
});

test('theft narrative without police report triggers fraud indicator', async () => {
  const n = await p.run('extract_narrative', { text: fx('narrative-theft.txt') });
  assert.equal(n.output.lossType, 'theft');
  const f = await p.run('fraud_signals', { facts: { lossType: n.output.lossType, lossDate: n.output.lossDate } });
  assert.ok(f.output.indicators.some((i) => i.code === 'NO_POLICE_REPORT_THEFT'));
  const ok = await p.run('fraud_signals', { facts: { lossType: 'theft', policeReportNumber: 'X-1234' } });
  assert.ok(!ok.output.indicators.some((i) => i.code === 'NO_POLICE_REPORT_THEFT'));
});

test('CAT and fire cues', async () => {
  const r = await p.run('extract_narrative', { text: 'Hail from the storm dented my roof on 2026-07-01.' });
  assert.ok(r.output.cues.includes('cat'));
  const f = await p.run('extract_narrative', { text: 'The garage fire burned my car.' });
  assert.equal(f.output.lossType, 'fire');
});

test('fraud indicators from facts', async () => {
  const r = await p.run('fraud_signals', { facts: {
    lossType: 'collision', inceptionDate: '2026-03-01', lossDate: '2026-03-10', reportedDate: '2026-04-20', priorClaims: 3, estimateTotal: 5000,
  } });
  const codes = r.output.indicators.map((i) => i.code);
  for (const c of ['LOSS_NEAR_INCEPTION', 'LATE_REPORT', 'PRIOR_CLAIMS', 'ROUND_NUMBER_ESTIMATE']) assert.ok(codes.includes(c), c);
  assert.ok(r.output.indicators.every((i) => typeof i.weight === 'number' && i.reason));
  const m = await p.run('fraud_signals', { facts: { lossType: 'glass', narrative: 'Someone broke into my car and stole the stereo.' } });
  assert.ok(m.output.indicators.some((i) => i.code === 'NARRATIVE_EVIDENCE_MISMATCH'));
  const clean = await p.run('fraud_signals', { facts: { lossType: 'collision', lossDate: '2026-03-10', estimateTotal: 4190.55 } });
  assert.equal(clean.output.score, 0);
});

test('severity bands', async () => {
  const low = await p.run('severity', { facts: { lossType: 'glass', glassOnly: true, drivable: true } });
  assert.equal(low.output.band, 'low');
  const sev = await p.run('severity', { facts: { lossType: 'collision', injuries: true, drivable: false, damageAreas: ['front', 'rear', 'roof'], estimateTotal: 18000 } });
  assert.equal(sev.output.band, 'severe');
  assert.ok(sev.output.score <= 100 && sev.output.drivers.length >= 4);
});

test('subrogation flag', async () => {
  const yes = await p.run('subrogation', { facts: { narrative: fx('narrative-rear-end.txt'), citedParty: 'Unit 2' } });
  assert.equal(yes.output.flag, true);
  assert.ok(yes.output.reasons.length >= 2);
  const no = await p.run('subrogation', { facts: { lossType: 'glass' } });
  assert.equal(no.output.flag, false);
});

test('summarize and next_best_actions', async () => {
  const s = await p.run('summarize', { facts: { lossType: 'collision', lossDate: '2026-03-09', injuries: false, estimateTotal: 4190.55 } });
  assert.match(s.output.summary, /collision loss occurred on 2026-03-09/);
  assert.ok(s.output.bullets.length >= 3);
  const a = await p.run('next_best_actions', { facts: { lossType: 'theft', injuries: true } });
  const codes = a.output.actions.map((x) => x.code);
  assert.ok(codes.includes('REQUEST_POLICE_REPORT') && codes.includes('CONTACT_CLAIMANT_INJURY'));
});

test('all 8 tasks match shared shapes and are deterministic', async () => {
  const inputs = {
    extract_narrative: { text: fx('narrative-rear-end.txt') },
    extract_document: { text: fx('repair-estimate.txt'), filename: 'e.txt' },
    classify_photo: { filename: 'rear-bumper-red.jpg', metadata: { make: 'Maple' } },
    severity: { facts: { lossType: 'collision' } },
    fraud_signals: { facts: {} },
    subrogation: { facts: {} },
    summarize: { facts: {} },
    next_best_actions: { facts: {} },
  };
  assert.deepEqual(Object.keys(inputs).sort(), [...TASKS].sort());
  for (const t of TASKS) {
    const a = await p.run(t, inputs[t]);
    const b = await p.run(t, inputs[t]);
    assert.ok(hasRequiredShape(t, a.output), t);
    assert.deepEqual(a, b);
    assert.ok([0.2, 0.5, 0.9].includes(a.confidence), `${t} ${a.confidence}`);
    assert.equal(typeof a.explanation, 'string');
    assert.ok(a.usage && a.model);
  }
  const ph = await p.run('classify_photo', inputs.classify_photo);
  assert.deepEqual(ph.output.damageAreas, ['rear', 'bumper']);
  assert.equal(ph.output.vehicle.color, 'red');
});

test('never crashes on empty input', async () => {
  for (const t of TASKS) assert.ok((await p.run(t, undefined)).output);
});
