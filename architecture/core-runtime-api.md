# Core runtime API (as built in S0-PLT-01)

Code against this. Source of truth is `src/core/*.mjs`.

S0-PLT-01 is built to ADR-001 with zero runtime dependencies, and `npm test` passes (35 of 35). That count includes another team's dashboard tests. The ticket is set to review.

I booted `scripts/dev.mjs` on a test port; it printed the platform URL and started the dashboard. I deleted the `data/` and `.secrets/` it created. I have not run `npm start` on the default port 8080. `.github/workflows/ci.yml` exists but has not been run.

**`createApp(opts)`** is async. Options are `{dbPath (default data/fnol.db, or env FNOL_DB_PATH), port (default 8080, 0 for tests), secretsDir, tenantsDir, modulesDir, webDir, devMode (default NODE_ENV!=='production'), logLevel, clock, host}`. It returns `{server, ctx, port, url, close()}`.

**Boot order**
- Core migrations run first, then each module's migrations (modules loaded in sorted order).
- Then `tenants/*.json` load.
- Then the auth and audit routes register.
- Then each module's optional `init(ctx)` runs. Whatever it returns is stored as `ctx.modules[name]`.
- Then `routes(router, ctx)` and `subscribe(bus, ctx)` are called.
- Finally pending outbox events are re-dispatched.

**`ctx` fields**
- `ctx.config` is `{devMode, dbPath, secretsDir, tenantsDir}`.
- `ctx.clock`, `ctx.log`, `ctx.modules`, `ctx.moduleNames`, `ctx.HttpError`.
- `ctx.ai` is null unless `src/ai/index.mjs` exports `createAi(ctx)`; then it is set to that result.

**Store (`ctx.db`)**
- `forTenant(tenantId)` returns `{tenantId, get(sql, ...params), all(...), run(...) → {changes, lastInsertRowid}, insert(table, obj), update(table, id, patch) → changes, transaction(fn)}`.
  - SELECT, UPDATE and DELETE on tenant tables are rewritten to filter by tenant; the tenant filter is bound as a named parameter.
  - Raw `INSERT INTO <tenant table>` throws; use `insert()`.
  - Comma joins on tenant tables throw; use `JOIN`.
  - `insert()` and `update()` take object values and convert them to JSON automatically.
  - `update()` matches on an `id` column.
  - `transaction(fn)` must be synchronous; nested calls use savepoints.
- `system` has `{get, all, run, insert, update, transaction}` and throws on any query that touches a tenant table.
- `migrate(moduleName, migrations)` takes strings or `{sql, tenantTables?, systemTables?}`; it is idempotent and tracked in `_migrations`. Any table created with a `tenant_id` column is auto-registered as a tenant table unless it is listed in `systemTables`.
- `registerTenantTables(names)`, `isTenantTable(name)`, `tenantTables()`.
- `id(prefix)` gives e.g. `clm_<20 hex>`; `toJson(v)`, `parseJson(str, fallback)`.
- `raw` is the DatabaseSync handle, for tests only.
- `defineMigration` is also exported from `store.mjs`.

**Crypto (`ctx.crypto`)**
- `encryptPii(tenantId, value)`, `decryptPii(tenantId, value)`, `hmacIndex(tenantId, value)`.
- `deriveKey(tenantId, info)`, `isEncrypted(v)`.
- `null` passes through. `decryptPii` returns non-encrypted strings unchanged and throws on tampering or the wrong tenant.

**Audit (`ctx.audit`)**
- `record(tenantId, {actor, action, entityType?, entityId?, details?})` returns the row.
- `list(tenantId, {actor, action, entityType, entityId, since, until, limit, offset, order})`.
- `verify(tenantId)` returns `{ok, brokenAt, count}`.
- The table has update and delete triggers that abort, so it is append-only.
- `GET /api/v1/audit` takes the same filters (camelCase) plus `verify=true`. It requires supervisor, carrier_admin or platform_admin.

