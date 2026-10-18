// Built-in fake core claims suite: stores what it receives (tenant scoped, PII encrypted) and returns a core claim number.

export const migrations = [{
  sql: `
CREATE TABLE IF NOT EXISTS fake_core_claims (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  core_claim_number TEXT NOT NULL,
  claim_ref TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_enc TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fake_core_ref ON fake_core_claims (tenant_id, claim_ref);`,
  tenantTables: ['fake_core_claims'],
}];

const ROLES = ['integration', 'tenant_admin', 'carrier_admin', 'supervisor'];

/** The platform claim reference inside either profile's payload, or undefined. */
export function claimRefOf(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  const ref = payload.claimsNotificationAddRq?.claimsOccurrence?.itemIdInfo?.agencyId ?? payload.CLAIM_REF;
  return typeof ref === 'string' && ref ? ref : undefined;
}

/**
 * Store a received payload for the bound tenant. A repeated claim reference keeps its core claim number.
 * @param {object} tctx tenant-bound ctx
 * @param {object} payload
 * @param {{ hash: (p: object) => string }} deps
 * @returns {{ coreClaimNumber: string, receivedAt: string, duplicate: boolean }}
 */
export function receiveClaim(tctx, payload, { hash }) {
  const claimRef = claimRefOf(payload);
  if (!claimRef) throw new tctx.AppError('invalid_payload', 'Payload has no claim reference (claimsOccurrence.itemIdInfo.agencyId or CLAIM_REF)', 400);
  const receivedAt = tctx.clock.nowIso();
  const existing = tctx.db.get('SELECT core_claim_number FROM fake_core_claims WHERE claim_ref = ? ORDER BY seq LIMIT 1', claimRef);
  let coreClaimNumber = existing?.core_claim_number;
  if (!coreClaimNumber) {
    const n = tctx.db.get('SELECT COUNT(DISTINCT core_claim_number) AS n FROM fake_core_claims').n;
    coreClaimNumber = `CORE-${tctx.clock.now().getUTCFullYear()}-${String(n + 1).padStart(6, '0')}`;
  }
  tctx.db.insert('fake_core_claims', {
    id: tctx.db.id('fcc'),
    core_claim_number: coreClaimNumber,
    claim_ref: claimRef,
    payload_hash: hash(payload),
    payload_enc: tctx.crypto.encryptPii(JSON.stringify(payload)),
    received_at: receivedAt,
  });
  return { coreClaimNumber, receivedAt, duplicate: Boolean(existing) };
}

/**
 * List received payloads (newest last) for the bound tenant, decrypted. For tests and demos.
 * @returns {{ coreClaimNumber: string, claimRef: string, payloadHash: string, receivedAt: string, payload: object }[]}
 */
export function listReceived(tctx, { limit = 100 } = {}) {
  const rows = tctx.db.all('SELECT * FROM fake_core_claims ORDER BY seq LIMIT ?', Math.min(Math.max(Number(limit) || 100, 1), 500));
  return rows.map((r) => ({
    coreClaimNumber: r.core_claim_number,
    claimRef: r.claim_ref,
    payloadHash: r.payload_hash,
    receivedAt: r.received_at,
    payload: JSON.parse(tctx.crypto.decryptPii(r.payload_enc)),
  }));
}

/** Register POST (receive) and GET (list) for /api/v1/integrations/fake-core/claims. */
export function registerFakeCoreRoutes(router, { hash }) {
  const path = '/api/v1/integrations/fake-core/claims';
  router.post(path, async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new req.ctx.AppError('invalid_payload', 'JSON object body required', 400);
    }
    res.json(201, receiveClaim(req.ctx, req.body, { hash }));
  }, { roles: ROLES });
  router.get(path, async (req, res) => {
    res.json(200, { items: listReceived(req.ctx, { limit: req.query.limit }) });
  }, { roles: ROLES });
}
