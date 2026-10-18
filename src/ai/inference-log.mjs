// ai_inference: tenant-scoped inference telemetry. Stores a sha256 of the input, never raw text.
import { createHash } from 'node:crypto';

export const migrations = [
  `CREATE TABLE IF NOT EXISTS ai_inference (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    task TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    tier TEXT,
    confidence REAL,
    input_hash TEXT NOT NULL,
    usage TEXT,
    latency_ms INTEGER,
    escalated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,
  'CREATE INDEX IF NOT EXISTS ix_ai_inference_task ON ai_inference (tenant_id, task, created_at)',
];

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/** sha256 hex of the canonical JSON of an input. */
export function hashInput(input) {
  return createHash('sha256').update(canonical(input ?? null)).digest('hex');
}

/**
 * @param {object} ctx root (or tenant-bound) ctx with db, clock
 * @returns {{record: Function, list: Function}}
 */
export function createInferenceLog(ctx) {
  ctx.db.migrate('ai', migrations); // idempotent

  /** Never throws: telemetry must not break a claim flow. */
  function record(tenantId, e) {
    if (!tenantId) return null;
    try {
      const row = {
        id: ctx.db.id('inf'),
        task: e.task,
        provider: e.provider ?? null,
        model: e.model ?? null,
        tier: e.tier ?? null,
        confidence: typeof e.confidence === 'number' ? e.confidence : null,
        input_hash: hashInput(e.input),
        usage: e.usage ?? null,
        latency_ms: Math.round(e.latencyMs ?? 0),
        escalated: e.escalated ? 1 : 0,
        created_at: ctx.clock?.nowIso?.() ?? new Date().toISOString(),
      };
      ctx.db.forTenant(tenantId).insert('ai_inference', row);
      return row;
    } catch (err) {
      ctx.log?.warn?.('ai_inference write failed', { error: err.message });
      return null;
    }
  }

  function list(tenantId, { task, limit = 100 } = {}) {
    const db = ctx.db.forTenant(tenantId);
    const rows = task
      ? db.all('SELECT * FROM ai_inference WHERE task = ? ORDER BY created_at DESC LIMIT ?', task, limit)
      : db.all('SELECT * FROM ai_inference ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map((r) => ({ ...r, usage: ctx.db.parseJson(r.usage, null), escalated: !!r.escalated }));
  }

  return { record, list };
}
