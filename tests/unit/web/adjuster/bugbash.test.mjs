// Regression tests for S6-BUG-03 (adjuster workbench bug bash, round 1): client render and view-model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerStrings, setLocale } from '../../../../src/web/shared/i18n.js';
import { registerAdjusterStrings } from '../../../../src/web/adjuster/strings.js';
import * as R from '../../../../src/web/adjuster/render.js';
import * as M from '../../../../src/web/adjuster/model.js';
import { submitDecision, changeStatus, updateTask, requestInfo, overrideRouting, loadDirectory } from '../../../../src/web/adjuster/actions.js';
import { fakeView } from './fixtures.mjs';

registerAdjusterStrings(registerStrings);
setLocale('en');
const NOW = Date.parse('2026-09-16T10:30:00.000Z');
const PROV = { provider: 'local', model: 'local-rules-v1', confidence: 0.9, tier: 0 };
const DIR = {
  people: { 'adj-aur-301': 'Jordan Reyes', 'dev-aurelia-mutual-adjuster': 'Jordan Reyes', 'adj-aur-302': 'Sasha Merriweather' },
  queues: [{ id: 'property', label: { en: 'Property', es: 'Propiedad' }, adjusters: ['adj-aur-301', 'adj-aur-302'] }],
  rules: { 'RT-HOME-DEFAULT': 'Home default queue' },
};

/** The Aurelia water claim the audit used (AUR-2026-000005), synthetic. */
function waterView(over = {}) {
  const base = fakeView();
  return {
    ...base,
    claim: {
      ...base.claim, status: 'in_review', lob: 'homeowners', flags: [], vehicles: [], policyNumber: 'HO-WI-4887253',
      lossEvent: { lossDate: '2026-05-25', lossTime: '14:36', lossTimeZone: 'America/Chicago', cause: 'water_plumbing', description: 'The supply line under the kitchen sink burst.', policeReport: { filed: false } },
      properties: [{ role: 'insured_location', policyLocationId: 'loc-1', dwellingType: 'condo', habitable: true, occupied: true, damagedAreas: ['kitchen'], damageDescription: 'Cabinet base wet', mitigationStarted: true }],
    },
    policy: {
      policyNumber: 'HO-WI-4887253', lob: 'homeowners', status: 'in_force', period: { effectiveDate: '2026-01-04', expirationDate: '2027-01-04' }, ratingState: 'WI',
      namedInsureds: [{ name: 'Casey Everhart', relation: 'named_insured' }],
      coverages: [
        { code: 'DWELLING', description: 'Coverage A - Dwelling', limit: { amount: 260000, currency: 'USD' }, deductible: { amount: 1000, currency: 'USD' }, excludedPerils: ['flood'] },
        { code: 'PERSONAL_LIABILITY', description: 'Coverage E', limitPerOccurrence: { amount: 300000, currency: 'USD' } },
      ],
      endorsements: [{ code: 'HO-WTR', description: 'Water backup (sump) endorsement, 5000' }],
      properties: [{ locationId: 'loc-1', dwellingType: 'condo', coverages: [{ code: 'DWELLING', limit: { amount: 260000, currency: 'USD' } }] }],
    },
    coverage: {
      outcome: 'covered', matchedCoverages: ['DWELLING'], applicableDeductible: { amount: 1000, currency: 'USD' },
      checks: [
        { code: 'policy_found', passed: true }, { code: 'loss_in_period', passed: true, detail: '2026-01-04 to 2027-01-04' },
        { code: 'in_force', passed: true, detail: 'policy status in_force' }, { code: 'location_on_policy', passed: true, detail: '1 of 1 locations matched' },
        { code: 'coverage_present', passed: true, detail: 'DWELLING or OTHER_STRUCTURES or PERSONAL_PROPERTY' }, { code: 'peril_covered', passed: true, detail: 'water_plumbing' },
      ],
      reasons: ['covered_under: DWELLING, OTHER_STRUCTURES, PERSONAL_PROPERTY'],
    },
    triage: { severityScore: 30, severityBand: 'moderate', complexity: 'low', fraud: { score: 15, indicators: [{ code: 'LATE_REPORT', reason: 'Reported late.' }], referToSiu: false }, subrogation: { flag: false, reasons: [] }, explanation: 'x', ai: PROV },
    routing: { outcome: 'assigned', queue: 'property', adjusterId: 'adj-aur-301', fastTrack: false, ruleIds: ['RT-HOME-DEFAULT'], reasons: ['RT-HOME-DEFAULT: route to property'], decidedAt: '2026-09-16T10:00:00.000Z' },
    notes: [
      { id: 'n2', category: 'fraud', body: '[decision:dismissed] QE audit: reviewed', author: { type: 'user', id: 'adj-aur-301' }, createdAt: '2026-09-16T11:00:00.000Z' },
      { id: 'n1', category: 'general', body: 'Reviewed the first notice.', author: { type: 'user', id: 'dev-aurelia-mutual-adjuster' }, createdAt: '2026-09-16T10:00:00.000Z' },
    ],
    tasks: [{ id: 'tsk_1', type: 'request_document', title: 'Request repair estimate or photos', status: 'open' }, { id: 'tsk_2', type: 'other', title: 'Acknowledge', status: 'done' }],
    summary: { text: 'A water plumbing loss occurred.\nFacts used: lossCause=water_plumbing', citedFacts: [{ name: 'lossCause', value: 'water_plumbing' }], ai: PROV, explanation: 'Templated.', unconfirmed: true, unconfirmedReason: 'carrier_policy' },
    nextActions: [{ code: 'REVIEW_CLAIM', label: 'Review claim details', priority: 'low', aiPriority: 4, source: 'ai', ai: PROV }],
    timeline: [
      { at: '2026-09-16T10:00:00.000Z', type: 'claim.status.changed', label: 'Status changed: assigned to in_review', params: { from: 'assigned', to: 'in_review' } },
      { at: '2026-09-16T10:00:00.000Z', type: 'claim.routed', label: 'Routed to property (Jordan Reyes)', params: { queue: 'property', adjusterId: 'adj-aur-301', adjusterName: 'Jordan Reyes' } },
    ],
    ...over,
  };
}

