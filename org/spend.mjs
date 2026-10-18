#!/usr/bin/env node
// Attribute token spend from harness transcripts to tickets.
//   node org/spend.mjs <workflow-transcript-dir> [--map label=TICKET ...]
// Each agent's label must contain a ticket ID (e.g. "S1-AI-03 extraction") or be
// mapped with --map. Re-running is idempotent: spend is keyed by agent id.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, getTicket, updateTicket } from './fabric.mjs';

const TICKET_RE = /\bS\d+-[A-Z]+-\d+\b/;
const tierFor = (model) => (/opus/.test(model) ? 'strong' : /haiku/.test(model) ? 'fast' : 'mid');

export function agentUsage(jsonlPath) {
  const byMsg = new Map();
  let model = 'sonnet';
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line) continue;
    const o = JSON.parse(line);
    const m = o.message;
    if (m && typeof m === 'object' && m.usage && m.id) {
      byMsg.set(m.id, m.usage); // streamed duplicates share an id; keep the last
      if (m.model) model = m.model;
    }
  }
  const u = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  for (const x of byMsg.values()) {
    u.inputTokens += x.input_tokens ?? 0;
    u.cacheWriteTokens += x.cache_creation_input_tokens ?? 0;
    u.cacheReadTokens += x.cache_read_input_tokens ?? 0;
    u.outputTokens += x.output_tokens ?? 0;
  }
  return { model, ...u };
}

export function usd(u, tiers = config().modelTiers) {
  const r = tiers[tierFor(u.model)];
  return (
    (u.inputTokens * r.inputPerMTok +
      u.cacheWriteTokens * r.inputPerMTok * 1.25 +
      u.cacheReadTokens * r.cacheReadPerMTok +
      u.outputTokens * r.outputPerMTok) / 1e6
  );
}

function main() {
  const [dir, ...rest] = process.argv.slice(2);
  const map = {};
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--map') { const [k, v] = rest[++i].split('='); map[k] = v; }
  const files = readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f));
  for (const f of files) {
    const agentId = f.slice(6, -6);
    const metaPath = join(dir, `agent-${agentId}.meta.json`);
    const label = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')).description ?? '' : '';
    const ticketId = map[label] ?? label.match(TICKET_RE)?.[0];
    if (!ticketId || !getTicket(ticketId)) { console.log(`skip ${agentId} (${label})`); continue; }
    const u = agentUsage(join(dir, f));
    const t = getTicket(ticketId);
    const agents = { ...(t.spend?.agents ?? {}), [agentId]: { label, ...u, usd: +usd(u).toFixed(4) } };
    const vals = Object.values(agents);
    const sum = (k) => vals.reduce((a, x) => a + (x[k] ?? 0), 0);
    updateTicket(ticketId, {
      spend: {
        usd: +sum('usd').toFixed(4), inputTokens: sum('inputTokens'), cacheWriteTokens: sum('cacheWriteTokens'),
        cacheReadTokens: sum('cacheReadTokens'), outputTokens: sum('outputTokens'), agents,
      },
    });
    console.log(`${ticketId}\t${label}\t$${usd(u).toFixed(2)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
