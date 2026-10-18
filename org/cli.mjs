#!/usr/bin/env node
// Agent-facing CLI for the coordination fabric.
//   node org/cli.mjs ticket <ID>                       show a ticket
//   node org/cli.mjs ticket <ID> status <status>       move a ticket
//   node org/cli.mjs ticket <ID> note "<text>"         append a work note
//   node org/cli.mjs tickets [team]                    list tickets
//   node org/cli.mjs post <hub> <type> "<text>" [--to agent] [--ticket ID] [--link path]
//   node org/cli.mjs hub <hub>                         read a hub
//   node org/cli.mjs ticket-new < ticket.json          create ticket(s) from JSON
//   node org/cli.mjs review <ID> accept|rework "<why>"  record a review verdict
import { getTicket, updateTicket, listTickets, post, readHub, saveTicket } from './fabric.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

switch (cmd) {
  case 'ticket': {
    const [id, action, value] = rest;
    if (!action) console.log(JSON.stringify(getTicket(id), null, 2));
    else if (action === 'status') console.log(updateTicket(id, { status: value }).status);
    else if (action === 'note') {
      const t = getTicket(id);
      updateTicket(id, { notes: [...(t.notes ?? []), { at: new Date().toISOString(), text: value }] });
      console.log('noted');
    } else throw new Error(`unknown ticket action ${action}`);
    break;
  }
  case 'ticket-new': {
    // JSON ticket (or array) on stdin; fills defaults
    const { readFileSync } = await import('node:fs');
    const input = JSON.parse(readFileSync(0, 'utf8'));
    for (const t of [input].flat()) {
      if (getTicket(t.id)) throw new Error(`ticket ${t.id} exists`);
      saveTicket({ status: 'ready', dependsOn: [], createdAt: new Date().toISOString(), history: [], ...t });
      console.log(`created ${t.id}`);
    }
    break;
  }
  case 'review': {
    // node org/cli.mjs review <ID> accept|rework "<reason>"
    const [id, verdict, reason] = rest;
    const t = getTicket(id);
    const r = t.review ?? { reworkCount: 0, verdicts: [] };
    r.verdicts = [...r.verdicts, { at: new Date().toISOString(), by: process.env.AGENT_ID ?? 'unknown', verdict, reason }];
    if (r.firstPass === undefined) r.firstPass = verdict === 'accept';
    if (verdict === 'rework') r.reworkCount += 1;
    updateTicket(id, { review: r, status: verdict === 'accept' ? 'done' : 'in_progress' });
    console.log(`${id} ${verdict}`);
    break;
  }
  case 'tickets': {
    const team = rest[0];
    for (const t of listTickets().filter((t) => !team || t.team === team))
      console.log(`${t.id}\t${t.team}\t${t.status}\t${t.points}pt\t${t.title}`);
    break;
  }
  case 'post': {
    const [hub, type, text] = rest;
    console.log(JSON.stringify(post(hub, { type, text, from: process.env.AGENT_ID ?? 'unknown', to: flag('to'), ticket: flag('ticket'), link: flag('link') })));
    break;
  }
  case 'hub':
    for (const m of readHub(rest[0])) console.log(`${m.at} [${m.type}] ${m.from}${m.to ? ' → ' + m.to : ''}: ${m.text}${m.link ? ' (' + m.link + ')' : ''}`);
    break;
  default:
    console.log('commands: ticket, tickets, post, hub');
}
