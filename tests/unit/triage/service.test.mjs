import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootTriageApp, call, triageErrors } from './helpers.mjs';
import { reset, putClaim, setFacts, setCoverage, makeAi, state } from './fakes.mjs';

let app; let ai;
let ID = '';
let seq = 0;
before(async () => { ai = makeAi(); app = await bootTriageApp(ai); });
after(async () => { await app.close(); });
beforeEach(() => { ID = `clm_${String(++seq).padStart(20, '0')}`; reset(); ai.fail = false; ai.calls.length = 0; app.ctx.ai = ai; });

test('runTriage returns a schema-valid result with AI provenance and publishes claim.triaged without PII', async () => {
  putClaim('alpha', { id: ID });
  setCoverage('alpha', ID, { id: 'cvr_1', outcome: 'covered', checks: [] });
  const r = await app.triage().runTriage(ID);
  assert.deepEqual(triageErrors(r), []);
  assert.equal(r.attempt, 1);
  assert.equal(r.severityScore, 30);
  assert.equal(r.severityBand, 'moderate');
  assert.equal(r.complexity, 'low');
  assert.equal(r.ai.provider, 'vertex-gemini');
  assert.equal(r.ai.model, 'fake-model-1');
  assert.equal(r.ai.confidence, 0.82);
  assert.match(r.inputsHash, /^[0-9a-f]{64}$/);
  assert.ok(r.explanation.length > 40);
  assert.equal(typeof r.subrogation.confidence, 'number');
  assert.deepEqual(ai.calls.map((c) => c.task).sort(), ['fraud_signals', 'severity', 'subrogation']);
  assert.ok(ai.calls.every((c) => c.opts.tenantId === 'alpha' && c.opts.claimId === ID && c.input.facts));
  assert.ok(!JSON.stringify(ai.calls).includes('Synthetic narrative'));
  const [evt] = app.events('claim.triaged');
  assert.equal(evt.data.triageResultId, r.id);
  assert.equal(evt.data.severityScore, 30);
  assert.deepEqual(Object.keys(evt.data).sort(), ['ai', 'attempt', 'claimId', 'complexity', 'fastTrackEligible', 'fraudIndicatorCodes', 'fraudScore', 'severityBand', 'severityScore', 'subrogation', 'triageResultId']);
  assert.ok(!evt.data.explanation);
});

test('skips when inputsHash is unchanged; force re-runs and increments attempt; listTriage returns all', async () => {
  putClaim('alpha', { id: ID });
  const t = app.triage();
  const a = await t.runTriage(ID);
  const b = await t.runTriage(ID);
  assert.equal(b.id, a.id);
  assert.equal(app.events('claim.triaged').filter((e) => e.subject === ID).length, 1);
  const c = await t.runTriage(ID, { force: true });
  assert.equal(c.attempt, 2);
  assert.notEqual(c.id, a.id);
  assert.equal(c.inputsHash, a.inputsHash);
  setFacts('alpha', ID, { estimateTotal: 6200.55 });
  const d = await t.runTriage(ID);
  assert.equal(d.attempt, 3);
  assert.notEqual(d.inputsHash, a.inputsHash);
  assert.deepEqual((await t.listTriage(ID)).map((x) => x.attempt), [1, 2, 3]);
  assert.equal((await t.getLatestTriage(ID)).id, d.id);
  assert.equal(app.events('claim.triaged').filter((e) => e.subject === ID).length, 3);
});

test('concurrent runs for one claim create a single attempt', async () => {
  putClaim('alpha', { id: ID });
  const [a, b] = await Promise.all([app.triage().runTriage(ID), app.triage().runTriage(ID)]);
  assert.equal(a.id, b.id);
  assert.equal((await app.triage().listTriage(ID)).length, 1);
});

test('rule add_severity deltas are added and clamped; set_complexity raises complexity', async () => {
  putClaim('alpha', { id: ID });
  state.rules.actions = [{ type: 'add_severity', points: 35, ruleId: 'R1' }, { type: 'add_severity', points: 50, ruleId: 'R2' }, { type: 'set_complexity', complexity: 'high', ruleId: 'R3' }];
  const r = await app.triage().runTriage(ID);
  assert.equal(r.severityScore, 100);
  assert.equal(r.severityBand, 'severe');
  assert.equal(r.complexity, 'high');
  assert.deepEqual(r.factors.map((f) => f.contribution), [30, 35, 50]);
  assert.equal(state.evalCalls[0].stage, 'triage');
  assert.deepEqual(triageErrors(r), []);
});

