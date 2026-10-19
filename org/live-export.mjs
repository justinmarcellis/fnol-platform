#!/usr/bin/env node
// Build the live program feed from real records only: the ticket board, hub
// messages, review verdicts, spend, scorecards and agent runs (start/finish
// times from harness transcripts). Nothing here is estimated or invented.
//
//   node org/live-export.mjs [--transcripts <dir>] [--out <dir>]
//
// Agent runs are merged into org/runs.json (committed), because harness
// transcripts disappear with the container. Output files in --out (default
// org/live/) are the documents pushed to the dashboard artifact's database:
//   board.json  rank.json  graph.json  events.json  metrics.json
// metrics.json is the dashboard computeMetrics output plus generatedAt, so the
// Velocity, Quality, Cost, Flow and Performance tabs update live too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ORG, listTickets, sprints, listHubs, readHub, scorecards, teams } from './fabric.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const readJson = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : d);
const TICKET_RE = /\bS\d+-[A-Z]+-\d+\b/;
// Sprint 0 labels predate the ticket-id label rule (IMP-1).
const S0_LABELS = { 'dir-product: value props': ['S0-PRD-01', 'dir-product'], 'dir-architecture: contracts': ['S0-ARC-01', 'dir-architecture'], 'ic-product-personas': ['S0-PRD-02', 'ic-product-personas'], 'ic-platform-runtime': ['S0-PLT-01', 'ic-platform-runtime'], 'ic-pmo-dashboard': ['S0-PMO-01', 'ic-pmo-dashboard'] };

/** Who an agent run was, from its label. */
export function parseLabel(label, ticketsById) {
  if (S0_LABELS[label]) return { ticket: S0_LABELS[label][0], agent: S0_LABELS[label][1], role: 'build' };
  const ticket = label.match(TICKET_RE)?.[0] ?? null;
  const rest = label.replace(TICKET_RE, '').trim();
  const t = ticketsById.get(ticket);
  if (/\bsecurity rework\b/.test(rest)) return { ticket, agent: rest.split(' ')[0], role: 'security-rework' };
  if (/^security$/.test(rest)) return { ticket, agent: 'sec-reviewer', role: 'security-review' };
  if (/^review( r2)?$/.test(rest)) return { ticket, agent: 'qe-acceptance', role: 'review' };
  if (/\bplanning$/.test(rest)) return { ticket, agent: rest.split(' ')[0], role: 'planning' };
  if (/\brework$/.test(rest)) return { ticket, agent: rest.split(' ')[0], role: 'rework' };
  return { ticket, agent: rest.split(' ')[0] || t?.owner || 'unknown', role: 'build' };
}

function scanTranscripts(root) {
  const runs = [];
  if (!root || !fs.existsSync(root)) return runs;
  for (const wf of fs.readdirSync(root)) {
    const dir = path.join(root, wf);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^agent-.*\.jsonl$/.test(x))) {
      const id = f.slice(6, -6);
      const meta = readJson(path.join(dir, `agent-${id}.meta.json`), {});
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean);
      const ts = lines.map((l) => { try { return JSON.parse(l).timestamp; } catch { return null; } }).filter(Boolean).sort();
      if (!ts.length) continue;
      runs.push({ id, workflow: wf, label: meta.description ?? '', model: meta.model ?? null, phase: meta.workflowPhase ?? null, startedAt: ts[0], endedAt: ts[ts.length - 1] });
    }
  }
  return runs;
}

function defaultTranscriptRoot() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(base)) return [];
  const roots = [];
  for (const proj of fs.readdirSync(base)) {
    const p = path.join(base, proj);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const sess of fs.readdirSync(p)) {
      const w = path.join(p, sess, 'subagents', 'workflows');
      if (fs.existsSync(w)) roots.push(w);
    }
  }
  return roots;
}

