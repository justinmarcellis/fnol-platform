# Test report (S3-QE-02)

Owner: Quality Engineering. Date of run: 2026-10-18 (UTC, about 21:39 to 21:41). Node 22, zero dependencies.

## 1. How this was run

Full suite, with shell-expanded globs (Node 22 rejects bare directories). The glob matches the `npm test` pattern (`tests/**/*.test.mjs`):

```sh
bash -O globstar -c 'node --test --disable-warning=ExperimentalWarning tests/**/*.test.mjs'
```

Per top-level folder, the same command with `tests/<folder>/**/*.test.mjs`. The `.test.js` files are outside the `npm test` glob, so they were run separately:

```sh
bash -O globstar -c 'node --test --disable-warning=ExperimentalWarning tests/**/*.test.js'
```

The two QE files in this ticket, run on their own:

```sh
node --test --disable-warning=ExperimentalWarning tests/unit/integrations/docs/yaml-lite.test.mjs tests/security/routes.test.mjs
```

Result: 58 pass, 0 fail, 2 skipped (`GET /healthz` and `GET /auth/me` are documented but not registered in this tree), 2 todo (known contract gaps).

## 2. Totals per top-level folder (`.test.mjs`, the npm test glob)

Counts are from the runner summary of each folder run. Tests and subtests count separately, so the sum is the runner total.

| Folder | Tests | Pass | Fail | Skipped | Todo |
|---|---:|---:|---:|---:|---:|
| tests/unit | 625 | 625 | 0 | 0 | 0 |
| tests/integration | 26 | 26 | 0 | 0 | 0 |
| tests/security | 188 | 150 | 11 | 6 | 21 |
| tests/e2e | 188 | 176 | 11 | 0 | 1 |
| tests/ui | 17 | 17 | 0 | 0 | 0 |
| tests/synthetic | 20 | 20 | 0 | 0 | 0 |
| **Total (single full run)** | **1064** | **1014** | **22** | **6** | **22** |

The single full run matches the per-folder sum. Its runner duration was about 35 s.

Separately, the 14 `.test.js` files (not in the npm test glob): 114 tests, 114 pass, 0 fail, 0 skipped, 0 todo.

Status: **the suite is not green.** 22 failing tests, all outside this ticket's paths. See section 4.

## 3. REQ-01..REQ-25 traceability

Test names do not start with `REQ-xx`, so this map was built by grepping test titles by topic. Each entry names the tests that cover the requirement. Status: `pass` means the named tests pass in this run, `fail` means a named test fails, `partial` means part of the criteria has no test, and `not automated` means no test exists.

