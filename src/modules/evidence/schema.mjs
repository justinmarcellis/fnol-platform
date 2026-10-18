// Migrations for the evidence module (modules.md#evidence). Both tables carry tenant_id.

export const migrations = [
  `CREATE TABLE IF NOT EXISTS documents (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    doc TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_documents_claim ON documents (tenant_id, claim_id, uploaded_at)`,
  // doc holds the extraction (fields, labels, summary) encrypted with encryptPii: it can quote PII.
  `CREATE TABLE IF NOT EXISTS extractions (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    status TEXT NOT NULL,
    doc TEXT NOT NULL,
    ai_provider TEXT,
    ai_model TEXT,
    confidence REAL,
    completed_at TEXT,
    PRIMARY KEY (tenant_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS ix_extractions_doc ON extractions (tenant_id, document_id)`,
];
