// Demo persona directory (dev mode only). Derived at request time from seeded data; never returns tokens or secrets.
// Registered by src/server.mjs only when ctx.config.devMode is true.

/** Role -> app route the persona lands on. */
export const APP_BY_ROLE = {
  claimant: '/', csr: '/csr', agent: '/csr', adjuster: '/adjuster', supervisor: '/adjuster', carrier_admin: '/admin',
};
const APP_LABEL = { '/': 'Claimant', '/csr': 'CSR and agent', '/adjuster': 'Adjuster', '/admin': 'Administration' };

const zip5 = (z) => { const m = /^\s*(\d{5})/.exec(String(z ?? '')); return m ? m[1] : ''; };
const lastWord = (name) => String(name ?? '').trim().split(/\s+/).pop() ?? '';
const ORG_HINT = /\b(co|company|inc|llc|ltd|corp|group|logistics|freight|delivery|services|transport)\b/i;
const isOrg = (i) => i?.kind === 'organization' || (i?.kind !== 'person' && !i?.lastName && ORG_HINT.test(String(i?.name ?? '').replace(/\([^)]*\)/g, ' ')));

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/** Rank of a policy as the claimant persona's: an individual on personal auto with 2-3 vehicles is best (DATA-3). */
function claimantRank(row, doc, insured) {
  if (!insured?.name || isOrg(insured)) return -1;
  const vehicles = (doc.vehicles ?? []).length;
  if (row.lob === 'personal_auto') return vehicles >= 2 && vehicles <= 3 ? 3 : vehicles ? 2 : 1;
  return 0;
}

/**
 * The claimant persona (named insured of the best-suited seeded policy, with a last name and ZIP that pass the
 * holder check and the policy's lob) and the agent persona (the producer with the largest seeded book).
 */
function findClaimantPolicy(tctx) {
  const rows = safe(() => tctx.db.all('SELECT policy_number, lob, doc, pii FROM coverage_policies ORDER BY policy_number LIMIT 500'), []);
  const producers = new Map();
  let holder = null;
  let best = -1;
  for (const row of rows) {
    const doc = safe(() => JSON.parse(row.doc), null);
    if (!doc) continue;
    const p = doc.producer ?? {};
    const id = p.agentId ?? p.id ?? doc.producerId ?? doc.agentId;
    if (typeof id === 'string' && id) {
      const cur = producers.get(id) ?? { id, name: p.name ?? null, agency: p.agency ?? null, policies: [] };
      cur.policies.push(row.policy_number);
      producers.set(id, cur);
    }
    if (best >= 3) continue;
    const pii = safe(() => (row.pii ? JSON.parse(tctx.crypto.decryptPii(row.pii)) : null), null);
    const insured = pii?.insureds?.[0];
    const rank = claimantRank(row, doc, insured);
    if (rank <= best) continue;
    const zips = [
      ...Object.values(pii.garaging ?? {}),
      ...Object.values(pii.addresses ?? {}).map((a) => a?.postalCode),
    ].map(zip5).filter(Boolean);
    if (!zips.length) continue;
    best = rank;
    holder = {
      policyNumber: row.policy_number, name: insured.name, lastName: insured.lastName ?? lastWord(insured.name), zip: zips[0],
      lob: row.lob, vehicleCount: (doc.vehicles ?? []).length,
    };
  }
  const producer = [...producers.values()].sort((a, b) => b.policies.length - a.policies.length || a.id.localeCompare(b.id))[0] ?? null;
  return { holder, producer };
}

const CLOSED = "('closed','withdrawn','denied')";

/**
 * Adjuster owning the most open claims, as the adjuster inbox sees it (the adjuster_inbox projection is what
 * the inbox filters on); ties go to the adjuster with the widest mix of lines of business, then by id.
 * Falls back to the claims table when the projection is empty or absent.
 */
