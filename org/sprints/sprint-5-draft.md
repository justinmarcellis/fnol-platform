# Sprint 5 draft (orchestrator) — budget $45 of $173.14 remaining; re-plan at $36, stop at $45
Goal: production-path credibility. Verified live deployment, live-model evaluation, 0 open medium security findings, spikes for the 4 production gaps.
Already done by the orchestrator (GCP credentials stay with the orchestrator): Cloud Run fnol-platform verified (IAP on, run.invoker only IAP agent, IAP accessor only the sponsor, maxScale 1, seed+demo-data lines in revision logs incl. a cold start at 01:39Z). Vertex AI API enabled; live probes: gemini-2.5-flash, gemini-2.5-pro, gemini-3.5-flash answer; claude-haiku/sonnet/opus-5-5 return 429 quota 0 (needs the sponsor: Model Garden enable / quota).

Wave 1 (3 workflows side by side, security gate on module code)
W1 security fixes (pre-planned, findings are precise):
- S5-WFL-01 (5, mid) policy-vehicles oracle: GET /intake/sessions/{id}/policy-vehicles returns vehicles only when the session's claimant matches the policy holder (claimant identity vs policy snapshot parties); otherwise the same 404 for unknown and not-yours. Paths intake/service.js, intake/routes.js, tests/unit/intake/policy-vehicles*.
- S5-WFL-02 (5, mid) tenant regex safety SEC2-013/014/SEC3-003: one strict safe-pattern checker (linear-time subset or whitelist grammar, bounded input) used by rules/condition.js, intake/questions.js and config/validator.js. Paths rules/, intake/questions.js, config/, tests/unit/rules|config.
- S5-AI-01 (5, mid) SEC2-009 output validation vs outputSchemas, SEC2-010 ai.run without tenant fails loudly, SEC2-011 untrusted-data framing + delimiters. Paths src/ai/{cascade,guardrails,schemas,index}.mjs, providers/_shared.mjs, tests/unit/ai/.
- S5-AI-02 (2, mid) SEC2-017 mask provenance.span for non-PII roles. Paths evidence/routes.mjs, tests/unit/evidence/.
W2 production spikes (platform manager plans; design doc in architecture/spikes/ + small proof, no migration, no new runtime deps; cloud calls via fetch+ADC token behind a port with a fake):
- Cloud SQL Postgres store adapter (store port + conformance suite SQLite passes; PG dialect proof)
- Pub/Sub outbox publisher; Cloud KMS master-key wrap (enc:v2); OIDC SSO verifier (RS256/JWKS) replacing dev tokens when devMode off.
W3 enablers:
- S5-ARC-01 (2, mid) architecture triage (IMP-5): contracts vs code for this sprint (policy-vehicles 404, AI validation errors, OIDC scheme); owns openapi.yaml.
- S5-QE-01 (3, mid, ic-quality-e2e-engineer, PI-2 re-measure) demo-script e2e remote mode: FNOL_BASE_URL + IAP token via Proxy-Authorization (IMP-11 standing rehearsal).
- S5-AI-03 (5, mid) eval.mjs --live: real vertex-gemini/vertex-claude providers, per-model metrics incl. latency and token cost, never in npm test.
- S5-AI-04 (3, fast) golden sets to >=15 synthetic cases per task.
Wave 2: S5-SEC-01 security re-review (flip t.todo to real tests, Sprint 5 status in security-review-s2.md); orchestrator runs live eval (Gemini now; Claude if sponsor enables); S5-AI-05 primary/challenger per task in docs/ai-evaluation.md; orchestrator redeploys new commits and runs the remote demo with a time-boxed IAP grant to the deployer SA (revoked after, logged in incidents hub); S5-PRD-01 refresh cots-readiness + demo-script; sprint close (scorecards, retro, top-3 improvements).
Deprecations: none. PI-1 has no UI ticket this sprint (cannot re-measure).
