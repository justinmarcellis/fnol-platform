# Spike: Cloud KMS master-key wrap, enc:v2 envelope (S5-PLT-03)

Status: spike. Code in `src/core/keywrap.mjs`, tests in `tests/unit/core/spikes/keywrap.test.mjs` (13 pass, fakes only, no network). Nothing imports it yet. `crypto.mjs` is untouched; there is no re-encryption or migration code.

Addresses threat-model 3.5 (single master key on disk; no key id in ciphertext) and the deferred `enc:v2:<keyId>` item of data-protection.md section 4.

## Envelope

```
enc:v2:<keyId>:<wrappedDek>:<iv>:<tag>:<ct>        (each part base64url, no padding)
```

| Part | Content |
| --- | --- |
| keyId | UTF-8 key id string. Cloud KMS: the full `.../cryptoKeyVersions/N` name returned by `:encrypt`. |
| wrappedDek | The 32-byte DEK, wrapped by KMS (opaque bytes) |
| iv | 12 random bytes |
| tag | 16-byte GCM tag |
| ct | AES-256-GCM ciphertext of the UTF-8 value (may be empty) |

- A fresh random 32-byte DEK and 12-byte IV per value. The DEK is `fill(0)`ed after use (best effort in JS).
- AAD = `'enc:v2|' + keyId`. Relabelling the key id fails the tag check even if a KMS ignored the id.
- The parser is strict: exactly five parts, canonical base64url, iv 12 bytes, tag 16 bytes, non-empty key id and wrapped DEK. Anything else throws `KeywrapError('malformed')`.
- The key id is not secret. The format contains no plaintext and no DEK in clear.
- `enc:v1` is unchanged. `decryptAny(value, {v1Decrypt, kms})` routes by prefix: v1 to the supplied decrypter (for example `(v) => crypto.decryptPii(tenantId, v)`), v2 to `decryptV2`, other values pass through. `crypto.mjs`'s `isEncrypted` stays false for v2, so it ignores v2 values.
- Not yet bound: row/column AAD (threat-model 3.5 "no AAD"). A later `encryptV2(value, {kms, aad})` can append to the AAD string without changing the envelope layout.

API: `createFakeKms`, `createCloudKmsRest`, `encryptV2`, `decryptV2`, `decryptAny`, `keyIdOf`, `isV2`, `KeywrapError` (codes: `malformed`, `auth_failed`, `kms_unwrap_failed`, `kms_error`, `kms_unavailable`, `kms_auth_failed`, `key_id_mismatch`, `bad_config`, `bad_kms`).

Kms port: `wrapKey(dek) -> {keyId, wrapped}`, `unwrapKey({keyId, wrapped}) -> Buffer(32)`.

## Cloud KMS REST

- `POST https://cloudkms.googleapis.com/v1/{keyName}:encrypt` with `{plaintext: base64(DEK)}` returns `{ciphertext, name}`. `name` is the key version used and becomes the envelope key id.
- `POST .../{keyName}:decrypt` with `{ciphertext}` returns `{plaintext}`. Bearer token from an injected `tokenProvider` (production: `createTokenProvider` from `gcp-auth.mjs`, S5-PLT-02; not imported here).
- Only the DEK (32 bytes) ever goes to KMS, never customer data. This keeps within the 64 KiB KMS payload limit and keeps PII off the wire.
- Synthetic key name: `projects/example-project/locations/global/keyRings/example/cryptoKeys/master`.
- Adapter checks that the `:encrypt` response names a version of the configured key, and refuses (before any request) to decrypt an envelope whose key id belongs to another key. Decrypt does not need the version: KMS picks the right one from the ciphertext.

## DEK caching and per-tenant key option

The spike makes one KMS call per value (one wrap on write, one unwrap on read). That is the safe default but costs latency (below). Options, in order of increasing change:

1. **Unwrapped-DEK cache** (read side): `Map<sha256(wrappedDek) -> DEK>` with TTL (for example 5 min) and a size bound. Since DEKs are per value, hit rates are low for random reads and high only for repeat reads (claim detail refresh). Value is limited; cache needs `fill(0)` on eviction. Not implemented.
2. **Shared DEK per tenant per key version** (write side): generate one DEK per (tenant, key version) and reuse it for N values or a time window (still a fresh IV each time; keep far below the 2^32 GCM random-IV limit, for example rotate DEK every 100k values). One wrap amortised across many writes and one cached unwrap serves many reads. Needs the envelope to allow the same `wrappedDek` across values, which the format already allows. This is the likely production setup.
3. **Per-tenant KEK**: `TenantConfig.security.piiKeyRef` holds a Cloud KMS key name; build one `createCloudKmsRest` per tenant (cache the adapter). Key id then carries the tenant's key version, so a tenant can be crypto-shredded by destroying its key versions. Matches data-protection.md step 3. Cost: one key per tenant (USD 0.06 per active key version per month at current list price, check before committing) and IAM per key.

