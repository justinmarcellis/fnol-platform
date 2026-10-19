# FNOL Platform: compliance mapping (v1, Sprint 1)

Status: draft for review · Owner: security (ic-security-threat-modeler) · Ticket: S1-SEC-01
Related: [../architecture/threat-model.md](../architecture/threat-model.md), [../architecture/data-protection.md](../architecture/data-protection.md), [security-overview.md](security-overview.md).

**Not legal advice.** This maps frameworks to platform controls so a licensee's compliance team can do its own assessment. Each licensee (the carrier) remains the regulated entity. The platform vendor acts as its third-party service provider. State deadlines below are **illustrative** placeholders, and the licensee must confirm them with counsel.

**Status values:**
- **Implemented**: in code today, with evidence you can run.
- **Planned (team)**: designed, not built.
- **Licensee**: a carrier or operator responsibility the product supports but cannot satisfy alone.

**Evidence paths:**
- `tests/unit/core/*.test.mjs` exists today.
- `tests/security/*.test.mjs` is delivered by ticket S1-SEC-02 and runs with `node --test --disable-warning=ExperimentalWarning tests/security/`.

## 1. GLBA Safeguards Rule (16 CFR Part 314)

For insurers, GLBA safeguards are enforced through state insurance law (see NAIC #668 below). The FTC rule's elements are still the common checklist that carriers apply to their service providers, so we map against them.

| Element | Requirement (summary) | Platform control | Evidence location | Status |
| --- | --- | --- | --- | --- |
| 314.4(a) | Qualified individual oversees the program | Security team owns this mapping and the threat model | `org/teams.json` (security), this file | Implemented (vendor). Licensee for its own program |
| 314.4(b) | Written risk assessment | STRIDE threat model, top-10 risks, residual risks | `architecture/threat-model.md` sections 3-7 | Implemented (v1) |
| 314.4(c)(1) | Access controls, least privilege | Signed bearer tokens, RBAC on every route, tenant from the token, `X-Tenant-Id` for `platform_admin` only | `src/core/auth.mjs`, `src/core/router.mjs`. `tests/unit/core/auth.test.mjs`, `tests/security/roles.test.mjs`, `tests/security/tenant-isolation.test.mjs` | Implemented (dev tokens). Planned (platform): OIDC, `claimIds` scoping |
| 314.4(c)(2) | Data and system inventory | PII inventory generated from `x-pii` | `architecture/data-protection.md` section 2 | Implemented |
| 314.4(c)(3) | Encrypt customer information at rest and in transit | AES-256-GCM per-tenant field encryption. TLS at the load balancer on GCP | `src/core/crypto.mjs`. `tests/unit/core/crypto.test.mjs`, `tests/security/pii-leak.test.mjs` | At rest: implemented. In transit: planned (platform, GCP LB) |
| 314.4(c)(4) | Secure development practices | Contract-first design, review checklist (tenant isolation, no PII in logs), zero-dependency core | `org/playbooks/standards.md`, `org/decisions/ADR-001-stack-and-layout.md` | Implemented |
| 314.4(c)(5) | Multi-factor authentication | Delegated to the licensee IdP (OIDC) | n/a in PoC | Planned (platform) + Licensee |
| 314.4(c)(6) | Secure disposal (no later than 2 years after last use unless retention is required) | Retention schedule, crypto-shred via per-tenant KMS keys | `architecture/data-protection.md` sections 4-5 | Planned (platform, workflow) |
| 314.4(c)(7) | Change management | Ticketed changes with acceptance review, contract registry, CI | `org/board/tickets/`, `org/contracts/registry.json`, `.github/workflows/ci.yml` | Implemented (process). CI not yet run |
| 314.4(c)(8) | Monitor and log user activity | Hash-chained, append-only audit log per tenant. JSON logs with redaction | `src/core/audit.mjs`, `src/core/log.mjs`. `tests/unit/core/audit.test.mjs`, `tests/security/audit-chain.test.mjs` | Implemented (core). Planned: access logging per request |
| 314.4(d) | Regular testing (continuous monitoring or annual pen test plus vulnerability scans) | Security regression suite on every change | `tests/security/*.test.mjs` | Planned (S1-SEC-02, in progress). Pen test: Licensee or vendor before GA |
| 314.4(e) | Staff training | n/a for the PoC | n/a | Licensee |
| 314.4(f) | Oversee service providers | This pack (threat model, data protection, mapping) is the vendor's due-diligence package | `docs/security-overview.md` | Implemented (documents) |
| 314.4(g) | Adjust the program | Sprint security backlog | `architecture/threat-model.md` section 8 | Implemented |
| 314.4(h) | Incident response plan | Audit plus logs give the timeline. A runbook is needed | n/a | Planned (security) |
| 314.4(i) | Report to the board | n/a | n/a | Licensee |
| 314.4(j) | Notify the regulator of security events | Supports the licensee with audit export (`GET /api/v1/audit?verify=true`) | `src/core/audit.mjs` `registerAuditRoutes` | Implemented (export). Notification: Licensee |

## 2. NAIC Insurance Data Security Model Law (#668)

| Section | Requirement (summary) | Platform control | Evidence location | Status |
| --- | --- | --- | --- | --- |
| 4.A-B | Information security program proportionate to risk | Threat model plus data-protection design | `architecture/threat-model.md`, `architecture/data-protection.md` | Implemented (v1) |
| 4.C | Risk assessment, including third-party providers | STRIDE per component and boundary, including AI providers and adapters | `architecture/threat-model.md` sections 3, 4, 6 | Implemented |
| 4.D(2)(a) | Access controls, including physical | RBAC, tenant isolation, master key `0600` | `src/core/auth.mjs`, `src/core/store.mjs`, `src/core/crypto.mjs`. `tests/security/tenant-isolation.test.mjs` | Implemented, with known defects R1 and R3 (threat-model.md section 5) |
| 4.D(2)(b) | Identify and manage data, devices and systems | PII inventory, tenant table registry | `architecture/data-protection.md` section 2, `store.tenantTables()` | Implemented |
| 4.D(2)(d) | Encrypt nonpublic information in transit and on external media | Field encryption. CMEK and TLS on GCP | `src/core/crypto.mjs` | At rest: implemented. Transit: planned (platform) |
| 4.D(2)(e) | Secure development for in-house applications | Standards, review checklist, security regression tests | `org/playbooks/standards.md`, `tests/security/` | Implemented / planned |
| 4.D(2)(g) | Multi-factor authentication | Licensee IdP | n/a | Planned + Licensee |
| 4.D(2)(h) | Monitoring to detect attacks and intrusions | Audit chain verification, error logs | `src/core/audit.mjs` `verify`, `src/core/log.mjs` | Partly implemented. Planned (platform): alerting on GCP |
| 4.D(2)(i) | Audit trails to detect and respond to cybersecurity events | Per-tenant hash-chained audit with tamper-evident `verify()` | `src/core/audit.mjs`. `tests/unit/core/audit.test.mjs`, `tests/security/audit-chain.test.mjs` | Implemented |
| 4.D(2)(k) | Secure disposal | Retention schedule and crypto-shred | `architecture/data-protection.md` sections 4-5 | Planned |
| 4.D(3) | Include cybersecurity in enterprise risk management | n/a | n/a | Licensee |
| 4.F | Third-party service provider oversight | Security overview, this mapping, contractual AI provider terms (no training) | `docs/security-overview.md`, `architecture/threat-model.md` section 6 | Implemented (documents). Licensee executes oversight |
| 4.H | Incident response plan | Runbook needed. Audit export supports the investigation | n/a | Planned (security) |
| 4.I | Annual certification to the commissioner | Vendor supplies this evidence pack | this file | Licensee |
| 5 | Investigation of a cybersecurity event | Audit filters by actor, entity and time window. Outbox history per tenant | `src/core/audit.mjs` `list`, `src/core/bus.mjs` `outbox` | Implemented |
| 6 | Notify the commissioner within 72 hours | Vendor-to-licensee notification clause. Per-tenant scoping lets affected tenants be identified | contractual | Licensee + vendor contract |

The NAIC Model Bulletin on the use of AI systems by insurers (2023) is related guidance. It is supported by AI provenance on every output, human confirmation, and explanations (threat-model.md section 6, AI-2 and AI-6). Status: planned (ai).

## 3. State claim-handling timelines (WI, IL, MI) — ILLUSTRATIVE

**How the platform implements deadlines (generic mechanism):**

1. **Definition.** A carrier configures `TenantConfig.timers[]`: `{ id, state, lobs, kind: acknowledge | contact | decide, duration: { value, unit: hours | days | business_days }, startOn, stopOn: { event, toStatus[], taskType }, warnBefore, onBreach[] }`, plus `holidays` for business-day maths (`architecture/contracts/domain/TenantConfig.schema.json`).
2. **Start.** The `claims` module owns timers (overview.md decision D2). When a timer's `startOn` event arrives (default `claim.reported`), claims creates a `RegulatoryTimer` for each definition that matches the claim's risk state and LOB, with `warnAt` and `dueAt`. The `citation` field records the tenant-entered source.
3. **Stop.** A timer is `met` when its `stopOn` event arrives. Examples:
   - acknowledge: `claim.status.changed` to `assigned`, or a completed `acknowledge` task
   - contact: a completed `contact_insured` task
   - decide: a status change carrying a decision
4. **Tick.** Driven by `ctx.clock` (`src/core/clock.mjs`, injectable for tests). It publishes `claim.timer.due` at `warnAt` and `claim.timer.breached` at `dueAt`, then runs `onBreach` actions (`notify`, `add_task`, `route_queue`, and so on). Every transition is audited.
5. **Pay deadlines.** Payment is made in the carrier's core claims system (overview.md: payment stays in the system of record). The platform's role is to hand the claim off promptly and record the external reference. The v1 `kind` enum has no `pay`, so a licensee can either:
   - track pay deadlines in the core system, or
   - model a pay timer as `kind: decide` with a `taskType` stop condition.

   An optional `pay` kind is proposed to the architecture hub for v1.1.

Status: mechanism planned (workflow, claims module). Evidence will be `tests/unit/claims/*` timer tests (workflow) and the e2e scenarios. No timer code exists yet.

**Illustrative seed values. Every value must be confirmed by the licensee's counsel against current law before use.**

| State | Kind | Illustrative duration | Starts on | Stops on | Reference to confirm |
| --- | --- | --- | --- | --- | --- |
| WI | acknowledge | 10 business days | `claim.reported` | status to `assigned` or acknowledge task done | Wis. Admin. Code Ins 6.11 (unfair claim settlement practices) |
| WI | decide | 30 days after proof of loss | proof-of-loss task done | decision recorded | Wis. Admin. Code Ins 6.11 |
| WI | pay | 30 days after written notice (core system) | n/a in v1 | n/a | Wis. Stat. 628.46 |
| IL | acknowledge | 15 business days | `claim.reported` | status to `assigned` or acknowledge task done | 50 Ill. Adm. Code 919 |
| IL | decide | 30 days after proof of loss, with a status letter if delayed | proof-of-loss task done | decision recorded | 50 Ill. Adm. Code 919 |
| IL | pay | 30 days after decision (core system) | n/a in v1 | n/a | 50 Ill. Adm. Code 919 |
| MI | acknowledge | 10 days (carrier policy) | `claim.reported` | status to `assigned` | MCL 500.2026 (unfair claim practices) |
| MI | decide | 30 days (carrier policy) | proof-of-loss task done | decision recorded | MCL 500.2006 |
| MI | pay | 60 days after satisfactory proof of loss (core system) | n/a in v1 | n/a | MCL 500.2006 |

The durations above are illustrative and configurable. They are not legal advice. Statutes change, and some deadlines depend on the line of business, on calendar vs business days, and on whether a claimant is represented. The platform supplies the mechanism and the audit trail. The carrier supplies the values.

## 4. SOC 2 (Trust Services Criteria 2017, revised points of focus 2022): CC6, CC7, CC8

| Criterion | Control | Implementation | Evidence location | Status |
| --- | --- | --- | --- | --- |
| **CC6.1** Logical access security, encryption | Tenant-scoped store. Per-tenant field encryption. Master key file permissions | `src/core/store.mjs` `forTenant`, `src/core/crypto.mjs` | `tests/unit/core/store.test.mjs`, `tests/unit/core/crypto.test.mjs`, `tests/security/tenant-isolation.test.mjs`, `tests/security/pii-leak.test.mjs` | Implemented, with defects R1 and R3 open |
| **CC6.2** User registration and authorization | Users come from the licensee IdP. Dev tokens only in dev mode | `src/core/auth.mjs` `registerAuthRoutes` (404 outside dev) | `tests/unit/core/auth.test.mjs` ("token endpoint disabled outside dev mode") | Implemented (dev). Planned: OIDC. R2 (dev default) open |
| **CC6.3** Role-based access, least privilege | `x-roles` per route enforced by the router before the handler | `src/core/router.mjs`, `src/core/auth.mjs` `requireRole` | `tests/unit/core/router.test.mjs`, `tests/security/roles.test.mjs`, `tests/security/routes.test.mjs` | Implemented. Role catalogue drift R8 open |
| **CC6.6** Boundary protection | Bind to 127.0.0.1 by default. Path-traversal guard. Body limit. On GCP: HTTPS LB, Cloud Armor | `src/server.mjs` (`listen` host, `resolveStatic`), `src/core/router.mjs` `BODY_LIMIT` | `tests/unit/core/router.test.mjs` (413), `tests/unit/core/server.test.mjs` | Implemented (local). Planned (platform): edge controls, rate limits |
| **CC6.7** Restrict transmission of data | Events carry no PII. Webhooks signed. AI redaction | `architecture/contracts/events/envelope.schema.json`, `TenantConfig` (`includePii: false`, `redactPiiBeforeModel`) | `tests/security/pii-leak.test.mjs` (outbox payloads) | Contract: implemented. Signing and redaction planned (integrations, ai) |
| **CC6.8** Prevent unauthorized or malicious software | Zero runtime dependencies in core. Optional SDKs load only with credentials | ADR-001, `package.json` | `docs/licenses.md` (platform; not yet written) | Implemented |
| **CC7.1** Detect configuration changes and vulnerabilities | Versioned, audited tenant config. Contract registry | `src/core/tenants.mjs` `put`, `history` | `tests/unit/core/server.test.mjs` ("tenants: versioned put") | Implemented |
| **CC7.2** Monitor for anomalies | Structured JSON logs with redaction. Bus failures recorded on the outbox | `src/core/log.mjs`, `src/core/bus.mjs` (`attempts`, `last_error`, `failed`) | `tests/unit/core/bus.test.mjs` | Implemented (signals). Planned (platform): alerting |
| **CC7.3** Evaluate security events | Audit query by actor, entity and time. Chain verification | `src/core/audit.mjs` `list`, `verify` | `tests/unit/core/audit.test.mjs`, `tests/security/audit-chain.test.mjs` | Implemented |
| **CC7.4** Incident response | Runbook. Per-tenant blast-radius identification | n/a | n/a | Planned (security) |
| **CC7.5** Recovery | Outbox recovery at boot. Backups on GCP | `src/core/bus.mjs` `recover` | `tests/unit/core/bus.test.mjs` | Partly implemented |
| **CC8.1** Change management | Tickets with acceptance criteria and reviewer, contracts versioned, ADRs, CI workflow, disjoint path ownership | `org/board/tickets/`, `org/decisions/`, `org/contracts/registry.json`, `.github/workflows/ci.yml`, `org/playbooks/standards.md` (review checklist) | Ticket history (`history[]` on each ticket), hub logs in `org/hubs/*.jsonl` | Implemented (process). CI not yet run |

## 5. Gaps that block a clean mapping (for Sprint 2)

The following are tracked in threat-model.md section 8:
- R1 and R3 store isolation defects (CC6.1, NAIC 4.D(2)(a))
- R2 dev-mode default (CC6.2)
- OIDC and MFA (GLBA 314.4(c)(5), NAIC 4.D(2)(g))
- KMS key rotation and crypto-shred (GLBA 314.4(c)(6), NAIC 4.D(2)(k))
- Incident response runbook (GLBA 314.4(h), NAIC 4.H, CC7.4)
- Regulatory timers in the claims module (section 3)
