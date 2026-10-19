// Display directory for the adjuster workbench: adjuster ids -> display names, queue labels and rule names,
// all read from the tenant config. The PoC has no identity directory, so names are synthetic and derived
// deterministically from the id (same id, same name, every time). In dev mode the demo personas' names win,
// so "Jordan Reyes" in the demo bar is "Jordan Reyes" on the claim view too.
import { personasForTenant } from '../../core/dev-personas.mjs';

// Fictional given and family names (synthetic data only).
const GIVEN = ['Alex', 'Blair', 'Cameron', 'Dana', 'Elliot', 'Finley', 'Gray', 'Harper', 'Indra', 'Jules', 'Kai', 'Lane', 'Marlo', 'Noor', 'Oakley', 'Parker', 'Quinn', 'Rowan', 'Sasha', 'Tatum'];
const FAMILY = ['Abernathy', 'Brightwater', 'Castellan', 'Dunmore', 'Everly', 'Fairbrook', 'Galloway', 'Hollis', 'Ivers', 'Juniper', 'Kingsley', 'Larkspur', 'Merriweather', 'Northcott', 'Oberlin', 'Pemberton', 'Quarry', 'Redfern', 'Stonebridge', 'Thornbury'];

/** Small stable string hash (FNV-1a). */
function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Deterministic synthetic display name for a user id. */
export function syntheticName(id) {
  const h = hash(id);
  return `${GIVEN[h % GIVEN.length]} ${FAMILY[Math.floor(h / GIVEN.length) % FAMILY.length]}`;
}

/**
 * Build the directory for the bound tenant.
 * @param {object} ctx tenant-bound ctx
 * @returns {{people: Record<string,string>, queues: {id:string,label:*,adjusters:string[]}[], rules: Record<string,string>}}
 */
export function buildDirectory(ctx) {
  const cfg = ctx.tenants?.get?.(ctx.tenant.id) ?? {};
  const people = {};
  const queues = (cfg.queues ?? []).map((q) => ({ id: q.id, label: q.label ?? q.id, adjusters: [...(q.adjusters ?? [])] }));
  for (const q of queues) for (const id of q.adjusters) people[id] = syntheticName(id);
  if (ctx.config?.devMode) {
    try {
      for (const p of personasForTenant(ctx)) {
        if (!p?.userId || !p.displayName) continue;
        people[p.userId] = p.displayName;
        // Seeded notes and tasks may carry the generic persona id even when the persona maps to a real adjuster id.
        people[`dev-${ctx.tenant.id}-${p.id.split(':')[1]}`] = p.displayName;
      }
    } catch { /* personas are a demo convenience */ }
  }
  const rules = {};
  for (const r of cfg.rules ?? []) if (r?.id) rules[r.id] = r.name ?? r.description ?? r.id;
  return { people, queues, rules };
}

/** Display name for an actor id: directory, then system label, then the id itself. */
export function nameOf(dir, id) {
  if (!id) return '';
  if (dir.people[id]) return dir.people[id];
  return id;
}