test('ADJUSTER-1: a supervisor lands on all claims, an adjuster on their own', () => {
  assert.equal(M.defaultScope('supervisor'), 'all');
  assert.equal(M.defaultScope('adjuster'), 'mine');
});

test('ADJUSTER-4: AI priority 1 is high, 4 is low', () => {
  assert.equal(R.priorityOf(1), 'high');
  assert.equal(R.priorityOf(2), 'medium');
  assert.equal(R.priorityOf(4), 'low');
  assert.equal(R.priorityOf(80), 'high');
});

test('ADJUSTER-3: AI actions with provenance are shown, none hidden', () => {
  const html = R.nbaPanel(waterView());
  assert.match(html, /Review claim details/);
  assert.match(html, /AI suggestion/);
  assert.ok(!html.includes('nba-hidden'));
});

test('ADJUSTER-5: no contradictory threshold note next to a high confidence chip', () => {
  const html = R.summaryPanel(waterView());
  assert.match(html, /Confidence 90%/);
  assert.match(html, /Carrier policy requires a person to confirm/);
  assert.ok(!/confidence threshold/i.test(html));
  assert.match(html, /Cause: Water \(plumbing\)/);
  assert.ok(!html.includes('water_plumbing'));
  assert.match(R.summaryPanel(waterView({ summary: { ...waterView().summary, unconfirmedReason: 'budget' } })), /budget/);
});

test('ADJUSTER-6: the policy panel shows term, named insured, coverages, limits, deductibles and endorsements', () => {
  const html = R.policyPanel(waterView());
  assert.match(html, /Jan 4, 2026 to Jan 4, 2027/);
  assert.match(html, /Casey Everhart/);
  assert.match(html, /Dwelling/);
  assert.match(html, /\$260,000/);
  assert.match(html, /\$1,000/);
  assert.match(html, /\$300,000 per occurrence/);
  assert.match(html, /HO-WTR/);
  assert.match(html, /Applies to this loss/);
  assert.match(html, /Excludes: Flood/);
  assert.match(html, /In force/);
  assert.ok(!html.includes('in_force'));
  assert.match(R.claimViewHtml(waterView(), { now: NOW, dir: DIR }), /id="panel-policy"/);
  assert.match(R.policyPanel(waterView({ policy: undefined })), /No policy snapshot/);
});

test('ADJUSTER-7: loss details show the narrative, loss time, police report and property damage', () => {
  const html = R.lossPanel(waterView());
  assert.match(html, /supply line under the kitchen sink/);
  assert.match(html, /14:36/);
  assert.match(html, /Not filed/);
  assert.match(html, /Kitchen/);
  assert.match(html, /Condominium/);
  const theft = waterView({ claim: { ...waterView().claim, lossEvent: { cause: 'theft', policeReport: { filed: true, agency: 'Riverbend Police Department (fictional)', reportNumber: 'RB-26033004' } } } });
  const t2 = R.lossPanel(theft);
  assert.match(t2, /Riverbend Police Department \(fictional\)/);
  assert.match(t2, /RB-26033004/);
});

