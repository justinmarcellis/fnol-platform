// triage_results table (modules.md#triage). Additive columns: input_hash, source_event_id.
export const migrations = [
  `CREATE TABLE IF NOT EXISTS triage_results (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    severity_score INTEGER NOT NULL,
    complexity TEXT NOT NULL,
    fraud_score INTEGER NOT NULL,
    subrogation INTEGER NOT NULL DEFAULT 0,
    doc TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    confidence REAL NOT NULL,
    input_hash TEXT,
    source_event_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_triage_results_attempt ON triage_results (tenant_id, claim_id, attempt)',
];
