// Claims module migrations. Every table has tenant_id, so core registers it as a tenant table.
export const migrations = [{
  sql: `
CREATE TABLE IF NOT EXISTS claims (
  tenant_id TEXT NOT NULL,
  id TEXT PRIMARY KEY,
  claim_number TEXT NOT NULL,
  status TEXT NOT NULL,
  lob TEXT NOT NULL,
  channel TEXT NOT NULL,
  policy_number TEXT,
  risk_state TEXT,
  severity INTEGER,
  queue TEXT,
  adjuster_id TEXT,
  fast_track INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  doc TEXT NOT NULL,
  reported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_number ON claims (tenant_id, claim_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_idem ON claims (tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims (tenant_id, status, reported_at);
CREATE TABLE IF NOT EXISTS claim_parties (
  tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_parties ON claim_parties (tenant_id, claim_id);
CREATE TABLE IF NOT EXISTS claim_vehicles (
  tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_vehicles ON claim_vehicles (tenant_id, claim_id);
CREATE TABLE IF NOT EXISTS claim_properties (
  tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_properties ON claim_properties (tenant_id, claim_id);
CREATE TABLE IF NOT EXISTS claim_notes (
  tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_notes ON claim_notes (tenant_id, claim_id, created_at);
CREATE TABLE IF NOT EXISTS claim_tasks (
  tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_tasks ON claim_tasks (tenant_id, claim_id, created_at);
CREATE TABLE IF NOT EXISTS claim_reserves (
  tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_reserves ON claim_reserves (tenant_id, claim_id);
CREATE TABLE IF NOT EXISTS claim_status_history (
  tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL, actor TEXT NOT NULL, reason TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claim_status_history ON claim_status_history (tenant_id, claim_id, at);
CREATE TABLE IF NOT EXISTS regulatory_timers (
  tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, definition_id TEXT NOT NULL,
  state TEXT NOT NULL, kind TEXT NOT NULL, started_at TEXT NOT NULL, warn_at TEXT, due_at TEXT NOT NULL,
  status TEXT NOT NULL, met_at TEXT, breached_at TEXT, doc TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_timer_def ON regulatory_timers (tenant_id, claim_id, definition_id);
CREATE INDEX IF NOT EXISTS idx_timer_sweep ON regulatory_timers (tenant_id, status, due_at);
CREATE TABLE IF NOT EXISTS claim_number_seq (
  tenant_id TEXT NOT NULL, year INTEGER NOT NULL, next INTEGER NOT NULL, PRIMARY KEY (tenant_id, year)
);`,
}];
