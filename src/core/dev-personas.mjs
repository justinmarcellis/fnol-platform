// Demo persona directory (dev mode only). Derived at request time from seeded data; never returns tokens or secrets.
// Registered by src/server.mjs only when ctx.config.devMode is true.

/** Role -> app route the persona lands on. */
export const APP_BY_ROLE = {
  claimant: '/', csr: '/csr', agent: '/csr', adjuster: '/adjuster', supervisor: '/adjuster', carrier_admin: '/admin',
};
const APP_LABEL = { '/': 'Claimant', '/csr': 'CSR and agent', '/adjuster': 'Adjuster', '/admin': 'Administration' };

const zip5 = (z) => { const m = /^\s*(\d{5})/.exec(String(z ?? '')); return m ? m[1] : ''; };
const lastWord = (name) => String(name ?? '').trim().split(/\s+/).pop() ?? '';

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/** First seeded policy whose named insured and a garaging/property ZIP are readable: the claimant persona. */
function findClaimantPolicy(tctx) {
  const rows = safe(() => tctx.db.all("SELECT policy_number, doc, pii FROM coverage_policies ORDER BY policy_number LIMIT 200"), []);
  let producer = null;
  let holder = null;
  for (const row of rows) {
    const doc = safe(() => JSON.parse(row.doc), null);
    if (!doc) continue;
    if (!producer) {
      const p = doc.producer ?? {};
      const id = p.agentId ?? p.id ?? doc.producerId ?? doc.agentId;
      if (typeof id === 'string' && id) producer = { id, name: p.name ?? null, policies: [] };
    }
    if (holder) continue;
    const pii = safe(() => (row.pii ? JSON.parse(tctx.crypto.decryptPii(row.pii)) : null), null);
    const insured = pii?.insureds?.[0];
    if (!insured?.name) continue;
    const zips = [
      ...Object.values(pii.garaging ?? {}),
      ...Object.values(pii.addresses ?? {}).map((a) => a?.postalCode),
    ].map(zip5).filter(Boolean);
    if (!zips.length) continue;
    holder = { policyNumber: row.policy_number, name: insured.name, lastName: insured.lastName ?? lastWord(insured.name), zip: zips[0], lob: row.lob };
  }
  if (producer) producer.policies = rows.filter((r) => safe(() => JSON.parse(r.doc).producer, null)).map((r) => r.policy_number).slice(0, 5);
  return { holder, producer };
}

const CLOSED = "('closed','withdrawn','denied')";

/**
 * Adjuster owning the most open claims, as the adjuster inbox sees it (the adjuster_inbox projection is what
 * the inbox filters on); falls back to the claims table when the projection is empty or absent.
 */
function busiestAdjuster(tctx) {
  const top = (table) => safe(() => tctx.db.all(
    `SELECT adjuster_id AS id, COUNT(*) AS n FROM ${table} WHERE adjuster_id IS NOT NULL AND status NOT IN ${CLOSED} GROUP BY adjuster_id ORDER BY n DESC, adjuster_id LIMIT 1`), [])[0];
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
  out.push(mk('claimant', 'claimant', holder?.name ?? `Casey Claimant`, {
    hint: holder ? { policyNumber: holder.policyNumber, lastName: holder.lastName, zip: holder.zip, lob: holder.lob } : undefined,
    note: holder ? `Named insured on ${holder.policyNumber}` : 'No seeded policy found; run the seed script',
  }));
  out.push(mk('csr', 'csr', 'Riley Okafor'));
  out.push(mk('agent', 'agent', producer?.name ?? 'Avery Lindqvist', {
    userId: producer?.id ?? `dev-${tenantId}-agent`,
    note: producer ? `Produces ${producer.policies.length} seeded policies` : 'No producer data on seeded policies',
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
