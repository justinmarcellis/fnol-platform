#!/usr/bin/env node
// Sprint plan/close tooling.
//   node org/sprint.mjs plan <n>    sum committed points of tickets with sprint n into org/sprints/sprint-<n>.json
//   node org/sprint.mjs close <n>   write review metrics (incl. test pass rate from org/quality.json); retro is kept
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ORG = dirname(fileURLToPath(import.meta.url));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const share = (a, b) => (b > 0 ? round(a / b, 3) : null);
const file = (dir, n) => join(dir, `sprint-${n}.json`);

function readSprint(dir, n) {
  const p = file(dir, n);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { number: n, name: `Sprint ${n}`, status: 'planned' };
}
function writeSprint(dir, s) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(dir, s.number), JSON.stringify(s, null, 2) + '\n');
}
const inSprint = (tickets, n) => tickets.filter((t) => Number(t.sprint) === Number(n));

/** Sum committed points of tickets in sprint n; merge into the sprint file, preserving every other field. */
export function planSprint(n, { tickets = [], dir = join(ORG, 'sprints'), at = new Date().toISOString() } = {}) {
  const list = inSprint(tickets, n);
  const committedPoints = sum(list.map((t) => num(t.points)));
  const prev = readSprint(dir, n);
  const sprint = {
    ...prev, number: Number(n),
    status: prev.status && prev.status !== 'planned' ? prev.status : 'planned',
    startedAt: prev.startedAt ?? at,
    committed: list.map((t) => t.id), committedPoints,
    targets: { ...(prev.targets ?? {}), committedPoints },
  };
  writeSprint(dir, sprint);
  return sprint;
}

/** Compute review metrics for sprint n and merge into the sprint file; retro and other fields are kept. */
export function closeSprint(n, { tickets = [], quality = null, dir = join(ORG, 'sprints'), at = new Date().toISOString() } = {}) {
  const prev = readSprint(dir, n);
  const ids = new Set(prev.committed ?? []);
  const list = ids.size ? tickets.filter((t) => ids.has(t.id) || Number(t.sprint) === Number(n)) : inSprint(tickets, n);
  const done = list.filter((t) => t.status === 'done');
  const completedPoints = sum(done.map((t) => num(t.points)));
  const committedPoints = sum(list.map((t) => num(t.points)));
  const usd = round(sum(list.map((t) => num(t.spend?.usd))), 2);
  const rv = (t) => t.review ?? {};
  const q = quality && typeof quality === 'object' ? quality : null;
  const review = {
    ...(prev.review ?? {}),
    completedPoints, committedPoints, usd,
    pointsPerDollar: usd > 0 ? round(completedPoints / usd, 1) : null,
    firstPassAcceptance: share(done.filter((t) => rv(t).firstPass === true).length, done.length),
    reworkRate: share(done.filter((t) => num(rv(t).reworkCount) > 0).length, done.length),
    testPassRate: q && q.testsTotal > 0 ? round(q.testsPassed / q.testsTotal, 4) : null,
    testsPassed: q && q.testsTotal > 0 ? `${q.testsPassed}/${q.testsTotal}` : null,
  };
  const sprint = { ...prev, number: Number(n), status: 'closed', closedAt: at, review };
  writeSprint(dir, sprint);
  return sprint;
}

function main() {
  const [cmd, n] = process.argv.slice(2);
  if (!['plan', 'close'].includes(cmd) || !/^\d+$/.test(n ?? '')) {
    console.error('usage: node org/sprint.mjs plan|close <n>');
    process.exit(1);
  }
  return import('./fabric.mjs').then(({ listTickets }) => {
    const tickets = listTickets();
    if (cmd === 'plan') {
      const s = planSprint(Number(n), { tickets });
      console.log(`Sprint ${n} planned: ${s.committedPoints} points across ${s.committed.length} tickets`);
    } else {
      const qp = join(ORG, 'quality.json');
      let quality = null;
      try { quality = existsSync(qp) ? JSON.parse(readFileSync(qp, 'utf8')) : null; } catch { quality = null; }
      const r = closeSprint(Number(n), { tickets, quality }).review;
      console.log(`Sprint ${n} closed: ${r.completedPoints}/${r.committedPoints} pts, $${r.usd}, ${r.pointsPerDollar ?? 'n/a'} pts/$, tests ${r.testsPassed ?? 'n/a'}`);
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
