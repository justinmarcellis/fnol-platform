// rules module entry (modules.md "rules"): condition language, rule evaluation, routing and STP decisions.
import { createService } from './service.js';
import { registerRoutes } from './routes.js';

export { evaluateCondition, validateCondition } from './condition.js';
export { validateRules } from './engine.js';

export const migrations = [
  `CREATE TABLE IF NOT EXISTS routing_decisions (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    queue TEXT NOT NULL,
    adjuster_id TEXT,
    fast_track INTEGER NOT NULL DEFAULT 0,
    rule_ids TEXT NOT NULL,
    doc TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    source_event_id TEXT,
    actions TEXT,
    actions_done INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, id)
  )`,
  'CREATE INDEX IF NOT EXISTS ix_routing_decisions_claim ON routing_decisions (tenant_id, claim_id, seq)',
  'CREATE INDEX IF NOT EXISTS ix_routing_decisions_event ON routing_decisions (tenant_id, source_event_id)',
  `CREATE TABLE IF NOT EXISTS queue_cursors (
    tenant_id TEXT NOT NULL,
    queue_id TEXT NOT NULL,
    last_adjuster_id TEXT,
    PRIMARY KEY (tenant_id, queue_id)
  )`,
];

export default {
  name: 'rules',
  migrations,

  /** Mounted at ctx.modules.rules (tenant-bound per ctx.forTenant). */
  service: (ctx) => createService(ctx),

  routes(router) {
    registerRoutes(router);
  },

  subscribe(bus, ctx) {
    // claim.triaged -> route automatically. Named so core dedupes on evt.id; route() is also idempotent per event.
    bus.on('claim.triaged', async (evt, tctx) => {
      const t = tctx ?? ctx.forTenant(evt.tenantid ?? evt.tenantId);
      await t.modules.rules.onClaimTriaged(evt);
    }, { name: 'rules:claim.triaged' });
  },
};
