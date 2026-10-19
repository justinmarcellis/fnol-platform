# Spike: OIDC SSO with an RS256/JWKS verifier (S5-PLT-04)

Owner: ic-platform-tenancy-dev (Platform & DevOps) · Status: spike, design plus proof, **not wired** · Sprint 5

Implements nothing in the request path. Inputs: ADR-001 (zero-dependency core, `src/core/*`), `architecture/core-runtime-api.md` (auth and tenant-bound `ctx`), `architecture/threat-model.md` (3.1 S, 3.2 S, 3.3 S, risk R2) and the `oidcBearer` scheme proposed in openapi by S5-ARC-01 (`x-status: proposed`).

## 1. What was built

| File | What |
| --- | --- |
| `src/core/oidc.mjs` | `createOidcVerifier({ issuer, audience, jwks, clockSkewSec, now, maxTokenBytes?, minRefreshIntervalMs? })` returning `{ verify(token) -> Promise<claims> }`; `OidcError` (extends `HttpError`, status 401, stable `code`); `OIDC_ERROR_CODES`; `createStaticJwks(keys)` for tests. `node:crypto` only. |
| `tests/unit/core/spikes/oidc.test.mjs` | 19 tests with keys from `generateKeyPairSync('rsa')` and fake JWKS ports. No network, no real keys. |

`auth.mjs`, `server.mjs`, `store.mjs` and the dev-token endpoint are unchanged, and nothing in `src/` imports `oidc.mjs` (a test checks this).

### Verification order

1. The token is a string of at most `maxTokenBytes` (8 KiB) with exactly three segments.
2. The header is decoded with strict base64url (alphabet, no padding, valid length) and parsed as a JSON object of at most 1 KiB.
3. **`header.alg === 'RS256'` is checked before any key is looked up.** `none`, `HS*`, `RS384/512`, `PS*`, `ES*`, a missing alg and case variants all fail with `bad_alg`. `header.crit` is rejected. `jku`, `x5u`, `jwk` and `x5c` header parameters are ignored and never fetched or used.
4. `kid` is required (non-empty string, at most 256 chars), otherwise `bad_token`.
5. The payload is decoded the same way and capped. The signature segment must be base64url.
6. The key is chosen by `kid` from `jwks.getKeys()`. It must have `kty: RSA`, `use` set to `sig` or absent, `alg` set to `RS256` or absent, and `key_ops` (if present) containing `verify`. It is built with `createPublicKey({ key: jwk, format: 'jwk' })` and must be at least 2048 bits. KeyObjects are cached per JWK object.
7. If no key matches the kid: call `jwks.refresh()` **at most once per verify()**, and only when `now() - lastRefresh >= minRefreshIntervalMs` (60 s by default, measured with the injected `now`). Concurrent verifies share one in-flight refresh. A failed refresh keeps the cached set. If there is still no key, the result is `unknown_kid`.
8. `crypto.verify('sha256', h.p, {key, RSA_PKCS1_PADDING}, sig)`, with a signature length equal to the modulus length. Failure gives `bad_signature`.
9. Claims: `iss` is compared strictly (`bad_iss`). `aud` is a string, or a non-empty array of strings that contains the audience (`bad_aud`). `exp` is required and numeric (`bad_token` if missing). `expired` if `now >= exp + skew`. `nbf` is optional and numeric: `not_yet_valid` if `now < nbf - skew`. `iat`, if present, must be numeric. `clockSkewSec` is 0..300 (default 60).

Error codes: `bad_token`, `bad_alg`, `unknown_kid`, `bad_signature`, `bad_iss`, `bad_aud`, `expired`, `not_yet_valid`. Each code has one fixed message, and messages never include claims, kid, issuer or token text (a test checks this).

## 2. Discovery and JWKS caching

The verifier is network-free. A production JWKS port (Sprint 6, `src/core/oidc-jwks.mjs` or similar) does the following:

