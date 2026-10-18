import { HttpError } from './errors.mjs';

export const migrations = [{
  sql: `
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT,
  event TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox (tenant_id, status);`,
  tenantTables: ['outbox'],
}, {
  sql: `
CREATE TABLE IF NOT EXISTS bus_handled (
  tenant_id TEXT NOT NULL,
  handler TEXT NOT NULL,
  event_id TEXT NOT NULL,
  handled_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, handler, event_id)
);`,
  tenantTables: ['bus_handled'],
}, {
  // Per-tenant monotonic sequence; backfilled in (created_at, rowid) order.
  sql: `
ALTER TABLE outbox ADD COLUMN seq INTEGER;
UPDATE outbox SET seq = (
  SELECT x.rn FROM (
    SELECT id AS oid, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at, rowid) AS rn FROM outbox
  ) x WHERE x.oid = outbox.id
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_tenant_seq ON outbox (tenant_id, seq);`,
}];

/**
 * Event bus: persisted outbox + in-process async dispatch with retries.
 * @param {object} ctx
 * @param {{ maxAttempts?: number, retryDelayMs?: number }} [opts]
 */
export function createBus(ctx, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 5;
  const handlers = [];
  const pending = new Set();

  const matching = (type) => handlers.filter((h) => h.type === '*' || h.type === type);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function deliver(evt) {
    const t = ctx.db.forTenant(evt.tenantid);
    let attempts = 0;
    let lastError = null;
    const failed = [];
    for (const h of matching(evt.type)) {
      let ok = false;
      for (let n = 1; n <= maxAttempts && !ok; n++) {
        attempts = Math.max(attempts, n);
        try {
          // Per-handler dedupe on event id (modules.md rule 6), so replays after a crash are safe.
          if (t.get('SELECT 1 AS x FROM bus_handled WHERE handler = ? AND event_id = ?', h.name, evt.id)) { ok = true; break; }
          await h.handler(evt, ctx.forTenant ? ctx.forTenant(evt.tenantid) : ctx);
          t.insert('bus_handled', { handler: h.name, event_id: evt.id, handled_at: ctx.clock.nowIso() });
          ok = true;
        } catch (e) {
          lastError = e?.message ?? String(e);
          ctx.log.error('bus handler failed', { type: evt.type, eventId: evt.id, attempt: n, error: lastError });
          t.update('outbox', evt.id, { attempts, last_error: lastError });
          if (n < maxAttempts) await sleep(retryDelayMs * n);
        }
      }
      // One failing handler must not starve the others; the event is marked failed at the end.
      if (!ok) failed.push(h.name);
    }
    if (failed.length) {
      t.update('outbox', evt.id, { status: 'failed', attempts, last_error: lastError });
      ctx.log.error('bus event failed', { type: evt.type, eventId: evt.id, handlers: failed });
      return;
    }
    t.update('outbox', evt.id, { status: 'delivered', attempts, delivered_at: ctx.clock.nowIso() });
  }

  function dispatch(evt) {
    const p = new Promise((resolve) => setImmediate(resolve))
      .then(() => deliver(evt))
      .catch((e) => ctx.log.error('bus dispatch error', { eventId: evt.id, error: e?.message }))
      .finally(() => pending.delete(p));
    pending.add(p);
  }

  return {
    /**
     * Persist and asynchronously dispatch a CloudEvents-style event.
     * @param {string} tenantId
     * @param {string} type e.g. 'claim.reported'
     * @param {string} subject e.g. the claim id
     * @param {object} data
     * @returns {object} the event envelope
     */
    publish(tenantId, type, subject, data = {}) {
      if (!tenantId || !type) throw new HttpError(500, 'bus_invalid', 'publish requires tenantId and type');
      const evt = {
        specversion: '1.0',
        id: ctx.db.id('evt'),
        source: '/fnol-platform',
        type,
        subject: subject ?? null,
        time: ctx.clock.nowIso(),
        tenantid: tenantId,
        datacontenttype: 'application/json',
        data,
      };
      const t = ctx.db.forTenant(tenantId);
      // seq is computed inside the same transaction as the insert, so it is gapless and unique per tenant.
      t.transaction(() => {
        const { n } = t.get('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM outbox');
        t.insert('outbox', {
          id: evt.id, type, subject: evt.subject, event: JSON.stringify(evt),
          status: 'pending', attempts: 0, created_at: evt.time, seq: n,
        });
      });
      dispatch(evt);
      return evt;
    },
    /**
     * Subscribe to an event type or '*'. Handler receives (event, tenantCtx). Returns an unsubscribe fn.
     * Give a stable opts.name (e.g. 'triage:claim.reported') so dedupe survives restarts.
     */
    on(type, handler, opts = {}) {
      const h = { type, handler, name: opts.name ?? `${type}#${handlers.filter((x) => x.type === type).length}` };
      handlers.push(h);
      return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); };
    },
    /** Await all in-flight handlers (for tests). */
    async drain() {
      while (pending.size) await Promise.all([...pending]);
    },
    /** Re-dispatch pending/failed outbox rows for the given tenants (call at boot after subscriptions). */
    recover(tenantIds) {
      for (const id of tenantIds) {
        const rows = ctx.db.forTenant(id).all("SELECT event FROM outbox WHERE status = 'pending' ORDER BY seq");
        rows.forEach((r) => dispatch(JSON.parse(r.event)));
      }
    },
    /** Read outbox rows for a tenant (optionally by status). */
    outbox(tenantId, status) {
      const t = ctx.db.forTenant(tenantId);
      return status
        ? t.all('SELECT * FROM outbox WHERE status = ? ORDER BY seq', status)
        : t.all('SELECT * FROM outbox ORDER BY seq');
    },
  };
}