test('ADJUSTER-8: no raw codes or ids on the claim view', () => {
  const html = R.claimViewHtml(waterView(), { now: NOW, dir: DIR });
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const raw of ['in_force', 'water_plumbing', 'DWELLING or', 'covered_under', 'adj-aur-301', 'RT-HOME-DEFAULT', 'Tier 0', 'dev-aurelia', '[decision:', 'LATE REPORT', 'passed', 'route to property']) {
    assert.ok(!text.includes(raw), `raw token "${raw}" is shown`);
  }
  assert.match(text, /Policy in force/);
  assert.match(text, /Status: In force/);
  assert.match(text, /Dwelling \/|Dwelling or Other structures or Personal property/);
  assert.match(text, /Covered under: Dwelling, Other structures, Personal property/);
  assert.match(html, /label="Passed"/);
  assert.match(text, /Jordan Reyes/);
  assert.match(text, /Home default queue/);
  assert.match(text, /On-platform rules/);
  assert.match(text, /Late report/);
  assert.match(text, /Route to Property/);
});

test('ADJUSTER-9: timeline titles are readable and keep publication order on equal timestamps', () => {
  const ev = R.timelineEvents(waterView(), DIR);
  assert.equal(ev[0].title, 'Status changed from Assigned to In review');
  assert.equal(ev[1].title, 'Routed to Property, assigned to Jordan Reyes');
  const html = R.timelinePanel(waterView(), { dir: DIR });
  const json = JSON.parse(/data-events="([^"]*)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  assert.equal(json[0].title, 'Routed to Property, assigned to Jordan Reyes', 'newest (last published) first');
});

test('ADJUSTER-10: fast-tracked KPI counts the routing outcome, not the status', () => {
  const rows = M.inboxRows([
    { claimId: 'a', status: 'in_review', fastTrack: true, routingOutcome: 'fast_tracked' },
    { claimId: 'b', status: 'in_review', fastTrack: false },
  ], { now: NOW });
  assert.equal(M.inboxKpis(rows, NOW).fastTracked, 1);
});

test('ADJUSTER-13: the inbox row uses the feed insuredName and assignedAt', () => {
  const r = M.inboxRow({ claimId: 'a', insuredName: 'Zed Fictional', assignedAt: '2026-09-16T10:00:00.000Z', reportedAt: '2026-09-15T10:00:00.000Z' }, { now: NOW });
  assert.equal(r.insured, 'Zed Fictional');
  assert.equal(r.assignedApprox, false);
  assert.equal(r.assignedAt, '2026-09-16T10:00:00.000Z');
});

test('ADJUSTER-14: tasks, status and information requests are actionable; supervisors can override routing', () => {
  const v = waterView();
  const tasks = R.tasksPanel(v);
  assert.match(tasks, /data-task-id="tsk_1" data-task-status="in_progress"/);
  assert.match(tasks, /data-task-id="tsk_1" data-task-status="done"/);
  assert.ok(!tasks.includes('data-task-id="tsk_2"'), 'done tasks have no buttons');
  assert.deepEqual(R.statusMoves('in_review', 'adjuster'), ['pending_info', 'closed']);
  assert.deepEqual(R.statusMoves('pending_info', 'adjuster'), ['in_review']);
  assert.deepEqual(R.statusMoves('closed', 'adjuster'), []);
  assert.deepEqual(R.statusMoves('closed', 'supervisor'), ['in_review']);
  const actions = R.actionsPanel(v, { role: 'adjuster' });
  assert.match(actions, /data-status-to="pending_info"/);
  assert.match(actions, /id="close-form"/);
  assert.match(actions, /id="request-form"/);
  assert.match(actions, /moves to Pending info/);
  const assigned = waterView({ claim: { ...v.claim, status: 'assigned' } });
  assert.match(R.routingPanel(assigned, { dir: DIR, role: 'supervisor' }), /id="override-form"/);
  assert.ok(!R.routingPanel(assigned, { dir: DIR, role: 'adjuster' }).includes('override-form'));
  assert.match(R.routingPanel(v, { dir: DIR, role: 'supervisor' }), /id="override-unavailable"/);
  assert.equal(R.actionTarget('REQUEST_POLICE_REPORT'), 'request-form');
});

