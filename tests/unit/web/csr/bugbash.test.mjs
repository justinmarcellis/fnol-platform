// S6-BUG-02 regression tests (CSR and agent desk bug bash, round 1). Pure modules only; the browser flows are in tests/ui/csr.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPolicySearch, planQuery } from '../../../../src/web/csr/search.js';
import { createAssistedIntake, nextQuestion, CSR_CHANNEL } from '../../../../src/web/csr/assisted.js';
import { createRecent, claimSummary, severityBand, failureMessage, descriptionSummary, insuredName } from '../../../../src/web/csr/recent.js';
import { contextModel, VEHICLES_OPEN_MAX } from '../../../../src/web/csr/desk.js';
import { fieldRules, coerceAnswer, isMultiSelect } from '../../../../src/web/csr/answers.js';
import { deskRole, deskAccess, channelFor, roleKeys, policyExamples, tokenRoles, AGENT_CHANNEL } from '../../../../src/web/csr/roles.js';
import { csrStrings, makeT } from '../../../../src/web/csr/strings.js';
import { fakeApi, FakeApiError, step, q } from './helpers.mjs';

const t = makeT('en');
const fmt = { date: (v) => `D(${v})`, money: (m) => `$${m?.amount ?? m}`, enum: (v) => `E(${v})` };
const dir = new URL('../../../../src/web/csr/', import.meta.url);
const AURELIA_LOBS = [
  { id: 'personal_auto', enabled: true, states: ['WI', 'IL'], channels: ['claimant_web', 'agent_portal', 'csr_phone'] },
  { id: 'homeowners', enabled: true, states: ['WI', 'IL'], channels: ['claimant_web', 'agent_portal', 'csr_phone'] },
];
const KESTREL_LOBS = [
  { id: 'personal_auto', enabled: true, states: ['MI'], channels: ['csr_phone', 'api'] },
  { id: 'commercial_auto', enabled: true, states: ['MI'], channels: ['csr_phone', 'api'] },
];

// ---- CSR-5: search hint and policy-number formats
test('CSR-5: the search hint uses the tenant policy prefixes, never AUT-1000 (en and es)', () => {
  for (const loc of ['en', 'es']) {
    for (const v of Object.values(csrStrings[loc])) assert.doesNotMatch(v, /AUT-1000/, `${loc} string mentions AUT-1000`);
  }
  assert.deepEqual(policyExamples(AURELIA_LOBS), ['PA-WI', 'HO-WI']);
  assert.deepEqual(policyExamples(KESTREL_LOBS), ['PA-MI', 'CA-MI']);
  assert.match(t('csr.search.hint', { examples: policyExamples(KESTREL_LOBS).join(t('csr.search.or')) }), /such as PA-MI or CA-MI\./);
  assert.match(makeT('es')('csr.search.hint', { examples: 'PA-WI o HO-WI' }), /como PA-WI o HO-WI\./);
  assert.deepEqual(policyExamples([]), []);
});

test('CSR-5: a full policy number or two-segment prefix is sent as its leading segment and filtered on the client', async () => {
  assert.deepEqual(planQuery('HO-IL-1030185'), { q: 'HO-', prefix: 'HO-IL-1030185' });
  assert.deepEqual(planQuery('pa-wi'), { q: 'PA-', prefix: 'PA-WI' });
  assert.deepEqual(planQuery('Lockhart'), { q: 'Lockhart', prefix: null });
  assert.deepEqual(planQuery('HO-'), { q: 'HO-', prefix: null });
  const api = fakeApi({ 'GET /policies': { items: [{ policyNumber: 'HO-IL-1030185' }, { policyNumber: 'HO-WI-2000001' }, { policyNumber: 'HO-IL-5651203' }], matchedOn: 'policyNumberPrefix' } });
  const s = createPolicySearch({ api, t });
  await s.search('HO-IL-1030185');
  assert.equal(api.calls[0].body.q, 'HO-');
  assert.deepEqual(s.state.results.map((r) => r.policyNumber), ['HO-IL-1030185']);
  await s.search('ho-il');
  assert.deepEqual(s.state.results.map((r) => r.policyNumber), ['HO-IL-1030185', 'HO-IL-5651203']);
});