test('band cut-offs: <25 minor, <50 moderate, <75 major, else severe', async () => {
  putClaim('alpha', { id: ID });
  const bands = [];
  for (const score of [24, 25, 49, 50, 74, 75]) {
    app.ctx.ai = makeAi({ outputs: { severity: { score, band: 'x', drivers: [] } } });
    bands.push((await app.triage().runTriage(ID, { force: true })).severityBand);
  }
  assert.deepEqual(bands, ['minor', 'moderate', 'moderate', 'major', 'major', 'severe']);
});

test('complexity rises with parties, injuries and coverage issues', async () => {
  putClaim('alpha', {
    id: ID, claim: { lossEvent: { lossDate: '2026-09-15', cause: 'collision', description: 'x', injuriesReported: true, vehiclesInvolved: 3 } },
    parties: [{ id: 'a', roles: ['insured'], kind: 'person', injured: true }, { id: 'b', roles: ['other'], kind: 'person' }, { id: 'c', roles: ['other'], kind: 'person' }],
  });
  setCoverage('alpha', ID, { id: 'cvr_1', outcome: 'not_covered', checks: [{ code: 'in_force', passed: false }] });
  const r = await app.triage().runTriage(ID);
  assert.equal(r.complexity, 'high');
});

test('fraud: deterministic indicators merge with AI indicators; score and SIU flag follow', async () => {
  putClaim('alpha', { id: ID, claim: { lossEvent: { lossDate: '2026-09-15', cause: 'theft', description: 'Car stolen.' } } });
  setFacts('alpha', ID, { estimateTotal: 5000 });
  app.ctx.ai = makeAi({ outputs: { fraud_signals: { score: 60, indicators: [{ code: 'NO_POLICE_REPORT_THEFT', weight: 40, reason: 'ai' }, { code: 'PHOTO_METADATA_MISMATCH', weight: 0.2, reason: 'ai photo' }] } } });
  const r = await app.triage().runTriage(ID);
  const by = Object.fromEntries(r.fraud.indicators.map((i) => [i.code, i]));
  assert.equal(by.NO_POLICE_REPORT_THEFT.weight, 0.4);
  assert.equal(by.ROUND_NUMBER_ESTIMATE.weight, 0.1);
  assert.ok(by.PHOTO_METADATA_MISMATCH);
  assert.equal(r.fraud.score, 70);
  assert.equal(r.fraud.referToSiu, true);
  assert.deepEqual(triageErrors(r), []);
});

test('subrogation flags citedParty, other-at-fault and rear-ended-by-other; insured at fault blocks it', async () => {
  putClaim('alpha', { id: ID });
  assert.equal((await app.triage().runTriage(ID)).subrogation.flag, false);
  setFacts('alpha', ID, { citedParty: 'Other driver (synthetic)' });
  let r = await app.triage().runTriage(ID);
  assert.equal(r.subrogation.flag, true);
  assert.deepEqual(r.subrogation.reasons.map((x) => x.code), ['other_driver_cited']);
  assert.ok(r.subrogation.confidence >= 0.8);
  putClaim('alpha', { id: ID, claim: { lossEvent: { lossDate: '2026-09-15', cause: 'collision', description: 'I was stopped at a light when a truck rear-ended me.' } } });
  setFacts('alpha', ID, {});
  r = await app.triage().runTriage(ID);
  assert.deepEqual(r.subrogation.reasons.map((x) => x.code), ['rear_ended_by_other']);
  putClaim('alpha', { id: ID, claim: { lossEvent: { lossDate: '2026-09-15', cause: 'collision', description: 'I rear-ended the car ahead.' } } });
  r = await app.triage().runTriage(ID);
  assert.equal(r.subrogation.flag, false);
  setFacts('alpha', ID, { atFaultParty: 'insured', citedParty: 'insured' });
  app.ctx.ai = makeAi({ outputs: { subrogation: { flag: true, reasons: ['looks like other party'], confidence: 0.7 } } });
  r = await app.triage().runTriage(ID);
  assert.equal(r.subrogation.flag, false);
});

