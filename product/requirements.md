# PoC requirements

Owner: dir-product · Ticket: S0-PRD-01 · Status: for review (ceo) · Date: 2026-10-18

These are the PoC capabilities as `REQ-xx`, each with the value drivers it serves (`VD-n`, defined in `product/value-propositions.md`) and Given/When/Then acceptance criteria that a reviewer can check against a running build or a test. Stack, layout and module boundaries follow ADR-001. Program defaults (lines of business, states, AI providers) follow ADR-002. Tickets should copy the relevant `REQ` and `VD` IDs.

**Lines of business:** personal auto (`pa`) and homeowners (`ho`) are required. Commercial auto (`ca`) is a stretch (REQ-24).
**Data:** synthetic and fictional only. Demo tenants, policies, claimants and the core suite are invented.
**AI rule (standards.md):** every AI output carries `provider`, `model`, `confidence` and `explanation`; with no credentials the deterministic `local` provider produces it, so every criterion below passes offline.

Priority: **M** = must for the PoC demo, **S** = should, **C** = stretch.

---

## A. Intake

### REQ-01 Omnichannel intake (claimant web, CSR console, agent, API). M · VD-1, VD-2, VD-6
- Given tenant A with channels `web`, `csr`, `agent` and `api` enabled, when a claim is submitted through each channel, then each produces the same canonical FNOL record (per `architecture/contracts/domain/`) with `channel` set, and publishes one `claim.reported` event.
- Given an agent user, when the agent reports a loss for a policyholder, then the record stores the agent as `reportedBy` with role `agent`, and the agent can see that claim's status but not other agencies' claims.
- Given a submission missing a required field for its line of business, when it is submitted through the API, then the response is `400` with `{ error: { code, message } }` naming the field.

### REQ-02 Conversational intake. M · VD-1, VD-6
- Given a claimant in the web app, when they describe the loss in free text ("I was rear-ended on Main St yesterday, no injuries"), then the assistant fills the matching structured fields (loss date, type, injuries=false, other party=true), shows them for confirmation, and asks only for what is still missing.
- Given the AI provider is unavailable or returns low confidence, when the conversation continues, then intake falls back to the deterministic form flow without losing entered answers.
- Given any extracted field, when the claimant reviews it, then they can correct it, and the record keeps both the AI value (with confidence) and the confirmed value.

### REQ-03 LOB-adaptive questions. M · VD-1, VD-3, VD-4, VD-5
- Given the loss type is personal auto collision, when intake proceeds, then auto questions appear (vehicles, drivers, other party, police report, drivable, injuries) and homeowners questions do not.
- Given homeowners water damage, when intake proceeds, then property questions appear (source of water, ongoing, habitable, mitigation started), including conditional follow-ups defined in tenant config.
- Given a tenant config that adds a question to a line of business, when the next intake starts, then the question appears with no code change or redeploy (see REQ-13).

### REQ-04 Multilingual intake and notifications. S · VD-6
- Given a claimant selects Spanish, when they complete intake, then all prompts, validation messages and the acknowledgment are in Spanish, the record stores `language: "es"`, and the adjuster sees an English summary plus the original text.

### REQ-05 Evidence capture with AI extraction. M · VD-1, VD-4, VD-5
- Given a claimant uploads photos, a synthetic police report (PDF or image) or a repair estimate, when processing completes, then the evidence is stored with type, hash and tenant ID, and an `evidence.extracted` event carries extracted fields (for example report number, other party plate, damage areas, estimate total) each with `confidence` and `explanation`.
- Given an extracted value conflicts with an intake answer (for example a loss date differs), when triage runs, then a `data_conflict` indicator is raised and both values are shown.
- Given a file over the configured size limit or of a disallowed type, when uploaded, then it is rejected with `413` or `415` and an error body.

## B. Decisioning

### REQ-06 Coverage verification against mock policy admin. M · VD-4, VD-1
- Given a mock policy admin system holding synthetic policies, when FNOL is submitted with a policy number and loss date, then the platform returns `coverageCheck` with policy status in force on the loss date, whether the vehicle or property and driver are listed, applicable coverages, deductible, and `result` in {`verified`, `needs_review`, `not_found`}.
- Given a loss date outside the policy period, or an unlisted vehicle, when the check runs, then `result = needs_review` with a reason, and the claim is **not** denied or closed automatically.
- Given the policy admin is down, when the check runs, then the claim is still accepted, the check is marked `pending`, and it is retried by the outbox.

### REQ-07 Severity and complexity scoring with explanations. M · VD-4, VD-2
- Given a claim, when triage runs, then it stores `severity` (1–5), `complexity` (low, medium, high), `confidence` and an `explanation` listing the top contributing factors (for example injuries, airbag deployed, not drivable, roof damage, uninhabitable).
- Given identical input and the `local` provider, when triage runs twice, then the scores are identical (deterministic for tests).

### REQ-08 Fraud and anomaly indicators. M · VD-4
- Given synthetic claims seeded with known patterns (loss within N days of policy inception or coverage change, late reporting, prior similar losses, narrative inconsistent with evidence, duplicate photo hash across claims), when triage runs, then each matching indicator is raised with ID, weight and human-readable reason, and the total `fraudScore` is shown.
- Given a claim with fraudScore at or above the tenant SIU threshold, when routing runs, then it is routed to SIU review and excluded from STP; no adverse action is taken against the claimant automatically.

