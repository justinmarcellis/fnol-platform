# COTS readiness assessment (S3-PRD-03)

Owner: ic-product-competitive-analyst · 2026-10-18 · VD-3, VD-7, REQ-01 · Synthetic data only; tenants are fictional.
Method: each gap was checked by reading the cited file in the tree at about 21:40Z. Ratings: **ready for pilot** only where code and tests back it, **gaps** where it is built but something blocks a pilot, **not started** where nothing exists. Effort: S = 1 sprint or less for one IC, M = 1-2 sprints for a squad, L = more than 2 sprints or needs cloud credentials.
Quality at assessment (`org/quality.json`, 2026-10-18T21:29:19Z): 979 tests, 948 passed, 0 failed, 31 neither passed nor failed (skipped or todo), `buildGreen: true`.

## Readiness by area

| Area | Rating | Evidence | Gaps (verified) | Effort |
| --- | --- | --- | --- | --- |
| Multi-tenancy | gaps | `src/core/store.mjs`, `src/core/tenant-context.mjs`, `tests/security/tenant-isolation.test.mjs`; review s.1 "tenant isolation held" (`architecture/security-review-s2.md`) | One shared SQLite file for all tenants (`store.mjs:1,44`); no per-tenant rate limit or quota anywhere in `src/` (no `429` or rate limiter; `architecture/overview.md` s.3 claims one); no database-per-tenant option | M |
| Configurability | gaps | `src/modules/config/`, `tenants/*.json`, admin UI `src/web/admin/` | Boot re-puts every `tenants/*.json` (`src/core/tenants.mjs:79`), so a restart overwrites console edits; `ai.humanConfirmRequired`, `redactPiiBeforeModel`, `maxTokensPerClaim` are never read in `src/`; full list in `docs/configuration-guide.md` s.10 | S |
| Integrations / adapters | gaps | `src/modules/coverage/adapters/mock-pas.mjs`, `src/modules/integrations/adapters/core-claims-suite.mjs`, `webhooks/` | Only a mock policy system and a generic core-claims adapter, no carrier system tested; tenants set `settings.fieldMapProfile` but code reads `settings.profile` (`adapters/index.mjs:76`, `tenants/kestrel-point.json:1180`), so both tenants push profile A; webhook signature has no timestamp (`webhooks/signing.mjs:52`, SEC2-020) | M |
| AI layer | gaps | `src/ai/cascade.mjs:76` (every provider wrapped by `guard`), `src/ai/guardrails.mjs`, `docs/ai-evaluation.md` | **No real Vertex run**: vertex results are replayed recorded fakes (`docs/ai-evaluation.md` Method); golden sets have 2-9 cases per task; live prompt-injection resistance unmeasured (SEC2-011); tenant AI safety settings unread (see Configurability) | M (needs credentials) |
| Security and compliance | gaps | `src/core/auth.mjs`, `src/core/crypto.mjs`, `tests/security/`, `docs/compliance-mapping.md` | **Dev tokens, no IdP/SSO**: HS256 tokens from a derived key (`auth.mjs:14,30`), no OIDC code in `src/`; `devMode` defaults on unless `NODE_ENV=production` (`src/server.mjs:69`), which opens the token endpoint (`auth.mjs:84`); **local master key, no Cloud KMS**: `.secrets/master.key` read from disk (`crypto.mjs:14-22`), no KMS call in `src/`; log redaction misses `dateOfBirth`, `description`, `body` (`src/core/log.mjs:1`); no retention or purge code; **regulatory timers illustrative** ("demo value ... not legal advice", `tenants/aurelia-mutual.json:1104`, `tenants/kestrel-point.json:1014`) and need counsel; **no SOC 2 evidence**, mapping only (`docs/compliance-mapping.md` s.4, `docs/security-overview.md`); open findings below | L |
| Operability | gaps | `Dockerfile`, `infra/cloudrun/service.yaml`, `.github/workflows/ci.yml`, `src/modules/health/index.mjs` | Every deploy command is NOT RUN (`docs/deployment.md`); CI never run (`docs/compliance-mapping.md` 314.4(c)(7)); no metrics, tracing or alerting (JSON logs only, `src/core/log.mjs`); no runbook or incident plan (compliance mapping 314.4(h)) | M |
| Scalability | not started | `src/core/bus.mjs:89`, `src/core/scheduler.mjs`, `infra/cloudrun/service.yaml:19,67` | **SQLite and in-process bus**: outbox dispatch via `setImmediate` in one process, interval scheduler in-process, `maxScale: "1"`, database on `emptyDir` (lost on restart); no Cloud SQL, Pub/Sub or Cloud Scheduler code in `src/`; **no load testing** (no load or throughput test in `tests/` or `scripts/`); capacity unknown | L |
| Data platform | not started | `src/modules/kpi/` (`GET /kpis` read API only) | No warehouse or analytics export, no backup (SQLite on `emptyDir`), no retention schedule in code; `docs/deployment.md` "Changes required" item 1 says no store adapter exists | L |
| UX / accessibility | gaps | `src/web/{claimant,csr,adjuster,admin}/`, `tests/ui/`, `src/web/shared/a11y-check.js` | a11y checks are advisory and never fail a build (`a11y-check.js:1`); no WCAG audit with assistive tech; **Spanish has no native-speaker review**: `es` strings written by agents (`src/web/claimant/strings.js:96`, `tenants/aurelia-mutual.json:10`), no review recorded in `product/` or `docs/` | S-M |
| Licensing | gaps | `docs/licenses.md`, `package.json` (empty `dependencies`) | Zero-dependency core is ready; `fast-sha256` (Unlicense) flagged for legal review; no product licence or EULA file in the repo; commercial terms unknown (`product/packaging.md` is hypotheses) | S |

