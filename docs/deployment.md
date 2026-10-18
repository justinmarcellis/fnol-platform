# Deployment guide (GCP, Cloud Run)

Status: authored, not executed. Every command below is marked NOT RUN. Nothing has been applied, built or pushed from this repo, and no credentials are involved.

## What gets deployed

One container (`Dockerfile`, `node:22-slim`, non-root user `node`) serving the whole platform on port 8080, described by `infra/cloudrun/service.yaml` (Knative serving v1, service `fnol-platform` in project `jmfnol-app-dev`). Health is `GET /healthz`, used by the Dockerfile HEALTHCHECK and the Cloud Run startup and liveness probes.

The image starts the server with an inline entry that passes `host: '0.0.0.0'`, because `createApp` binds 127.0.0.1 by default. A `HOST` env var in `src/server.mjs` would be cleaner; this was raised as a contract-change request to the architecture hub.

## Mapping to infra stages

| Stage | What this deployment uses |
|---|---|
| `infra/0-bootstrap` | Seed project, state bucket and the Terraform service account. Must be applied first. |
| `infra/1-org` | `jmfnol-cicd` project and the Artifact Registry repository `fnol` that holds the image. Cloud Run's service agent already has reader on it (`run_pull` in identities.tf). |
| `infra/2-env` (`envs/dev.tfvars`) | `jmfnol-app-dev` (Cloud Run), `jmfnol-sec-dev` (Secret Manager, KMS), Shared VPC subnets and Direct VPC egress (`network.tf`), runtime service account `fnol-intake-api` (`identities.tf`), ingress limited to internal and load balancer by org policy. |

Runtime identity: `fnol-intake-api@jmfnol-app-dev.iam.gserviceaccount.com`. It currently holds only subnet `networkUser`; grant it `roles/secretmanager.secretAccessor` on the one secret below and nothing broader.

## Secrets

No secret value appears in git or in `service.yaml`. The PII master key (32 random bytes) is a Secret Manager secret `fnol-pii-master-key` in `jmfnol-sec-dev`, mounted as a file at `/app/.secrets/master.key` because `src/core/crypto.mjs` reads a file, not an env var. Any future string secret must be injected with `valueFrom.secretKeyRef`, never `value`.

## Commands (all NOT RUN)

```sh
PROJECT=jmfnol-app-dev
REGION=us-central1
IMAGE=$REGION-docker.pkg.dev/jmfnol-cicd/fnol/fnol-platform:$(git rev-parse --short HEAD)

# 1. Local sanity check (NOT RUN)
docker build -t fnol-platform:local .
docker run --rm -p 8080:8080 fnol-platform:local   # then GET /healthz

# 2. Build and push to the shared registry (NOT RUN)
gcloud builds submit --project jmfnol-cicd --tag "$IMAGE" .

# 3. Create the master key secret from a locally generated key, then delete the local copy (NOT RUN)
head -c 32 /dev/urandom > /tmp/master.key
gcloud secrets create fnol-pii-master-key --project jmfnol-sec-dev --data-file=/tmp/master.key
shred -u /tmp/master.key
gcloud secrets add-iam-policy-binding fnol-pii-master-key --project jmfnol-sec-dev \
  --member serviceAccount:fnol-intake-api@jmfnol-app-dev.iam.gserviceaccount.com \
  --role roles/secretmanager.secretAccessor

# 4. Deploy the service definition with the image substituted (NOT RUN)
sed "s#fnol-platform:latest#fnol-platform:$(git rev-parse --short HEAD)#" infra/cloudrun/service.yaml \
  | gcloud run services replace - --project "$PROJECT" --region "$REGION"

# 5. Verify through the internal path (NOT RUN; from inside the VPC or via the load balancer)
curl -fsS https://INTERNAL_OR_LB_HOST/healthz
```

Ingress is `internal-and-cloud-load-balancing`, so the run.app URL is not reachable from the internet; put an external HTTPS load balancer with a serverless NEG in front for user traffic (not defined in infra yet).

## Proof-of-concept limits

- SQLite lives on an `emptyDir` volume and is lost on restart; `maxScale` is 1 because SQLite is single-writer. Seed data is not loaded in the container.
- The in-process bus and scheduler assume one instance.
- `devMode` is off because `NODE_ENV=production`, so the dev token endpoint is disabled. A real identity provider must be configured before any use beyond a demo.

## Changes required for production

1. Database: replace SQLite with Cloud SQL (Postgres, private IP via the PSA range in `network.tf`, CMEK key `primary/sql`) or Firestore (key `us/firestore`). This needs a store adapter behind `src/core/store.mjs`; no code exists yet.
2. Cloud KMS: replace the file master key with an envelope scheme: the master key is wrapped by a KMS key (the `pii-tokenization` key in `kms.tf`), unwrapped at start, and the runtime SA gets `cloudkms.cryptoKeyDecrypter` on that key only.
3. Pub/Sub: replace the in-process outbox dispatch in `src/core/bus.mjs` with Pub/Sub topics (CMEK key `us/pubsub`) and push subscriptions to a Cloud Run endpoint, so multiple instances can run and `maxScale` can rise.
4. Scale and state: remove the single-instance assumption, set `minScale` per SLO, and move the scheduler to Cloud Scheduler.
5. Edge: external HTTPS load balancer, Cloud Armor, IAP or an identity provider, and per-service runtime accounts (the other accounts in `identities.tf`) as modules are split out.
6. Pipeline: build and deploy through Cloud Build and Cloud Deploy in `jmfnol-cicd` with immutable image digests instead of manual commands; promote dev, stg, prd with the matching `envs/*.tfvars`.
7. VPC Service Controls: the perimeter is dry-run; enforce it only after confirming Cloud Run, Secret Manager and Artifact Registry flows are allowed.
