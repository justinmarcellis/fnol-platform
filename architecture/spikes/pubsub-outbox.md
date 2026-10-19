# Spike: Pub/Sub outbox publisher (S5-PLT-02)

Status: proof of concept. Code: `src/core/outbox-publisher.mjs`, `src/core/gcp-auth.mjs`. Nothing here has run against GCP; tests use fake fetch. `bus.mjs` and `store.mjs` are untouched.

## Outbox columns (verified in `src/core/bus.mjs`)
`outbox (id, tenant_id, type, subject, event, status, attempts, last_error, created_at, delivered_at, seq)`. `status` is `pending | delivered | failed`; `seq` is per-tenant, gapless, unique on `(tenant_id, seq)`, never reused. `event` is the JSON CloudEvents-style envelope. There is no `published` status; the host injects `readUndelivered()` (for example `status != 'published'` or a new column/status added by the platform owner) and `markPublished(ids)`. Rows whose status is `pending` are also dispatched in process by `bus.recover`; the host must decide whether Pub/Sub publishing replaces or supplements that.

## Ordering semantics
`publishPending()` sorts rows by `(tenant_id, seq)` and publishes one message at a time, awaiting the ack before the next. `orderingKey = tenant_id`, so Pub/Sub preserves per-tenant order across publisher restarts; there is no global order across tenants. Attributes (all strings): `outboxId`, `tenant_id`, `type`, `seq`. Message data is the `event` JSON.

## Delivery guarantee and dedupe
At-least-once. A row is marked published only after the publish ack, so a crash between ack and mark re-publishes it. Subscribers dedupe on the `outboxId` attribute (equals the event id). The contract-level dedupe table is called `consumed_events` in the brief; as built, core has `bus_handled (tenant_id, handler, event_id)` with the same purpose. Subscribers should insert `(tenant_id, outboxId)` before side effects and skip on conflict. Subscriptions must enable message ordering to receive per-key order.

## Topic and subscription ordering enablement
Ordering is enabled on the subscription (`--enable-message-ordering`); publishing with an `orderingKey` requires a regional endpoint for strict guarantees across regions. Example (synthetic project):
```
gcloud pubsub topics create fnol-events --project example-project
gcloud pubsub subscriptions create fnol-events-sub --topic fnol-events --enable-message-ordering --project example-project
```

## Failure and resume
On any publish error the tenant halts: later rows for that tenant stay pending (other tenants continue). Pub/Sub client libraries pause an ordering key after a failed ordered publish until `resumePublish(key)`. The REST publisher mirrors this: after a failure it rejects further publishes for that key until `resumePublish(orderingKey)`. `publishPending` calls `publisher.resumePublish(tenantId)` at the start of the next run for halted tenants, then retries from the first unacked `seq`. Rerunning is idempotent: acked rows are no longer returned by `readUndelivered`.

## Retention
Set topic `--message-retention-duration` (for example 7d) so a slow subscriber can be re-driven, and subscription retention to match. Outbox rows are never deleted by this spike, so the outbox itself is the long-term replay source.

## Auth (`gcp-auth.mjs`)
`createTokenProvider({ fetch, env, now })` returns `{ getToken(), invalidate() }`. It GETs `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token` with `Metadata-Flavor: Google`, expects `{access_token, expires_in}`, and caches until 60 s before expiry (concurrent callers share one request). Overrides: `GCP_ACCESS_TOKEN` (static token) and `GCE_METADATA_HOST`. `gcpFetch(url, init, { tokenProvider, fetch })` adds `Authorization: Bearer` and retries once on 401 after `invalidate()`. Errors carry a code (`token_unreachable | token_http | token_invalid`) and never include tokens or response bodies. These export names and signatures are stable for S5-PLT-03.

## Live check (not under tests/)
Requires a topic and credentials; run from a dev shell:
```
GCP_ACCESS_TOKEN=$(gcloud auth print-access-token) node --input-type=module -e "
import { createTokenProvider } from './src/core/gcp-auth.mjs';
import { createPubSubRestPublisher } from './src/core/outbox-publisher.mjs';
const p = createPubSubRestPublisher({ project: 'example-project', topic: 'fnol-events', tokenProvider: createTokenProvider() });
console.log(await p.publish({ data: '{\"ping\":true}', orderingKey: 'live-check', attributes: { outboxId: 'live-1', tenant_id: 'live-check' } }));"
```
Expect `{ messageId: '...' }`; pull from the subscription to confirm.

## Contract notes
No contract change requested. Additive: Publisher port `{ publish({data, attributes, orderingKey}), resumePublish?(key) }`.
