# Ticket template, coding standards and review checklist (v1)

## Ticket template
```json
{
  "id": "S1-AI-03", "team": "ai", "title": "...", "story": "As a ... I want ... so that ...",
  "points": 5, "tier": "mid", "owner": "ic-ai-extraction", "reviewer": "dir-ai",
  "status": "ready", "sprint": 1, "dependsOn": [], "contracts": ["architecture/contracts/openapi.yaml#/paths/..."],
  "paths": ["src/modules/evidence/", "tests/unit/evidence/"],
  "acceptance": ["Given ... when ... then ...", "..."],
  "valueDrivers": ["VD-2"]
}
```

## Coding standards
- ES modules, 2-space indent, single quotes, semicolons. JSDoc on exported functions.
- No new runtime dependency without a platform-hub request and a license entry in `docs/licenses.md`.
- Every SQL query goes through `ctx.db` (tenant-scoped). Never build SQL from user input; use parameters.
- PII fields (names, DOB, phone, email, addresses, licence numbers, VINs are not PII but plates are treated as PII) are encrypted with `ctx.crypto.encryptPii` before storage.
- Every state change to a claim records an audit entry and publishes an event.
- AI outputs carry `provider`, `model`, `confidence` and `explanation`; never present AI output without them.
- Errors: JSON `{ error: { code, message } }` with the right HTTP status.

## Review checklist
1. Each acceptance criterion met (cite file/test).
2. Tests exist and pass (`node --test <paths>`).
3. Only the ticket's paths changed.
4. Tenant isolation respected; no PII in logs.
5. Contract conformance: request/response/event shapes match `architecture/contracts/`.
6. No secrets, no real-world data or brands.

## Changes from the self-improvement loop (v2, after Sprints 1-4)
- Reviewers run tests/e2e and tests/security for any ticket touching src/modules, src/core or src/ai, and must record the verdict in the fabric (IMP-4, IMP-7).
- UI tickets ship a Playwright smoke test in Chromium (IMP-6).
- Module tickets get a mid-tier security review; high findings trigger a security rework (IMP-9).
- Contract-version-sensitive tests read the version from the contract (IMP-8).
- An architecture-hub triage ticket runs at the start of every sprint (IMP-5).
- From Sprint 2, a standing ticket rehearses the demo against the running system (IMP-11).
- A feature that needs both UI and server changes is one squad ticket, not two cross-team tickets.
- Cross-module calibration (scores, thresholds) has one owner: the integration squad (ADR-003).
