# Setup guide

Everything here uses synthetic, fictional data. No real carriers, people or secrets.

## Prerequisites
- Node 22 or newer (`node --version`). The platform uses the built-in `node:sqlite`, so there is nothing to `npm install`.
- Git and a shell. No database server, no Docker needed for local work.

## Quick start
```
npm start       # seeds and loads demo claims on a new database, then serves the platform on :8080
```
`npm start` runs `scripts/dev.mjs`. It creates `.secrets/`. When the database is missing or empty it runs `scripts/seed.mjs` (policies and dev users) and then `scripts/demo-data.mjs` (demo claims). It then starts the platform and the dashboard (:8090) if present, and prints the demo URLs and a bearer token for every dev user.

## Demo URLs
| URL | What |
| --- | --- |
| http://localhost:8080/ | Claimant app |
| http://localhost:8080/csr | CSR app |
| http://localhost:8080/adjuster | Adjuster workbench |
| http://localhost:8080/admin | Admin console |
| http://localhost:8080/healthz | Health |
| http://localhost:8090/ | Dashboard (if `dashboard/server.mjs` starts; needs port 8090 free) |

Authenticated checks with a printed token (use a supervisor token for KPIs):
```
curl -H "Authorization: Bearer <token>" "http://localhost:8080/api/v1/adjuster/inbox?mine=false"
curl -H "Authorization: Bearer <supervisor token>" http://localhost:8080/api/v1/kpis
curl -H "Authorization: Bearer <token>" http://localhost:8080/api/v1/claims
```
The inbox defaults to `mine=true` (claims assigned to the token's `sub`). Routing assigns adjusters named in the tenant config (for example `adj-aur-302`), not the dev users, so use `mine=false` or `queue=<queue>` to see the demo claims.

## Demo data
`scripts/demo-data.mjs` (`npm run demo`) boots the app on port 0 and, for every tenant in `tenants/*.json`, generates every scenario in `SCENARIOS` (from `tests/synthetic/index.mjs`) whose line of business is enabled, repeating with new deterministic seeds until the tenant has at least 12 claims (about 14 to 15 today). For each tenant it:
1. Seeds the scenario policies through `coverage.seedPolicies` first.
2. Creates each claim through `ctx.forTenant(tenantId).modules.claims.createClaim` (never SQL) with an idempotency key `demo:<tenant>:<scenario>:<seed>`.
3. Waits for the event pipeline to settle (`bus.drain`), then walks a planned, legal path of status changes so the claims spread across `assigned`, `in_review`, `pending_info` and `closed`, and adds a task (some completed) and a note.

A failure on one claim is logged (`fail <tenant>/<scenario>#<seed>: ...`) and skipped. The last line is a summary, for example `demo-data summary: created 29, existing 0, failed 0, policies 29`. Running it again creates nothing new (`existing` counts the claims already there). Options for `demoData(opts)`: `minPerTenant`, `seed`, `createApp`, `importSynthetic`, `log`.

## What the seed script does
`scripts/seed.mjs` boots `createApp` on port 0 (nothing listens), then for each tenant in `tenants/*.json` and each enabled line of business:
1. Calls `generatePolicies({ tenantId, lob, count: 25, seed: 42, state })` from `tests/synthetic/index.mjs`, where `state` is the first state of the LOB.
2. Loads them through `ctx.forTenant(tenantId).modules.coverage.seedPolicies(...)`.

It then writes `data/dev-users.json`, prints a token for every dev user, and closes the app.

It is defensive: if `tests/synthetic/index.mjs` or the coverage service is missing, that step is skipped with a message and the rest still runs. It is idempotent: policies are replaced by policy number, and the users file is rewritten with identical content. Tokens are printed but never stored.

## Dev users and tokens
Each tenant gets one fictional user per role: claimant, csr, adjuster, supervisor, carrier_admin, platform_admin (for example `dev-kestrel-point-csr`, email `csr@kestrel-point.example`). They are listed in `data/dev-users.json`.

Use a printed token:
```
curl -H "Authorization: Bearer <token>" http://localhost:8080/api/v1/audit
```
Or mint one in dev mode:
```
curl -X POST http://localhost:8080/api/v1/auth/token -H 'content-type: application/json' \
  -d '{"tenantId":"kestrel-point","sub":"dev-kestrel-point-csr","roles":["csr"],"name":"Riley Csr"}'
```
The token endpoint returns 404 unless dev mode is on. Only `platform_admin` may send `X-Tenant-Id` to act in another tenant.

## Environment variables
| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | 8080 | Platform port (`npm start`) |
| `FNOL_DB_PATH` | `data/fnol.db` | SQLite file |
| `FNOL_DEV_USERS_PATH` | `data/dev-users.json` | Where the seed writes dev users |
| `FNOL_DEV_MODE` | unset | `1` turns dev mode (token endpoint, demo personas) on; anything else is off. `npm start` enables it for local use unless this is set. `NODE_ENV` does not affect it |

## Tests
```
npm test                  # everything
npm run test:unit
npm run test:e2e
node --test --disable-warning=ExperimentalWarning tests/unit/scripts/seed.test.mjs   # one file
```
Tests use temporary databases and local fakes; they do not touch `data/`.

## Secrets and local files
`.secrets/` (master key), `data/` and `*.db` are gitignored. Never commit them. The master key is generated on first boot; deleting it makes existing encrypted data unreadable, so reset by deleting `data/` and `.secrets/` together.

## Tenant seeding (seed-once)
`tenants/*.json` are seeds, not the source of truth after first boot. On every start `loadDir()` applies a file only when the tenant has no stored config, or when the file's top-level `seedVersion` (missing means 0) is greater than the `seedVersion` in the stored config (missing means 0). Otherwise the file is skipped and a log line says so (`tenant config applied` or `tenant config skipped`, with `tenantId`, `reason` and both seed versions; config contents are never logged). A tenant edited in the console (stored via `put()`) is therefore not overwritten by a restart.

To force a re-seed of a tenant from its file, bump `seedVersion` in the file (for example 1 to 2) and restart. The file then overwrites the stored config as a new version.

Console edits must carry `seedVersion` forward. If an edit drops the field, the stored config is treated as `seedVersion` 0 and any file with a higher value will overwrite the edit on the next start.

`npm run demo:reset` wipes `data/`, so no stored configs remain and every tenant file is applied again on the next boot (a full reseed).

## Reset
Demo reset keeps `.secrets/` (so the master key and token signing stay valid), wipes `data/`, reseeds and reloads demo claims:
```
npm run demo:reset
```
Full reset, including the master key (existing tokens stop working):
```
rm -rf data .secrets && npm run seed && npm run demo
```

## Clean-clone procedure
```
git clone <repo-url> fnol && cd fnol    # Node 22+, nothing to npm install
npm start                               # first run: seed + demo claims, then serves on :8080
curl localhost:8080/healthz             # expect {"ok":true,...,"tenants":2}
```
Use `PORT=8081 npm start` if 8080 is busy. A second `npm start` finds a non-empty database and skips seeding and demo data.

## Troubleshooting
- Port in use: `PORT=8081 npm start`.
- `ExperimentalWarning` noise: use the npm scripts, which pass `--disable-warning=ExperimentalWarning`.
- "skip policies" in seed output: `tests/synthetic/index.mjs` or the coverage module is missing in your checkout; pull the latest.
- Tokens rejected after a reset: the signing key derives from the master key, so reissue tokens after deleting `.secrets/`.