test('AI subrogation reasons are included when the AI flags it', async () => {
  putClaim('alpha', { id: ID });
  app.ctx.ai = makeAi({ outputs: { subrogation: { flag: true, reasons: ['Other party ran a red light.'], confidence: 0.77 } } });
  const r = await app.triage().runTriage(ID);
  assert.equal(r.subrogation.flag, true);
  assert.equal(r.subrogation.reasons[0].code, 'ai_signal');
  assert.equal(r.subrogation.confidence, 0.77);
});

test('degrades gracefully when ai, evidence, coverage and rules fail or are absent', async () => {
  putClaim('alpha', { id: ID });
  state.rules.fail = true;
  ai.fail = true;
  const r = await app.triage().runTriage(ID);
  assert.deepEqual(triageErrors(r), []);
  assert.equal(r.ai.provider, 'local');
  assert.ok(r.ai.confidence < 0.5);
  assert.match(r.explanation, /AI service was unavailable/);
  app.ctx.ai = null;
  const r2 = await app.triage().runTriage(ID, { force: true });
  assert.equal(r2.attempt, 2);
  assert.equal(r2.severityBand, 'minor');
});

test('unknown claim is a 404 and tenants are isolated', async () => {
  putClaim('alpha', { id: ID });
  await assert.rejects(app.triage().runTriage('clm_missing'), (e) => e.status === 404);
  await app.triage().runTriage(ID);
  assert.equal(await app.triage('beta').getLatestTriage(ID), null);
  assert.deepEqual(await app.triage('beta').listTriage(ID), []);
});

test('severity and fraud use accepted evidence facts and inception from the policy snapshot', async () => {
  putClaim('alpha', { id: ID });
  state.snapshots.set('alpha:psn_1', { period: { effectiveDate: '2026-09-01', expirationDate: '2027-09-01' } });
  setCoverage('alpha', ID, { id: 'cvr_1', outcome: 'covered', policySnapshotId: 'psn_1', checks: [] });
  const r = await app.triage().runTriage(ID);
  assert.ok(r.fraud.indicators.some((i) => i.code === 'LOSS_NEAR_INCEPTION'));
});

test('GET/POST /claims/{id}/triage follow openapi x-roles', async () => {
  putClaim('alpha', { id: ID });
  const url = `/api/v1/claims/${ID}/triage`;
  const adj = app.token(['adjuster']); const csr = app.token(['csr']); const aud = app.token(['claimant']);
  assert.equal((await call(app, 'GET', url, { token: adj })).status, 404);
  assert.equal((await call(app, 'POST', url, {})).status, 401);
  assert.equal((await call(app, 'POST', url, { token: csr })).status, 403);
  assert.equal((await call(app, 'POST', url, { token: aud })).status, 403);
  const post = await call(app, 'POST', url, { token: adj, body: {} });
  assert.equal(post.status, 200);
  assert.deepEqual(triageErrors(post.json), []);
  const again = await call(app, 'POST', url, { token: app.token(['supervisor']), body: { force: true } });
  assert.equal(again.json.attempt, 2);
  assert.equal((await call(app, 'GET', url, { token: aud })).status, 403);
  for (const t of [csr, adj]) assert.equal((await call(app, 'GET', url, { token: t })).json.attempt, 2);
  const hist = await call(app, 'GET', `${url}?history=true`, { token: csr });
  assert.deepEqual(hist.json.items.map((i) => i.attempt), [1, 2]);
  assert.equal((await call(app, 'GET', url, { token: app.token(['adjuster'], 'beta') })).status, 404);
  assert.equal((await call(app, 'POST', `/api/v1/claims/clm_nope/triage`, { token: adj, body: {} })).status, 404);
  state.claims.get(`alpha:${ID}`).claim.status = 'closed';
  assert.equal((await call(app, 'POST', url, { token: adj, body: { force: true } })).status, 409);
});
