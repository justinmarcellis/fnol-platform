// Coordination fabric: tickets, hubs, sprints and improvements stored as
// plain files so concurrent agents never contend on one database file.
//   org/board/tickets/<ID>.json   one file per ticket
//   org/hubs/<hub>.jsonl          append-only typed messages
//   org/sprints/sprint-<n>.json   plan, targets, review, retro
//   org/improvements.json         self-improvement log
import { readFileSync, writeFileSync, readdirSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORG = dirname(fileURLToPath(import.meta.url));
const TICKETS = join(ORG, 'board', 'tickets');
const HUBS = join(ORG, 'hubs');

export const STATUSES = ['backlog', 'ready', 'in_progress', 'review', 'done', 'blocked'];
export const MESSAGE_TYPES = ['request', 'answer', 'decision', 'contract-change', 'blocker', 'handoff', 'status'];

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
};

export const config = () => readJson(join(ORG, 'config.json'), {});
export const teams = () => readJson(join(ORG, 'teams.json'), { teams: [] });

export function listTickets() {
  if (!existsSync(TICKETS)) return [];
  return readdirSync(TICKETS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(TICKETS, f)))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export const getTicket = (id) => readJson(join(TICKETS, `${id}.json`), null);

export function saveTicket(t) {
  if (!STATUSES.includes(t.status)) throw new Error(`bad status ${t.status}`);
  t.history ??= [];
  writeJson(join(TICKETS, `${t.id}.json`), t);
  return t;
}

export function updateTicket(id, patch, at = new Date().toISOString()) {
  const t = getTicket(id);
  if (!t) throw new Error(`no ticket ${id}`);
  if (patch.status && patch.status !== t.status) {
    t.history = [...(t.history ?? []), { at, from: t.status, to: patch.status }];
    if (patch.status === 'in_progress' && !t.startedAt) t.startedAt = at;
    if (patch.status === 'done') t.doneAt = at;
  }
  return saveTicket({ ...t, ...patch, history: t.history });
}

export function post(hub, msg) {
  if (!MESSAGE_TYPES.includes(msg.type)) throw new Error(`bad message type ${msg.type}`);
  mkdirSync(HUBS, { recursive: true });
  const line = { at: new Date().toISOString(), hub, ...msg };
  appendFileSync(join(HUBS, `${hub}.jsonl`), JSON.stringify(line) + '\n');
  return line;
}

export function readHub(hub) {
  const p = join(HUBS, `${hub}.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function listHubs() {
  if (!existsSync(HUBS)) return [];
  return readdirSync(HUBS).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
}

export function sprints() {
  const dir = join(ORG, 'sprints');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^sprint-\d+\.json$/.test(f))
    .map((f) => readJson(join(dir, f)))
    .sort((a, b) => a.number - b.number);
}

export const saveSprint = (s) => writeJson(join(ORG, 'sprints', `sprint-${s.number}.json`), s);
export const improvements = () => readJson(join(ORG, 'improvements.json'), []);
export const saveImprovements = (list) => writeJson(join(ORG, 'improvements.json'), list);
export const scorecards = () => readJson(join(ORG, 'scorecards', 'latest.json'), { agents: [], teams: [] });

export function snapshot() {
  return {
    generatedAt: new Date().toISOString(),
    config: config(),
    teams: teams(),
    tickets: listTickets(),
    sprints: sprints(),
    hubs: Object.fromEntries(listHubs().map((h) => [h, readHub(h)])),
    improvements: improvements(),
    scorecards: scorecards(),
  };
}
