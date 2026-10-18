# Setup guide

Everything here uses synthetic, fictional data. No real carriers, people or secrets.

## Prerequisites
- Node 22 or newer (`node --version`). The platform uses the built-in `node:sqlite`, so there is nothing to `npm install`.
- Git and a shell. No database server, no Docker needed for local work.

## Quick start
```
npm run seed    # optional: seeds policies and writes data/dev-users.json
npm start       # platform on :8080, dashboard on :8090 if present
```
`npm start` runs `scripts/dev.mjs`. It creates `.secrets/`, runs the seed script only when the database is missing or empty, then starts the platform. Open http://localhost:8080/ and check http://localhost:8080/healthz.

The apps are served at `/` (claimant), `/csr`, `/adjuster` and `/admin`.

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
| `NODE_ENV` | unset | `production` turns dev mode (and the token endpoint) off |

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

## Reset
```
rm -rf data .secrets && npm run seed
```

## Troubleshooting
- Port in use: `PORT=8081 npm start`.
- `ExperimentalWarning` noise: use the npm scripts, which pass `--disable-warning=ExperimentalWarning`.
- "skip policies" in seed output: `tests/synthetic/index.mjs` or the coverage module is missing in your checkout; pull the latest.
- Tokens rejected after a reset: the signing key derives from the master key, so reissue tokens after deleting `.secrets/`.
