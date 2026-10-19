// intake module entry (modules.md#intake): guided FNOL sessions that end in claims.createClaim.
import { createService } from './service.js';
import { registerRoutes } from './routes.js';

export const migrations = [
  `CREATE TABLE IF NOT EXISTS intake_sessions (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    status TEXT NOT NULL,
    lob TEXT NOT NULL,
    channel TEXT NOT NULL,
    question_set_id TEXT NOT NULL,
    question_set_version INTEGER NOT NULL,
    doc TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY (tenant_id, id)
  )`,
  'CREATE INDEX IF NOT EXISTS ix_intake_sessions_status ON intake_sessions (tenant_id, status)',
  `CREATE TABLE IF NOT EXISTS intake_answers (
    tenant_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    value_enc TEXT NOT NULL,
    provenance TEXT,
    answered_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, session_id, question_id)
  )`,
];

export { createService };

// Injectable producer lookup for the agent role (fail closed when unset and coverage has no producer data).
let coverageLookup;
export function setCoverageLookup(fn) { coverageLookup = typeof fn === 'function' ? fn : undefined; }

export default {
  name: 'intake',
  migrations,

  /** Mounted at ctx.modules.intake (tenant-bound per ctx.forTenant). */
  service: (ctx) => createService(ctx, { get coverageLookup() { return coverageLookup; } }),

  routes(router) {
    registerRoutes(router);
  },

  subscribe(bus, ctx) {
    // Expire active sessions whose question set was removed from config.
    bus.on('tenant.config.updated', async (evt, tctx) => {
      try {
        const t = tctx ?? ctx.forTenant(evt.tenantid ?? evt.tenantId);
        t.modules.intake.expireOrphaned();
      } catch (e) {
        ctx.log.warn('intake event handler failed', { eventType: evt?.type, eventId: evt?.id, error: e?.message });
      }
    }, { name: 'intake:tenant.config.updated' });
  },
};
