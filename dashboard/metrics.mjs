// Pure metric functions for the PMO dashboard. No I/O; all inputs are plain data.
const HOUR = 3600000;
const ts = (v) => (v ? Date.parse(v) : NaN);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => (xs.length ? sum(xs) / xs.length : null);
const round = (v, d = 2) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
const ratio = (a, b) => (b > 0 ? a / b : null);
const isDone = (t) => t.status === 'done';

/** Tickets that belong to a sprint: listed in sprint.committed, else ticket.sprint === number. */
function sprintTickets(sprint, tickets) {
  const ids = new Set(sprint.committed ?? []);
  return tickets.filter((t) => ids.has(t.id) || (!ids.size && t.sprint === sprint.number));
}

/** Per sprint committed vs completed story points. */
export function sprintPoints(tickets = [], sprints = []) {
  return sprints.map((s) => {
    const ts_ = sprintTickets(s, tickets);
    return {
      sprint: s.number, name: s.name ?? `Sprint ${s.number}`, status: s.status ?? 'unknown',
      committed: sum(ts_.map((t) => num(t.points))),
      completed: sum(ts_.filter(isDone).map((t) => num(t.points))),
      tickets: ts_.length, doneTickets: ts_.filter(isDone).length,
    };
  });
}

/** Rolling average of completed points over the last `window` sprints that have started finishing work. */
export function rollingVelocity(points = [], window = 3) {
  const closed = points.filter((p) => ['done', 'closed', 'complete', 'completed'].includes(p.status));
  const pool = (closed.length ? closed : points.filter((p) => p.completed > 0)).slice(-window);
  return pool.length ? round(avg(pool.map((p) => p.completed))) : 0;
}

/** Forecast sprints to finish all non-done backlog points at the rolling velocity. */
export function forecast(tickets = [], velocity = 0) {
  const backlogPoints = sum(tickets.filter((t) => !isDone(t)).map((t) => num(t.points)));
  const sprintsRemaining = backlogPoints === 0 ? 0 : velocity > 0 ? Math.ceil(backlogPoints / velocity) : null;
  const text = backlogPoints === 0 ? 'No remaining backlog points.'
    : sprintsRemaining === null ? `${backlogPoints} points remain; no velocity yet, so no forecast.`
      : `${backlogPoints} points remain at ${velocity} points per sprint: about ${sprintsRemaining} sprint(s) to PoC completion.`;
  return { backlogPoints, velocity, sprintsRemaining, text };
}

/** Burndown (remaining committed points) and burnup (completed vs scope) over doneAt times. */
export function burn(sprint, tickets = []) {
  if (!sprint) return { burndown: [], burnup: [], committed: 0 };
  const list = sprintTickets(sprint, tickets);
  const committed = sum(list.map((t) => num(t.points)));
  const done = list.filter((t) => isDone(t) && !Number.isNaN(ts(t.doneAt))).sort((a, b) => ts(a.doneAt) - ts(b.doneAt));
  const start = sprint.startedAt ?? done[0]?.doneAt ?? null;
  const burndown = [], burnup = [];
  if (start) { burndown.push({ at: start, remaining: committed }); burnup.push({ at: start, completed: 0, scope: committed }); }
  let completed = 0;
  for (const t of done) {
    completed += num(t.points);
    burndown.push({ at: t.doneAt, remaining: committed - completed, ticket: t.id });
    burnup.push({ at: t.doneAt, completed, scope: committed, ticket: t.id });
  }
  return { burndown, burnup, committed };
}

/** Cycle (startedAt to doneAt) and lead (createdAt to doneAt) time averages in hours, overall and per team. */
export function flowTimes(tickets = []) {
  const by = {};
  for (const t of tickets.filter(isDone)) {
    const g = (by[t.team ?? 'unknown'] ??= { cycle: [], lead: [] });
    const c = ts(t.doneAt) - ts(t.startedAt), l = ts(t.doneAt) - ts(t.createdAt);
    if (c >= 0) g.cycle.push(c / HOUR);
    if (l >= 0) g.lead.push(l / HOUR);
  }
  const all = { cycle: [], lead: [] };
  const perTeam = {};
  for (const [team, g] of Object.entries(by)) {
    perTeam[team] = { cycleHours: round(avg(g.cycle)), leadHours: round(avg(g.lead)), samples: g.lead.length };
    all.cycle.push(...g.cycle); all.lead.push(...g.lead);
  }
  return { cycleHours: round(avg(all.cycle)), leadHours: round(avg(all.lead)), perTeam };
}