- **Discovery:** at boot, `GET {issuer}/.well-known/openid-configuration` over HTTPS. Require `issuer` in the document to equal the configured issuer byte for byte (OIDC Discovery 4.3). Take `jwks_uri`, which must be `https:` and on the issuer host or an allowlisted host. Check that `id_token_signing_alg_values_supported` contains `RS256`. Re-read discovery at most every 24 h.
- **JWKS fetch:** fetch with a 3 s timeout and a 64 KiB response cap. Parse defensively, keep only RSA `sig` keys, and keep at most 20 keys. A bad response never replaces a good cached set.
- **Cache:** `getKeys()` serves from memory. Background refresh follows `Cache-Control: max-age`, clamped to the range 5 min to 24 h (default 1 h). After a fetch error, keep serving stale keys for up to 24 h, then fail closed.
- **Refresh limits (unknown kid):** at most one refresh per `verify()`, and at most one per `minRefreshIntervalMs` (60 s) per issuer. This is enforced in the verifier, so random kids cannot turn into a fetch flood against the IdP (threat T4). Concurrent callers share one in-flight fetch.
- **Rotation:** the IdP publishes the new key before signing with it. The first token with the new kid triggers one refresh, and the key is cached afterwards (tested). Retired keys drop out at the next refresh.
- **Multi-tenant:** use one verifier per configured issuer, cached by issuer. Each tenant names its issuer (section 3). Tenants that share an IdP share the cache.

## 3. Claim-to-tenant and role mapping

The proposed TenantConfig addition (Sprint 6 contract change, additive) is `auth.oidc: { issuer, audience, tenantClaim?, tenantValue?, rolesClaim?, roleMap?, subClaim?, nameClaim? }`.

- **Tenant:** the issuer determines the tenant first. Look up the tenants whose `auth.oidc.issuer` equals the verified `iss`. If an IdP serves several tenants, `tenantClaim` (default `tenantId`, or e.g. `tid`/`org_id`) must equal that tenant's `tenantValue`. **The tenant is never taken from a claim alone**, so a token from tenant A's IdP cannot pick tenant B. Unknown or ambiguous tenants are rejected (fixes "tokens for unknown tenants are accepted", threat-model 3.3).
- **Roles:** read `rolesClaim` (default `roles`, or e.g. `groups`). Translate through `roleMap` (IdP group to core role), and keep only values in core `ROLES`. Unmapped values are dropped. An empty result is 403 `role_denied`. **`platform_admin` is never granted through tenant OIDC.** It comes only from a platform-operated issuer configured outside tenant config, and `X-Tenant-Id` override auditing applies to it.
- **Principal:** `req.user = { sub: iss + '|' + sub, tenantId, roles, name }`. The issuer prefix stops `sub` collisions across IdPs. The `name` claim is display only and is not logged (PII).
- **Session TTL:** accept the token only while `exp` holds. Optionally cap the token age with `TenantConfig.sessionTtlMinutes` using `iat` (threat-model 3.1 S).
- **Token type:** API calls should carry an access token whose `aud` is the platform's API audience. If an ID token is used (SPA-only IdPs), its `aud` is the client id, and `azp` is checked when `aud` has several entries.

## 4. Threat table (informed by threat-model.md)

| # | Threat | STRIDE | Control in the spike | Test |
| --- | --- | --- | --- | --- |
| T1 | `alg: none` token accepted | S/E | Allowlist `RS256` before key lookup | `alg=none rejected` |
| T2 | HS256 key confusion: HMAC signed with the RSA public key (PEM/JWK) as the secret | S/E | `bad_alg` before any key is touched. The key is only ever used with `crypto.verify` RSA | `HS256 key confusion` (asserts the JWKS port is not called) |
| T3 | Algorithm substitution (RS384/PS256/ES256) or a weak RSA key | T | RS256 only. JWK `alg` must be RS256 or absent. Modulus at least 2048 bits | `RS256 only`, `key selection` |
| T4 | Unknown-kid flood makes the platform DoS the IdP or itself | D | One refresh per verify, 60 s minimum interval, shared in-flight refresh | `unknown kid ... rate limited` |
| T5 | Attacker-controlled key via `jku`/`x5u`/`jwk`/`x5c` headers | S | These headers are ignored. Keys come only from the configured JWKS port | design (no code path reads them) |
| T6 | Encryption key (`use: enc`) or wrong key type used to verify | S | `use` must be `sig` or absent, `kty: RSA`, `key_ops` must include `verify` | `key selection` |
| T7 | Payload tampering (role elevation to `platform_admin`) | T/E | RSASSA-PKCS1-v1_5 over the exact `h.p` bytes, plus a signature length check | `tampered payload, header or signature` |
| T8 | Token from another IdP, or for another client, replayed here | S | Strict `iss` and `aud` (string or array) | `issuer`, `audience` |
| T9 | Stolen or expired token replayed (threat-model 3.1 S) | S | Required `exp`, `nbf`, skew at most 300 s (default 60). Short IdP TTLs are expected | `exp`, `nbf`, `skew boundary` |
| T10 | Oversized or malicious JSON (DoS, parser abuse) | D | 8 KiB token cap, 1 KiB header cap, strict base64url, object-only JSON | `malformed tokens` |
| T11 | Token contents leak into logs through error messages (threat-model 3.8 I) | I | Fixed messages per code. No claim, kid or iss in the error | `error messages never contain token contents` |
| T12 | Cross-tenant token use (TB8) | E | Tenant from verified issuer plus tenant claim (section 3), not from the claim alone | Sprint 6 (wiring) |
| T13 | Dev HS256 mint endpoint left on in production (R2) | E | Sprint 6: when OIDC is configured and `devMode` is false, `/auth/token` stays 404 and HS256 dev tokens are refused | Sprint 6 |
| T14 | IdP compromise or a malicious JWKS response | S | Out of scope for the verifier. HTTPS-only discovery, `jwks_uri` host allowlist, response caps, and a bad fetch never evicts good keys | Sprint 6 (port) |