export function build({ tickets, sprintList, hubs, cards, teamsDoc, runs, interventions, deprecations }) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const teamOf = new Map();
  for (const t of teamsDoc.teams) { teamOf.set(t.director.id, t.id); teamOf.set(t.manager.id, t.id); }
  for (const t of tickets) if (t.owner) teamOf.set(t.owner, t.team);
  teamOf.set('qe-acceptance', 'quality'); teamOf.set('sec-reviewer', 'security'); teamOf.set('ceo', 'leadership');

  // ---- board: user stories with real status, points, review and spend
  const defects = (t) => (Array.isArray(t.review?.escapedDefects) ? t.review.escapedDefects.length : 0);
  const board = {
    tickets: tickets.map((t) => ({
      id: t.id, team: t.team, sprint: t.sprint, title: t.title, story: (t.story ?? '').slice(0, 280),
      points: t.points, status: t.status, owner: t.owner, tier: t.tier,
      firstPass: t.review?.firstPass ?? null, rework: t.review?.reworkCount ?? 0, defects: defects(t),
      usd: +(t.spend?.usd ?? 0).toFixed(4), createdAt: t.createdAt, startedAt: t.startedAt ?? null, doneAt: t.doneAt ?? null,
      valueDrivers: t.valueDrivers ?? [],
    })),
    sprints: sprintList.map((s) => {
      const st = tickets.filter((t) => t.sprint === s.number);
      return {
        number: s.number, name: s.name, status: s.status, startedAt: s.startedAt, closedAt: s.closedAt ?? null, goal: s.goal,
        committed: st.reduce((a, t) => a + t.points, 0), completed: st.filter((t) => t.status === 'done').reduce((a, t) => a + t.points, 0),
        usd: +st.reduce((a, t) => a + (t.spend?.usd ?? 0), 0).toFixed(2), tickets: st.length,
        firstPass: st.filter((t) => t.review?.firstPass === true).length, reviewed: st.filter((t) => t.review?.firstPass !== undefined).length,
        retro: s.retro ?? null, review: s.review ?? null,
      };
    }),
  };

  // ---- rank: stack rank of agent configurations with lifecycle status
  const dep = new Map((deprecations ?? []).map((d) => [d.config, d]));
  const watch = new Map((interventions ?? []).map((i) => [i.config.split(' ')[0], i]));
  const rank = (cards.agents ?? []).filter((a) => a.ticketsDone > 0).map((a) => ({
    key: a.key, team: teamOf.get(a.key) ?? null, tickets: a.ticketsDone, points: a.points,
    firstPassAcceptance: a.firstPassAcceptance, reworkRate: a.reworkRate, defects: a.defects,
    costPerPoint: a.costPerPoint, composite: a.composite, lowConfidence: !!a.lowConfidence, flagged: !!a.lowPerformer,
    status: dep.has(a.key) ? 'deprecated' : (a.lowPerformer || watch.has(a.key)) ? 'on watch' : 'active',
    diagnosis: a.diagnosis ?? [], intervention: watch.get(a.key)?.intervention ?? null, deprecation: dep.get(a.key) ?? null,
  })).sort((x, y) => (y.composite ?? 0) - (x.composite ?? 0)).map((r, i) => ({ rank: i + 1, ...r }));

  // ---- events: one real timeline
  const events = [];
  for (const [hub, msgs] of Object.entries(hubs)) {
    for (const m of msgs) events.push({ t: m.at, kind: `msg:${m.type}`, from: m.from ?? 'unknown', to: m.to ? m.to : `hub:${hub}`, via: `hub:${hub}`, ticket: m.ticket ?? null, text: String(m.text ?? '').slice(0, 200) });
  }
  for (const t of tickets) {
    for (const h of t.history ?? []) events.push({ t: h.at, kind: `ticket:${h.to}`, from: t.owner ?? 'unknown', to: `hub:${t.team}`, ticket: t.id, text: `${t.id} ${h.from} → ${h.to}` });
    for (const v of t.review?.verdicts ?? []) events.push({ t: v.at, kind: `review:${v.verdict}`, from: v.by ?? 'unknown', to: t.owner ?? 'unknown', ticket: t.id, text: String(v.reason ?? '').slice(0, 200) });
  }
  for (const r of runs) {
    const p = parseLabel(r.label, byId);
    const t = byId.get(p.ticket);
    const boss = p.role === 'planning' ? 'ceo' : p.role === 'review' || p.role === 'security-review' ? p.agent : t ? (tickets.find((x) => x.id === `S${t.sprint}-${t.id.split('-')[1]}-00`)?.owner ?? 'ceo') : 'ceo';
    const from = p.role === 'review' || p.role === 'security-review' ? p.agent : boss;
    const to = p.role === 'review' || p.role === 'security-review' ? (t?.owner ?? p.agent) : p.agent;
    events.push({ t: r.startedAt, kind: `run:${p.role}`, from, to, ticket: p.ticket, model: r.model, text: r.label, endedAt: r.endedAt, runId: r.id });
  }
  events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

  // ---- graph: who talks to whom, aggregated from the same events
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind: id === 'ceo' ? 'orchestrator' : id.startsWith('hub:') ? 'hub' : id.startsWith('dir-') ? 'director' : id.startsWith('mgr-') ? 'manager' : id === 'qe-acceptance' || id === 'sec-reviewer' ? 'reviewer' : 'ic', team: id.startsWith('hub:') ? id.slice(4) : teamOf.get(id) ?? null, activity: 0, lastAt: null });
    return nodes.get(id);
  };
  const edges = new Map();
  for (const e of events) {
    if (!e.from || !e.to || e.from === e.to) continue;
    const a = node(e.from); const b = node(e.to);
    a.activity++; b.activity++;
    a.lastAt = !a.lastAt || e.t > a.lastAt ? e.t : a.lastAt;
    b.lastAt = !b.lastAt || e.t > b.lastAt ? e.t : b.lastAt;
    const k = `${e.from}|${e.to}`;
    const ed = edges.get(k) ?? { source: e.from, target: e.to, count: 0, kinds: {}, lastAt: null };
    ed.count++; ed.kinds[e.kind.split(':')[0]] = (ed.kinds[e.kind.split(':')[0]] ?? 0) + 1;
    ed.lastAt = !ed.lastAt || e.t > ed.lastAt ? e.t : ed.lastAt;
    edges.set(k, ed);
  }
  const active = tickets.filter((t) => t.status === 'in_progress' || t.status === 'review').map((t) => ({ id: t.id, owner: t.owner, status: t.status }));
  const graph = { nodes: [...nodes.values()], edges: [...edges.values()], active };

  return { board, rank, graph, events };
}