test('CSR-5: a one-character search explains the minimum without calling the server', async () => {
  const api = fakeApi({});
  const s = createPolicySearch({ api, t });
  await s.search('A');
  assert.equal(api.calls.length, 0);
  assert.equal(s.state.phase, 'invalid');
  assert.equal(s.state.message, t('csr.search.tooShort'));
});

// ---- CSR-8, CSR-10, CSR-11, DATA-14: agent persona
const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
test('CSR-11/DATA-14: the desk role comes from the persona, then the token; labels read Agent for agents', () => {
  assert.equal(deskRole({ persona: { role: 'agent' } }, null), 'agent');
  assert.equal(deskRole(null, jwt({ roles: ['agent'] })), 'agent');
  assert.equal(deskRole(null, jwt({ roles: ['csr'] })), 'csr');
  assert.equal(deskRole(null, 'not-a-token'), 'csr');
  assert.deepEqual(tokenRoles('x.@@@.y'), []);
  const k = roleKeys('agent');
  assert.equal(t(k.role), 'Agent'); assert.equal(t(k.heading), 'Agent desk'); assert.equal(t(k.title), 'Agent claims desk');
  assert.equal(t(roleKeys('csr').role), 'CSR'); assert.equal(t(roleKeys('csr').heading), 'CSR desk');
  assert.equal(makeT('es')(k.role), 'Agente');
  const app = readFileSync(new URL('app.js', dir), 'utf8');
  assert.doesNotMatch(app, /setAttribute\('user-role', 'csr'\)/, 'the role is not hard-coded');
});

test('DATA-14: agents use agent_portal where the tenant enables it for the line, else csr_phone', async () => {
  assert.equal(channelFor('agent', AURELIA_LOBS, 'personal_auto'), AGENT_CHANNEL);
  assert.equal(channelFor('agent', KESTREL_LOBS, 'personal_auto'), CSR_CHANNEL);
  assert.equal(channelFor('csr', AURELIA_LOBS, 'personal_auto'), CSR_CHANNEL);
  assert.equal(channelFor('agent', [], 'homeowners'), CSR_CHANNEL);
  const api = fakeApi({ 'POST /intake/sessions': step() });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'PA-WI-1', channel: channelFor('agent', AURELIA_LOBS, 'personal_auto') });
  assert.equal(api.calls[0].body.channel, 'agent_portal');
  await f.start({ lob: 'personal_auto', policyNumber: 'PA-WI-1' });
  assert.equal(api.calls[1].body.channel, 'csr_phone', 'default stays csr_phone');
});

