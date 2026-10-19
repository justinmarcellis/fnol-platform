import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerStrings, setLocale, t } from '../../../../src/web/shared/i18n.js';
import { registerAdjusterStrings, adjusterStrings } from '../../../../src/web/adjuster/strings.js';
import * as R from '../../../../src/web/adjuster/render.js';
import { fakeView, fakeInbox } from './fixtures.mjs';

registerAdjusterStrings(registerStrings);
setLocale('en');
const NOW = Date.parse('2026-09-16T10:30:00.000Z');

test('strings: en and es have identical keys', () => {
  assert.deepEqual(Object.keys(adjusterStrings.es).sort(), Object.keys(adjusterStrings.en).sort());
});

test('esc escapes markup in every dynamic value', () => {
  assert.equal(R.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.ok(!R.badge('<script>x</script>').includes('<script>'));
  assert.ok(R.badge('<script>x</script>').includes('&lt;script&gt;'));
});

test('severity bands and badge text carry meaning', () => {
  assert.equal(R.severityBand(10), 'minor');
  assert.equal(R.severityBand(25), 'moderate');
  assert.equal(R.severityBand(50), 'major');
  assert.equal(R.severityBand(75), 'severe');
  assert.equal(R.severityBand(undefined), null);
  assert.match(R.severityChip(80), /label="Severe · 80"/);
  assert.match(R.severityChip(undefined), /not scored/);
});

test('timerState: overdue, due soon, running, met', () => {
  assert.equal(R.timerState({ status: 'breached', dueAt: '2026-09-16T08:00:00.000Z' }, NOW).state, 'overdue');
  assert.equal(R.timerState({ status: 'running', dueAt: '2026-09-16T08:00:00.000Z' }, NOW).state, 'overdue');
  assert.equal(R.timerState({ status: 'due_soon', dueAt: '2026-09-16T12:00:00.000Z' }, NOW).state, 'due_soon');
  assert.equal(R.timerState({ status: 'running', dueAt: '2026-09-20T12:00:00.000Z' }, NOW).state, 'running');
  assert.equal(R.timerState({ status: 'met', dueAt: 'x' }, NOW).state, 'met');
  assert.equal(R.timerState(undefined, NOW).state, 'none');
  assert.equal(R.formatDuration(90 * 60000), '1h 30m');
  assert.equal(R.formatDuration(26 * 3600000), '1d 2h');
});

test('timer badge text and urgency tone', () => {
  const over = R.timerChip({ kind: 'acknowledge', status: 'breached', dueAt: '2026-09-16T08:00:00.000Z' }, NOW);
  assert.match(over, /label="Acknowledge: overdue by 2h 30m"/);
  assert.match(over, /tone="danger"/);
  assert.match(R.timerChip({ kind: 'contact', status: 'running', dueAt: '2026-09-18T10:30:00.000Z' }, NOW), /label="Contact: 2d 0h left"/);
  assert.match(R.timerChip({ kind: 'contact', status: 'running', dueAt: '2026-09-16T12:00:00.000Z' }, NOW), /tone="warning"/);
  assert.match(R.timerChip(undefined), /No timer/);
});

test('claim view has every panel, header facts and no raw tokens', () => {
  const html = R.claimViewHtml(fakeView(), { now: NOW });
  for (const id of ['header', 'summary', 'nba', 'triage', 'coverage', 'routing', 'timers', 'parties', 'vehicles', 'documents', 'tasks', 'notes', 'timeline']) {
    assert.match(html, new RegExp(`id="panel-${id}"`), id);
  }
  assert.match(html, /Elm St and 3rd Ave/);
  assert.match(html, /Personal auto/);
  assert.match(html, /data-chip="status"/);
  assert.ok(!html.includes('personal_auto'));
  assert.match(R.claimHeading(fakeView()), /Claim ALP-26-000001/);
});

test('sortInbox: earliest timer first, then severity', () => {
  assert.deepEqual(R.sortInbox(fakeInbox().items).map((r) => r.claimId), ['c1', 'c4', 'c2', 'c3']);
});

test('subrogation flag shows a banner only when present', () => {
  assert.match(R.claimViewHtml(fakeView(), { now: NOW }), /id="subro-banner"/);
  const none = fakeView({ claim: { ...fakeView().claim, flags: [] }, triage: { ...fakeView().triage, subrogation: { flag: false, reasons: [] } } });
  assert.ok(!R.claimViewHtml(none, { now: NOW }).includes('subro-banner'));
});

test('AI summary always shows provider, model, confidence and explanation', () => {
  const html = R.summaryPanel(fakeView());
  assert.match(html, /Two-car collision/);
  assert.ok(!/<details/.test(html), 'provenance is never collapsed');
  assert.match(html, /local-rules-v1/);
  assert.match(html, /Provider/);
  assert.match(html, /Confidence 82%/);
  assert.match(html, /Built from claim facts/);
  assert.match(html, /Facts used: lossCause=collision/);
  assert.match(R.summaryPanel(fakeView({ summary: { text: 'x', ai: { provider: 'local', model: 'm', confidence: 0.4 } } })), /Low confidence/);
  assert.match(R.summaryPanel(fakeView({ summary: undefined })), /No summary has been generated/);
});

test('AI summary without provenance is withheld', () => {
  const html = R.summaryPanel(fakeView({ summary: { text: 'Secret AI text', ai: { provider: 'local' } } }));
  assert.ok(!html.includes('Secret AI text'));
  assert.match(html, /not shown/);
});

test('parties and vehicles cards escape values and show flags', () => {
  const p = R.partiesPanel(fakeView());
  assert.match(p, /Avery Stone/);
  assert.ok(!p.includes('<b>'));
  assert.match(p, /Injured/);
  assert.match(p, /At fault/);
  const v = R.vehiclesPanel(fakeView());
  assert.match(v, /2019 Ford Focus/);
  assert.match(v, /Not drivable/);
  assert.match(R.partiesPanel(fakeView({ claim: { ...fakeView().claim, parties: [] } })), /No parties recorded/);
});

test('timeline events are humanised, AI events carry provenance, old ones fold away', () => {
  const ev = R.timelineEvents(fakeView());
  assert.equal(ev.length, 2);
  assert.match(ev.find((e) => e.title.startsWith('Triaged')).actor, /local \/ local-rules-v1 · 82% confidence/);
  const many = fakeView({ timeline: Array.from({ length: 20 }, (_, i) => ({ at: `2026-09-16T10:${String(i).padStart(2, '0')}:00.000Z`, type: 'audit.claim.updated', label: 'Audit: claim.updated' })) });
  const html = R.timelinePanel(many);
  assert.match(html, /Show 8 earlier events/);
  assert.match(html, /Audit: Claim updated/);
});

test('triage escapes reasons and offers decisions for fraud and subrogation', () => {
  const html = R.triagePanel(fakeView());
  assert.ok(!html.includes('<b>x</b>'));
  assert.match(html, /form class="decision" data-kind="fraud"/);
  assert.match(html, /form class="decision" data-kind="subrogation"/);
  assert.match(html, /data-action="accepted"/);
  assert.match(html, /data-action="dismissed"/);
  assert.match(html, /Why this triage/);
  assert.match(html, /local-rules-v1/);
  const clean = R.triagePanel(fakeView({ triage: { ...fakeView().triage, fraud: { score: 5, indicators: [] }, subrogation: { flag: false, reasons: [] } } }));
  assert.ok(!clean.includes('class="decision"'));
});

test('decisionState reads the newest decision note and replaces the form', () => {
  const notes = [
    { category: 'fraud', body: '[decision:dismissed] False alarm', author: { id: 'adj-1' }, createdAt: '2026-09-16T11:00:00.000Z' },
    { category: 'fraud', body: '[decision:accepted] Earlier', author: { id: 'adj-1' }, createdAt: '2026-09-16T10:00:00.000Z' },
    { category: 'general', body: '[decision:accepted] wrong category' },
  ];
  assert.equal(R.decisionState(notes, 'fraud').status, 'dismissed');
  assert.equal(R.decisionState(notes, 'subrogation'), null);
  const html = R.triagePanel(fakeView({ notes }));
  assert.match(html, /data-decision="dismissed"/);
  assert.match(html, /Dismissed by adj-1/);
  assert.ok(!html.includes('data-kind="fraud"'));
});

test('buildDecision requires a note and picks the matching open task', () => {
  const tasks = fakeView().tasks;
  assert.deepEqual(R.buildDecision({ kind: 'fraud', action: 'accepted', note: '  ', tasks }), { ok: false, error: 'noteRequired' });
  assert.equal(R.buildDecision({ kind: 'bogus', action: 'accepted', note: 'x' }).ok, false);
  const a = R.buildDecision({ kind: 'fraud', action: 'accepted', note: 'Looks real', tasks });
  assert.equal(a.note.body, '[decision:accepted] Looks real');
  assert.equal(a.note.category, 'fraud');
  assert.deepEqual(a.taskPatch, { taskId: 'tsk1', status: 'in_progress' });
  const d = R.buildDecision({ kind: 'subrogation', action: 'dismissed', note: 'No recovery', tasks });
  assert.deepEqual(d.taskPatch, { taskId: 'tsk2', status: 'cancelled' });
  assert.equal(R.buildDecision({ kind: 'fraud', action: 'accepted', note: 'x', tasks: [] }).taskPatch, null);
});

test('NBA rows are actionable; AI rows need provenance or are hidden and counted', () => {
  const html = R.nbaPanel(fakeView(), ['refer_siu']);
  assert.match(html, /1 of 3 done/);
  assert.match(html, /data-goto="item-fraud"/);
  assert.match(html, /AI suggestion/);
  assert.ok(!html.includes('Hidden AI action'));
  assert.match(html, /1 AI suggestions hidden/);
  assert.match(html, /data-code="refer_siu" checked/);
  assert.ok(!/data-code="ai_extra" checked/.test(html));
  assert.match(html, /<label for="nba-0">Review SIU referral/);
  assert.match(R.nbaPanel(fakeView({ nextActions: [] })), /No suggested actions/);
});

test('routing, coverage, timers, evidence panels', () => {
  assert.match(R.routingPanel(fakeView()), /Siu/);
  assert.match(R.routingPanel(fakeView()), /r-siu/);
  assert.match(R.routingPanel(fakeView({ routing: undefined })), /has not been routed/);
  assert.match(R.coveragePanel(fakeView()), /status="partial"/);
  assert.match(R.coveragePanel(fakeView()), /Driver listed/);
  assert.match(R.timersPanel(fakeView(), NOW), /Synthetic reg 1/);
  assert.match(R.timersPanel(fakeView({ timers: [] }), NOW), /No regulatory timers/);
  assert.match(R.documentsPanel(fakeView()), /Needs review/i);
});

test('es locale renders translated panels', () => {
  setLocale('es');
  try {
    assert.match(R.nbaPanel(fakeView()), /Siguientes mejores acciones/);
    assert.equal(t('adj.panel.summary'), 'Resumen de IA');
  } finally { setLocale('en'); }
});
