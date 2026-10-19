// Migrations for the adjuster read models. Both tables carry tenant_id, so core registers them
// as tenant tables. adjuster_inbox is a projection and can be rebuilt from the outbox.
// Columns beyond modules.md (additive): claim_number, lob, complexity, next_timer, reported_at.

export const migrations = [
  `CREATE TABLE IF NOT EXISTS adjuster_inbox (
    tenant_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    claim_number TEXT,
    lob TEXT,
    queue TEXT,
    adjuster_id TEXT,
    status TEXT,
    severity INTEGER,
    complexity TEXT,
    next_due_at TEXT,
    next_timer TEXT,
    flags TEXT NOT NULL DEFAULT '[]',
    reported_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, claim_id)
  )`,
  'CREATE INDEX IF NOT EXISTS ix_adjuster_inbox_adjuster ON adjuster_inbox (tenant_id, adjuster_id, next_due_at)',
  'CREATE INDEX IF NOT EXISTS ix_adjuster_inbox_queue ON adjuster_inbox (tenant_id, queue, next_due_at)',
  `CREATE TABLE IF NOT EXISTS adjuster_summaries (
    tenant_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    triage_attempt INTEGER NOT NULL,
    doc TEXT NOT NULL,
    created_at TEXT,
    PRIMARY KEY (tenant_id, claim_id, triage_attempt)
  )`,
];