test('CSR-8/CSR-10: the desk gates each read on the role (S6-RA-04: the server now allows all of them for agents)', () => {
  assert.deepEqual({ ...deskAccess('agent') }, { policySnapshot: true, policyVehicles: true, recentClaims: true, claimView: true });
  assert.deepEqual({ ...deskAccess('csr') }, { policySnapshot: true, policyVehicles: true, recentClaims: true, claimView: true });
  // Without the snapshot the panel still shows what the search row knows (insured, term, risk description).
  const m = contextModel({ summary: { policyNumber: 'PA-WI-1', lob: 'personal_auto', status: 'in_force', insuredName: 'Sloane Dunmore', description: '2020 Corvane Cruiser', period: { effectiveDate: '2026-01-01', expirationDate: '2027-01-01' } }, snapshot: null }, { t, fmt });
  assert.equal(m.risk, '2020 Corvane Cruiser');
  assert.deepEqual(m.insureds.map((n) => n.name), ['Sloane Dunmore']);
  assert.match(t('csr.ctx.limited.agent'), /agent/i);
  const app = readFileSync(new URL('app.js', dir), 'utf8');
  assert.match(app, /if \(!access\.policySnapshot\)/);
  assert.match(app, /access\.policyVehicles \? await fetchPolicyVehicles/);
  assert.match(app, /if \(access\.recentClaims\) recent\.load\(\)/);
  assert.match(app, /if \(!access\.claimView\) \{ showClaimMessage/);
});

test('CSR-10/CSR-17: a 403 or 404 is a message, never an empty list or a blank claim card', async () => {
  assert.equal(failureMessage('list', { status: 403 }, t), t('csr.recent.forbidden.list'));
  assert.equal(failureMessage('open', { status: 403 }, t), t('csr.recent.forbidden.claim'));
  assert.equal(failureMessage('open', { status: 404 }, t), t('csr.recent.notFound.claim'));
  assert.equal(failureMessage('open', { status: 500 }, t), t('csr.recent.failed.claim'));
  const api = fakeApi({ 'GET /claims': () => { throw new FakeApiError(403, 'role_denied'); }, 'GET /claims/clm_x': () => { throw new FakeApiError(404, 'not_found'); } });
  const r = createRecent({ api, t });
  await r.load();
  assert.equal(r.state.phase, 'failed');
  assert.equal(r.state.message, t('csr.recent.forbidden.list'));
  await r.open('clm_x');
  assert.equal(r.state.kind, 'open');
  assert.equal(r.state.claim, null);
  assert.equal(r.state.message, t('csr.recent.notFound.claim'));
  const html = readFileSync(new URL('index.html', dir), 'utf8');
  assert.match(html, /id="claim-msg"/); assert.match(html, /id="recent-msg"/);
});

// ---- CSR-12: picker only when the question set has a vehicle question
test('CSR-12: the insured-vehicle answer targets the session vehicle question; none is known without one', async () => {
  const withQ = fakeApi({
    'POST /intake/sessions': step({ question: q('loss_date', { type: 'date', order: 10 }), optional: [q('insured_vehicle', { type: 'vehicle', required: false, order: 35 })] }),
    'POST /intake/sessions/s1/answers': (b) => step({ question: q('loss_date', { type: 'date', order: 10 }), echo: b }),
  });
  const a = createAssistedIntake({ api: withQ, t });
  await a.start({ lob: 'personal_auto', policyNumber: 'PA-WI-1' });
  assert.equal(a.state.vehicleQuestionId, 'insured_vehicle');
  await a.setInsuredVehicle({ policyVehicleId: 'veh-1' });
  assert.equal(withQ.calls[1].body.questionId, 'insured_vehicle');
  const commercial = fakeApi({ 'POST /intake/sessions': step({ question: q('loss_date', { type: 'date' }), optional: [q('loss_time', { type: 'time', required: false })] }) });
  const b = createAssistedIntake({ api: commercial, t });
  await b.start({ lob: 'commercial_auto', policyNumber: 'CA-MI-1' });
  assert.equal(b.state.vehicleQuestionId, null, 'no vehicle question: the app does not offer the picker');
  assert.match(readFileSync(new URL('app.js', dir), 'utf8'), /const vq = intake\.state\.vehicleQuestionId;\s*\n\s*pickerVehicles = vq && /);
});

// ---- CSR-13: optional questions
test('CSR-13: optional questions are asked in question-set order and can be skipped or left blank', async () => {
  const opt = [q('loss_time', { type: 'time', required: false, order: 12 }), q('police_report_number', { required: false, order: 42, validation: { maxLength: 40 } })];
  assert.equal(nextQuestion({ question: q('loss_date', { order: 10 }), optional: opt }).id, 'loss_date');
  assert.equal(nextQuestion({ question: q('injuries', { order: 30 }), optional: opt }).id, 'loss_time');
  assert.equal(nextQuestion({ question: q('injuries', { order: 30 }), optional: opt }, { skipped: new Set(['loss_time']) }).id, 'injuries');
  assert.equal(nextQuestion({ question: null, optional: opt }, { external: new Set(['loss_time']) }).id, 'police_report_number');
  assert.equal(nextQuestion({ question: null, optional: [] }), null);

  let answered = [];
  const api = fakeApi({
    'POST /intake/sessions': step({ question: q('injuries', { type: 'boolean', order: 30 }), optional: opt }),
    'POST /intake/sessions/s1/answers': (b) => { answered.push(b.questionId); return step({ done: true, progress: { answered: 1, requiredRemaining: 0 }, question: null, optional: opt.filter((o) => !answered.includes(o.id)) }); },
  });
  const f = createAssistedIntake({ api, t });
  await f.start({ lob: 'personal_auto', policyNumber: 'PA-MI-1' });
  assert.equal(f.state.question.id, 'loss_time', 'an earlier optional question comes first');
  assert.equal(f.state.question.required, false);
  await f.answer('loss_time', '');
  assert.deepEqual(answered, [], 'a blank optional answer is a skip, not a 422');
  assert.equal(f.state.question.id, 'injuries');
  assert.equal(f.skip('injuries'), null, 'a required question cannot be skipped');
  await f.answer('injuries', false);
  assert.equal(f.state.done, true);
  assert.equal(f.state.question.id, 'police_report_number', 'after the required ones, the remaining optional questions are offered');
  await f.answer('police_report_number', 'PR-1');
  assert.deepEqual(answered, ['injuries', 'police_report_number']);
  assert.equal(f.state.question, null);
  assert.equal(f.state.phase, 'ready');
});

test('CSR-13: multi-select answers are arrays; media and text get the server length limit', () => {
  const ms = q('damaged_areas', { type: 'multiselect', options: [{ value: 'kitchen' }, { value: 'roof' }] });
  assert.equal(isMultiSelect(ms), true);
  assert.deepEqual(coerceAnswer(ms, ['kitchen', '', 'roof']), ['kitchen', 'roof']);
  assert.deepEqual(coerceAnswer(ms, 'kitchen'), []);
});

// ---- CSR-15: client-side length check and inline errors
test('CSR-15: free-text fields carry the server maxLength; server errors go inline, not into stacked toasts', () => {
  assert.deepEqual(fieldRules(q('police_report_number', { validation: { maxLength: 40 } })), { maxLength: 40 });
  assert.deepEqual(fieldRules(q('loss_description', { type: 'longtext' })), { maxLength: 8000 });
  assert.deepEqual(fieldRules(q('unit_number')), { maxLength: 500 });
  assert.deepEqual(fieldRules(q('injuries', { type: 'boolean' })), {});
  assert.deepEqual(fieldRules(q('loss_date', { type: 'date' })), {});
  const app = readFileSync(new URL('app.js', dir), 'utf8');
  assert.match(app, /f\.setAttribute\('maxlength', String\(rules\.maxLength\)\)/);
  assert.match(app, /showInlineError\(s\.question, mine\)/);
  assert.doesNotMatch(app, /if \(s\.errors\.length\) toast\(/, 'no toast per 422');
});

// ---- CSR-17: claim view
test('CSR-17: the claim view has a severity scale, loss date, description summary and insured', () => {
  assert.equal(severityBand(10), 'minor'); assert.equal(severityBand(45), 'moderate'); assert.equal(severityBand(50), 'major'); assert.equal(severityBand(80), 'severe');
  assert.equal(severityBand(null), null); assert.equal(severityBand('x'), null);
  const long = 'Kitchen fire spread to the attic. The fire department put it out but the house is not livable. Smoke and water damage throughout the ground floor, the stairs and both bedrooms upstairs.';
  const sum = descriptionSummary(long);
  assert.ok(sum.length <= 161 && sum.endsWith('…'), sum);
  const c = { status: 'assigned', lob: 'homeowners', policyNumber: 'HO-IL-1030185', channel: 'csr_phone', reportedAt: '2026-10-19T10:00:00Z',
    lossEvent: { lossDate: '2026-10-15', description: 'Pipe burst.' }, triage: { severityScore: 10 },
    parties: [{ roles: ['insured', 'reporter'], firstName: 'Riley', lastName: 'Lockhart' }, { roles: ['witness'], lastName: 'Other' }] };
  assert.equal(insuredName(c), 'Riley Lockhart');
  const s = Object.fromEntries(claimSummary(c, t).map((x) => [x.key, x.value]));
  assert.equal(s.severity, '10 of 100 (Minor)');
  assert.equal(s.lossDate, '2026-10-15');
  assert.equal(s.description, 'Pipe burst.');
  assert.equal(s.insured, 'Riley Lockhart');
  assert.equal(claimSummary({}, t).find((x) => x.key === 'severity').value, t('csr.claim.none'));
});

// ---- CSR-18: recent list refreshes until the new claim settles
test('CSR-18: after submit the recent list reloads until the new claim leaves the transient statuses', async () => {
  const statuses = ['validating', 'triaged', 'assigned', 'assigned'];
  let n = 0;
  const api = fakeApi({ 'GET /claims': () => ({ items: [{ id: 'c9', claimNumber: 'AUR-2026-000099', status: statuses[Math.min(n++, 3)] }] }) });
  const r = createRecent({ api, t });
  const waits = [];
  const ok = await r.refreshUntilSettled('c9', { delays: [1, 1, 1, 1], sleep: async (ms) => { waits.push(ms); } });
  assert.equal(ok, true);
  assert.equal(r.state.rows[0].status, 'assigned');
  assert.equal(api.calls.length, 3, 'stops once settled');
  assert.equal(waits.length, 2);
  const stuck = fakeApi({ 'GET /claims': { items: [{ id: 'c1', status: 'validating' }] } });
  const r2 = createRecent({ api: stuck, t });
  assert.equal(await r2.refreshUntilSettled('c1', { delays: [1, 1], sleep: async () => {} }), false);
  assert.equal(stuck.calls.length, 3, 'bounded');
});

// ---- CSR-19 and CSR-20: links and headings
test('CSR-19/CSR-20: claim numbers are links, the footer matches the click behaviour, the confirmation reads Claim submitted', () => {
  const app = readFileSync(new URL('app.js', dir), 'utf8');
  assert.match(app, /claimNumber: \{ \.\.\.c, render: claimNumberLink \}/);
  assert.match(app, /policyNumber: \{ \.\.\.c, render: \(r\) => cell\(formatPolicyNumber\(r\.policyNumber\), 'csr-ref'\) \}/);
  assert.doesNotMatch(t('csr.recent.footer'), /Select a row and press Enter/);
  assert.match(t('csr.recent.footer'), /Click/);
  assert.match(app, /\$\('done-sec'\)\.setAttribute\('heading', t\('csr\.submit\.heading'\)\)/);
  assert.equal(t('csr.submit.heading'), 'Claim submitted');
  assert.equal(makeT('es')('csr.submit.heading'), 'Reclamo enviado');
});

// ---- CSR-21: fleet policies
test('CSR-21: a fleet folds its vehicles and coverages render before them', () => {
  const vehicles = Array.from({ length: 10 }, (_, i) => ({ unitId: `veh-${i + 1}`, year: 2020, make: 'Aldera', model: 'Box', coverages: [{ code: 'COLL' }] }));
  const m = contextModel({ snapshot: { policyNumber: 'CA-MI-1', status: 'in_force', vehicles, coverages: [{ code: 'BI', description: 'Liability' }] } }, { t, fmt });
  assert.equal(m.collapseVehicles, true);
  const two = contextModel({ snapshot: { policyNumber: 'PA-MI-1', status: 'in_force', vehicles: vehicles.slice(0, VEHICLES_OPEN_MAX) } }, { t, fmt });
  assert.equal(two.collapseVehicles, false);
  const app = readFileSync(new URL('app.js', dir), 'utf8');
  assert.ok(app.indexOf("section(t('csr.ctx.coverages'))") < app.indexOf("section(t('csr.ctx.vehicles'))"), 'coverages come first');
  assert.match(app, /el\('details', 'csr-units'\)/);
});