function busiestAdjuster(tctx) {
  const top = (table) => safe(() => tctx.db.all(
    `SELECT adjuster_id AS id, COUNT(*) AS n, COUNT(DISTINCT lob) AS lobs FROM ${table} WHERE adjuster_id IS NOT NULL AND status NOT IN ${CLOSED} GROUP BY adjuster_id ORDER BY n DESC, lobs DESC, adjuster_id LIMIT 1`), [])[0];
  return top('adjuster_inbox') ?? top('claims') ?? null;
}

const titleCase = (s) => String(s).split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/**
 * Build the persona list for one tenant from seeded data.
 * @param {object} tctx tenant-bound context
 * @returns {object[]}
 */
export function personasForTenant(tctx) {
  const tenantId = tctx.tenant.id;
  const { holder, producer } = findClaimantPolicy(tctx);
  const adj = busiestAdjuster(tctx);
  const mk = (role, key, displayName, extra = {}) => {
    const app = APP_BY_ROLE[role];
    return {
      id: `${tenantId}:${key}`,
      userId: extra.userId ?? `dev-${tenantId}-${key}`,
      displayName, role,
      roles: extra.roles ?? [role],
      app, appLabel: APP_LABEL[app],
      path: role === 'claimant' ? `/?tenant=${encodeURIComponent(tenantId)}` : app,
      ...(extra.hint ? { hint: extra.hint } : {}),
      ...(extra.note ? { note: extra.note } : {}),
    };
  };
  const out = [];
  const lobLabel = { personal_auto: 'personal auto', homeowners: 'homeowners', commercial_auto: 'commercial auto' };
  out.push(mk('claimant', 'claimant', holder?.name ?? `Casey Claimant`, {
    hint: holder ? { policyNumber: holder.policyNumber, lastName: holder.lastName, zip: holder.zip, lob: holder.lob } : undefined,
    note: holder
      ? `Named insured on ${lobLabel[holder.lob] ?? holder.lob} policy ${holder.policyNumber}${holder.vehicleCount ? ` (${holder.vehicleCount} vehicles)` : ''}`
      : 'No seeded policy found; run the seed script',
  }));
  out.push(mk('csr', 'csr', 'Riley Okafor'));
  out.push(mk('agent', 'agent', producer?.name ?? 'Avery Lindqvist', {
    userId: producer?.id ?? `dev-${tenantId}-agent`,
    note: producer ? `Producer of ${producer.policies.length} seeded policies${producer.agency ? ` at ${producer.agency}` : ''}` : 'No producer data on seeded policies',
  }));
  out.push(mk('adjuster', 'adjuster', 'Jordan Reyes', {
    userId: adj?.id ?? `dev-${tenantId}-adjuster`,
    note: adj ? `Owns ${adj.n} open claims` : 'No assigned claims yet',
  }));
  out.push(mk('supervisor', 'supervisor', 'Morgan Hale'));
  out.push(mk('carrier_admin', 'carrier-admin', 'Taylor Brandt', { roles: ['carrier_admin', 'tenant_admin'] }));
  return out;
}

/**
 * Handler body for GET /api/v1/dev/personas.
 * @param {object} ctx root context
 */
export function listDevPersonas(ctx) {
  const tenants = [...(ctx.tenants.list() ?? [])].sort().map((id) => {
    const cfg = ctx.tenants.get(id) ?? {};
    return {
      id,
      name: cfg.displayName ?? titleCase(id),
      branding: { primaryColor: cfg.branding?.primaryColor, accentColor: cfg.branding?.accentColor, fontFamily: cfg.branding?.fontFamily },
      personas: personasForTenant(ctx.forTenant(id)),
    };
  });
  return { tenants };
}

/**
 * Register GET /api/v1/dev/personas. Callers must only invoke this in devMode; the handler re-checks and answers 404 otherwise.
 * @param {object} router
 * @param {object} ctx
 */
export function registerDevPersonaRoutes(router, ctx) {
  router.get('/api/v1/dev/personas', (req, res) => {
    if (!ctx.config.devMode) throw new ctx.HttpError(404, 'not_found', 'Not found');
    res.json(200, listDevPersonas(ctx));
  }, { public: true });
}