Per-value DEKs (spike default) plus option 3 gives the cleanest isolation; option 2 is what to add if latency matters.

## Rotation

- **KEK rotation (automatic in KMS)**: set a rotation period on the crypto key. New writes get a new version in `name`, so new envelopes carry the new key id. Old envelopes decrypt unchanged, because KMS keeps old enabled versions. No data rewrite.
- **Rewrap** (optional, cheap): unwrap and re-wrap only the DEK part to move to the newest version; the data ciphertext stays. Note AAD includes the key id, so a pure DEK rewrap changes the AAD and therefore needs re-encrypting the data too. If rewrap-without-rewrite matters, move key id out of the AAD in a v3 or use option 2 (shared DEKs) so only one record per tenant/version is rewrapped. This is a known tradeoff of the brief's AAD choice.
- **Retire a version**: scan with `keyIdOf(value)` (no KMS call) to find values still on the old key id; once zero, disable then destroy the version (KMS schedules destruction with a delay). The test `rotation` shows a disabled key fails closed.
- A re-encrypt job (data-protection.md 4(b)) is out of scope for this ticket.

## Failure modes (all fail closed)

| Failure | Behaviour |
| --- | --- |
| KMS unreachable / 5xx / 403 / 429 | Encrypt and decrypt throw (`kms_unavailable` / `kms_error` with HTTP status only). Never fall back to plaintext or to enc:v1. |
| Token provider fails or returns empty | `kms_auth_failed`, no request sent |
| Key version disabled or destroyed | Decrypt of affected values throws; others unaffected |
| Envelope malformed or tampered (any part) | `malformed` or `auth_failed`/`kms_unwrap_failed` |
| Key id altered | KMS unwrap fails, or the AAD check fails |
| Key id from another key | `key_id_mismatch`, no request sent |
| Unwrapped key not 32 bytes | Rejected |

Error messages carry no plaintext, DEK, token or response bodies. Callers should retry reads with backoff only above this layer, and surface 503 for writes that cannot be encrypted rather than store unencrypted PII.

## IAM

Grant the Cloud Run runtime service account `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the specific crypto key (or key ring), not at project level. It needs no admin role. Key administration (create, rotate, disable, destroy) belongs to a separate human or CI identity with `roles/cloudkms.admin`. Enable Cloud KMS audit logging (Data Access logs for `Encrypt`/`Decrypt`) for the key. Use `roles/cloudkms.cryptoKeyEncrypter` only for a write-only service if one is ever split out.

## Cost and latency (estimates, to be measured by the live check)

- Each wrap or unwrap is one HTTPS round trip. Expect roughly 10-30 ms in-region for a software key, more cross-region; budget 50 ms p99. Not measured in this spike.
- Cloud KMS charges per key version per month plus a small price per 10,000 cryptographic operations (software keys cheapest; HSM keys cost more). A claim read that decrypts 8 PII fields with per-value DEKs is 8 KMS calls; with option 1 or 2 this drops sharply. Check current pricing before sizing.
- Quota: default per-project cryptographic request quotas apply (a few thousand per minute); list views that decrypt many rows need caching (option 1/2) or must not decrypt at all (use blind indexes and redacted list responses).

## Live check (outside tests/)

Not run in this spike. Requires a real project, a key, and credentials; no secrets in git. Suggested script `scripts/kms-livecheck.mjs` (not created by this ticket):

```
KMS_KEY_NAME=projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k> \
  node --input-type=module -e "
import { createCloudKmsRest, encryptV2, decryptV2 } from './src/core/keywrap.mjs';
import { execFileSync } from 'node:child_process';
const tokenProvider = async () => execFileSync('gcloud', ['auth', 'print-access-token']).toString().trim();
const kms = createCloudKmsRest({ tokenProvider, keyName: process.env.KMS_KEY_NAME, fetch });
const t0 = performance.now();
const v = await encryptV2('live-check-value', { kms });
const back = await decryptV2(v, { kms });
console.log(back === 'live-check-value' ? 'OK' : 'MISMATCH', Math.round(performance.now() - t0) + ' ms', v.split(':')[2].length > 0);
"
```

On Cloud Run use `createTokenProvider` from `gcp-auth.mjs` (metadata server) instead of `gcloud`. Check the printed round-trip time against the budget above and that Cloud Audit Logs show the Encrypt and Decrypt calls.

## Decisions needed before adopting

1. Choose per-value DEKs vs shared per-tenant DEKs (cost/latency, rewrap story, AAD including key id).
2. Choose global key vs per-tenant KEK (crypto-shredding).
3. Row/column AAD scheme (threat-model 3.5).
4. Where `encryptPii`/`decryptPii` become async: KMS calls are async, but `crypto.mjs` is synchronous. Adoption needs an async crypto port (same direction as the async StorePort in S5-PLT-01).