### REQ-09 Subrogation flag. M · VD-5
- Given an auto claim where another party is identified and the narrative or police report indicates the other party was at fault (for example rear-ended, other party ran a red light), when triage runs, then `subrogation.flag = true` with reasons and the captured other-party details, and a `claim.subrogation_flagged` event is published.
- Given a homeowners claim with a third-party cause (for example contractor work or a failed appliance), when triage runs, then a subrogation flag with reason is raised. Given a single-vehicle collision with no third party, then no flag is raised.

### REQ-10 Configurable routing. M · VD-1, VD-2, VD-3
- Given tenant routing rules (conditions on line of business, severity, complexity, fraudScore, subrogation, state and coverage result mapped to a queue or adjuster group), when a claim is triaged, then it is assigned to the first matching queue and the record shows which rule fired and why.
- Given an admin changes a rule in the admin UI, when the next claim is triaged, then the new rule applies without a deploy, and the change is audited (REQ-21).

### REQ-11 Straight-through processing (STP). M · VD-1, VD-2
- Given tenant STP criteria (for example `pa` glass only, or `ho` estimate under $2,500 non-CAT, coverage `verified`, fraudScore under threshold, no injuries), when a claim meets all of them, then it goes to `stp_ready` with no human touch, the claimant is told the next step, and a `claim.stp_ready` event is published for the core adapter.
- Given a claim that fails any STP criterion, when routing runs, then it is not STP and the failing criteria are listed.
- Given the demo dataset, when processed, then the dashboard reports the STP rate (target ≥ 10%).

## C. Experience and timers

### REQ-12 Instant acknowledgment and claimant status. M · VD-2, VD-6, VD-7
- Given a submitted claim, when it is accepted, then within 60 seconds the claimant gets a claim number and acknowledgment (screen plus synthetic email/SMS log), and the `acknowledgedAt` timestamp is recorded.
- Given a claimant or agent with the claim number and a verification factor, when they open the status page, then they see the current stage, the assigned contact (role only), next steps and outstanding items, and never another claimant's data.

### REQ-13 No-code carrier configuration. M · VD-3
- Given an admin of tenant A, when they edit branding, enabled lines of business, question sets, STP criteria, thresholds, routing rules, languages or timers in the admin app, then the changes are validated against the tenant config schema, versioned, and take effect for new claims without code change or restart.
- Given an invalid config (for example a routing rule that references an unknown queue), when it is saved, then it is rejected with a precise error and the previous version stays active.
- Given a config version, when an admin rolls back, then the earlier version becomes active and the rollback is audited.

### REQ-14 Regulatory timers per state and line. M · VD-7, VD-2
- Given tenant timer config for WI, IL and MI (acknowledge, first contact, and status-communication deadlines expressed in calendar or business days per line of business), when a claim is reported in one of those states, then the timers start from the reported time and are shown on the claim with their due dates.
- Given a timer at its configured warning threshold (for example 80% elapsed) without the required action, then a `timer.warning` event is published and the claim is highlighted in the adjuster queue. At breach, a `timer.breached` event is published and recorded in audit.
- Given the required action happens (for example acknowledgment sent), then the matching timer stops and records `metAt`.
- Seeded deadline values are illustrative configuration and must be confirmed by the carrier's compliance team.

## D. Adjuster

### REQ-15 Adjuster first view. M · VD-1, VD-2, VD-4, VD-5
- Given an assigned claim, when the adjuster opens it, then one screen shows: an AI summary (≤ 120 words, with provider, model, confidence and explanation), the coverage check result, severity and complexity, fraud indicators, subrogation flag, regulatory timers, an evidence gallery with extracted fields, and a timeline of every event since FNOL.
- Given flags on the claim, when the adjuster views them, then each shows its reason and source data, and the adjuster can accept or dismiss it with a note (audited).
- Given claim facts, when next best actions are generated, then 1–5 actions appear with a rationale (for example "Contact claimant within 4h: IL timer", "Request police report", "Refer to subrogation", "Inspect: roof damage severity 4"), and marking one done records it on the timeline.

## E. Integration

### REQ-16 Integration events and webhooks. M · VD-3
- Given a tenant webhook subscription for `claim.reported`, `claim.triaged`, `claim.stp_ready`, `claim.subrogation_flagged` and `timer.breached`, when the event occurs, then a POST is delivered with a payload matching `architecture/contracts/events/*.schema.json`, an HMAC signature header and an idempotency key.
- Given the receiver returns 5xx or times out, then delivery retries with backoff from the persisted outbox and is visible as failed after the retry limit; events are never lost on restart.

### REQ-17 Sample core-suite adapter. M · VD-3
- Given a fictional "core claims suite" mock (no real vendor system is called), when `claim.reported` and `claim.stp_ready` events occur, then the adapter maps the canonical claim to the mock's claim-create format, stores the returned core claim ID on the FNOL record, and an integration test proves the round trip.
- Given the adapter mapping is configuration (field map per tenant), when tenant B uses a different mapping, then both tenants integrate correctly from the same code.

