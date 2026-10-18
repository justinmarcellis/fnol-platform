import crypto from 'node:crypto';

const GENESIS = '0'.repeat(64);

export const migrations = [{
  sql: `
CREATE TABLE IF NOT EXISTS audit_log (
  tenant_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (tenant_id, entity_type, entity_id);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;`,
  tenantTables: ['audit_log'],
}];

function hashEntry(e) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([e.tenant_id, e.seq, e.at, e.actor, e.action, e.entity_type, e.entity_id, e.details, e.prev_hash]))
    .digest('hex');
}

/** Hash-chained, append-only audit log (one chain per tenant). */
export function createAudit(ctx) {
  const { db } = ctx;
  return {
    /**
     * Append an audit entry.
     * @param {string} tenantId
     * @param {{ actor: string, action: string, entityType?: string, entityId?: string, details?: object }} entry
     * @returns {object} stored row (details parsed)
     */
    record(tenantId, { actor, action, entityType = null, entityId = null, details = null }) {
      if (!actor || !action) throw new Error('audit.record requires actor and action');
      const t = db.forTenant(tenantId);
      return t.transaction(() => {
        const last = t.get('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
        const row = {
          tenant_id: tenantId,
          seq: last ? last.seq + 1 : 1,
          at: ctx.clock.nowIso(),
          actor,
          action,
          entity_type: entityType,
          entity_id: entityId,
          details: details === null ? null : JSON.stringify(details),
          prev_hash: last ? last.hash : GENESIS,
        };
        row.hash = hashEntry(row);
        t.insert('audit_log', row);
        return { ...row, details };
      });
    },
    /** Query entries. Filters: actor, action, entityType, entityId, since, until, limit, offset, order ('asc'|'desc'). */
    list(tenantId, f = {}) {
      const where = [];
      const p = [];
      const eq = (col, v) => { if (v) { where.push(`${col} = ?`); p.push(v); } };
      eq('actor', f.actor); eq('action', f.action); eq('entity_type', f.entityType); eq('entity_id', f.entityId);
      if (f.since) { where.push('at >= ?'); p.push(f.since); }
      if (f.until) { where.push('at <= ?'); p.push(f.until); }
      const limit = Math.min(Math.max(parseInt(f.limit ?? 100, 10) || 100, 1), 1000);
      const offset = Math.max(parseInt(f.offset ?? 0, 10) || 0, 0);
      const dir = f.order === 'asc' ? 'ASC' : 'DESC';
      const rows = db.forTenant(tenantId).all(
        `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${dir} LIMIT ? OFFSET ?`,
        ...p, limit, offset);
      return rows.map((r) => ({ ...r, details: db.parseJson(r.details) }));
    },
    /** Recompute the chain. @returns {{ok: boolean, brokenAt: number|null, count: number}} */
    verify(tenantId) {
      const rows = db.forTenant(tenantId).all('SELECT * FROM audit_log ORDER BY seq ASC');
      let prev = GENESIS;
      let expectSeq = 1;
      for (const r of rows) {
        if (r.seq !== expectSeq || r.prev_hash !== prev || hashEntry(r) !== r.hash) {
          return { ok: false, brokenAt: r.seq, count: rows.length };
        }
        prev = r.hash;
        expectSeq++;
      }
      return { ok: true, brokenAt: null, count: rows.length };
    },
  };
}

/** GET /api/v1/audit */
export function registerAuditRoutes(router, ctx) {
  router.get('/api/v1/audit', (req, res) => {
    const q = req.query;
    const items = ctx.audit.list(req.tenant.id, q);
    const body = { items };
    if (q.verify === 'true') body.verification = ctx.audit.verify(req.tenant.id);
    res.json(200, body);
  }, { roles: ['supervisor', 'carrier_admin', 'platform_admin'] });
}
