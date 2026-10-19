// Migrations for the coverage module. Every table carries tenant_id, so core
// registers them as tenant tables and the store filters every query by tenant.

export const migrations = [
  // Mock PAS data, owned by adapters/mock-pas.mjs. PII lives encrypted in `pii`;
  // the *_idx columns hold comma-delimited HMAC blind indexes (",h1,h2,"), never plaintext.
  `CREATE TABLE IF NOT EXISTS coverage_policies (
    tenant_id TEXT NOT NULL,
    policy_number TEXT NOT NULL,
    lob TEXT NOT NULL,
    doc TEXT NOT NULL,
    pii TEXT,
    last_name_idx TEXT,
    postal_idx TEXT,
    vin_idx TEXT,
    phone_idx TEXT,
    PRIMARY KEY (tenant_id, policy_number)
  )`,
  // Cache of snapshots retrieved through the policy port.
  `CREATE TABLE IF NOT EXISTS policy_snapshots (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    policy_number TEXT NOT NULL,
    as_of TEXT NOT NULL,
    doc TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_policy_snapshots_pn ON policy_snapshots (tenant_id, policy_number, as_of)`,
  `CREATE TABLE IF NOT EXISTS coverage_verifications (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    status TEXT NOT NULL,
    source_event_id TEXT,
    doc TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_coverage_verifications_claim ON coverage_verifications (tenant_id, claim_id, verified_at)`,
  `CREATE INDEX IF NOT EXISTS ix_coverage_verifications_evt ON coverage_verifications (tenant_id, source_event_id)`,
];
