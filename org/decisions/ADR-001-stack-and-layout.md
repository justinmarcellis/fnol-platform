# ADR-001: Stack, repository layout and module contract

Status: accepted · Owner: dir-platform (set by orchestrator in Sprint 0) · Date: 2026-10-18

## Decision
- **Runtime**: Node.js 22, ES modules, plain JavaScript with JSDoc types. No build step.
- **Core has zero runtime dependencies**: `node:http`, `node:sqlite`, `node:crypto`, `node:test`. Fewer dependencies means fewer licenses to clear for COTS (see `docs/licenses.md`).
- **Optional AI provider SDKs**, loaded only when credentials are configured: `@anthropic-ai/vertex-sdk` (MIT) for Claude on Vertex AI, `@google/genai` (Apache-2.0) for Gemini. Without credentials the deterministic `local` provider runs, so the PoC and its tests work offline.
- **UI**: static HTML + vanilla ES-module web components served by the platform. No framework, no bundler.
- **Storage**: one SQLite file per environment (`data/fnol.db`). Every tenant-owned table has `tenant_id`; the store layer adds the tenant filter to every query so a module cannot forget it.
- **Tests**: `node --test`. `npm test` runs unit + integration + e2e.
- **One command**: `npm start` seeds demo tenants and synthetic policies if the database is empty, then serves the platform on :8080 and the PM dashboard on :8090.

## Layout
```
src/server.mjs              entry: builds ctx, loads every src/modules/*/index.mjs
src/core/                   http router, auth (RBAC), tenancy, store, crypto (PII), audit, event bus + outbox, config loader, logger
src/ai/                     provider interface, providers (local, vertex-claude, vertex-gemini), cascade router, prompts
src/modules/<name>/         one bounded context per folder (intake, evidence, coverage, triage, rules, claims, integrations, config, adjuster)
src/web/<app>/              claimant, csr, adjuster, admin
tenants/<tenant>.json       carrier configuration (branding, LOBs, questions, rules, timers)
architecture/contracts/     openapi.yaml, events/*.schema.json, domain/*.schema.json
tests/{unit,integration,e2e,synthetic}
dashboard/                  PM dashboard (reads org/)
scripts/                    dev, seed, CI helpers
```

## Module contract
Every module exports a default object:
```js
export default {
  name: 'triage',
  migrations: ['CREATE TABLE IF NOT EXISTS ...'],   // run in order at boot
  routes(router, ctx) { router.post('/api/v1/claims/:id/triage', handler, { roles: ['adjuster'] }) },
  subscribe(bus, ctx) { bus.on('claim.reported', async (evt) => {...}) },
}
```
`ctx` provides: `db` (tenant-scoped store), `bus` (publish/on, persisted outbox), `audit.record()`, `crypto.encryptPii()/decryptPii()`, `ai` (cascade), `tenants.get(id)`, `log`, `clock`.
Handlers receive `(req, res)` where `req.tenant`, `req.user`, `req.params`, `req.body` are already resolved and `res.json(status, body)` is available.

## Consequences
Teams work in disjoint folders against `architecture/contracts/`. Cross-module calls go through events or `ctx.modules.<name>` service functions documented in the contracts, never direct imports of another module's internals.
