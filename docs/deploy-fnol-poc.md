# Deploying the PoC to the `fnol-poc` project

Target: GCP project `fnol-poc` (number 1033030652144), dev environment only. Synthetic data only.

This is the runbook for a session that has the deployer credential. The full multi-project landing zone in `infra/` is not used for the PoC. It creates folders and projects across the organization, and the PoC needs one project.

## Scope rules

- Touch only project `fnol-poc`. The service account also has organization-wide access; do not use it outside this project.
- The app runs with `devMode` on, so `POST /api/v1/auth/token` can mint any role. The service must **never** allow unauthenticated access (`allUsers`). Put Identity-Aware Proxy in front and grant access only to the sponsor's account.
- SQLite lives on the instance's local disk. Keep `max-instances=1`. Data resets when the instance restarts, and `npm start` reseeds the demo data on a new database.

## Steps

```sh
PROJECT=fnol-poc
REGION=us-central1

# 1. Authenticate with the deployer key (from the environment; never commit it)
gcloud auth activate-service-account --key-file=<path-to-key-from-environment>
gcloud config set project $PROJECT

# 2. APIs
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com iap.googleapis.com secretmanager.googleapis.com \
  cloudresourcemanager.googleapis.com

# 3. Image. The org enforces cloudbuild.disableCreateDefaultServiceAccount, so the
#    build runs as a dedicated SA and logs to Cloud Logging only (no storage.admin).
gcloud artifacts repositories create fnol --repository-format=docker --location=$REGION
BUILD_SA=fnol-build@$PROJECT.iam.gserviceaccount.com
gcloud iam service-accounts create fnol-build --display-name="FNOL PoC image build"
for r in roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding $PROJECT --condition=None --member=serviceAccount:$BUILD_SA --role=$r
done
gcloud storage buckets add-iam-policy-binding gs://${PROJECT}_${REGION}_cloudbuild \
  --member=serviceAccount:$BUILD_SA --role=roles/storage.objectViewer
IMAGE=$REGION-docker.pkg.dev/$PROJECT/fnol/platform:poc
printf 'steps:\n- name: gcr.io/cloud-builders/docker\n  args: [build, -t, %s, .]\nimages: [%s]\noptions:\n  logging: CLOUD_LOGGING_ONLY\n' \
  "$IMAGE" "$IMAGE" > /tmp/cloudbuild.yaml
gcloud builds submit --region=$REGION --config=/tmp/cloudbuild.yaml \
  --service-account=projects/$PROJECT/serviceAccounts/$BUILD_SA \
  --default-buckets-behavior=regional-user-owned-bucket .

# 4. Runtime identity with no roles beyond what the service needs
gcloud iam service-accounts create fnol-run --display-name="FNOL PoC runtime"

# 5. Deploy: authenticated only, single instance, IAP in front
gcloud run deploy fnol-platform --image $REGION-docker.pkg.dev/$PROJECT/fnol/platform:poc \
  --region $REGION --service-account fnol-run@$PROJECT.iam.gserviceaccount.com \
  --no-allow-unauthenticated --max-instances 1 --min-instances 0 --memory 1Gi --port 8080 \
  --set-env-vars FNOL_DEV_MODE=1 --iap
gcloud iap web add-iam-policy-binding --member=user:<sponsor-email> \
  --role=roles/iap.httpsResourceAccessor --region $REGION --resource-type=cloud-run --service fnol-platform

# 5b. The Google-managed OAuth client only admits users in the project's organization,
#     so a sponsor outside it (e.g. @gmail.com) gets "You don't have access". Console only:
#     OAuth consent screen (Audience: External, sponsor added as a test user), then a
#     Web application client with redirect URI
#     https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect
#     Then point IAP at it (prompts, so the secret is not echoed or committed):
read -p "Client ID: " CID; read -s -p "Client secret: " CSEC; echo
printf 'access_settings:\n  oauth_settings:\n    client_id: %s\n    client_secret: %s\n' "$CID" "$CSEC" > iap.yaml
gcloud iap settings set iap.yaml --region $REGION --resource-type=cloud-run --service fnol-platform
rm iap.yaml; unset CSEC

# 6. Verify
#   - open the service URL in a browser signed in as the sponsor
#   - the run.app frontend reserves /healthz (Google 404), so check the revision
#     logs instead: four "seeded ... 25 policies" lines and "demo-data summary: created 29"
#   - run docs/demo-script.md
```

The image starts via `scripts/dev.mjs`, which seeds policies and demo claims on a new database and binds `HOST=0.0.0.0`. `FNOL_DEV_MODE=1` (set explicitly on the deploy command; the image defaults it to 0) turns on devMode. `NODE_ENV` has no effect on it. This is the accepted R2 risk for an IAP-only PoC. The startup log prints dev tokens; they only work against this ephemeral instance, behind IAP.

If `gcloud` says it is using `CLOUDSDK_AUTH_ACCESS_TOKEN`, run it as `env -u CLOUDSDK_AUTH_ACCESS_TOKEN gcloud ...` so the activated service account is used.

If IAP for Cloud Run is unavailable in the project, fall back to `--no-allow-unauthenticated` and `gcloud run services proxy fnol-platform --region $REGION` for local browser access.

## Not in scope for the PoC deploy

Cloud SQL, Pub/Sub, Cloud KMS and SSO are production gaps tracked in `docs/cots-readiness.md`. Vertex AI providers stay off until Claude models are enabled in Model Garden for `fnol-poc`.

## Deployment log

| Date (UTC) | Revision | Commit | Why | Verified |
| --- | --- | --- | --- | --- |
| 2026-10-19 01:15 | fnol-platform-00002-5pz | bff35bc (image `poc`) | First PoC deploy | IAP on, run.invoker only the IAP agent, sponsor only, seed + 29 demo claims in logs |
| 2026-10-19 02:23 | fnol-platform-00003-mzt | 1702813 | Web apps work behind IAP (S5-EXP-01), claimant holder check by last name + ZIP (S5-WFL-04) | Same checks; full npm test 1406 pass, 0 fail |
| 2026-10-19 04:18 | fnol-platform-00004-kvk | f2d6fc9 | Labelled-name redaction (S5-AI-08), per-policy holder lockout (S5-WFL-05) | Same checks; full npm test 1446 pass, 0 fail, 3 todo |
| 2026-10-19 13:26 | fnol-platform-00005-zqd | 22a6591 | Sprint 6 redesign: design system, app shell, persona switcher, four app redesigns, design QA; FNOL_DEV_MODE=1 now explicit (S6-PLT-01) | Same checks; full npm test 1533 pass, 0 fail, 3 todo |
| 2026-10-19 21:35 | fnol-platform-00006-55f | 4b5878a | Sprint 6 bug bash: policy data fills on every desk, agent desk, demo personas, timers on every intake claim, intake answers kept | IAP on, run.invoker only the IAP agent; full npm test 1705 pass, 1 load-sensitive UI test (passes alone); demo audit clean across 12 personas |
| 2026-10-20 00:24 | fnol-platform-00007-xjg | a019ba8 | Two-persona demo journey: adjuster requests reach the claimant's claim page (docs/demo-journey.md) | IAP on (302 to Google sign-in); full npm test 1708 pass, 0 fail; scripts/demo-journey.mjs all 12 beats ok locally |

Images are tagged with the short commit (`$REGION-docker.pkg.dev/$PROJECT/fnol/platform:<sha>`) as well as `poc`. Build from a clean `git worktree` of the commit so uncommitted files never reach the image.
