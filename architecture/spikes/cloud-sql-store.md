# Spike: Cloud SQL Postgres store adapter (S5-PLT-01)

Status: spike, design plus small proof. No migration of callers, no driver added. Owner: Platform (ic-platform-runtime-dev).

## What was built
| Path | Purpose |
|---|---|
| `src/core/store-port.mjs` | JSDoc async port (`StorePort`, `StoreHandle`) and `wrapSyncStore(store)` over the existing SQLite store. |
| `tests/conformance/store/suite.mjs` | `runStoreConformance(name, makeStore)`: 14 backend-agnostic cases. |
| `tests/conformance/store/sqlite.test.mjs` | Runs the suite on `createStore(':memory:')` via `wrapSyncStore`. |
| `tests/conformance/store/dialect.mjs` | `translateToPostgres(sql)`, pure string helper. |
| `tests/conformance/store/postgres-dialect.test.mjs` | Translates the real migrations from `bus.mjs`, `audit.mjs` and `webhooks/migrations.mjs`. |

Run: `node --test --disable-warning=ExperimentalWarning tests/conformance/store/*.test.mjs` (23 tests, no network, no pg driver).
`store.mjs`, `bus.mjs`, `crypto.mjs`, `auth.mjs`, `server.mjs` and `package.json` are untouched.

## 1. Sync to async port change
Today every store call is synchronous (`node:sqlite`). A network database cannot be, so the port is promise-based:

- `port.forTenant(tid)` returns a handle with `get/all/run` (parameterized SQL, same tenant rewriting), `insert`, `update`, `getById`, `list`, `count`, `delete`, `transaction`. `port.system` is the unscoped handle for non-tenant tables.
- `getById/list/count/delete` are new typed helpers (equality-only `where`, validated identifiers) so new code avoids raw SQL. Existing `get(sql, ...)` keeps its meaning, so `getById` is the by-id read.
- `port.migrate`, `port.close` are async. `id/toJson/parseJson` stay synchronous (pure).
- Rejections carry the backend error. The suite matches `/unique|duplicate/i` so both SQLite and Postgres messages pass.

`wrapSyncStore` is the strangler seam: callers move to `await` while the backend is still SQLite, so the change ships independently of any Postgres work.

## 2. transaction(fn) semantics
- Today: `transaction(fn)` requires a synchronous `fn` (an async one throws "must be synchronous"), takes `BEGIN IMMEDIATE`, nested calls use `SAVEPOINT sp_<depth>`.
- Port: `transaction(async (tx) => ...)`. Commit when `fn` resolves, rollback when it rejects, value passed through. All work inside must use `tx`; nested `tx.transaction` is a savepoint (inner failure rolls back only the inner part when the outer catches it).
- SQLite adapter: one connection, so top-level transactions are serialized and calls made outside the open transaction wait for it (conformance case "concurrent top-level transactions"). Without this, unrelated requests would silently join another request's transaction.
- Postgres adapter: one pooled client per transaction (`BEGIN` ... `COMMIT`/`ROLLBACK`), released in `finally`. Default isolation READ COMMITTED. Two behaviors differ from SQLite and need a decision per call site: (a) SQLite `BEGIN IMMEDIATE` serializes all writers, Postgres does not, so read-then-write patterns such as `SELECT COALESCE(MAX(seq),0)+1` in `bus.publish` (`src/core/bus.mjs:120`) and audit chain `seq` (`src/core/audit.mjs:47`) need `pg_advisory_xact_lock(hashtext(tenant))` or `SELECT ... FOR UPDATE`, otherwise the per-tenant unique indexes turn races into errors; (b) a serialization or deadlock error (`40001`/`40P01`) should retry the whole `fn`, so `fn` must be idempotent apart from its DB effects.
- No slow external I/O inside `fn` (webhook sends, AI calls): it pins a pool connection.

## 3. Inventory of raw prepare/exec callers (grep-verified 2026-10-19)
Command: `grep -rnE "\bprepare\(|\.exec\(['\`\"A-Z]|\.raw\b" src scripts`, with regex `.exec(` (RegExp) matches filtered out.

The brief expected about 17. The verified count is different and smaller in production code:

**Production code outside `store.mjs`: 0 raw `prepare()`/`exec()` callers.** Modules, AI, scripts and other core files reach the database only through `db.get/all/run/insert/update/transaction` (107 call sites in 15+ files, below).

**Inside `src/core/store.mjs`: 13 sites** (these are what the adapter replaces):

