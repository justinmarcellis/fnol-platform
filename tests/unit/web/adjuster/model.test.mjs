import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../../../src/web/adjuster/model.js';
import { fakeInbox } from './fixtures.mjs';

const NOW = Date.parse('2026-09-16T10:30:00.000Z');

test('timerUrgency colours by urgency', () => {
  assert.equal(M.timerUrgency({ status: 'breached', dueAt: '2026-09-16T08:00:00.000Z' }, NOW).tone, 'danger');
  assert.equal(M.timerUrgency({ status: 'running', dueAt: '2026-09-16T12:00:00.000Z' }, NOW).tone, 'warning');
  assert.equal(M.timerUrgency({ status: 'running', dueAt: '2026-09-17T06:00:00.000Z' }, NOW).tone, 'info');
  assert.equal(M.timerUrgency({ status: 'running', dueAt: '2026-09-25T06:00:00.000Z' }, NOW).tone, 'neutral');
  assert.equal(M.timerUrgency({ status: 'met' }, NOW).tone, 'success');
  assert.equal(M.timerUrgency(undefined, NOW).state, 'none');
});

test('inboxRow builds sortable fields and falls back to reportedAt for assigned', () => {
  const [a, b] = M.inboxRows(fakeInbox().items, { now: NOW, insureds: { c2: 'Avery Stone' } });
  assert.equal(a.severityBand, 'severe');
  assert.equal(a.timerState, 'overdue');
  assert.equal(a.assignedApprox, false);
  assert.equal(b.insured, 'Avery Stone');
  assert.equal(b.assignedApprox, true);
  const none = M.inboxRow({ claimId: 'x' }, { now: NOW });
  assert.ok(Number.isFinite(none.timerMs));
  assert.equal(none.severityScore, null);
});

test('KPI counts: open, due today, overdue, fast-tracked', () => {
  const rows = M.inboxRows(fakeInbox().items, { now: NOW });
  const k = M.inboxKpis(rows, NOW);
  assert.equal(k.open, 3);
  assert.equal(k.overdue, 1);
  assert.equal(k.fastTracked, 1);
  assert.ok(k.dueToday >= 0);
  assert.deepEqual(M.inboxKpis([], NOW), { open: 0, dueToday: 0, overdue: 0, fastTracked: 0 });
});

test('filters by status and severity', () => {
  const rows = M.inboxRows(fakeInbox().items, { now: NOW });
  assert.equal(M.filterRows(rows, {}).length, 4);
  assert.deepEqual(M.filterRows(rows, { status: 'closed' }).map((r) => r.claimId), ['c4']);
  assert.deepEqual(M.filterRows(rows, { severity: 'severe' }).map((r) => r.claimId), ['c1', 'c4']);
  assert.equal(M.filterRows(rows, { status: 'closed', severity: 'minor' }).length, 0);
  assert.deepEqual(M.statusOptions(rows), ['assigned', 'fast_tracked', 'closed']);
});

test('insuredName prefers the insured role, then policy party, then organisation', () => {
  assert.equal(M.insuredName({ parties: [{ roles: ['third_party'], firstName: 'A', lastName: 'B' }, { roles: ['insured'], firstName: 'Cy', lastName: 'Dee' }] }), 'Cy Dee');
  assert.equal(M.insuredName({ parties: [{ roles: ['reporter'], organizationName: 'Acme' }] }), 'Acme');
  assert.equal(M.insuredName({}), '');
});
