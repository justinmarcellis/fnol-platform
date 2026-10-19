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
  cloudbuild.googleapis.com iap.googleapis.com secretmanager.googleapis.com

# 3. Image
gcloud artifacts repositories create fnol --repository-format=docker --location=$REGION
gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT/fnol/platform:poc .

# 4. Runtime identity with no roles beyond what the service needs
gcloud iam service-accounts create fnol-run --display-name="FNOL PoC runtime"

# 5. Deploy: authenticated only, single instance, IAP in front
gcloud run deploy fnol-platform --image $REGION-docker.pkg.dev/$PROJECT/fnol/platform:poc \
  --region $REGION --service-account fnol-run@$PROJECT.iam.gserviceaccount.com \
  --no-allow-unauthenticated --max-instances 1 --min-instances 0 --memory 1Gi --port 8080 \
  --iap
gcloud iap web add-iam-policy-binding --member=user:<sponsor-email> \
  --role=roles/iap.httpsResourceAccessor --region $REGION --resource-type=cloud-run --service fnol-platform

# 6. Verify
#   - open the service URL in a browser signed in as the sponsor
#   - /healthz returns ok with 11 modules and 2 tenants
#   - run docs/demo-script.md
```

If IAP for Cloud Run is unavailable in the project, fall back to `--no-allow-unauthenticated` and `gcloud run services proxy fnol-platform --region $REGION` for local browser access.

## Not in scope for the PoC deploy

Cloud SQL, Pub/Sub, Cloud KMS and SSO are production gaps tracked in `docs/cots-readiness.md`. Vertex AI providers stay off until Claude models are enabled in Model Garden for `fnol-poc`.