| REQ | Priority | Named tests (file :: title) | Status |
|---|---|---|---|
| REQ-01 Omnichannel intake | M | e2e/dod.test.mjs :: "DoD: ${lob} via ${channel} (${role})"; tests/integration/workflow/intake-to-claim.test.js :: "guided session submits into claims.createClaim with a mapped ClaimCreate" | pass |
| REQ-02 Conversational intake | M | tests/integration/workflow/intake-to-claim.test.js :: "conversational flow: narrative -> confirm suggestions -> submit; provenance reaches the claim"; tests/unit/ai/providers/local.test.mjs :: "rear-end narrative: other party at fault" | pass |
| REQ-03 LOB-adaptive questions | M | tests/unit/intake/session.test.js :: "a question added in tenant config appears with no code change; removed set expires sessions"; tests/e2e/tenant-differences.test.mjs :: "questions shown for the same glass claim differ between tenants" | pass |
| REQ-04 Multilingual intake and notifications | S | tests/unit/intake/session.test.js :: "es locale returns Spanish prompt and messages; unknown locale falls back to en"; tests/ui/claimant.test.mjs :: "Spanish toggle switches labels on Aurelia". Notifications in another language: no test | partial |
| REQ-05 Evidence capture with AI extraction | M | e2e/dod.test.mjs :: "upload (PDF, PNG, scenario documents) and extraction"; tests/unit/evidence/service.test.mjs :: "event triggers extraction; fields carry confidence and provenance; event has no PII"; "simple PDF text is extracted; unreadable PDF needs review without calling AI" | pass |
| REQ-06 Coverage verification | M | tests/unit/coverage/verify.test.mjs :: "evaluateCoverage: ${name}" and "unsupported LOB with an existing policy needs review"; tests/unit/coverage/commercial-auto.test.mjs :: "hired auto without HNOA purchased is excluded"; e2e/dod.test.mjs :: "coverage verified" | pass |
| REQ-07 Severity and complexity scoring | M | tests/unit/triage/service.test.mjs :: "band cut-offs: <25 minor, <50 moderate, <75 major, else severe"; "complexity rises with parties, injuries and coverage issues"; e2e/dod.test.mjs :: "triage: severity, fraud, subrogation, explanation" | **fail** (e2e: `severityBand` expected "major", got "severe" for three scenarios; see section 4) |
| REQ-08 Fraud and anomaly indicators | M | tests/unit/triage/fraud.test.mjs :: "LOSS_NEAR_INCEPTION fires at 30 days and not at 31 or before inception"; "PRIOR_CLAIMS fires at two or more prior claims"; tests/ui/adjuster.test.mjs :: "fraud item: note is required, accept records a decision" | pass |
| REQ-09 Subrogation flag | M | tests/unit/triage/service.test.mjs :: "subrogation flags citedParty, other-at-fault and rear-ended-by-other; insured at fault blocks it"; tests/unit/triage/calibration.test.mjs :: "... read a rear-end narrative as subrogation" | pass |
| REQ-10 Configurable routing | M | tests/unit/rules/routing.test.js :: "first route_queue wins (lowest priority number); default queue is used when no rule routes"; "deny_fast_track beats fast_track and records the reason"; e2e/dod.test.mjs :: "routing decision" | pass |
| REQ-11 Straight-through processing | M | tests/unit/config/demo-tenants.test.mjs :: "Aurelia fast-tracks a covered glass-only claim"; "Kestrel never fast-tracks commercial auto, even when triage marks the claim eligible"; tests/unit/rules/routing.test.js :: "guards block fast track: severity, fraud, estimate, coverage, triage flag, tenant switch" | pass |
| REQ-12 Instant acknowledgment and claimant status | M | tests/ui/claimant.test.mjs :: "claimant (Aurelia) completes guided intake to a claim number and status page"; tests/unit/web/claimant/status.test.mjs :: "polls on the interval and stops at a terminal status"; tests/unit/adjuster/adjuster.test.mjs :: "view includes reportedAt, acknowledgedAt and assignedAt" | partial (the instant-acknowledgment message itself has no dedicated test) |
| REQ-13 No-code carrier configuration | M | tests/unit/config/validator.test.mjs :: "required, properties and additionalProperties report JSON-pointer paths"; tests/ui/admin.test.mjs :: "invalid values show inline errors from /config/validate and nothing is saved"; "a stale version is rejected with a conflict banner (If-Match)" | pass |
| REQ-14 Regulatory timers | M | tests/unit/claims/timers.test.mjs :: "business-day math skips weekends and holidays"; "sweepTimers publishes due once at warnAt and breached once at dueAt, then applies onBreach"; e2e/tenant-differences.test.mjs :: "regulatory timers differ between tenants" | pass |
| REQ-15 Adjuster first view | M | tests/unit/adjuster/adjuster.test.mjs :: "getFirstView returns a schema-valid doc with all sections"; tests/ui/adjuster.test.mjs :: "adjuster signs in, sees the inbox and the claim summary with every panel"; e2e/dod.test.mjs :: "adjuster view with AI summary" | **fail** in e2e ("adjuster first view", same `severityBand` mismatch as REQ-07); unit and UI pass |
| REQ-16 Integration events and webhooks | M | tests/integration/integrations/webhooks/webhooks-http.test.mjs :: "end to end: a real bus event is POSTed to a real receiver with a valid signature, then retried until it succeeds"; tests/unit/integrations/webhooks/signing.test.mjs :: "sign is HMAC-SHA256 hex of the raw body"; e2e/dod.test.mjs :: "claim.routed webhook delivered with a valid HMAC signature" | pass |
| REQ-17 Sample core-suite adapter | M | tests/integration/integrations/adapters/adapters.test.mjs :: "pushClaim (manual route) syncs through the fake core, records core_sync, sets the external ref, audits"; "previewMapping honours the tenant profile (B is flat) and 404s unknown adapter or claim"; e2e/dod.test.mjs :: "core-suite adapter received the mapped ACORD-aligned payload" | pass |
| REQ-18 Tenant isolation | M | tests/security/tenant-isolation.test.mjs :: "isolation: a claim created by tenant A is invisible to tenant B"; "tenant-B token gets 404/403 for tenant-A resources on every registered {id} route"; tests/security/sec2-rbac-pii.test.mjs :: "sec2: tenant B cannot read or change tenant A claims, documents, webhooks, intake sessions or routing" | tenant-isolation.test.mjs pass; the sec2 cross-tenant test **fail** (section 4) |
| REQ-19 Role-based access control | M | tests/security/roles.test.mjs :: "roles: no token gets 401, wrong role gets 403, allowed roles are never 401/403"; tests/security/audit-chain.test.mjs :: "audit chain: only audit-reading roles can query /audit"; tests/security/routes.test.mjs :: "openapi: role matrix has not drifted from the checked-in snapshot"; tests/unit/kpi/routes.test.mjs :: "other roles and anonymous callers are refused" | **fail** in roles.test.mjs (documented carrier_admin refused on intake and routing routes); routes.test.mjs snapshot test pass |
| REQ-20 PII encryption | M | tests/security/pii-leak.test.mjs :: "pii: encrypted columns hold ciphertext only, outbox and audit stay clean, tenants cannot cross-decrypt"; "pii: logger redacts PII keys, including nested fields"; tests/unit/core/crypto.test.mjs :: "crypto: per-tenant keys differ; wrong tenant and tampering fail" | pass |
| REQ-21 Audit trail | M | tests/security/audit-chain.test.mjs :: "audit chain: field tamper is rejected and stays inside the tampered tenant"; "audit chain: append-only triggers block update and delete"; tests/unit/core/audit.test.mjs :: "audit: chain verifies, per-tenant chains, filters via API" | pass |
| REQ-22 Two differently configured demo tenants | M | tests/e2e/tenant-differences.test.mjs :: "branding differs between tenants"; "lines of business differ between tenants"; tests/unit/config/demo-tenants.test.mjs :: "${name} validates with the real rule validator"; tests/ui/claimant.test.mjs :: "Kestrel branding differs from Aurelia (name and brand colour token)" | pass |
| REQ-23 Value-driver KPI instrumentation | S | tests/unit/kpi/service.test.mjs :: "fixture tenant: expected value, numerator and denominator for every metric"; "tenants are isolated"; tests/unit/kpi/routes.test.mjs :: "allowed roles get the contract shape"; tests/ui/admin.test.mjs :: "history and KPI panels render data or a 404 fallback" | pass |
| REQ-24 Commercial auto line | C | tests/unit/coverage/commercial-auto.test.mjs :: "fleet unit removed before the loss date is not on the policy"; "hired auto without HNOA purchased is excluded"; tests/unit/config/demo-tenants.test.mjs :: "Kestrel commercial_auto question set covers fleet, compliance, cargo and recovery questions" | pass (no e2e scenario for commercial auto is named) |
| REQ-25 Explainable, overridable AI | M | tests/unit/ai/guardrails.test.mjs :: "sanitize: neutralises override phrases, role tags and fenced system blocks (case-insensitive)"; "guard: injection markers never reach the provider"; tests/unit/ai/eval.test.mjs :: "runEval on the real golden set covers every task and leaks no PII"; tests/ui/adjuster.test.mjs :: "fraud item: note is required, accept records a decision" | partial (SEC2-016 todo: a note can forge AI provenance) |