## F. Security, tenancy and governance

### REQ-18 Tenant isolation. M · VD-3 (prerequisite for VD-6 TPA/MGA use)
- Given users and data in tenants A and B, when a user of A calls any API with a B resource ID, then the response is `404` and no B data is returned. An automated test covers every route.
- Given the store layer, when any module queries a tenant-owned table, then the tenant filter is applied by the store (ADR-001), and a test fails if a query omits it.

### REQ-19 Role-based access control. M · VD-7
- Given roles `claimant`, `agent`, `csr`, `adjuster`, `supervisor`, `siu`, `tenant_admin` and `platform_admin`, when a role calls a route outside its allowance (for example a CSR editing routing rules, or an adjuster seeing SIU-only notes), then the response is `403` and the attempt is audited.

### REQ-20 PII encryption. M · VD-7
- Given PII fields (names, DOB, phone, email, addresses, licence numbers, plates), when stored, then they are encrypted with `ctx.crypto.encryptPii` (per-tenant key), are unreadable in the raw SQLite file, and are never written to logs. A test greps logs and the database for seeded PII strings.

### REQ-21 Audit trail. M · VD-7, VD-4
- Given any claim state change, config change, flag decision, AI output or access denial, when it occurs, then an append-only audit entry records who, what, when, tenant, before and after (PII redacted), and for AI the provider, model and confidence.
- Given an auditor role, when they export the audit for a claim, then they get the complete ordered history, and tampering with an entry is detectable (hash chain).

### REQ-25 Explainable, overridable AI. M · VD-4, VD-7
- Given any AI-derived field, score or summary, when it is displayed, then it shows its provider, model, confidence and explanation; a human can override it; and the override is audited.
- Given the PoC, when any decision would be adverse to the claimant (deny, close, reduce), then the system only recommends it and requires a human action.

## G. Demo and measurement

### REQ-22 Two differently configured demo tenants. M · VD-3
Proposed (fictional; names to be confirmed by the architecture and platform team):
- **Tenant A "Aurelia Mutual" (fictional):** personal auto and homeowners; WI and IL; English and Spanish; claimant web, agent and CSR channels; aggressive STP (glass, home under $2,500); conversational intake on; adapter mapping A.
- **Tenant B "Kestrel Point Insurance" (fictional):** personal auto plus commercial auto (stretch); MI; English only; CSR and API channels; conservative STP (glass only); stricter SIU threshold; different branding; adapter mapping B.

Acceptance:
- Given `npm start` on an empty database, when it completes, then both tenants are seeded with config and synthetic policies, and the same synthetic loss submitted to each tenant gives different questions, routing, STP outcome and timers, each explained by that tenant's config.
- Given the two tenants, when the code is diffed, then there is no tenant-specific code path; all differences are in `tenants/*.json`.

### REQ-23 Value-driver KPI instrumentation. S · VD-1, VD-2, VD-4, VD-5, VD-6
- Given processed claims, when the KPI endpoint or dashboard is opened, then it shows per tenant: STP rate, median time to acknowledgment, time to first contact, % routed at intake, flags raised by type (coverage, fraud, subrogation), timers met or breached, and channel and language mix, so that each in-scope driver has a measured PoC number.

### REQ-24 Commercial auto line. C · VD-3
- Given tenant B with `ca` enabled, when a commercial auto FNOL is reported, then fleet- and driver-specific questions appear (unit number, employee driver, cargo or hazmat, DOT-recordable), coverage is checked against a synthetic commercial policy, and triage and routing use `ca` rules, with no new code beyond config and question sets.

---

## Traceability: driver to requirements

| Driver | Requirements |
|---|---|
| VD-1 LAE via STP and automated capture | REQ-01, 02, 03, 05, 06, 10, 11, 15, 23 |
| VD-2 Cycle time | REQ-01, 07, 10, 11, 12, 14, 15, 23 |
| VD-3 Speed to deploy as COTS | REQ-03, 10, 13, 16, 17, 18, 22, 24 |
| VD-4 Leakage | REQ-03, 05, 06, 07, 08, 15, 21, 25, 23 |
| VD-5 Subrogation | REQ-03, 05, 09, 15, 23 |
| VD-6 Claimant experience | REQ-01, 02, 04, 12, 23 |
| VD-7 Regulatory compliance (guardrail) | REQ-12, 14, 19, 20, 21, 25 |
| VD-8 CAT surge (out of scope) | Partial by-product of REQ-01, 02, 12; no dedicated requirement |
| VD-9 Vendor dispatch (out of scope) | Only as a next-best-action text in REQ-15 |

## Non-functional (PoC level)
- Runs offline with `npm start` and passes `npm test` without cloud credentials (ADR-001).
- Intake API p95 under 500 ms with the local provider on the dev container; AI extraction is asynchronous.
- Accessibility: claimant intake meets WCAG 2.1 AA basics (labels, keyboard, contrast).
- No real carrier names, logos, policies or people anywhere in code, seed data or screenshots.