## Open security findings (`architecture/security-review-s2.md`)

The review lists every finding as Open except SEC2-018 (fixed in tree). "Tree check" is my code reading after Sprint 3 edits, not a re-review; only a security re-review can close a finding.

| Id | Sev | Tree check 21:40Z | Id | Sev | Tree check 21:40Z |
| --- | --- | --- | --- | --- | --- |
| SEC2-001 | H | partly: `agent` still in intake roles with an ownership rule (`intake/routes.js:4`); contract change pending | SEC2-012 | M | appears fixed: claimant facts stay suggestions (`evidence/service.mjs:231-233`) |
| SEC2-002 | H | appears fixed: snapshot sealed (`coverage/service.mjs:49`) | SEC2-013 | M | **open**: `isSafeRegex` heuristic unchanged, accepts `(a\|aa)+$` (`rules/condition.js:94-97`) |
| SEC2-003 | H | partly: roles narrowed, PII masked (`fake-core.mjs:22-26`); still mounted outside dev mode | SEC2-014 | M | partly: guarded at evaluation (`intake/questions.js:16,160`); config validator does not check patterns |
| SEC2-004 | H | appears fixed: claimant ownership and view (`claims/routes.mjs:36,43`) | SEC2-015 | M | appears fixed: `checkAllowedHost` (`webhooks/service.mjs:83`, `worker.mjs:89`) |
| SEC2-005 | H | partly: `maxOutputLength` added (`evidence/parse.mjs:188`); still synchronous on the main thread | SEC2-016 | M | appears fixed: route passes only body, category, visibility (`claims/routes.mjs:66`) |
| SEC2-006 | H | appears fixed: length cap first (`evidence/routes.mjs:46`) | SEC2-017 | M | appears fixed: masking (`coverage/redact.mjs:4`, `evidence/routes.mjs:15`) |
| SEC2-007 | H | appears fixed: pinned address (`webhooks/worker.mjs:35-36`) | SEC2-019 | L | appears fixed (`webhooks/url-guard.mjs:59-61`) |
| SEC2-008 | M | appears fixed: `reasonCode` in event, text encrypted (`claims/service.mjs:267-278`) | SEC2-020 | L | **open**: no timestamp header (`webhooks/signing.mjs:52`) |
| SEC2-009 | M | appears fixed: output validated in `guard` (`ai/guardrails.mjs:5-6`) | SEC2-021 | L | **open**: `/healthz` returns modules and tenant count (`health/index.mjs:5`) |
| SEC2-010 | M | appears fixed: `tenantId` passed (`intake/conversation.js:54`) | SEC2-022 | L | **open**: `actor !== SYSTEM_ACTOR` compares the token `sub` (`triage/service.mjs:77`, `triage/routes.mjs:5`) |
| SEC2-011 | M | partly: sanitise and redact in `guard`; not measured on a live model | SEC2-023 | L | **open**: no `claim.pii.read` audit anywhere in `src/modules` |

Threat-model R2 (`devMode` default, `src/server.mjs:69`) is still open.

## Recommended path to first carrier pilot

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| 1. Close the PoC gaps (S-M) | SEC2-001/003/005/013/014/020-023 and R2 (`devMode` off by default); log redaction; seed tenant files only when no stored config; one canonical adapter profile key; read or remove the unread AI and queue settings | Security re-review shows 0 open high and 0 open medium; `tests/security` has no `t.todo`; `org/quality.json` shows 0 failed and the todo count falls from 31 |
| 2. Production foundation (L, needs GCP credentials) | Cloud SQL store adapter behind `store.mjs`; Pub/Sub bus and Cloud Scheduler; KMS-wrapped keys (`enc:v2`); OIDC with the carrier IdP; apply `infra/` to dev; run CI; backups | Deployed in dev from CI with immutable digests; 2 or more instances; restart loses no data; load test at a target volume agreed with the pilot carrier (target unknown today); no dev token path in production |
| 3. Carrier fit (M) | Counsel-confirmed timers for the pilot state and LOB; adapter mapped to the carrier's policy and claims sandbox; live Vertex evaluation on larger synthetic golden sets; native Spanish review; WCAG 2.1 AA audit; retention schedule | Carrier UAT scripts signed off; live-model metrics at or above the local baseline in `docs/ai-evaluation.md`; counsel memo on file; a11y audit has no blocking issue |
| 4. Limited pilot (M) | One state, one LOB, one channel, shadow mode first (platform suggests, carrier system decides), then live; pen test; SOC 2 readiness assessment started | Agreed KPIs from `GET /kpis` tracked against the hypotheses in `product/value-propositions.md`; no Sev-1 incident for the agreed period; go/no-go by carrier and product director |
