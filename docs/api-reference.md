# FNOL Platform API reference

Version 1.0.0 · Base path `/api/v1` · JSON over HTTPS · Synthetic data only.

This document has hand-written sections (authentication, tenancy, errors, events and webhooks, pagination) and one generated section
that is built from `architecture/contracts/openapi.yaml` and the JSON Schemas next to it. Edit the hand-written text freely. Never edit
anything between the `BEGIN GENERATED` and `END GENERATED` markers: run `node architecture/contracts/tools/gen-api-reference.mjs` instead
(add `--check` in CI to fail when the file is out of date).

## Authentication

Every endpoint except the health probe and the development token endpoint needs a bearer token:

```http
GET /api/v1/claims HTTP/1.1
Authorization: Bearer <token>
```

- Tokens are signed JWT-style tokens carrying the user (`sub`), the tenant, the roles and an expiry (`exp`). In production the platform
  accepts OIDC tokens from the carrier's identity provider with the same claims; in development `POST /api/v1/auth/token` issues one.
- A missing, malformed, tampered or expired token returns `401` with code `unauthorized`.
- Each operation lists the roles allowed to call it (see **Roles** in the endpoint reference). A valid token without one of those roles returns
  `403` with code `role_denied`. The `platform_admin` role passes every role check.
- Roles used by this API: `claimant`, `agent`, `csr`, `adjuster`, `supervisor`, `carrier_admin` (the contract's `tenant_admin`),
  `platform_admin` and `integration`. Use an `integration` token for machine-to-machine clients such as outbox pollers.

## Tenancy

The platform is multi-tenant. A carrier is a tenant, and its data is isolated from every other tenant.

- **The tenant comes from the token, never from the request.** Every query is scoped to the token's tenant.
- A body may repeat `tenantId`; if it differs from the token's tenant the call fails with `403` and code `tenant_mismatch`.
- Looking up an id that belongs to another tenant returns `404 not_found`, exactly as if it did not exist.
- Only `platform_admin` may act on a different tenant, by sending an `X-Tenant-Id` header. Other callers sending it receive `403`.
- Events, webhook subscriptions, delivery logs and the outbox are all per tenant. Events carry ids and codes only, never personal data.

## Errors

Every error uses one envelope, with a stable machine-readable `code` and a human-readable `message`:

```json
{ "error": { "code": "validation_failed", "message": "invalid event type(s): claims.reported" } }
```

| HTTP | Typical codes | Meaning |
| --- | --- | --- |
| 400 | `bad_request`, `invalid_json`, `invalid_query`, `invalid_cursor` | Malformed request, body, query string or cursor |
| 401 | `unauthorized` | Missing, invalid or expired token |
| 403 | `forbidden`, `role_denied`, `tenant_mismatch` | Role not allowed, or the body names another tenant |
| 404 | `not_found` | Unknown id, or an id owned by another tenant |
| 409 | `version_conflict`, `invalid_transition` | Stale `If-Match` version, or a state change that is not allowed |
| 413 | `payload_too_large` | Request body over 15 MB |
| 422 | `validation_failed` | Well-formed JSON that fails validation (for example a webhook URL that is not allowed) |
| 502 | `upstream_error` | A core or policy system adapter failed |
| 500 | `internal_error` | Unexpected failure; the message is generic and details stay in the server log |

Clients should branch on `code`, not on `message`. New codes may be added; treat unknown codes by their HTTP status.

## Events and webhooks

Every state change publishes an event on the platform bus. Events use a CloudEvents 1.0 style envelope (see **Event envelope** below) and are
written to the tenant's outbox in the same transaction as the change, so delivery is **at least once**. Events never contain personal
data: they carry ids and codes, and consumers fetch details through the API.

### Registering a subscription

```bash
curl -X POST https://api.fnol-platform.example/api/v1/integrations/webhooks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "url": "https://hooks.partner.example/fnol", "eventTypes": ["claim.routed", "claim.status.changed"] }'
```

- `eventTypes` takes event types such as `claim.routed`, or `*` for every event.
- The response contains a `secret` (`whsec_...`). **It is returned once and never again.** Store it in your secret manager. If you lose it,
  `PATCH` the subscription with `{ "rotateSecret": true }` to receive a new one; the old secret stops working immediately.
- The URL must be `https` and must not point at a private, loopback, link-local or internal address (SSRF protection). Credentials in the URL are rejected.
  Development servers also allow `http://localhost`.

### What your endpoint receives

A `POST` with the event envelope as the JSON body and these headers:

| Header | Value |
| --- | --- |
| `X-FNOL-Signature` | Lower-case hex HMAC-SHA256 of the **raw request body** keyed with the subscription secret |
| `X-FNOL-Event-Id` | The event id (`evt_...`); identical on every retry, use it to de-duplicate |
| `X-FNOL-Event-Type` | The event type, for example `claim.routed` |
| `X-FNOL-Delivery-Id` | The delivery record id (see the deliveries endpoint) |
| `X-FNOL-Attempt` | 1 for the first try, 2 for the first retry, and so on |

```json
{
  "specversion": "1.0",
  "id": "evt_5c1f0a9e2b7d4e8a91c3",
  "type": "claim.routed",
  "source": "/tenants/harborline-mutual/modules/rules",
  "time": "2026-03-01T12:00:00.000Z",
  "tenantId": "harborline-mutual",
  "subject": "clm_8f2a41c07d3b4e6a9b10",
  "datacontenttype": "application/json",
  "data": { "claimId": "clm_8f2a41c07d3b4e6a9b10", "queue": "auto-standard" }
}
```

### Verifying the signature

Compute the HMAC over the exact bytes you received (before any JSON parsing or re-serialisation) and compare in constant time.
Reject the request when it does not match.

```js
import http from 'node:http';
import crypto from 'node:crypto';

const SECRET = process.env.FNOL_WEBHOOK_SECRET; // the whsec_... value from the create response
const seen = new Set();                         // use a durable store in production

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const expected = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    const given = String(req.headers['x-fnol-signature'] ?? '');
    const ok = given.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) { res.writeHead(401).end(); return; }

    const eventId = req.headers['x-fnol-event-id'];
    if (!seen.has(eventId)) {            // at-least-once delivery: process each event id once
      seen.add(eventId);
      const event = JSON.parse(raw.toString('utf8'));
      console.log('received', event.type, event.subject);
    }
    res.writeHead(204).end();            // any 2xx acknowledges the delivery
  });
}).listen(3000);
```

### Delivery, retries and ordering

- Respond with any `2xx` within 5 seconds to acknowledge. Any other status, a network error or a timeout counts as a failure. Redirects are not followed.
- Failed deliveries are retried with exponential backoff: 30 seconds, 2 minutes, 10 minutes, then 1 hour, for 5 attempts in total (the default
  `retryPolicy.maxAttempts` is 5 and can be set from 1 to 10 per subscription). After the last attempt the delivery is marked `failed`.
- Each (subscription, event) pair has exactly one delivery record, so a replay never sends an event twice to the same subscription.
  Inspect it, with its attempt count, last response status and next attempt time, at `GET /integrations/webhooks/{webhookId}/deliveries`.
- Ordering is not guaranteed across events or across retries. Use `time`, the claim `version` in `data` where present, and idempotent handlers.
- To replay or audit what was published, read the outbox with `GET /integrations/outbox` (see **Pagination**).

## Pagination

List endpoints that can grow without bound are paginated. Short, fixed lists (subscriptions, adapters) return `{ "items": [...] }` in full.

**Cursor pagination** (claims, deliveries, audit and similar):

- Query parameters: `limit` (1 to 200, default 50) and `cursor` (opaque; copy it from the previous page).
- Response: `{ "items": [...], "nextCursor": "..." }`. `nextCursor` is `null` on the last page. Do not parse or build cursors.
- An unrecognised cursor returns `400 invalid_cursor`.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.fnol-platform.example/api/v1/integrations/webhooks/whk_123/deliveries?limit=50"
# then, while nextCursor is not null:
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.fnol-platform.example/api/v1/integrations/webhooks/whk_123/deliveries?limit=50&cursor=$NEXT"
```

**Sequence pagination** (the outbox): `GET /integrations/outbox?afterSequence=N&limit=L` returns events in publication order, each with an
integer `sequence`, plus `nextSequence`. Persist `nextSequence` and pass it as `afterSequence` on the next poll to resume exactly where you left
off; an empty page returns the `afterSequence` you sent. Filter with `type` and `subject` (the claim id).

<!-- BEGIN GENERATED -->

## Overview of the API

API-first contract for every channel (claimant web, CSR, adjuster, admin, partners).

* Base path `/api/v1`. All bodies are JSON unless stated.
* **Tenant comes from the bearer token** (`tid` claim). A request never names another tenant;
  a `tenantId` in a body, if present, must equal the token tenant or the call fails with `403 tenant_mismatch`.
* **Roles** per operation are listed in `x-roles`. `x-module` names the module (ADR-001) that registers the route.
* Errors always use `{ "error": { "code", "message" } }` (see `Error`).
* Domain shapes are referenced from `domain/*.schema.json` (JSON Schema 2020-12) so the API and storage share one source of truth.
* Responses decrypt PII only for roles allowed to see it; others receive `"[redacted]"` in `x-pii` fields.
* Optimistic concurrency: mutating calls on claims and config accept `If-Match: <version>`; a stale version returns `409 version_conflict`.
* Synthetic data only. Tenants are fictional carriers.

**Servers**

- `http://localhost:8080/api/v1`: Local one-command dev server
- `https://{tenantHost}/api/v1`: Cloud Run behind the HTTPS load balancer

## Endpoint reference

All paths are relative to the base path `/api/v1`.

| Method | Path | Operation | Summary |
| --- | --- | --- | --- |
| POST | [`/auth/token`](#post-authtoken) | `issueDevToken` | Issue a development token (disabled when NODE_ENV=production) |
| GET | [`/auth/me`](#get-authme) | `getMe` | Current principal |
| POST | [`/intake/sessions`](#post-intakesessions) | `startIntakeSession` | Start a guided FNOL session for a line of business and channel |
| GET | [`/intake/sessions/{sessionId}`](#get-intakesessionssessionid) | `getIntakeSession` |  |
| GET | [`/intake/sessions/{sessionId}/next-question`](#get-intakesessionssessionidnext-question) | `getNextQuestion` | Next question after evaluating showIf / requiredIf against current answers |
| POST | [`/intake/sessions/{sessionId}/answers`](#post-intakesessionssessionidanswers) | `answerQuestion` | Answer one question (or several with `answers`); returns the next step |
| POST | [`/intake/sessions/{sessionId}/submit`](#post-intakesessionssessionidsubmit) | `submitIntakeSession` | Submit a complete session; creates the claim (publishes claim.reported) |
| GET | [`/claims`](#get-claims) | `listClaims` | List claims with filters (tenant-scoped) |
| POST | [`/claims`](#post-claims) | `createClaim` | Create a claim directly (API / partner channel) |
| GET | [`/claims/{claimId}`](#get-claimsclaimid) | `getClaim` |  |
| POST | [`/claims/{claimId}/status`](#post-claimsclaimidstatus) | `changeClaimStatus` | Move the claim along the lifecycle (validated against the state machine) |
| GET | [`/claims/{claimId}/notes`](#get-claimsclaimidnotes) | `listNotes` |  |
| POST | [`/claims/{claimId}/notes`](#post-claimsclaimidnotes) | `addNote` |  |
| GET | [`/claims/{claimId}/tasks`](#get-claimsclaimidtasks) | `listTasks` |  |
| PATCH | [`/claims/{claimId}/tasks/{taskId}`](#patch-claimsclaimidtaskstaskid) | `updateTask` |  |
| GET | [`/claims/{claimId}/timers`](#get-claimsclaimidtimers) | `listTimers` | Regulatory timers on the claim |
| GET | [`/claims/{claimId}/documents`](#get-claimsclaimiddocuments) | `listDocuments` |  |
| POST | [`/claims/{claimId}/documents`](#post-claimsclaimiddocuments) | `uploadDocument` | Upload evidence (multipart or base64 JSON); extraction runs asynchronously |
| GET | [`/claims/{claimId}/documents/{documentId}`](#get-claimsclaimiddocumentsdocumentid) | `getDocument` |  |
| GET | [`/claims/{claimId}/documents/{documentId}/content`](#get-claimsclaimiddocumentsdocumentidcontent) | `getDocumentContent` | Download the original bytes (audited as a sensitive read) |
| GET | [`/claims/{claimId}/documents/{documentId}/extraction`](#get-claimsclaimiddocumentsdocumentidextraction) | `getExtraction` | Extraction results with field-level confidence and provenance |
| POST | [`/claims/{claimId}/documents/{documentId}/extraction`](#post-claimsclaimiddocumentsdocumentidextraction) | `rerunExtraction` |  |
| POST | [`/claims/{claimId}/documents/{documentId}/extraction/review`](#post-claimsclaimiddocumentsdocumentidextractionreview) | `reviewExtraction` | Accept, correct or reject extracted fields (AI suggests, a person confirms) |
| POST | [`/claims/{claimId}/coverage/verify`](#post-claimsclaimidcoverageverify) | `verifyCoverage` | Verify (or re-verify) coverage against a policy snapshot as of the loss date |
| GET | [`/claims/{claimId}/coverage`](#get-claimsclaimidcoverage) | `getCoverage` |  |
| GET | [`/policies/{policyNumber}/snapshot`](#get-policiespolicynumbersnapshot) | `getPolicySnapshot` | Policy lookup through the policy port (CSR intake helper) |
| GET | [`/claims/{claimId}/triage`](#get-claimsclaimidtriage) | `getTriage` |  |
| POST | [`/claims/{claimId}/triage`](#post-claimsclaimidtriage) | `runTriage` | Run (or re-run) triage through the AI cascade |
| GET | [`/claims/{claimId}/routing`](#get-claimsclaimidrouting) | `getRoutingDecision` |  |
| POST | [`/claims/{claimId}/routing`](#post-claimsclaimidrouting) | `routeClaim` | Route a triaged claim by tenant rules, or override (supervisor) |
| GET | [`/adjuster/claims/{claimId}/view`](#get-adjusterclaimsclaimidview) | `getAdjusterView` | Aggregated first-view payload (claim, policy, coverage, triage, routing, evidence, timers, tasks, notes, summary) |
| GET | [`/adjuster/inbox`](#get-adjusterinbox) | `getAdjusterInbox` | Claims assigned to me or my queues, ordered by timer urgency then severity |
| GET | [`/config`](#get-config) | `getTenantConfig` |  |
| PUT | [`/config`](#put-config) | `putTenantConfig` | Replace tenant config (validated, versioned, audited; publishes tenant.config.updated) |
| POST | [`/config/validate`](#post-configvalidate) | `validateTenantConfig` | Dry-run validation (schema + semantic checks such as unknown queue ids, unreachable questions, rule syntax) |
| GET | [`/config/public`](#get-configpublic) | `getPublicTenantConfig` | Branding, enabled LOBs and loss types for claimant/CSR UIs (no rules, no secrets) |
| GET | [`/integrations/webhooks`](#get-integrationswebhooks) | `listWebhooks` |  |
| POST | [`/integrations/webhooks`](#post-integrationswebhooks) | `createWebhook` |  |
| GET | [`/integrations/webhooks/{webhookId}`](#get-integrationswebhookswebhookid) | `getWebhook` |  |
| PATCH | [`/integrations/webhooks/{webhookId}`](#patch-integrationswebhookswebhookid) | `updateWebhook` |  |
| DELETE | [`/integrations/webhooks/{webhookId}`](#delete-integrationswebhookswebhookid) | `deleteWebhook` |  |
| GET | [`/integrations/webhooks/{webhookId}/deliveries`](#get-integrationswebhookswebhookiddeliveries) | `listWebhookDeliveries` |  |
| GET | [`/integrations/outbox`](#get-integrationsoutbox) | `listOutbox` | Tenant's published events (outbox), for replay and debugging |
| GET | [`/integrations/adapters`](#get-integrationsadapters) | `listAdapters` |  |
| GET | [`/integrations/adapters/{adapterId}/preview/{claimId}`](#get-integrationsadaptersadapteridpreviewclaimid) | `previewAdapterPayload` | Show the payload the adapter would send to the core system (PII masked unless role allows) |
| POST | [`/integrations/adapters/{adapterId}/push/{claimId}`](#post-integrationsadaptersadapteridpushclaimid) | `pushClaimToCore` | Send (or resend) the claim to the core system through the adapter |
| GET | [`/audit`](#get-audit) | `listAudit` |  |
| GET | [`/health`](#get-health) | `getHealth` | Liveness and readiness |

### auth

#### POST /auth/token

Issue a development token (disabled when NODE_ENV=production)

Dev-only HMAC-signed token. In production the platform accepts OIDC tokens from the tenant identity provider (Identity Platform / IAP) with the same claims.

Operation `issueDevToken` · Roles: public, no token needed · Module: `core`

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tenantId` | string | yes | Tenant (licensee carrier) slug, e.g. "harborline-mutual". Fictional only. |
| `userId` | string | yes | Example: `"adj-0001"`. |
| `displayName` | string |  |  |
| `roles` | array of string (`claimant`, `csr`, `adjuster`, `supervisor`, `tenant_admin`, `integration`, `auditor`) | yes |  |
| `claimIds` | array of string |  | For claimant tokens, the claims this user may see. |
| `ttlMinutes` | integer |  | Default `60`. Range ..720. |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 201 | Token issued | [Token](#schema-token) |
| 400 | Malformed request | [Error](#schema-error) |
| 404 | Not available in production | [Error](#schema-error) |

#### GET /auth/me

Current principal

Operation `getMe` · Roles: `claimant`, `csr`, `adjuster`, `supervisor`, `tenant_admin`, `integration`, `auditor` · Module: `core`

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Principal | [Principal](#schema-principal) |
| 401 | Missing or invalid token | [Error](#schema-error) |

### intake

#### POST /intake/sessions

Start a guided FNOL session for a line of business and channel

Operation `startIntakeSession` · Roles: `claimant`, `csr`, `integration` · Module: `intake`

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tenantId` | string |  | Optional; must match the token. |
| `lob` | string | yes | Line of business id from tenant config, e.g. personal_auto, homeowners, commercial_auto. Each LOB carries an ACORD LOBCd mapping (AUTOP, HOME, AUTOB). |
| `lossType` | string |  |  |
| `channel` | string (`claimant_web`, `claimant_mobile`, `csr_phone`, `agent_portal`, `api`, `email`, `partner`) | yes | Intake channel (FNOL reported-by channel). |
| `locale` | string |  | Default `"en"`. |
| `policyNumber` | string |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 201 | Session started; includes the first question | [IntakeStep](#schema-intakestep) |
| 400 | Malformed request | [Error](#schema-error) |
| 401 | Missing or invalid token | [Error](#schema-error) |
| 403 | Role not allowed or tenant mismatch | [Error](#schema-error) |
| 422 | Validation failed | [Error](#schema-error) |

#### GET /intake/sessions/{sessionId}

Operation `getIntakeSession` · Roles: `claimant`, `csr`, `integration` · Module: `intake`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `sessionId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Session | `IntakeSession` |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### GET /intake/sessions/{sessionId}/next-question

Next question after evaluating showIf / requiredIf against current answers

Operation `getNextQuestion` · Roles: `claimant`, `csr`, `integration` · Module: `intake`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `sessionId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Next step (question is null when every required question is answered) | [IntakeStep](#schema-intakestep) |
| 404 | Not found in this tenant | [Error](#schema-error) |
| 409 | Version conflict or invalid state transition | [Error](#schema-error) |

#### POST /intake/sessions/{sessionId}/answers

Answer one question (or several with `answers`); returns the next step

Operation `answerQuestion` · Roles: `claimant`, `csr`, `integration` · Module: `intake`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `sessionId` | path | string | yes |  |

**Request body** (required)

Type: object \| object

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Accepted; next step | [IntakeStep](#schema-intakestep) |
| 404 | Not found in this tenant | [Error](#schema-error) |
| 409 | Version conflict or invalid state transition | [Error](#schema-error) |
| 422 | Validation failed | [Error](#schema-error) |

#### POST /intake/sessions/{sessionId}/submit

Submit a complete session; creates the claim (publishes claim.reported)

Operation `submitIntakeSession` · Roles: `claimant`, `csr`, `integration` · Module: `intake`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `sessionId` | path | string | yes |  |
| `Idempotency-Key` | header | string |  | Replays within 24h return the original response. |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 201 | Claim created | `Claim` |
| 409 | Version conflict or invalid state transition | [Error](#schema-error) |
| 422 | Validation failed | [Error](#schema-error) |

### claims

#### GET /claims

List claims with filters (tenant-scoped)

Operation `listClaims` · Roles: `csr`, `adjuster`, `supervisor`, `auditor`, `integration` · Module: `claims`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `status` | query | array of string |  |  |
| `lob` | query | string |  |  |
| `queue` | query | string |  |  |
| `adjusterId` | query | string |  |  |
| `fastTrack` | query | boolean |  |  |
| `severityMin` | query | integer |  | Range 0..100. |
| `flag` | query | string |  |  |
| `riskState` | query | string |  |  |
| `reportedFrom` | query | string (date-time) |  |  |
| `reportedTo` | query | string (date-time) |  |  |
| `q` | query | string |  | Claim number or policy number prefix |
| `sort` | query | string (`reportedAt`, `-reportedAt`, `severity`, `-severity`) |  | Default `"-reportedAt"`. |
| `limit` | query | integer |  | Default `50`. Range 1..200. |
| `cursor` | query | string |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Page of claims (summary form; parties omitted) | [Page](#schema-page) |

#### POST /claims

Create a claim directly (API / partner channel)

Operation `createClaim` · Roles: `integration`, `csr` · Module: `claims`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `Idempotency-Key` | header | string |  | Replays within 24h return the original response. |

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tenantId` | string |  | Tenant (licensee carrier) slug, e.g. "harborline-mutual". Fictional only. |
| `lob` | string | yes | Line of business id from tenant config, e.g. personal_auto, homeowners, commercial_auto. Each LOB carries an ACORD LOBCd mapping (AUTOP, HOME, AUTOB). |
| `lossType` | string |  |  |
| `channel` | string (`api`, `partner`, `email`, `csr_phone`) |  | Default `"api"`. |
| `policyNumber` | string |  |  |
| `riskState` | string |  | USPS state code (WI, IL, MI seeded). |
| `lossEvent` | `LossEvent` | yes | What happened, when and where. ACORD: ClaimsOccurrence (LossDt, LossTime, LossCauseCd, IncidentDesc). |
| `parties` | array of `Party` |  | id/tenantId/claimId are assigned by the server and ignored if sent |
| `vehicles` | array of `Vehicle` |  |  |
| `properties` | array of `Property` |  |  |
| `externalRef` | object |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 201 | Created | `Claim` |
| 400 | Malformed request | [Error](#schema-error) |
| 409 | Version conflict or invalid state transition | [Error](#schema-error) |
| 422 | Validation failed | [Error](#schema-error) |

#### GET /claims/{claimId}

Operation `getClaim` · Roles: `claimant`, `csr`, `adjuster`, `supervisor`, `auditor`, `integration` · Module: `claims`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Claim | `Claim` |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### POST /claims/{claimId}/status

Move the claim along the lifecycle (validated against the state machine)

Allowed manual transitions are in overview.md. Automatic transitions (reported to validating to triaged to assigned/fast_tracked) are made by event subscribers, not this endpoint. Reopen (closed to in_review) and withdraw after assignment need supervisor.

Operation `changeClaimStatus` · Roles: `adjuster`, `supervisor`, `csr` · Module: `claims`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |
| `If-Match` | header | string |  | Expected version |

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `to` | string (`in_review`, `pending_info`, `closed`, `withdrawn`) | yes |  |
| `reason` | string |  |  |
| `closeReason` | string (`paid`, `denied`, `no_coverage`, `duplicate`, `withdrawn_by_insured`, `below_deductible`, `other`) |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Updated claim | `Claim` |
| 404 | Not found in this tenant | [Error](#schema-error) |
| 409 | Version conflict or invalid state transition | [Error](#schema-error) |

#### GET /claims/{claimId}/notes

Operation `listNotes` · Roles: `csr`, `adjuster`, `supervisor`, `auditor` · Module: `claims`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Notes, newest first | object |

#### POST /claims/{claimId}/notes

Operation `addNote` · Roles: `csr`, `adjuster`, `supervisor` · Module: `claims`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `body` | string | yes |  |
| `category` | string |  |  |
| `visibility` | string (`internal`, `shared_with_claimant`) |  | Default `"internal"`. |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 201 | Note added (publishes claim.note.added) | `Note` |
| 422 | Validation failed | [Error](#schema-error) |

#### GET /claims/{claimId}/tasks

Operation `listTasks` · Roles: `csr`, `adjuster`, `supervisor`, `auditor` · Module: `claims`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Tasks | object |

#### PATCH /claims/{claimId}/tasks/{taskId}

Operation `updateTask` · Roles: `adjuster`, `supervisor` · Module: `claims`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |
| `taskId` | path | string | yes |  |

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | string (`open`, `in_progress`, `done`, `cancelled`) |  |  |
| `assigneeId` | string |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Task | `Task` |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### GET /claims/{claimId}/timers

Regulatory timers on the claim

Operation `listTimers` · Roles: `csr`, `adjuster`, `supervisor`, `auditor` · Module: `claims`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Timers | object |

### evidence

#### GET /claims/{claimId}/documents

Operation `listDocuments` · Roles: `claimant`, `csr`, `adjuster`, `supervisor`, `auditor`, `integration` · Module: `evidence`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |
| `kind` | query | string |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Documents with extraction summaries | object |

#### POST /claims/{claimId}/documents

Upload evidence (multipart or base64 JSON); extraction runs asynchronously

Operation `uploadDocument` · Roles: `claimant`, `csr`, `adjuster`, `integration` · Module: `evidence`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |
| `Idempotency-Key` | header | string |  | Replays within 24h return the original response. |

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | string (`photo`, `police_report`, `estimate`, `invoice`, `other`) | yes |  |
| `filename` | string | yes |  |
| `contentType` | string | yes |  |
| `contentBase64` | string | yes |  |
| `description` | string |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 201 | Stored (publishes claim.evidence.added); extraction.status is pending | `Document` |
| 404 | Not found in this tenant | [Error](#schema-error) |
| 413 | Too large (default limit 15 MB) | [Error](#schema-error) |
| 415 | Unsupported media type | [Error](#schema-error) |

#### GET /claims/{claimId}/documents/{documentId}

Operation `getDocument` · Roles: `claimant`, `csr`, `adjuster`, `supervisor`, `auditor`, `integration` · Module: `evidence`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |
| `documentId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Document | `Document` |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### GET /claims/{claimId}/documents/{documentId}/content

Download the original bytes (audited as a sensitive read)

Operation `getDocumentContent` · Roles: `csr`, `adjuster`, `supervisor` · Module: `evidence`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |
| `documentId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Bytes |  |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### GET /claims/{claimId}/documents/{documentId}/extraction

Extraction results with field-level confidence and provenance

Operation `getExtraction` · Roles: `csr`, `adjuster`, `supervisor`, `auditor`, `integration` · Module: `evidence`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |
| `documentId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Extraction | `extraction` |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### POST /claims/{claimId}/documents/{documentId}/extraction

Operation `rerunExtraction` · Roles: `adjuster`, `supervisor` · Module: `evidence`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |
| `documentId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 202 | Re-extraction queued |  |

#### POST /claims/{claimId}/documents/{documentId}/extraction/review

Accept, correct or reject extracted fields (AI suggests, a person confirms)

Operation `reviewExtraction` · Roles: `csr`, `adjuster`, `supervisor` · Module: `evidence`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |
| `documentId` | path | string | yes |  |

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `fields` | array of object | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Updated extraction | `extraction` |

### coverage

#### POST /claims/{claimId}/coverage/verify

Verify (or re-verify) coverage against a policy snapshot as of the loss date

Operation `verifyCoverage` · Roles: `csr`, `adjuster`, `supervisor`, `integration` · Module: `coverage`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Verification (publishes claim.coverage.verified) | `CoverageVerification` |
| 404 | Not found in this tenant | [Error](#schema-error) |
| 502 | Core or policy system adapter failed | [Error](#schema-error) |

#### GET /claims/{claimId}/coverage

Operation `getCoverage` · Roles: `csr`, `adjuster`, `supervisor`, `auditor` · Module: `coverage`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Latest verification and the snapshot it used | object |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### GET /policies/{policyNumber}/snapshot

Policy lookup through the policy port (CSR intake helper)

Operation `getPolicySnapshot` · Roles: `csr`, `adjuster`, `supervisor`, `integration` · Module: `coverage`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `policyNumber` | path | string | yes |  |
| `asOf` | query | string (date) | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Snapshot | `PolicySnapshot` |
| 404 | Not found in this tenant | [Error](#schema-error) |
| 502 | Core or policy system adapter failed | [Error](#schema-error) |

### triage

#### GET /claims/{claimId}/triage

Operation `getTriage` · Roles: `adjuster`, `supervisor`, `auditor`, `csr` · Module: `triage`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |
| `history` | query | boolean |  | Default `false`. |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Latest result (or all attempts when history=true) | `TriageResult` \\| object |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### POST /claims/{claimId}/triage

Run (or re-run) triage through the AI cascade

Operation `runTriage` · Roles: `adjuster`, `supervisor` · Module: `triage`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Request body**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `force` | boolean |  | Re-run even if inputs are unchanged. Default `false`. |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Triage result (publishes claim.triaged) | `TriageResult` |
| 404 | Not found in this tenant | [Error](#schema-error) |
| 409 | Version conflict or invalid state transition | [Error](#schema-error) |

### routing

#### GET /claims/{claimId}/routing

Operation `getRoutingDecision` · Roles: `csr`, `adjuster`, `supervisor`, `auditor` · Module: `rules`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Latest decision | `RoutingDecision` |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### POST /claims/{claimId}/routing

Route a triaged claim by tenant rules, or override (supervisor)

Operation `routeClaim` · Roles: `supervisor`, `adjuster` · Module: `rules`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Request body**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `override` | object |  | Supervisor only. Skips rule evaluation and records the override. |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Decision (publishes claim.routed) | `RoutingDecision` |
| 403 | Role not allowed or tenant mismatch | [Error](#schema-error) |
| 404 | Not found in this tenant | [Error](#schema-error) |
| 409 | Version conflict or invalid state transition | [Error](#schema-error) |

### adjuster

#### GET /adjuster/claims/{claimId}/view

Aggregated first-view payload (claim, policy, coverage, triage, routing, evidence, timers, tasks, notes, summary)

Operation `getAdjusterView` · Roles: `adjuster`, `supervisor` · Module: `adjuster`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | View | `AdjusterView` |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### GET /adjuster/inbox

Claims assigned to me or my queues, ordered by timer urgency then severity

Operation `getAdjusterInbox` · Roles: `adjuster`, `supervisor` · Module: `adjuster`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `queue` | query | string |  |  |
| `mine` | query | boolean |  | Default `true`. |
| `limit` | query | integer |  | Default `50`. Range 1..200. |
| `cursor` | query | string |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Inbox rows | [Page](#schema-page) |

### config

#### GET /config

Operation `getTenantConfig` · Roles: `tenant_admin`, `supervisor`, `auditor` · Module: `config`

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Current tenant config | `TenantConfig` |

#### PUT /config

Replace tenant config (validated, versioned, audited; publishes tenant.config.updated)

Operation `putTenantConfig` · Roles: `tenant_admin` · Module: `config`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `If-Match` | header | string |  | Expected version |

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `$schema` | string |  |  |
| `tenantId` | string | yes | Tenant (licensee carrier) slug, e.g. "harborline-mutual". Fictional only. |
| `version` | integer | yes | Monotonic; PUT must send current version (optimistic concurrency). Range 1... |
| `displayName` | string | yes | Fictional carrier name. |
| `claimNumberPrefix` | string |  |  |
| `timeZone` | string |  | Default `"America/Chicago"`. |
| `locales` | array of string |  | Default `["en"]`. |
| `branding` | object | yes |  |
| `lobs` | array of object | yes |  |
| `questionSets` | array of object | yes |  |
| `rules` | array of object | yes |  |
| `queues` | array of object | yes |  |
| `defaultQueue` | string |  |  |
| `fastTrack` | object |  |  |
| `severityBands` | object |  |  |
| `timers` | array of object | yes |  |
| `holidays` | array of string (date) |  | Excluded from business-day timers. |
| `notifications` | object |  |  |
| `integrations` | object |  |  |
| `ai` | object | yes |  |
| `security` | object |  |  |
| `updatedAt` | string (date-time) |  | RFC 3339 UTC timestamp. |
| `updatedBy` | string |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Saved | `TenantConfig` |
| 409 | Version conflict or invalid state transition | [Error](#schema-error) |
| 422 | Invalid config | [ValidationReport](#schema-validationreport) |

#### POST /config/validate

Dry-run validation (schema + semantic checks such as unknown queue ids, unreachable questions, rule syntax)

Operation `validateTenantConfig` · Roles: `tenant_admin` · Module: `config`

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `$schema` | string |  |  |
| `tenantId` | string | yes | Tenant (licensee carrier) slug, e.g. "harborline-mutual". Fictional only. |
| `version` | integer | yes | Monotonic; PUT must send current version (optimistic concurrency). Range 1... |
| `displayName` | string | yes | Fictional carrier name. |
| `claimNumberPrefix` | string |  |  |
| `timeZone` | string |  | Default `"America/Chicago"`. |
| `locales` | array of string |  | Default `["en"]`. |
| `branding` | object | yes |  |
| `lobs` | array of object | yes |  |
| `questionSets` | array of object | yes |  |
| `rules` | array of object | yes |  |
| `queues` | array of object | yes |  |
| `defaultQueue` | string |  |  |
| `fastTrack` | object |  |  |
| `severityBands` | object |  |  |
| `timers` | array of object | yes |  |
| `holidays` | array of string (date) |  | Excluded from business-day timers. |
| `notifications` | object |  |  |
| `integrations` | object |  |  |
| `ai` | object | yes |  |
| `security` | object |  |  |
| `updatedAt` | string (date-time) |  | RFC 3339 UTC timestamp. |
| `updatedBy` | string |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Report | [ValidationReport](#schema-validationreport) |

#### GET /config/public

Branding, enabled LOBs and loss types for claimant/CSR UIs (no rules, no secrets)

Operation `getPublicTenantConfig` · Roles: `claimant`, `csr`, `adjuster`, `supervisor`, `tenant_admin`, `integration`, `auditor` · Module: `config`

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Public subset | [PublicConfig](#schema-publicconfig) |

### integrations

#### GET /integrations/webhooks

Operation `listWebhooks` · Roles: `tenant_admin` · Module: `integrations`

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Subscriptions | object |

#### POST /integrations/webhooks

Operation `createWebhook` · Roles: `tenant_admin` · Module: `integrations`

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string (uri) | yes |  |
| `eventTypes` | array of string | yes |  |
| `description` | string |  |  |
| `active` | boolean |  | Default `true`. |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 201 | Created; `secret` is returned only here | `WebhookSubscription` & object |
| 422 | Validation failed | [Error](#schema-error) |

#### GET /integrations/webhooks/{webhookId}

Operation `getWebhook` · Roles: `tenant_admin` · Module: `integrations`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `webhookId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Subscription | `WebhookSubscription` |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### PATCH /integrations/webhooks/{webhookId}

Operation `updateWebhook` · Roles: `tenant_admin` · Module: `integrations`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `webhookId` | path | string | yes |  |

**Request body** (required)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string (uri) |  |  |
| `eventTypes` | array of string |  |  |
| `active` | boolean |  |  |
| `description` | string |  |  |
| `rotateSecret` | boolean |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Updated | `WebhookSubscription` |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### DELETE /integrations/webhooks/{webhookId}

Operation `deleteWebhook` · Roles: `tenant_admin` · Module: `integrations`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `webhookId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 204 | Deleted |  |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### GET /integrations/webhooks/{webhookId}/deliveries

Operation `listWebhookDeliveries` · Roles: `tenant_admin` · Module: `integrations`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `webhookId` | path | string | yes |  |
| `limit` | query | integer |  | Default `50`. Range 1..200. |
| `cursor` | query | string |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Delivery attempts | [Page](#schema-page) |

#### GET /integrations/outbox

Tenant's published events (outbox), for replay and debugging

Operation `listOutbox` · Roles: `tenant_admin`, `auditor`, `integration` · Module: `integrations`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `type` | query | string |  |  |
| `subject` | query | string |  | claimId |
| `afterSequence` | query | integer |  |  |
| `limit` | query | integer |  | Default `50`. Range 1..200. |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Events in sequence order | object |

#### GET /integrations/adapters

Operation `listAdapters` · Roles: `tenant_admin`, `supervisor` · Module: `integrations`

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Registered adapters | object |

#### GET /integrations/adapters/{adapterId}/preview/{claimId}

Show the payload the adapter would send to the core system (PII masked unless role allows)

Operation `previewAdapterPayload` · Roles: `tenant_admin`, `supervisor`, `adjuster` · Module: `integrations`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `adapterId` | path | string | yes |  |
| `claimId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Mapped payload and mapping report | object |
| 404 | Not found in this tenant | [Error](#schema-error) |

#### POST /integrations/adapters/{adapterId}/push/{claimId}

Send (or resend) the claim to the core system through the adapter

Operation `pushClaimToCore` · Roles: `tenant_admin`, `supervisor` · Module: `integrations`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `adapterId` | path | string | yes |  |
| `claimId` | path | string | yes |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 202 | Queued |  |
| 404 | Not found in this tenant | [Error](#schema-error) |

### audit

#### GET /audit

Operation `listAudit` · Roles: `auditor`, `tenant_admin`, `supervisor` · Module: `core`

**Parameters**

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `claimId` | query | string |  |  |
| `entityType` | query | string |  |  |
| `entityId` | query | string |  |  |
| `actorId` | query | string |  |  |
| `action` | query | string |  |  |
| `from` | query | string (date-time) |  |  |
| `to` | query | string (date-time) |  |  |
| `limit` | query | integer |  | Default `50`. Range 1..200. |
| `cursor` | query | string |  |  |

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Audit entries, newest first | [Page](#schema-page) |

### health

#### GET /health

Liveness and readiness

Operation `getHealth` · Roles: public, no token needed · Module: `health`

**Responses**

| Status | Description | Body |
| --- | --- | --- |
| 200 | Healthy | object |

## Schemas

Shared request and response shapes from the OpenAPI components. Domain objects are listed in the next section.

### Schema: Error

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `error` | object | yes |  |

### Schema: Token

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | string | yes |  |
| `expiresAt` | string (date-time) | yes |  |
| `principal` | [Principal](#schema-principal) |  |  |

### Schema: Principal

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `userId` | string | yes |  |
| `tenantId` | string | yes |  |
| `displayName` | string |  |  |
| `roles` | array of string (`claimant`, `csr`, `adjuster`, `supervisor`, `tenant_admin`, `integration`, `auditor`) | yes |  |
| `claimIds` | array of string |  |  |

### Schema: Page

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `items` | array of any | yes |  |
| `nextCursor` | string \| null |  |  |
| `total` | integer |  |  |

### Schema: Question

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes |  |
| `text` | `I18nText` | yes | Plain string, or a map of BCP 47 locale to string. |
| `help` | `I18nText` |  | Plain string, or a map of BCP 47 locale to string. |
| `type` | string (`text`, `longtext`, `number`, `currency`, `boolean`, `date`, `time`, `datetime`, `select`, `multiselect`, `address`, `location`, `phone`, `email`, `vin`, `party`, `vehicle`, `media`, `disclosure`) | yes |  |
| `required` | boolean |  | Default `false`. |
| `requiredIf` | `Condition` |  | FNOL condition language v1 (see domain-model.md). Combinators all/any/not, leaves compare a fact path to a value. |
| `options` | array of object |  |  |
| `validation` | object |  |  |
| `showIf` | `Condition` |  | Ask only when true; facts are answers.<id>, session.*, policy.*. |
| `pii` | boolean |  | Default `false`. |
| `mapsTo` | string |  | Domain path the answer populates, e.g. lossEvent.lossDate, parties[role=driver].phone, vehicles[role=insured].drivable |
| `aiAssist` | boolean |  | Allow AI to prefill/extract this answer from narrative or documents. |
| `order` | integer |  |  |
| `section` | string |  |  |

### Schema: IntakeStep

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | yes |  |
| `done` | boolean | yes | True when every required question is answered and the session can be submitted. |
| `question` | [Question](#schema-question) \| null |  |  |
| `progress` | object | yes |  |
| `errors` | array of object |  |  |
| `suggestions` | array of object |  | AI-prefilled answers awaiting confirmation |
| `disclosures` | array of string |  | State fraud warning etc. to display |

### Schema: ClaimCreate

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tenantId` | string |  | Tenant (licensee carrier) slug, e.g. "harborline-mutual". Fictional only. |
| `lob` | string | yes | Line of business id from tenant config, e.g. personal_auto, homeowners, commercial_auto. Each LOB carries an ACORD LOBCd mapping (AUTOP, HOME, AUTOB). |
| `lossType` | string |  |  |
| `channel` | string (`api`, `partner`, `email`, `csr_phone`) |  | Default `"api"`. |
| `policyNumber` | string |  |  |
| `riskState` | string |  | USPS state code (WI, IL, MI seeded). |
| `lossEvent` | `LossEvent` | yes | What happened, when and where. ACORD: ClaimsOccurrence (LossDt, LossTime, LossCauseCd, IncidentDesc). |
| `parties` | array of `Party` |  | id/tenantId/claimId are assigned by the server and ignored if sent |
| `vehicles` | array of `Vehicle` |  |  |
| `properties` | array of `Property` |  |  |
| `externalRef` | object |  |  |

### Schema: InboxRow

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string |  |  |
| `claimNumber` | string |  |  |
| `status` | string |  |  |
| `lob` | string |  |  |
| `queue` | string |  |  |
| `severityScore` | integer |  |  |
| `complexity` | string |  |  |
| `flags` | array of string |  |  |
| `nextTimer` | `RegulatoryTimer` |  | A state-mandated or SOP deadline on a claim, started and stopped by events per tenant timer config. |
| `reportedAt` | string (date-time) |  |  |

### Schema: ValidationReport

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `valid` | boolean | yes |  |
| `errors` | array of object | yes |  |
| `warnings` | array of object |  |  |

### Schema: PublicConfig

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `tenantId` | string |  |  |
| `displayName` | string |  |  |
| `branding` | `branding` |  |  |
| `lobs` | array of object |  |  |
| `locales` | array of string |  |  |

### Schema: OutboxRecord

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sequence` | integer | yes |  |
| `event` | `envelope` | yes | Every event on ctx.bus, in the outbox, on Pub/Sub and on webhooks uses this envelope. Events carry ids and codes, never PII; consumers fetch details through the API. On Pub/Sub binary mode the attributes are ce-specversion, ce-type, ce-source, ce-id, ce-time, ce-subject and tenantid (CloudEvents extension names are lowercase). |
| `publishedAt` | string (date-time) | yes |  |
| `dispatch` | object |  |  |

### Schema: Delivery

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string |  |  |
| `eventId` | string |  |  |
| `eventType` | string |  |  |
| `attempt` | integer |  |  |
| `status` | string (`pending`, `succeeded`, `failed`, `dead_letter`) |  |  |
| `responseStatus` | integer |  |  |
| `nextAttemptAt` | string (date-time) |  |  |
| `at` | string (date-time) |  |  |

## Domain objects

Each object is defined by a JSON Schema (2020-12) under `architecture/contracts/domain/`; the API and storage share it.

| Object | Schema file | Description |
| --- | --- | --- |
| `Adjuster first view` | `domain/AdjusterView.schema.json` | Read model: everything an adjuster needs on first open, aggregated by the adjuster module. PII decrypted per role. |
| `Audit entry` | `domain/AuditEntry.schema.json` | Append-only record of every state change and sensitive read. Hash-chained per tenant. |
| `Claim` | `domain/Claim.schema.json` | Aggregate root of the FNOL platform. ACORD: Claim / ClaimsOccurrence as carried in a claims notification. Child entities are stored in their own tables and embedded on read. |
| `Coverage verification` | `domain/CoverageVerification.schema.json` | Result of checking a claim against its policy snapshot. Indicative only; coverage decisions stay with the carrier (overview.md scope). |
| `Document / media` | `domain/Document.schema.json` | Uploaded evidence (photo, police report, estimate, invoice, other) and its extraction results. ACORD: Attachment / FileAttachmentInfo. |
| `Intake session` | `domain/IntakeSession.schema.json` | A guided FNOL conversation (claimant web, CSR phone, agent portal) driven by the tenant question set. Submitting it creates a Claim. |
| `Loss event` | `domain/LossEvent.schema.json` | What happened, when and where. ACORD: ClaimsOccurrence (LossDt, LossTime, LossCauseCd, IncidentDesc). |
| `Note` | `domain/Note.schema.json` | Free-text claim note. Body is PII-bearing and encrypted. |
| `Party` | `domain/Party.schema.json` | A person or organization involved in the loss. ACORD: ClaimsParty with ClaimsPartyRoleCd. Fields marked x-pii are encrypted at rest with the tenant PII key. |
| `Policy snapshot` | `domain/PolicySnapshot.schema.json` | Point-in-time copy of the policy as of the loss date, read from the carrier policy system through the policy port. ACORD: Policy / PersAutoLineBusiness / HomeLineBusiness. |
| `Property` | `domain/Property.schema.json` | A dwelling or structure involved in a property loss. ACORD: PropertyLossInfo / Location. |
| `Regulatory timer` | `domain/RegulatoryTimer.schema.json` | A state-mandated or SOP deadline on a claim, started and stopped by events per tenant timer config. |
| `Reserve (placeholder)` | `domain/Reserve.schema.json` | Placeholder: the PoC records suggested initial reserves only; reserving stays in the core claims system. ACORD: ClaimsReserve concept. |
| `Routing decision` | `domain/RoutingDecision.schema.json` | Where a triaged claim goes: an adjuster queue (and optionally an adjuster) or straight-through fast track. |
| `Task` | `domain/Task.schema.json` | Work item on a claim (ACORD: ClaimsActivity concept). Created by rules, timers or people. |
| `Tenant configuration` | `domain/TenantConfig.schema.json` | The COTS heart: one versioned document per tenant (tenants/<tenant>.json) that configures branding, lines of business, question sets, rules, queues, regulatory timers, notifications and AI. Validated on PUT; every change audited and published as tenant.config.updated. |
| `Triage result` | `domain/TriageResult.schema.json` | Severity, complexity, fraud and subrogation assessment of a claim. AI-assisted; always carries provider/model/confidence and an explanation. |
| `Vehicle` | `domain/Vehicle.schema.json` | A vehicle involved in an auto loss, insured or third party. ACORD: AutoLossInfo / VehInfo concepts. |
| `Webhook subscription` | `domain/WebhookSubscription.schema.json` | Tenant-registered HTTPS endpoint receiving CloudEvents. Deliveries are signed (HMAC-SHA256 over the raw body, header X-FNOL-Signature). |

## Event catalog

### Event envelope

Every event on ctx.bus, in the outbox, on Pub/Sub and on webhooks uses this envelope. Events carry ids and codes, never PII; consumers fetch details through the API. On Pub/Sub binary mode the attributes are ce-specversion, ce-type, ce-source, ce-id, ce-time, ce-subject and tenantid (CloudEvents extension names are lowercase).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `specversion` | `"1.0"` | yes |  |
| `id` | string | yes | Unique event id (evt_...). Consumers must be idempotent on id. |
| `type` | string | yes |  |
| `source` | string | yes | Example: `"/tenants/harborline-mutual/modules/claims"`. |
| `time` | string (date-time) | yes | RFC 3339 UTC timestamp. |
| `tenantId` | string | yes | Tenant (licensee carrier) slug, e.g. "harborline-mutual". Fictional only. |
| `subject` | string | yes | claimId for claim.* events; tenantId for tenant.* events. |
| `datacontenttype` | `"application/json"` |  |  |
| `dataschema` | string (uri) |  |  |
| `dataversion` | string |  | Default `"1.0.0"`. |
| `correlationId` | string |  | Request or intake session that started the chain. |
| `causationId` | string |  | Id of the event that caused this one. |
| `actor` | `Actor` |  |  |
| `sequence` | integer |  | Per-tenant monotonic outbox sequence. |
| `data` | object | yes |  |

### claim.coverage.verified

Coverage check against the policy snapshot completed. Published by coverage.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `verificationId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `policySnapshotId` | string |  | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `policyNumber` | string |  |  |
| `outcome` | string (`covered`, `partial`, `not_covered`, `policy_not_found`, `needs_review`) | yes |  |
| `policyStatus` | string |  |  |
| `lossInPeriod` | boolean |  |  |
| `matchedCoverages` | array of string |  |  |
| `failedChecks` | array of string |  |  |

Schema: `events/claim.coverage.verified.schema.json` · Published by `coverage`

### claim.evidence.added

A document or media file was stored for a claim. Published by evidence.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `documentId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `kind` | string (`photo`, `police_report`, `estimate`, `invoice`, `other`) | yes |  |
| `contentType` | string | yes |  |
| `sizeBytes` | integer | yes |  |
| `sha256` | string | yes |  |
| `source` | string |  |  |

Schema: `events/claim.evidence.added.schema.json` · Published by `evidence`

### claim.evidence.extracted

Extraction finished (or failed) for a document. Published by evidence.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `documentId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `extractionId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `kind` | string |  |  |
| `status` | string (`completed`, `partial`, `failed`, `skipped`) | yes |  |
| `fieldCount` | integer |  |  |
| `lowConfidenceFields` | array of string |  |  |
| `ai` | `AiProvenance` |  | Required on every AI output (standards.md). |

Schema: `events/claim.evidence.extracted.schema.json` · Published by `evidence`

### claim.note.added

A note was added. The body is not in the event (PII). Published by claims.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `noteId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `category` | string | yes |  |
| `visibility` | string (`internal`, `shared_with_claimant`) | yes |  |
| `author` | `Actor` |  |  |
| `aiGenerated` | boolean |  |  |

Schema: `events/claim.note.added.schema.json` · Published by `claims`

### claim.reported

A new claim exists (FNOL recorded) from any channel. Published by claims.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `claimNumber` | string | yes |  |
| `lob` | string | yes | Line of business id from tenant config, e.g. personal_auto, homeowners, commercial_auto. Each LOB carries an ACORD LOBCd mapping (AUTOP, HOME, AUTOB). |
| `lossType` | string |  |  |
| `channel` | string (`claimant_web`, `claimant_mobile`, `csr_phone`, `agent_portal`, `api`, `email`, `partner`) | yes | Intake channel (FNOL reported-by channel). |
| `policyNumber` | string |  |  |
| `lossDate` | string (date) | yes |  |
| `lossCause` | string (`collision`, `collision_animal`, `single_vehicle`, `hit_and_run`, `glass`, `theft`, `vandalism`, `fire`, `lightning`, `wind`, `hail`, `water_weather`, `water_plumbing`, `flood`, `freeze`, `falling_object`, `liability_bodily_injury`, `liability_property_damage`, `other`) | yes | Platform loss-cause code. Aligned with the ACORD LossCauseCd concept; each tenant/adapter maps it to its own code list (see domain-model.md section ACORD alignment). |
| `riskState` | string |  | USPS state code (WI, IL, MI seeded). |
| `injuriesReported` | boolean |  |  |
| `vehiclesInvolved` | integer |  |  |
| `documentCount` | integer |  |  |
| `intakeSessionId` | string |  | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `reportedAt` | string (date-time) | yes | RFC 3339 UTC timestamp. |

Schema: `events/claim.reported.schema.json` · Published by `claims`

### claim.routed

Routing decided: assigned to a queue/adjuster or fast tracked. Published by rules.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `decisionId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `outcome` | string (`assigned`, `fast_tracked`) | yes |  |
| `queue` | string | yes |  |
| `adjusterId` | string |  |  |
| `ruleIds` | array of string | yes |  |
| `override` | boolean |  |  |

Schema: `events/claim.routed.schema.json` · Published by `rules`

### claim.status.changed

Claim status moved along the lifecycle state machine. Published by claims.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `from` | string (`reported`, `validating`, `triaged`, `assigned`, `fast_tracked`, `in_review`, `pending_info`, `closed`, `withdrawn`) | yes |  |
| `to` | string (`reported`, `validating`, `triaged`, `assigned`, `fast_tracked`, `in_review`, `pending_info`, `closed`, `withdrawn`) | yes |  |
| `reason` | string |  |  |
| `version` | integer | yes |  |
| `actor` | `Actor` |  |  |

Schema: `events/claim.status.changed.schema.json` · Published by `claims`

### claim.timer.breached

A regulatory timer passed its due time without being met. Published by claims.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `timerId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `definitionId` | string |  |  |
| `state` | string | yes | USPS state code (WI, IL, MI seeded). |
| `kind` | string (`acknowledge`, `contact`, `decide`) | yes |  |
| `dueAt` | string (date-time) | yes | RFC 3339 UTC timestamp. |
| `breachedAt` | string (date-time) | yes | RFC 3339 UTC timestamp. |

Schema: `events/claim.timer.breached.schema.json` · Published by `claims`

### claim.timer.due

A regulatory timer reached its warning point (due soon). Published by claims.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `timerId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `definitionId` | string |  |  |
| `state` | string | yes | USPS state code (WI, IL, MI seeded). |
| `kind` | string (`acknowledge`, `contact`, `decide`) | yes |  |
| `dueAt` | string (date-time) | yes | RFC 3339 UTC timestamp. |
| `warnAt` | string (date-time) |  | RFC 3339 UTC timestamp. |

Schema: `events/claim.timer.due.schema.json` · Published by `claims`

### claim.triaged

Triage (initial or re-run) produced a TriageResult. Published by triage.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `claimId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `triageResultId` | string | yes | Prefixed opaque id, e.g. clm_01J9Z..., doc_..., ses_... |
| `attempt` | integer | yes | Range 1... |
| `severityScore` | integer | yes | Range 0..100. |
| `severityBand` | string |  |  |
| `complexity` | string (`low`, `medium`, `high`) | yes |  |
| `fraudScore` | integer | yes | Range 0..100. |
| `fraudIndicatorCodes` | array of string |  |  |
| `subrogation` | boolean | yes |  |
| `fastTrackEligible` | boolean |  |  |
| `ai` | `AiProvenance` | yes | Required on every AI output (standards.md). |

Schema: `events/claim.triaged.schema.json` · Published by `triage`

### tenant.config.updated

Tenant configuration saved; caches must refresh. subject = tenantId. Published by config.

Payload `data`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `version` | integer | yes |  |
| `previousVersion` | integer |  |  |
| `changedSections` | array of string (`branding`, `lobs`, `questionSets`, `rules`, `queues`, `timers`, `notifications`, `integrations`, `ai`, `security`, `fastTrack`, `severityBands`, `holidays`, `other`) | yes |  |

Schema: `events/tenant.config.updated.schema.json` · Published by `config`

<!-- END GENERATED -->