/** Synapse latency: request message to the first later answer with the same ticket (same hub). */
export function synapseLatency(hubs = {}) {
  const lat = [];
  let unanswered = 0;
  for (const msgs of Object.values(hubs)) {
    const sorted = [...msgs].sort((a, b) => ts(a.at) - ts(b.at));
    sorted.forEach((m, i) => {
      if (m.type !== 'request') return;
      const ans = m.ticket ? sorted.slice(i + 1).find((x) => x.type === 'answer' && x.ticket === m.ticket) : null;
      if (ans) lat.push((ts(ans.at) - ts(m.at)) / 60000); else unanswered++;
    });
  }
  return { avgMinutes: round(avg(lat)), samples: lat.length, unanswered };
}

/** Tickets with unmet dependencies (non-empty dependsOn and not done). */
export function serialDependencies(tickets = []) {
  const list = tickets.filter((t) => (t.dependsOn ?? []).length && !isDone(t));
  return { count: list.length, ids: list.map((t) => t.id) };
}

/** Spend by sprint/team/ticket, points per dollar and budget remaining. */
export function cost(tickets = [], config = {}) {
  const usd = (t) => num(t.spend?.usd);
  const group = (key) => {
    const o = {};
    for (const t of tickets) o[key(t)] = round((o[key(t)] ?? 0) + usd(t), 4);
    return o;
  };
  const total = round(sum(tickets.map(usd)), 4);
  const donePts = sum(tickets.filter(isDone).map((t) => num(t.points)));
  const budget = config.budget?.totalUsd ?? null;
  return {
    totalUsd: total, bySprint: group((t) => t.sprint ?? 'none'), byTeam: group((t) => t.team ?? 'unknown'),
    byTicket: Object.fromEntries(tickets.filter((t) => usd(t) > 0).map((t) => [t.id, round(usd(t), 4)])),
    pointsPerDollar: total > 0 ? round(donePts / total) : null,
    budgetUsd: budget, budgetRemainingUsd: budget === null ? null : round(budget - total, 4),
    budgetUsedPct: budget ? round((total / budget) * 100, 1) : null,
  };
}

/** Quality: test results from org/quality.json plus review-derived rates. */
export function quality(tickets = [], q = null) {
  const done = tickets.filter(isDone);
  const reviewed = tickets.filter((t) => t.review && typeof t.review === 'object');
  const r = (t) => t.review ?? {};
  const t_ = q && typeof q === 'object' ? q : null;
  return {
    testsTotal: t_?.testsTotal ?? null, testsPassed: t_?.testsPassed ?? null,
    testPassRate: t_ && t_.testsTotal > 0 ? round(t_.testsPassed / t_.testsTotal, 4) : null,
    coveragePct: t_?.coveragePct ?? null, buildGreen: t_?.buildGreen ?? null, at: t_?.at ?? null,
    defectEscapeRate: round(ratio(done.filter((t) => num(r(t).escapedDefects) > 0).length, done.length), 4),
    reworkRate: round(ratio(done.filter((t) => num(r(t).reworkCount) > 0).length, done.length), 4),
    firstPassAcceptance: round(ratio(reviewed.filter((t) => r(t).firstPass === true).length, reviewed.filter((t) => typeof r(t).firstPass === 'boolean').length), 4),
    reviewed: reviewed.length,
  };
}

/** Compare an actual to a target. higher=true means bigger is better. */
function judge(actual, target, higher = true) {
  if (actual === null || actual === undefined || target === null || target === undefined) return 'no-data';
  if (typeof target === 'boolean') return actual === target ? 'on-track' : 'off-track';
  const ok = higher ? actual >= target : actual <= target;
  if (ok) return 'on-track';
  const near = higher ? actual >= target * 0.9 : actual <= target * 1.1;
  return near ? 'at-risk' : 'off-track';
}

