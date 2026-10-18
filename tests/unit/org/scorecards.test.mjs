import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentScorecards, teamScorecards, configScorecards, compositeScore, diagnose, buildScorecards, medians, metricsFor, median,
} from '../../../org/scorecards.mjs';

const T0 = '2026-01-01T00:00:00.000Z';
const at = (h) => new Date(Date.parse(T0) + h * 3.6e6).toISOString();
let n = 0;
const tk = (o = {}) => ({
  id: `X-${++n}`, status: 'done', owner: 'a', tier: 'mid', team: 't', points: 2, sprint: 1,
  startedAt: T0, doneAt: at(2), spend: { usd: 0.2 }, review: { firstPass: true, reworkCount: 0, escapedDefects: 0 }, ...o,
});
const NaNFree = (o) => assert.ok(!JSON.stringify(o).includes('NaN') && !JSON.stringify(o).includes('Infinity'));

test('median and medians', () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.deepEqual(medians([tk(), tk({ status: 'review' })]), { hoursPerPoint: 1, costPerPoint: 0.1 });
});

test('composite follows the formula exactly', () => {
  const med = { hoursPerPoint: 1, costPerPoint: 0.1 };
  const m = { firstPassAcceptance: 0.5, reworkRate: 0.5, defects: 0.2, hoursPerPoint: 1.5, costPerPoint: 0.2 };
  // 0.35*.5 + 0.2*.5 + 0.2*.5 + 0.15*.5 + 0.1*.8
  assert.equal(compositeScore(m, med), 0.175 + 0.1 + 0.1 + 0.075 + 0.08);
  assert.equal(compositeScore({ firstPassAcceptance: 1, reworkRate: 0, defects: 0, hoursPerPoint: 1, costPerPoint: 0.1 }, med), 1);
});

test('no-data and zero edge cases give finite values', () => {
  const med = { hoursPerPoint: 0, costPerPoint: 0 };
  const c = compositeScore({ firstPassAcceptance: 0, reworkRate: 0, defects: 0, hoursPerPoint: null, costPerPoint: null }, med);
  assert.ok(Number.isFinite(c));
  const m = metricsFor([]);
  assert.equal(m.ticketsDone, 0);
  NaNFree(m);
  const z = agentScorecards([tk({ points: 0, spend: undefined, startedAt: undefined })]);
  assert.equal(z.length, 1);
  assert.equal(z[0].hoursPerPoint, null);
  assert.equal(z[0].lowConfidence, true);
  NaNFree(z);
  assert.deepEqual(agentScorecards([]), []);
  NaNFree(buildScorecards({ tickets: [], now: 'x' }));
});

test('only done tickets count; groupings and ordering', () => {
  const tickets = [tk({ owner: 'b' }), tk({ owner: 'a', tier: 'fast' }), tk({ owner: 'a' }), tk({ owner: 'a', status: 'review' })];
  const a = agentScorecards(tickets);
  assert.deepEqual(a.map((r) => [r.key, r.ticketsDone]), [['a', 2], ['b', 1]]);
  assert.deepEqual(configScorecards(tickets).map((r) => r.key), ['a+fast', 'a+mid', 'b+mid']);
  assert.equal(configScorecards(tickets)[0].tier, 'fast');
  assert.deepEqual(teamScorecards(tickets).map((r) => r.key), ['t']);
});

test('lowConfidence under 3 tickets is never flagged', () => {
  const rows = agentScorecards([tk({ review: { firstPass: false, reworkCount: 2 } })]);
  assert.equal(rows[0].lowConfidence, true);
  assert.equal(rows[0].lowPerformer, false);
  assert.ok(rows[0].diagnosis.some((d) => d.startsWith('low confidence')));
});

test('bottom 10% flagged among confident rows', () => {
  const tickets = [];
  for (const o of ['good1', 'good2', 'bad']) {
    for (let i = 0; i < 3; i++) tickets.push(tk({ owner: o, review: { firstPass: o !== 'bad', reworkCount: o === 'bad' ? 1 : 0, escapedDefects: 0 } }));
  }
  const rows = agentScorecards(tickets);
  assert.deepEqual(rows.filter((r) => r.lowPerformer).map((r) => r.key), ['bad']);
  // all equal: nobody flagged
  assert.equal(agentScorecards([...Array(3)].map(() => tk())).filter((r) => r.lowPerformer).length, 0);
});

test('below target two sprints running', () => {
  const tickets = [...Array(3)].map(() => tk({ owner: 'x', review: { firstPass: false, reworkCount: 1 } }))
    .concat([...Array(3)].map(() => tk({ owner: 'y' })), [...Array(3)].map(() => tk({ owner: 'z' })).flat());
  const cfg = { targets: { firstPassAcceptance: 0.75 } };
  const without = agentScorecards(tickets, { config: cfg, previous: { agents: {} } }).find((r) => r.key === 'x');
  const withPrev = agentScorecards(tickets, { config: cfg, previous: { agents: { x: 0.5 } } }).find((r) => r.key === 'x');
  assert.ok(withPrev.lowPerformer);
  assert.ok(withPrev.diagnosis.some((d) => d.includes('two sprints')));
  assert.ok(without.composite < 0.75);
  const fine = agentScorecards(tickets, { config: cfg, previous: { agents: { y: 0.5 } } }).find((r) => r.key === 'y');
  assert.equal(fine.lowPerformer, false);
});

test('diagnosis: oversized and wrong tier', () => {
  const cheap = [...Array(4)].map(() => tk({ owner: 'c' }));
  const dear = [...Array(3)].map(() => tk({ owner: 'd', tier: 'strong', spend: { usd: 2 } }));
  const big = tk({ owner: 'e', points: 13, review: { firstPass: false, reworkCount: 1 } });
  const all = [...cheap, ...dear, big];
  const rows = agentScorecards(all);
  assert.ok(rows.find((r) => r.key === 'd').diagnosis.some((d) => d.startsWith('wrong tier')));
  assert.ok(rows.find((r) => r.key === 'e').diagnosis.some((d) => d.startsWith('oversized task')));
  assert.equal(rows.find((r) => r.key === 'c').diagnosis.length, 0);
  assert.deepEqual(diagnose({ costPerPoint: 1, hoursPerPoint: null, firstPassAcceptance: 1, defects: 0, lowConfidence: false }, [], { costPerPoint: 0.1, hoursPerPoint: 0 }).length, 1);
});

test('buildScorecards shape, rounding, sprint scoping', () => {
  const tickets = [tk({ spend: { usd: 1 / 3 } }), tk({ sprint: 2 })];
  const doc = buildScorecards({ tickets, sprint: 1, now: 'NOW' });
  assert.deepEqual(Object.keys(doc), ['sprint', 'generatedAt', 'medians', 'agents', 'configs', 'teams']);
  assert.equal(doc.sprint, 1);
  assert.equal(doc.agents[0].ticketsDone, 1);
  assert.equal(doc.agents[0].costPerPoint, 0.167);
  assert.equal(buildScorecards({ tickets }).sprint, 2);
  for (const k of ['key', 'ticketsDone', 'points', 'firstPassAcceptance', 'reworkRate', 'defects', 'hoursPerPoint', 'costPerPoint', 'composite', 'lowPerformer', 'lowConfidence', 'diagnosis']) {
    assert.ok(k in doc.agents[0], k);
  }
});
