# Sprint 5 architecture triage (S5-ARC-01, IMP-5)

Owner: ic-integrations-api-designer. Scope: the four Sprint 5 contract touchpoints. Line numbers are as of this triage and
refer to the working tree before S5-WFL-01, S5-WFL-02 and S5-AI-01 land; those tickets will move them. `x-roles` are unchanged
(the routes snapshot in tests/security is owned by S5-SEC-01).

## 1. GET /intake/sessions/{sessionId}/policy-vehicles (S5-WFL-01)

| | openapi.yaml (before) | Code today | Disposition |
|---|---|---|---|
| Access | "Readable by the session owner ... Any other caller gets 404" (openapi.yaml:261-277) | Session ownership only: `assertAccess` (src/modules/intake/service.js:78-86) lets the starter, a producing agent, csr, integration and platform_admin through; route at src/modules/intake/routes.js:53-55 with roles `claimant, csr, agent`. No check of claimant vs policy holder. | Gap: the starter of a session may name ANY policy number, so the endpoint is a policy-number oracle. |
| Empty vs missing | "A session without a policy, or a policy with no vehicles, returns `[]`" | `policyVehicles` returns `[]` for no policy number (service.js:326) and for an unknown policy or failed lookup (service.js:327-331), versus the vehicle list for a real policy. | Oracle: `[]` vs vehicles discloses whether a policy number exists. |
| 404 body | Only `$ref NotFound` | `err('not_found', 'Intake session not found', 404)` (service.js:85) | Contract now documents one 404 body. |

openapi.yaml now (1.2.0 text, behaviour marked proposed for S5-WFL-01): vehicles only when the session's claimant matches the
policy holder; otherwise the same 404 (same status and body, example given) for unknown session and not-your-policy. Response
shape and `x-roles` unchanged. Code change belongs to S5-WFL-01.

## 2. AI output validation errors (S5-AI-01)

| | Contract | Code today | Disposition |
|---|---|---|---|
| Surface | openapi.yaml has no AI error surface; AI is internal (modules.md: a refusal is a cascade skip; outputs carry AiProvenance). No `ai_*` code is in the Error taxonomy. | Cascade checks only top-level required keys via `hasRequiredShape` (src/ai/schemas.mjs:88-96, used at src/ai/cascade.mjs:149) and skips the provider on failure; the full `validateOutput` (src/ai/guardrails.mjs:274-279, used at :348) runs only in the guard wrapper. Total failure throws `ai_unavailable` 503 (cascade.mjs:180). A missing tenant silently falls back to `{provider:'local'}` (cascade.mjs:90-91). | No openapi change needed: invalid output remains a cascade skip and `ai_unavailable` 503 only if all providers fail; S5-AI-01's "ai.run without tenant fails loudly" is an internal AppError (400/500), not a new public response. No contract-change posted for this item. Note for S5-AI-01: if a route can now surface a new status, post a contract-change first. |

## 3. Tenant regex validation errors on PUT /config (S5-WFL-02)

| | Contract | Code today | Disposition |
|---|---|---|---|
| 422 | openapi.yaml PUT /config 422 "Invalid config", `ValidationReport` | Route returns `422 e.report` (src/modules/config/routes.js:27-28); service throws `validation_failed` 422 (src/modules/config/service.js:246-249). | Wired. |
| Unsafe pattern | Not documented | The validator does not check tenant regexes: it compiles schema `pattern` keywords with `new RegExp` (src/modules/config/validator.js:99) and the semantic checks (service.js:49+) never test `validation.pattern` or rule `matches` for safety. Evaluation-time guards differ: `isSafePattern` (src/modules/intake/security.js:158-163, used src/modules/intake/questions.js:14-19, :130-132) and `isSafeRegex` (src/modules/rules/condition.js:94-100). Unsafe patterns pass save and are only skipped at evaluation. | PUT /config 422 now documents the unsafe-pattern rejection naming the pattern `path`. Same `ValidationReport` shape; no schema change. Code: S5-WFL-02. |

## 4. OIDC bearer scheme

| | Contract | Code today | Disposition |
|---|---|---|---|
| Scheme | `securitySchemes.bearerAuth` only (http bearer JWT, dev HS256) (openapi.yaml, components.securitySchemes) | `issueToken`/`verifyToken` are HS256 HMAC only (src/core/auth.mjs:25-52); `authenticate` takes `Bearer` (auth.mjs:56-60); no JWKS/RS256 code in src; `/auth/token` is 404 unless devMode (auth.mjs:84). | Added `oidcBearer` (type openIdConnect, placeholder issuer URL) with `x-status: proposed`, not referenced from `security` on any operation. Implementation is the platform spike. |

## Contract changes and hub posts

1. policy-vehicles: documented uniform 404 and holder-match rule (contract-change posted).
2. PUT /config: documented 422 for an unsafe tenant pattern (contract-change posted).
3. securitySchemes.oidcBearer proposed, unapplied (contract-change posted).
AI validation errors: no contract change (status post explains).

Hub requests read at start and before finishing: none new for Sprint 5 beyond the S4 items already applied in 1.3.0/seedVersion.
Not applied (out of scope): openapi.yaml `info.version` stays as is; 1.2.0 header vs 1.3.0 additions noted in the S4 hub posts is not reconciled here.

## Tests

`node --test --disable-warning=ExperimentalWarning tests/unit/integrations/docs/*.test.mjs tests/security/routes.test.mjs tests/unit/rules/routing.test.js` pass. No tests/unit/contracts* exist; the files that read openapi.yaml are the yaml-lite and gen-api-reference docs tests and the security routes test.