/** Target status vs sprint.targets and config.targets. */
export function targetsStatus({ sprint, config = {}, qual, costM, points }) {
  const ct = config.targets ?? {}, st = sprint?.targets ?? {};
  const out = [];
  const add = (name, actual, target, higher, unit) => out.push({ name, actual, target, unit, status: judge(actual, target, higher) });
  const fpT = st.firstPassAcceptance ?? ct.firstPassAcceptance;
  if (fpT !== undefined) add('First-pass acceptance', qual.firstPassAcceptance, fpT, true, 'ratio');
  if (ct.testPassRate !== undefined) add('Test pass rate', qual.testPassRate, ct.testPassRate, true, 'ratio');
  if (ct.buildGreen !== undefined) add('Build green', qual.buildGreen, ct.buildGreen, true, 'bool');
  if (ct.pointsPerDollar !== undefined) add('Points per dollar', costM.pointsPerDollar, ct.pointsPerDollar, true, 'pts/$');
  if (st.committedPoints !== undefined) {
    const done = points.find((p) => p.sprint === sprint.number)?.completed ?? 0;
    out.push({ name: 'Committed points done', actual: done, target: st.committedPoints, unit: 'pts', status: done >= st.committedPoints ? 'on-track' : done > 0 ? 'at-risk' : 'no-data' });
  }
  const bT = st.budgetUsd ?? config.budget?.totalUsd;
  if (bT !== undefined) {
    const spent = st.budgetUsd !== undefined && sprint ? costM.bySprint[sprint.number] ?? 0 : costM.totalUsd;
    out.push({ name: st.budgetUsd !== undefined ? 'Sprint budget (USD)' : 'Program budget (USD)', actual: spent, target: bT, unit: 'usd', status: spent > bT ? 'off-track' : spent >= bT * ((config.budget?.replanAtPct ?? 80) / 100) ? 'at-risk' : 'on-track' });
  }
  return out;
}

/** Flag low performers and low-confidence rows in scorecards (passthrough plus annotations). */
export function scorecardView(sc, config = {}) {
  const minTickets = 3;
  const annotate = (rows) => {
    const list = Array.isArray(rows) ? rows : [];
    const scored = list.filter((r) => typeof r.composite === 'number' && (r.tickets ?? r.ticketCount ?? minTickets) >= minTickets).map((r) => r.composite).sort((a, b) => a - b);
    const cut = scored.length >= 10 ? scored[Math.floor(scored.length * 0.1) - 1 < 0 ? 0 : Math.floor(scored.length * 0.1) - 1] : null;
    return list.map((r) => {
      const n = r.tickets ?? r.ticketCount ?? null;
      const lowConfidence = r.lowConfidence ?? (n !== null && n < minTickets);
      const low = !lowConfidence && (r.lowPerformer === true || (cut !== null && r.composite <= cut));
      return { ...r, lowConfidence: !!lowConfidence, lowPerformerFlag: !!low };
    });
  };
  return { ...(sc ?? {}), agents: annotate(sc?.agents), teams: annotate(sc?.teams) };
}

/** Compute every dashboard metric from a fabric snapshot. */
export function computeMetrics(snap = {}, opts = {}) {
  const tickets = snap.tickets ?? [], sprints = snap.sprints ?? [], config = snap.config ?? {};
  const points = sprintPoints(tickets, sprints);
  const current = [...sprints].reverse().find((s) => s.status === 'active') ?? sprints[sprints.length - 1] ?? null;
  const velocity = rollingVelocity(points);
  const qual = quality(tickets, opts.quality ?? null);
  const costM = cost(tickets, config);
  const byStatus = {};
  for (const t of tickets) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  const total = sum(tickets.map((t) => num(t.points)));
  const donePts = sum(tickets.filter(isDone).map((t) => num(t.points)));
  return {
    generatedAt: snap.generatedAt ?? null,
    currentSprint: current ? current.number : null,
    tickets: { total: tickets.length, byStatus, totalPoints: total, donePoints: donePts },
    wip: tickets.filter((t) => t.status === 'in_progress').length,
    sprintPoints: points, velocity, forecast: forecast(tickets, velocity),
    ...burn(current, tickets),
    flow: flowTimes(tickets), synapse: synapseLatency(snap.hubs ?? {}),
    serialDependencies: serialDependencies(tickets),
    cost: costM, quality: qual,
    targets: targetsStatus({ sprint: current, config, qual, costM, points }),
    scorecards: scorecardView(snap.scorecards, config),
  };
}