Counting (25 REQs): 18 pass (REQ-01, 02, 03, 05, 06, 08, 09, 10, 11, 13, 14, 16, 17, 20, 21, 22, 23, 24). 4 have a failing named test (REQ-07, 15, 18, 19). 3 are partial (REQ-04, 12, 25). None is "not automated". Every priority M requirement has at least one named test, which meets the STRATEGY section 3 rule.

## 4. Failing and todo tests (the defects QE found)

The 22 failures are outside this ticket's paths. They were not fixed here. Each is for the owning team.

Failing (`fail`):

- `tests/security/roles.test.mjs`: "roles: no token gets 401, wrong role gets 403, allowed roles are never 401/403" (7 subtests). Documented role `carrier_admin` is refused with 403 on `POST /intake/sessions`, `GET /intake/sessions/{sessionId}`, `.../next-question`, `.../answers`, `.../narrative`, `.../submit` and `POST /claims/{claimId}/routing`. This matches S3-WFL-01 (intake roles narrowed to claimant, csr, agent, integration), which the contract has not yet reflected.
- `tests/security/sec2-rbac-pii.test.mjs` and the `sec2-webhooks` group: cross-tenant test "sec2: tenant B cannot read or change tenant A claims, documents, webhooks, intake sessions or routing"; webhook tests fail with "url host not allowed: host is not in the tenant allowedHosts list" and "webhook and adapter routes require admin roles and secrets are shown once".
- `tests/e2e/dod.test.mjs` and `tests/e2e/scenarios.test.mjs`: "triage" and "adjuster first view" for `aurelia-mutual`, `kestrel-point` and `e2e-demo` with `auto_rear_end_injury`. Expected `severityBand` "major", got "severe". The band boundary or calibration differs from the scenario expectation.

Known defects tracked as `todo` (non-fatal, visible in the output): SEC2-001 to SEC2-022 in `tests/security/sec2-*.test.mjs`, plus the two contract todos in `tests/security/routes.test.mjs`:

- "contract: documented roles are all issuable by ctx.auth": passes in this run, so its `todo` marker is now stale and should be removed by the owner of `routes.test.mjs` (QE).
- "contract: registered route roles match documented x-roles": fails as a `todo`. The observed differences are the six intake routes and `POST /claims/{claimId}/routing` (`carrier_admin` documented, not registered). The same difference is the failing roles test above.

## 5. Changes made in this ticket

- `tests/security/routes.test.mjs`: the snapshot drift test now prints added, removed and changed operations, with the one-line refresh command. Exports `currentMatrix`, `matrixDiff`, `formatDrift` and `refreshSnapshot(file?, list?)`. The refresh is documented in the file header. Setting `FNOL_REFRESH_ROUTES=1` refreshes on load. Refresh writes only when content changes.
- `tests/unit/integrations/docs/yaml-lite.test.mjs`: the literal `'1.2.0'` and the fixed counts (`>= 38`, `> 38`) are replaced by a raw-text read of `info.version` (semver shape checked, parser must agree) and counts derived from the raw file (`paths` keys and `operationId` lines).
- `tests/security/routes.snapshot.json`: not changed. A refresh run produced identical content, so the file is untouched.

Refresh command (one line):

```sh
FNOL_REFRESH_ROUTES=1 node --test --disable-warning=ExperimentalWarning tests/security/routes.test.mjs
```