Residual risks: no `jti` replay cache (bearer tokens are replayable until `exp`); no token revocation (it relies on short TTLs); clock trust relies on the host's NTP.

## 5. Sprint 6 wiring plan

1. **Contract** (architecture hub): make `oidcBearer` active, add `TenantConfig.auth.oidc` (section 3), and document 401 codes `bad_alg`, `unknown_kid` and the others as `invalid_token` sub-codes (or map them all to `invalid_token`, with the specific code only in audit). Platform does not decide this alone.
2. **JWKS port** `src/core/oidc-jwks.mjs`: discovery plus fetch with the limits in section 2, injected `fetch` and `now` for tests.
3. **auth.mjs:** in `authenticate`, if the token header has `alg: RS256`, route it to the verifier for the issuer resolved from the unverified `iss` (used only for lookup; the verifier checks it again), then map claims (section 3). HS256 dev tokens stay accepted **only** when `devMode` is true. `verifyToken`, `issueToken` and `/auth/token` keep their behaviour.
4. **server.mjs:** build the verifiers at boot from tenant configs. Refuse to boot with `devMode=false` and no OIDC issuer configured (closes R2).
5. **Audit:** record `auth.oidc.rejected` with the code and tenant only, and `X-Tenant-Id` overrides by platform issuers.
6. **Tests:** e2e with a fake IdP (in-process HTTP server serving discovery and JWKS with generated keys), plus a security test that HS256 is rejected when `devMode` is off.

## 6. Live check (manual, outside tests/)

This is for checking a real or sandbox IdP by hand. It needs network access and a token you obtained yourself. Do not commit tokens or paste them into tickets. Run it from the repo root:

```sh
OIDC_ISSUER=https://idp.example.test OIDC_AUDIENCE=fnol-platform OIDC_TOKEN="$(cat .secrets/oidc-token.txt)" \
node --input-type=module -e '
import { createOidcVerifier } from "./src/core/oidc.mjs";
const issuer = process.env.OIDC_ISSUER;
const disc = await (await fetch(new URL(".well-known/openid-configuration", issuer.endsWith("/") ? issuer : issuer + "/"))).json();
if (disc.issuer !== issuer) throw new Error("discovery issuer mismatch");
let keys = [];
const jwks = { getKeys: () => keys, refresh: async () => { keys = (await (await fetch(disc.jwks_uri)).json()).keys ?? []; } };
await jwks.refresh();
const v = createOidcVerifier({ issuer, audience: process.env.OIDC_AUDIENCE, jwks });
try { const c = await v.verify(process.env.OIDC_TOKEN); console.log("ok", { iss: c.iss, aud: c.aud, exp: c.exp, keys: Object.keys(c) }); }
catch (e) { console.log("rejected", e.code); process.exitCode = 1; }
'
```

`.secrets/` is gitignored. The output prints claim names, not values. `https://idp.example.test` is a synthetic placeholder, so replace it with your sandbox issuer.

## 7. Run the spike tests

`node --test --disable-warning=ExperimentalWarning tests/unit/core/spikes/oidc.test.mjs` gives 19 pass.