| file:line | Statement | Postgres approach |
|---|---|---|
| store.mjs:45 | `raw.exec('PRAGMA journal_mode/foreign_keys/busy_timeout')` | Drop. Use `statement_timeout`, `lock_timeout` on the connection; FKs always on. |
| store.mjs:52 | `prepare()` statement cache | Use `pg` named/prepared queries or none (pool does it). |
| store.mjs:61, 67, 71 | `BEGIN IMMEDIATE`, `SAVEPOINT`, `COMMIT`, `RELEASE`, `ROLLBACK [TO]` | Same verbs on a dedicated pool client (`BEGIN`, not `IMMEDIATE`). |
| store.mjs:154 | `prepare(finalSql)` in `exec()` (tenant rewrite, `:__tenant` named param) | Keep the regex rewriter; emit `$n` instead of named params. |
| store.mjs:194, 200, 216, 222 | `prepare().run()` in system/tenant `insert`/`update` | Parameterized `INSERT`/`UPDATE`; use `RETURNING` for changes. |
| store.mjs:234 | `CREATE TABLE IF NOT EXISTS _migrations` | Portable as is. |
| store.mjs:243, 246 | `raw.prepare(SELECT 1 FROM _migrations ...)`, `INSERT INTO _migrations` | Parameterized; wrap in a migration advisory lock so two Cloud Run instances do not race. |
| store.mjs:245 | `raw.exec(mig.sql)` multi-statement DDL | Run `translateToPostgres(sql)` (see section 4), one statement per `query()` or simple-query protocol. |

**Test-only `db.raw` users: 50 sites in 19 files** (`grep -rnE "\.raw\.(prepare|exec)\(|\braw\.prepare\(" tests`): `tests/security/{audit-chain,pii-leak,sec2-webhooks,sec2-rbac-pii,sec2-availability-ai,helpers}`, `tests/unit/{claims/pii (8), coverage/* (11), core/audit (4), core/outbox-sequence, adjuster, ai/inference-log, evidence/service (2), triage/events}`, `tests/integration/integrations/webhooks/adapters-wiring`. They assert on ciphertext at rest, read `sqlite_master`, tamper with `outbox.status` and probe the audit triggers. Approach: add a test-helper `rawQuery(sql, params)` on the port (test builds only) and change `sqlite_master` lookups to `information_schema.tables`. Not part of the production port.

Other SQLite-specific SQL in `src/` (not raw callers, but they matter): `CREATE TRIGGER ... RAISE(ABORT)` (`src/core/audit.mjs:21-24`), `ROW_NUMBER ... rowid` backfill (`src/core/bus.mjs:30-36`), `INTEGER PRIMARY KEY AUTOINCREMENT` in `webhooks/migrations.mjs:5,16`, `adapters/index.mjs:17,32`, `adapters/fake-core.mjs:6`. All five are handled by the translator. The `claims/service.mjs:78` comment already avoids `rowid`.

### Async ripple
- 107 `db.get/all/run/insert/update` calls (grep `\b(db|t|tdb)\.(get|all|run|insert|update)\(` in `src`) and 26 `transaction(` calls (`claims/service.mjs` 13, `claims/timers.mjs` 2, `evidence/service.mjs` 3, `integrations/webhooks/service.mjs` 3, `coverage/service.mjs` 2, `coverage/adapters/mock-pas.mjs`, `triage/service.mjs`, `core/audit.mjs:47`, `core/bus.mjs:120`) must all gain `await`, which makes their enclosing functions async, so route handlers and service methods up the call chain become async (handlers already are; many pure-looking service helpers are not).
- `bus.publish` is synchronous and used inside transactions (14 callers). It must become `await bus.publish(...)` using the caller's `tx`, so the outbox row commits atomically with the business write. Today `publish` opens its own `t.transaction`; with a port it must accept the open `tx` (or detect nesting via savepoint) and call `dispatch` only after commit, not inside it.
- `audit.record()` (`core/audit.mjs:47`) is called from inside transactions the same way and follows the same rule.
- Sync-only helpers that read the DB indirectly (config loaders, `tenants.mjs`, `scheduler` jobs) need the same pass; the scheduler already tolerates async jobs.
- Tests: `ctx.db` users in unit tests become `await`; mechanical but wide.