/** Compute the four feed documents from the fabric and every known agent run. */
export function computeFeed({ transcripts = null, persistRuns = false } = {}) {
  const runsPath = path.join(ORG, 'runs.json');
  const merged = new Map(readJson(runsPath, []).map((r) => [r.id, r]));
  for (const root of transcripts ? [transcripts] : defaultTranscriptRoot()) for (const r of scanTranscripts(root)) merged.set(r.id, r);
  const runs = [...merged.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  if (persistRuns) fs.writeFileSync(runsPath, JSON.stringify(runs, null, 1) + '\n');
  const hubs = Object.fromEntries(listHubs().map((h) => [h, readHub(h)]));
  const res = build({
    tickets: listTickets(), sprintList: sprints(), hubs, cards: scorecards(), teamsDoc: teams(), runs,
    interventions: readJson(path.join(ORG, 'scorecards', 'interventions.json'), []),
    deprecations: readJson(path.join(ORG, 'scorecards', 'deprecations.json'), []),
  });
  const generatedAt = new Date().toISOString();
  const docs = Object.fromEntries(Object.entries(res).map(([name, doc]) => [name, Array.isArray(doc) ? { generatedAt, items: doc } : { generatedAt, ...doc }]));
  return { docs, runs };
}

/** Size cap per live document (artifact database documents must stay small). */
export const MAX_DOC_BYTES = 600 * 1024;

async function main() {
  const out = arg('out', path.join(ORG, 'live'));
  fs.mkdirSync(out, { recursive: true });
  const { docs, runs } = computeFeed({ transcripts: arg('transcripts', null), persistRuns: true });
  // Imported lazily: dashboard/server.mjs itself imports computeFeed from this file.
  docs.metrics = (await import('../dashboard/server.mjs')).metricsDoc();
  for (const [name, body] of Object.entries(docs)) {
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > MAX_DOC_BYTES) throw new Error(`live document ${name} is ${Buffer.byteLength(text)} bytes, over the ${MAX_DOC_BYTES} byte limit`);
    fs.writeFileSync(path.join(out, `${name}.json`), text);
  }
  const kb = (n) => Math.round(fs.statSync(path.join(out, `${n}.json`)).size / 1024);
  console.log(`live feed: ${docs.board.tickets.length} stories, ${docs.rank.items.length} ranked agents, ${docs.graph.nodes.length} nodes / ${docs.graph.edges.length} edges, ${docs.events.items.length} events, ${runs.length} runs; sizes KB board ${kb('board')} rank ${kb('rank')} graph ${kb('graph')} events ${kb('events')} metrics ${kb('metrics')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
