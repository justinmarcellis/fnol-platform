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
  const html = R.inboxHtml(fakeInbox().items, NOW);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('severity bands and chip text carry meaning', () => {
  assert.equal(R.severityBand(10), 'minor');
  assert.equal(R.severityBand(25), 'moderate');
  assert.equal(R.severityBand(50), 'major');
  assert.equal(R.severityBand(75), 'severe');
  assert.equal(R.severityBand(undefined), null);
  assert.match(R.severityChip(80), /Severity 80 \(severe\)/);
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

test('timer chip text', () => {
  assert.match(R.timerChip({ kind: 'acknowledge', status: 'breached', dueAt: '2026-09-16T08:00:00.000Z' }, NOW), /Acknowledge: overdue by 2h 30m/);
  assert.match(R.timerChip({ kind: 'contact', status: 'running', dueAt: '2026-09-18T10:30:00.000Z' }, NOW), /Contact: 2d 0h left/);
  assert.match(R.timerChip(undefined), /No timer/);
});

test('inbox shows severity, flag and timer chips with links', () => {
  const html = R.inboxHtml(fakeInbox().items, NOW);
  assert.match(html, /data-chip="severity"/);
  assert.match(html, /data-flag="siu"/);
  assert.match(html, />SIU</);
  assert.match(html, /data-flag="weird_flag"/);
  assert.match(html, /data-chip="timer"/);
  assert.match(html, /href="#\/claim\/c1"/);
  assert.match(R.inboxHtml([]), /No claims in your inbox/);
});

test('sortInbox: earliest timer first, then severity', () => {
  const ids = R.sortInbox(fakeInbox().items).map((r) => r.claimId);
  assert.deepEqual(ids, ['c1', 'c2', 'c3']);
});

test('claim view has every panel', () => {
  const html = R.claimViewHtml(fakeView(), { now: NOW });
  for (const id of ['summary', 'nba', 'triage', 'coverage', 'routing', 'timers', 'documents', 'tasks', 'notes', 'timeline']) {
    assert.match(html, new RegExp(`id="panel-${id}"`), id);
  }
  assert.match(html, /Claim ALP-26-000001/);
});

test('AI summary shows text, provenance and explanation', () => {
  const html = R.summaryPanel(fakeView());
  assert.match(html, /Two-car collision/);
  assert.match(html, /Why this summary/);
  assert.match(html, /local-rules-v1/);
  assert.match(html, /Confidence 82%/);
  assert.match(html, /Injury and late report raised severity/);
  const low = R.summaryPanel(fakeView({ summary: { text: 'x', ai: { provider: 'local', model: 'm', confidence: 0.4 } } }));
  assert.match(low, /Low confidence/);
  assert.match(R.summaryPanel(fakeView({ summary: undefined })), /No summary has been generated/);
});

test('triage escapes reasons and offers decisions for fraud and subrogation', () => {
  const html = R.triagePanel(fakeView());
  assert.ok(!html.includes('<b>x</b>'));
  assert.match(html, /form class="decision" data-kind="fraud"/);
  assert.match(html, /form class="decision" data-kind="subrogation"/);
  assert.match(html, /data-action="accepted"/);
  assert.match(html, /data-action="dismissed"/);
  assert.match(html, /Why this triage/);
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

test('NBA checklist reflects ticked codes and progress', () => {
  const html = R.nbaPanel(fakeView(), ['refer_siu']);
  assert.match(html, /1 of 3 done/);
  assert.match(html, /data-code="refer_siu" checked/);
  assert.ok(!/data-code="ai_extra" checked/.test(html));
  assert.match(html, /<label for="nba-0">Review SIU referral/);
  assert.match(R.nbaPanel(fakeView({ nextActions: [] })), /No suggested actions/);
});

test('routing, coverage, timers, evidence panels', () => {
  assert.match(R.routingPanel(fakeView()), /siu/);
  assert.match(R.routingPanel(fakeView()), /r-siu/);
  assert.match(R.routingPanel(fakeView({ routing: undefined })), /has not been routed/);
  assert.match(R.coveragePanel(fakeView()), /Partially covered/);
  assert.match(R.coveragePanel(fakeView()), /driver_listed: failed/);
  assert.match(R.timersPanel(fakeView(), NOW), /Synthetic reg 1/);
  assert.match(R.timersPanel(fakeView({ timers: [] }), NOW), /No regulatory timers/);
  assert.match(R.documentsPanel(fakeView()), /needs review/);
});

test('es locale renders translated panels', () => {
  setLocale('es');
  try {
    assert.match(R.nbaPanel(fakeView()), /Siguientes mejores acciones/);
    assert.equal(t('adj.panel.summary'), 'Resumen de IA');
  } finally { setLocale('en'); }
});
