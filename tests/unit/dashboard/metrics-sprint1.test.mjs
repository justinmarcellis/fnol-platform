import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  tierSpendMix, parseValueDrivers, valueDriverView, improvementLogView, sprintReviews, scorecardView, computeMetrics,
} from '../../../dashboard/metrics.mjs';
import { renderSnapshotHtml } from '../../../dashboard/export.mjs';
import { readValueDrivers } from '../../../dashboard/server.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/scorecards.json', import.meta.url), 'utf8'));
const tickets = [
  { id: 'T1', tier: 'mid', points: 3, status: 'done', spend: { usd: 3 }, valueDrivers: ['VD-1', 'VD-3'] },
  { id: 'T2', tier: 'strong', points: 5, status: 'ready', spend: { usd: 1 }, valueDrivers: ['VD-1'] },
  { id: 'T3', points: 1, status: 'done' },
];

test('tierSpendMix groups spend by ticket tier', () => {
  const m = tierSpendMix(tickets);
  assert.equal(m.totalUsd, 4);
  assert.deepEqual(m.tiers.map((t) => [t.tier, t.usd, t.pct]), [['strong', 1, 25], ['mid', 3, 75], ['unspecified', 0, 0]]);
  assert.deepEqual(tierSpendMix([]), { totalUsd: 0, tiers: [] });
});

test('parseValueDrivers keeps VD-1..VD-6 headings only', () => {
  const md = '### VD-1 First thing\n- x\n### VD-6 Sixth (a)\n### VD-7 Seventh\n#### VD-2 not h3\n### VD-1 dup';
  assert.deepEqual(parseValueDrivers(md), [{ id: 'VD-1', title: 'First thing' }, { id: 'VD-6', title: 'Sixth (a)' }]);
  assert.deepEqual(parseValueDrivers(undefined), []);
});

test('real value-propositions file yields six drivers', () => {
  assert.deepEqual(readValueDrivers().map((x) => x.id), ['VD-1', 'VD-2', 'VD-3', 'VD-4', 'VD-5', 'VD-6']);
});

test('valueDriverView links tickets', () => {
  const v = valueDriverView([{ id: 'VD-1', title: 'a' }, { id: 'VD-2', title: 'b' }], tickets);
  assert.deepEqual(v[0].tickets.map((t) => t.id), ['T1', 'T2']);
  assert.equal(v[0].points, 8);
  assert.equal(v[0].donePoints, 3);
  assert.deepEqual(v[1].tickets, []);
});

test('improvementLogView derives result and delta', () => {
  const r = improvementLogView([
    { id: 'a', before: 0, after: 1, target: 1 }, { id: 'b', before: 5, after: 2, target: 1 },
    { id: 'c', before: 0 }, { id: 'd', before: 1, after: 0, target: 2, result: 'kept' },
  ]);
  assert.deepEqual(r.map((x) => x.result), ['improved', 'improved', 'pending', 'kept']);
  assert.equal(r[0].delta, 1);
  assert.deepEqual(improvementLogView(null), []);
});

test('sprintReviews newest first with null review/retro', () => {
  const r = sprintReviews([{ number: 0, review: { usd: 1 }, retro: { went_well: [] } }, { number: 1 }]);
  assert.deepEqual(r.map((x) => x.number), [1, 0]);
  assert.equal(r[0].review, null);
});

test('scorecardView handles fixture shape (ticketsDone, lowPerformer, lowConfidence)', () => {
  const v = scorecardView(fixture);
  assert.ok(v.teams.some((t) => t.lowPerformerFlag));
  assert.ok(v.agents.every((a) => a.lowConfidence));
  assert.deepEqual(scorecardView(undefined).agents, []);
});

test('computeMetrics adds sprint1 fields and tolerates missing scorecards', () => {
  const m = computeMetrics({ tickets, sprints: [{ number: 1, status: 'active' }], improvements: [{ id: 'x' }] }, { valueDrivers: [{ id: 'VD-1', title: 't' }] });
  assert.equal(m.tierMix.totalUsd, 4);
  assert.equal(m.valueDrivers[0].tickets.length, 2);
  assert.equal(m.improvements[0].result, 'pending');
  assert.deepEqual(m.scorecards.agents, []);
});

test('export is one self-contained HTML and does not break out of the script tag', () => {
  const evil = '<img src=x onerror=alert(1)></script>';
  const metrics = computeMetrics({ tickets: [{ ...tickets[0], title: evil }], sprints: [] }, { valueDrivers: [{ id: 'VD-1', title: evil }] });
  const html = renderSnapshotHtml({ snapshot: { tickets, config: {}, sprints: [], improvements: [] }, metrics });
  assert.ok(!/<link[^>]+stylesheet/.test(html));
  assert.ok(!/src="app\.js"/.test(html));
  assert.ok(!/(src|href)="https?:/.test(html));
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
  assert.ok(!html.includes('</script><img'));
});

test('app renders every tab, escaped, with and without scorecards', () => {
  const src = readFileSync(new URL('../../../dashboard/app.js', import.meta.url), 'utf8');
  const evil = '<b>x</b>';
  const data = (sc) => {
    const snapshot = { config: {}, teams: { teams: [] }, tickets: tickets.map((t) => ({ ...t, title: evil, owner: evil, team: 'a' })), sprints: [], improvements: [] };
    const sprints = [{ number: 1, status: 'closed', review: { completedPoints: 1, committedPoints: 2, shipped: [evil] }, retro: { went_well: [evil] } }];
    return { snapshot, metrics: computeMetrics({ ...snapshot, sprints, scorecards: sc }, { valueDrivers: [{ id: 'VD-1', title: evil }] }) };
  };
  for (const sc of [undefined, fixture]) {
    for (let i = 0; i < 11; i++) {
      const handlers = [];
      const els = {};
      const el = (id) => (els[id] ??= { id, innerHTML: '', textContent: '', className: '', addEventListener: (_, h) => handlers.push(h) });
      const ctx = vm.createContext({ window: { __SNAPSHOT__: data(sc) }, document: { getElementById: el }, setInterval() {} });
      vm.runInContext(src, ctx);
      if (i === 0) assert.equal((els.tabs.innerHTML.match(/<button/g) || []).length, 11);
      handlers[0]({ target: { closest: () => ({ dataset: { i: String(i) } }) } });
      assert.ok(!els.view.innerHTML.includes('Render error'), `tab ${i}: ${els.view.innerHTML.slice(0, 160)}`);
      assert.ok(!els.view.innerHTML.includes('<b>x</b>'), `tab ${i} unescaped`);
    }
  }
});