test('ADJUSTER-14: action requests hit the claims and routing endpoints', async () => {
  const calls = [];
  const api = {
    get: async (p) => { calls.push(['GET', p]); return { people: { a: 'A' } }; },
    post: async (p, b) => { calls.push(['POST', p, b]); return { id: 'x' }; },
    patch: async (p, b) => { calls.push(['PATCH', p, b]); return { id: 'x' }; },
  };
  await changeStatus(api, 'c1', { to: 'closed', closeReason: 'paid' });
  await updateTask(api, 'c1', 't1', 'done');
  const r = await requestInfo(api, 'c1', { body: 'Information requested: Police report.', status: 'in_review' });
  await overrideRouting(api, 'c1', { queue: 'property', adjusterId: 'adj-2', reason: ' workload ' });
  assert.equal(r.moved, true);
  assert.deepEqual(calls[0], ['POST', '/claims/c1/status', { to: 'closed', closeReason: 'paid' }]);
  assert.deepEqual(calls[1], ['PATCH', '/claims/c1/tasks/t1', { status: 'done' }]);
  assert.deepEqual(calls[2][2], { body: 'Information requested: Police report.', category: 'contact', visibility: 'shared_with_claimant' });
  assert.deepEqual(calls[3], ['POST', '/claims/c1/status', { to: 'pending_info', reason: 'awaiting information from the claimant' }]);
  assert.deepEqual(calls[4], ['POST', '/claims/c1/routing', { override: { reason: 'workload', queue: 'property', adjusterId: 'adj-2' } }]);
  assert.deepEqual((await loadDirectory(api)).people, { a: 'A' });
  assert.deepEqual(await loadDirectory({ get: async () => { throw new Error('x'); } }), { people: {}, queues: [], rules: {} });
  assert.equal(typeof submitDecision, 'function');
});

test('ADJUSTER-15: low-score fraud needs no decision; closed claims are read-only', () => {
  const v = waterView({ notes: [] });
  const triage = R.triagePanel(v);
  assert.ok(!triage.includes('class="decision"'));
  assert.match(triage, /no decision needed/);
  const closed = waterView({ notes: [], claim: { ...v.claim, status: 'closed' }, triage: { ...v.triage, fraud: { score: 80, referToSiu: true, indicators: [] }, subrogation: { flag: true, reasons: [] } } });
  const html = R.claimViewHtml(closed, { now: NOW, dir: DIR });
  assert.ok(!html.includes('class="decision"'));
  assert.ok(!html.includes('data-task-status'));
  assert.ok(!html.includes('id="request-form"'));
  assert.match(html, /This claim is closed/);
});

test('ADJUSTER-16: decision notes read "Fraud decision: Dismissed." with the author name', () => {
  const html = R.notesPanel(waterView(), { dir: DIR });
  assert.match(html, /Fraud decision: Dismissed\. QE audit: reviewed/);
  assert.ok(!html.includes('[decision:'));
  assert.match(html, /Jordan Reyes/);
  assert.ok(!html.includes('adj-aur-301') && !html.includes('dev-aurelia'));
});

test('ADJUSTER-17: the note form has an inline error slot tied to the textarea', () => {
  const html = R.notesPanel(waterView());
  assert.match(html, /aria-describedby="note-err"/);
  assert.match(html, /<p class="err" id="note-err" role="alert" hidden><\/p>/);
});

test('ADJUSTER-21: Spanish locale translates codes, coverage checks, routing and the timeline', () => {
  setLocale('es');
  try {
    const html = R.claimViewHtml(waterView(), { now: NOW, dir: DIR });
    const text = html.replace(/<[^>]+>/g, ' ');
    for (const en of ['Policy found', 'Loss within the policy term', 'Status changed', 'Route to', 'Covered under', 'Late report', 'label="Passed"']) assert.ok(!(text + html).includes(en), `"${en}" left in English`);
    assert.match(text, /Póliza encontrada/);
    assert.match(text, /Enviar a Propiedad/);
    assert.match(text, /Reporte tardío/);
    assert.match(text, /Agua \(fontanería\)/);
    assert.match(R.timelineEvents(waterView(), DIR)[0].title, /Estado cambiado de Asignado a En revisión/);
    assert.match(html, /id="summary-text" class="adj-summary-text" lang="en"/, 'English AI text is marked as English');
    const nba = R.nbaPanel(waterView({ nextActions: [{ code: 'contact_injured_party', label: 'Contact injured party', reason: 'Injury reported at first notice', priority: 'high', source: 'rule' }, { code: 'timer_contact_due', label: 'Complete contact step', priority: 'high', source: 'rule' }] }));
    assert.match(nba, /Contactar a la parte lesionada/);
    assert.match(nba, /Se reportaron lesiones/);
    assert.match(nba, /Completar el paso de Contactar/);
  } finally { setLocale('en'); }
});
