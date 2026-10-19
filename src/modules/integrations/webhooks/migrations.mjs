/** Tables owned by the webhook part of the integrations module (modules.md#integrations). */
export const migrations = [{
  sql: `
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  url TEXT NOT NULL,
  event_types TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  secret_enc TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_tenant ON webhook_subscriptions (tenant_id, active);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  response_status INTEGER,
  last_error TEXT,
  next_attempt_at TEXT,
  at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_delivery_sub_event ON webhook_deliveries (tenant_id, subscription_id, event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);`,
  tenantTables: ['webhook_subscriptions', 'webhook_deliveries'],
}];