## 4. Dialect translation (proved by test)
`translateToPostgres` covers: PRAGMA removed; `INTEGER PRIMARY KEY AUTOINCREMENT` to `BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`; the correlated `ROW_NUMBER()` backfill to `UPDATE ... SET seq = x.rn FROM (...) x WHERE x.oid = outbox.id`; `rowid` to an explicit `_rowid` identity column added by a prelude `ALTER TABLE`; `RAISE(ABORT)` triggers to plpgsql function plus trigger; `?` to `$n` outside string literals.
Known limits: backfill order for rows with equal `created_at` is arbitrary in Postgres (identity values are assigned during the table rewrite), acceptable because the production database starts empty; `:__tenant` named parameters are not translated (the adapter's rewriter should emit `$n` directly); SQLite type affinity (TEXT JSON in `doc` columns) maps to `TEXT` first, `JSONB` later; `INSERT OR IGNORE/REPLACE`, `strftime`, `json_extract` do not appear in current `src/` and are not translated.

## 5. Cloud SQL connection
- Instance: Cloud SQL for PostgreSQL 16, private IP, in the same region as Cloud Run, HA off for the PoC.
- From Cloud Run: Cloud SQL connector via the built-in unix socket (`--add-cloudsql-instances`, host `/cloudsql/PROJECT:REGION:INSTANCE`), IAM database authentication with the service account (`cloudsql.client` + `cloudsql.instanceUser`), so no password in env or git. Fallback: password in Secret Manager mounted as env.
- Pool: `max` small (5 to 10 per instance, multiplied by Cloud Run max instances must stay under the instance connection limit; consider PgBouncer or Cloud SQL managed pooling if scaling out).
- Settings: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` (kills leaked transactions), UTC, SSL required for any TCP path.
- Config switch: `FNOL_DB_URL` (absent means today's SQLite file, so the default and tests are unchanged).
- Dependency: a driver (`pg`, MIT) is required. **ADR-001 says the core has zero runtime dependencies; adding `pg` conflicts with it and needs a director decision (ADR amendment).** Options for the director: (a) optional dependency loaded only when `FNOL_DB_URL` is set, as the AI SDKs are; (b) vendor a minimal wire-protocol client (not recommended); (c) stay on SQLite on a persistent volume for the PoC. This spike adds nothing to `package.json`.

## 6. Staged plan and rollback
1. Port and conformance suite (done here). Adopt `wrapSyncStore` in `server.mjs` behind `ctx.db`, no behavior change. Rollback: revert, nothing depends on it.
2. Async ripple, module by module (bus/audit first, then claims, coverage, evidence, integrations, triage, adjuster, kpi). Each module's own tests plus the conformance suite must stay green; ship per module. Rollback: per-module revert, backend is still SQLite.
3. Postgres adapter behind the port, in `src/core/store-pg.mjs` (needs the director decision above). Gate: it must pass `runStoreConformance` unchanged. The live check (below) runs it against a real instance, outside `tests/`.
4. Dual-run: run the conformance suite and the e2e suite against both backends in CI (Postgres service container), then shadow-write a staging environment and compare row counts and audit chain hashes.
5. Cutover: export SQLite per tenant, load with `COPY`, verify audit chain head hash per tenant, switch `FNOL_DB_URL`. Rollback: unset `FNOL_DB_URL` (SQLite file stays untouched and read-only until the next release); writes made on Postgres after cutover are lost unless exported back, so keep the window short and keep a pre-cutover Cloud SQL backup.

## 7. Risks
- Writer concurrency: SQLite serializes all writers; Postgres does not. `MAX(seq)+1` patterns (outbox, audit chain) become races without locks (section 2).
- Regex tenant rewriter (`store.mjs` `rewrite`, `scopeFrom`) was written for SQLite SQL; it must be re-verified for Postgres syntax (`::casts`, `$n`, `RETURNING`, `ILIKE`). Consider Postgres row-level security as defense in depth.
- Transactions that wrap external effects, or `bus.publish` dispatching inside a transaction, hold connections and can publish events for rolled-back data.
- Cold-start and connection limits on Cloud Run with a pool per instance.
- Latency: a loop of N sync queries becomes N network round trips; hot paths (kpi, adjuster inbox) may need batching.
- PII at rest: field-level `enc:v1:` ciphertext stays in the app, but disk encryption and backups are now Cloud SQL's (CMEK decision).
- Triggers: the audit append-only triggers must exist in Postgres or the audit guarantee silently disappears; the migration test asserts the translation, a live check must assert the behavior.
- Scope drift: ADR-001 conflict (section 5) blocks step 3 until decided.

## 8. Optional live check (not part of the test suite, not run here)
Lives outside `tests/` so `npm test` never needs a network. Sketch, to run by hand with a disposable Cloud SQL or local Postgres and a driver installed ad hoc (`npm i --no-save pg`):

```
FNOL_PG_URL=postgres://USER@/fnol_spike?host=/cloudsql/PROJECT:REGION:INSTANCE \
  node scripts/spikes/pg-live-check.mjs
```
The script (to be written when the director approves step 3) creates a `pg` pool, builds the Postgres `StorePort`, applies the translated real migrations, and calls `runStoreConformance('postgres', () => makePgPort(url))` through `node:test`, then drops the schema. No credentials in git; the URL comes from the environment.
