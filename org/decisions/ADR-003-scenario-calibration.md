# ADR-003: Who is right when e2e expectations and module behaviour disagree

Status: accepted · Owner: orchestrator with dir-quality and dir-ai · Date: 2026-10-18

## Context
At the end of Sprint 1 every module passed its own tests, but the e2e scenarios disagreed with triage and routing. Severity bands were off by one band, and glass and small-water claims were not fast-tracked. Nobody owned the cross-module behaviour.

## Decision
1. The scenario `expected` values in `tests/synthetic/` are the acceptance specification. They express what an adjuster or a claims VP would expect.
2. Module behaviour is tuned to meet them: triage weights and band cut-offs, and tenant STP rules.
3. An expectation may change only with a one-line rationale in the scenario file, citing the tenant rule or the claims practice it relies on. One owner, the integration squad, makes both kinds of change, so the two sides cannot drift apart again.
4. Severity band cut-offs (0–24 minor, 25–49 moderate, 50–74 major, 75–100 severe, unless the tenant overrides them) are documented in `architecture/domain-model.md` by the architecture triage ticket.
5. From Sprint 2 on, a ticket that touches `src/modules/` or `src/core/` is accepted only if `tests/e2e` and `tests/security` show no new failures (IMP-4).
