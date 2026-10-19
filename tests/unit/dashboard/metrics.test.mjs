import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sprintPoints, rollingVelocity, forecast, burn, flowTimes, synapseLatency,
  serialDependencies, cost, quality, targetsStatus, scorecardView, computeMetrics,
} from '../../../dashboard/metrics.mjs';
import { parseTap, writeReport } from '../../../dashboard/quality-report.mjs';
import { renderSnapshotHtml } from '../../../dashboard/export.mjs';
import { start } from '../../../dashboard/server.mjs';

const T = (o) => ({ team: 'a', points: 3, status: 'ready', dependsOn: [], ...o });
const tickets = [
  T({ id: 'A1', sprint: 0, status: 'done', createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T02:00:00Z', doneAt: '2026-01-01T06:00:00Z', spend: { usd: 2 }, review: { firstPass: true, reworkCount: 0, escapedDefects: 0 } }),
  T({ id: 'A2', sprint: 0, status: 'done', points: 5, team: 'b', createdAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T04:00:00Z', doneAt: '2026-01-02T00:00:00Z', spend: { usd: 3 }, review: { firstPass: false, reworkCount: 1, escapedDefects: 1 } }),
  T({ id: 'A3', sprint: 0, status: 'in_progress', dependsOn: ['A1'] }),
  T({ id: 'A4', sprint: 1, status: 'ready', dependsOn: ['A3'], points: 8 }),
];
const sprints = [
  { number: 0, status: 'done', startedAt: '2026-01-01T00:00:00Z', committed: ['A1', 'A2', 'A3'], targets: { committedPoints: 11, firstPassAcceptance: 0.75, budgetUsd: 10 } },
  { number: 1, status: 'active', committed: ['A4'] },
];

test('sprintPoints committed vs completed', () => {
  const p = sprintPoints(tickets, sprints);
  assert.deepEqual([p[0].committed, p[0].completed, p[1].committed, p[1].completed], [11, 8, 8, 0]);
  assert.deepEqual(sprintPoints([], []), []);
});

test('velocity and forecast', () => {
  const v = rollingVelocity(sprintPoints(tickets, sprints));
  assert.equal(v, 8);
  const f = forecast(tickets, v);
  assert.equal(f.backlogPoints, 11);
  assert.equal(f.sprintsRemaining, 2);
  assert.equal(forecast(tickets, 0).sprintsRemaining, null);
  assert.equal(forecast([], 0).sprintsRemaining, 0);
  assert.equal(rollingVelocity([]), 0);
});

test('burndown and burnup', () => {
  const b = burn(sprints[0], tickets);
  assert.deepEqual(b.burndown.map((x) => x.remaining), [11, 8, 3]);
  assert.deepEqual(b.burnup.map((x) => x.completed), [0, 3, 8]);
  assert.deepEqual(burn(null, []), { burndown: [], burnup: [], committed: 0 });
});

test('flow times per team', () => {
  const f = flowTimes(tickets);
  assert.equal(f.perTeam.a.cycleHours, 4);
  assert.equal(f.perTeam.a.leadHours, 6);
  assert.equal(f.perTeam.b.leadHours, 24);
  assert.equal(flowTimes([]).cycleHours, null);
});

test('synapse latency', () => {
  const hubs = { x: [
    { at: '2026-01-01T00:00:00Z', type: 'request', ticket: 'A1' },
    { at: '2026-01-01T00:10:00Z', type: 'status', ticket: 'A1' },
    { at: '2026-01-01T00:30:00Z', type: 'answer', ticket: 'A1' },
    { at: '2026-01-01T01:00:00Z', type: 'request', ticket: 'A2' },
  ] };
  const s = synapseLatency(hubs);
  assert.equal(s.avgMinutes, 30);
  assert.equal(s.unanswered, 1);
  assert.equal(synapseLatency({}).avgMinutes, null);
});

test('serial dependencies', () => {
  assert.deepEqual(serialDependencies(tickets).ids, ['A3', 'A4']);
  assert.equal(serialDependencies([]).count, 0);
});

test('cost', () => {
  const c = cost(tickets, { budget: { totalUsd: 20 } });
  assert.equal(c.totalUsd, 5);
  assert.equal(c.bySprint[0], 5);
  assert.equal(c.byTeam.b, 3);
  assert.equal(c.pointsPerDollar, 1.6);
  assert.equal(c.budgetRemainingUsd, 15);
  assert.equal(cost([], {}).budgetRemainingUsd, null);
});

test('quality', () => {
  const q = quality(tickets, { testsTotal: 10, testsPassed: 9, coveragePct: 80, buildGreen: false, at: 'x' });
  assert.equal(q.testPassRate, 0.9);
  assert.equal(q.defectEscapeRate, 0.5);
  assert.equal(q.reworkRate, 0.5);
  assert.equal(q.firstPassAcceptance, 0.5);
  const e = quality([], null);
  assert.equal(e.testPassRate, null);
  assert.equal(e.defectEscapeRate, null);
});

test('targets status', () => {
  const m = computeMetrics({ tickets, sprints: [sprints[0]], config: { targets: { firstPassAcceptance: 0.75, buildGreen: true } } }, { quality: { testsTotal: 1, testsPassed: 1, buildGreen: true } });
  const by = Object.fromEntries(m.targets.map((t) => [t.name, t.status]));
  assert.equal(by['First-pass acceptance'], 'off-track');
  assert.equal(by['Build green'], 'on-track');
  assert.equal(by['Committed points done'], 'at-risk');
  assert.equal(by['Sprint budget (USD)'], 'on-track');
  assert.deepEqual(targetsStatus({ sprint: null, config: {}, qual: quality([]), costM: cost([]), points: [] }), []);
});

test('scorecards flag low confidence', () => {
  const s = scorecardView({ agents: [{ id: 'x', composite: 0.2, tickets: 1 }, { id: 'y', composite: 0.9, tickets: 5, lowPerformer: true }] });
  assert.equal(s.agents[0].lowConfidence, true);
  assert.equal(s.agents[0].lowPerformerFlag, false);
  assert.equal(s.agents[1].lowPerformerFlag, true);
  assert.deepEqual(scorecardView(undefined), { agents: [], teams: [] });
});

test('computeMetrics with empty data', () => {
  const m = computeMetrics({}, {});
  assert.equal(m.wip, 0);
  assert.equal(m.currentSprint, null);
  assert.equal(m.forecast.sprintsRemaining, 0);
  assert.deepEqual(m.targets, []);
  JSON.stringify(m);
});

test('computeMetrics full', () => {
  const m = computeMetrics({ tickets, sprints, hubs: {}, config: {} });
  assert.equal(m.wip, 1);
  assert.equal(m.currentSprint, 1);
  assert.equal(m.tickets.byStatus.done, 2);
});

test('quality-report parses TAP', () => {
  const r = parseTap('ok 1 - a\nnot ok 2 - b\n# tests 2\n# pass 1\n# fail 1\n');
  assert.deepEqual(r, { testsTotal: 2, testsPassed: 1, testsFailed: 1, buildGreen: false });
  assert.equal(parseTap('ok 1 - a\nok 2 - b\n').buildGreen, true);
  assert.equal(parseTap('').buildGreen, false);
  const out = join(mkdtempSync(join(tmpdir(), 'q-')), 'q.json');
  writeReport('# tests 1\n# pass 1\n# fail 0\n', out, 'T');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).at, 'T');
});

test('server serves UI and APIs; export is self-contained', async () => {
  const srv = await start({ port: 0 });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.match(await (await fetch(base + '/')).text(), /<title>/);
    const snap = await (await fetch(base + '/api/snapshot')).json();
    assert.ok(Array.isArray(snap.tickets));
    const met = await (await fetch(base + '/api/metrics')).json();
    assert.ok('velocity' in met);
    assert.equal((await fetch(base + '/nope')).status, 404);
  } finally { srv.close(); }
  const html = renderSnapshotHtml({ snapshot: { tickets: [] }, metrics: {} });
  assert.match(html, /window\.__SNAPSHOT__=/);
  assert.doesNotMatch(html, /src="app\.js"|href="styles\.css"/);
});