**Bus (`ctx.bus`)**
- `publish(tenantId, type, subject, data)` returns a CloudEvents-style envelope `{specversion, id, source, type, subject, time, tenantid, datacontenttype, data}`. The event is written to the outbox and dispatched asynchronously.
- `on(type|'*', handler)` returns an unsubscribe function. The handler gets the event envelope.
- Each handler is tried up to 3 times. The outbox row ends as `delivered` or `failed`, with `attempts` and `last_error` recorded.
- `drain()`, `recover(tenantIds)`, `outbox(tenantId, status?)`.

**Tenants (`ctx.tenants`)**
- `get(id)` returns the parsed latest config or null.
- `put(id, config, actor)` returns `{version, changed}`. An identical config is a no-op, and a put is audited.
- `addValidator(fn)` takes a function returning `string[]`; `validate(config)`.
- `version(id)`, `history(id)`, `list()`, `loadDir()`.
- Tenant id is `config.id`, or the file name if `id` is absent.

**Auth (`ctx.auth`)**
- `issueToken({sub, tenantId, roles, name, ttlSeconds})`, `verifyToken(token)`, `authenticate(req)`.
- `hasRole(user, roles)`, `requireRole(user, roles)`, `ROLES`.
- The token-signing key is derived from the master key, so there is no extra secret to manage.
- `POST /api/v1/auth/token` is public and dev mode only (404 otherwise).
- On authenticated routes, `req.user` is `{sub, tenantId, roles, name}` and `req.tenant` is `{id, config}`.
- `X-Tenant-Id` is accepted only from platform_admin; anyone else gets 403.

**Router (`ctx.router`)**
- Methods are `get/post/put/patch/delete(pattern, handler, {roles?, public?})`. Handlers receive `(req, res)`.
- `req` has `params`, `query` (repeated keys become arrays), `body`, `path`, `user` and `tenant`.
- `res.json(status, body)` is available. Errors use the `{error: {code, message}}` envelope, and a thrown `HttpError(status, code, message)` maps to it.
- Request bodies over 15MB get 413.

**Logger**
- `ctx.log.{debug, info, warn, error}(msg, fields)` writes JSON lines and redacts keys matching `name|email|phone|dob|address|ssn|license|plate`.

**Clock**
- `ctx.clock` has `now()` (a Date), `nowIso()`, `set()`, `advance(ms)` and `reset()`.

**Static serving**
- `/`, `/csr`, `/adjuster` and `/admin` serve `src/web/<app>/index.html` if present.
- Other paths resolve under `src/web/`. Root-level asset paths fall back to `src/web/claimant/`, so the claimant app's relative assets work at `/`.

**Other files and scripts**
- `GET /healthz` returns `{ok, modules, tenants}`.
- `package.json` has `start`, `test`, `test:unit`, `test:e2e` and `seed`, all with `--disable-warning=ExperimentalWarning`.
- `scripts/dev.mjs` ensures `.secrets/`, runs `scripts/seed.mjs` only if the db file is missing or empty, starts the platform, and starts `dashboard/server.mjs` with `PORT=8090` if it exists.

## Assumptions made by the platform IC
- platform_admin passes every per-route role check.
- req.tenant is {id, config}, where config is the latest tenant config or null.
- ctx.audit.record takes tenantId as its first argument, so audit entries always belong to a named tenant.
- Table, column and schema names in the store helpers are validated as plain identifiers. SQL rewriting is regex-based, so it covers ordinary SELECT, UPDATE, DELETE and JOIN statements but not CTE names that shadow tenant tables or table names inside string literals.
- tenant_configs is a system table (read across tenants at boot). The outbox and audit_log are tenant tables.
- scripts/seed.mjs runs before the server starts when the db file is missing or empty. A seed script that needs migrated tables should call createApp itself.
- The 15MB body limit returns 413. On oversized bodies the client may instead see a connection reset.
- The optional src/ai/index.mjs hook (exporting createAi(ctx)) is a guess at the AI team's entry point and can be changed.
- If scripts/seed.mjs does not exist, `npm run seed` simply fails.
