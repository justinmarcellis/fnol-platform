import { parseLimit } from './service.mjs';

const DISPATCH = { pending: 'pending', delivered: 'dispatched', failed: 'failed' };

/**
 * Read the tenant's outbox in sequence order (for replay and debugging), through ctx.bus.outbox.
 * Core's outbox rows carry no sequence column yet, so the sequence is the 1-based position in the tenant's
 * append-only outbox (created_at order); a core-provided `sequence` field wins when present.
 * Reads the whole tenant outbox per call (fine for the PoC; see the platform request for a sequence column).
 * @param {object} ctx tenant-bound context
 * @param {{ type?: string, subject?: string, afterSequence?: number|string, limit?: number|string }} [q]
 * @returns {Promise<{ items: object[], nextSequence: number }>}
 */
export async function listOutbox(ctx, q = {}) {
  if (!ctx.tenant?.id) throw new ctx.AppError('tenant_required', 'Outbox listing requires a tenant-bound context', 500);
  const limit = parseLimit(ctx, q.limit);
  let after = 0;
  if (q.afterSequence !== undefined && q.afterSequence !== '') {
    after = Number(q.afterSequence);
    if (!Number.isInteger(after) || after < 0) throw new ctx.AppError('invalid_query', 'afterSequence must be a non-negative integer', 400);
  }
  for (const [col, v] of [['type', q.type], ['subject', q.subject]]) {
    if (v !== undefined && typeof v !== 'string') throw new ctx.AppError('invalid_query', `${col} must be a single value`, 400);
  }
  const items = [];
  const rows = ctx.bus.outbox(ctx.tenant.id);
  for (let i = 0; i < rows.length && items.length < limit; i++) {
    const r = rows[i];
    const sequence = r.sequence ?? i + 1;
    if (sequence <= after) continue;
    if (q.type && r.type !== q.type) continue;
    if (q.subject && r.subject !== q.subject) continue;
    items.push({
      sequence,
      event: toEnvelope(ctx.db.parseJson(r.event, {}), ctx.tenant.id, sequence),
      publishedAt: r.created_at,
      dispatch: { status: DISPATCH[r.status] ?? r.status, attempts: r.attempts },
    });
  }
  return { items, nextSequence: items.length ? items[items.length - 1].sequence : after };
}

const SOURCE_RE = /^\/tenants\/[a-z0-9-]+\/modules\/[a-z]+$/;

/**
 * Normalise a bus event into the contract envelope (events/envelope.schema.json):
 * camelCase tenantId (core also emits the CloudEvents extension `tenantid`), a conforming source,
 * a string subject, and the per-tenant sequence.
 * @param {object} evt
 * @param {string} tenantId
 * @param {number} [sequence]
 * @returns {object}
 */
export function toEnvelope(evt, tenantId, sequence) {
  const out = { ...evt, tenantId };
  if (!SOURCE_RE.test(String(out.source ?? ''))) out.source = `/tenants/${tenantId}/modules/platform`;
  if (typeof out.subject !== 'string') out.subject = tenantId;
  if (sequence !== undefined) out.sequence = sequence;
  return out;
}
