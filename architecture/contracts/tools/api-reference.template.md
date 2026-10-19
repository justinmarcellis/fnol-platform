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

