#!/usr/bin/env bash
# One-command deploy: Cloud Run + Firebase Hosting (https://fintechco-workbench.web.app).
# Usage: ./deploy.sh [gcp-project-id]
#   With no project id, it finds the project that hosts fintechco-roi.web.app.
#
# Optional environment:
#   REGION=us-central1        Cloud Run region
#   MIN_INSTANCES=1           keep one warm instance on demo day (default 1)
#   FIREBASE_SITE=name        Hosting site name (default fintechco-workbench)
#   ANTHROPIC_KEY_SECRET=name Secret Manager secret holding ANTHROPIC_API_KEY (enables Live CLI mode)
#   USE_VERTEX=1 VERTEX_PROJECT=... VERTEX_REGION=us-east5   run Live mode through Vertex AI instead
set -euo pipefail
cd "$(dirname "$0")"

REGION="${REGION:-us-central1}"
SITE="${FIREBASE_SITE:-fintechco-workbench}"

command -v firebase >/dev/null || npm install -g firebase-tools >/dev/null
if ! firebase projects:list >/dev/null 2>&1; then
  echo ">> Sign in to Firebase (opens a link; paste the code back here)"
  firebase login --no-localhost
fi

PROJECT="${1:-}"
if [[ -z "$PROJECT" ]]; then
  echo ">> Looking for the project that hosts fintechco-roi.web.app..."
  for p in $(gcloud projects list --format='value(projectId)'); do
    sites=$(firebase hosting:sites:list --project "$p" 2>/dev/null || true)
    if [[ "$sites" == *fintechco-roi* ]]; then PROJECT="$p"; break; fi
  done
  PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
fi
[[ -n "$PROJECT" ]] || { echo "No project found. Run: ./deploy.sh <project-id>"; exit 1; }
echo ">> Deploying to project: $PROJECT"
gcloud config set project "$PROJECT" >/dev/null

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firebasehosting.googleapis.com --project "$PROJECT"

ARGS=(--project "$PROJECT" --region "$REGION" --source . --allow-unauthenticated --quiet
      --memory 1Gi --cpu 1 --max-instances 1 --min-instances "${MIN_INSTANCES:-1}" --timeout 300)
# Firebase Hosting proxies Cloud Run with a 60s limit, so cap live runs below it.
ENV_VARS="LIVE_IDLE_TIMEOUT_MS=15000,LIVE_MAX_MS=50000"
if [[ -n "${ANTHROPIC_KEY_SECRET:-}" ]]; then
  ARGS+=(--set-secrets "ANTHROPIC_API_KEY=${ANTHROPIC_KEY_SECRET}:latest")
fi
if [[ "${USE_VERTEX:-0}" == "1" ]]; then
  ENV_VARS+=",CLAUDE_CODE_USE_VERTEX=1,ANTHROPIC_VERTEX_PROJECT_ID=${VERTEX_PROJECT:-$PROJECT},CLOUD_ML_REGION=${VERTEX_REGION:-us-east5}"
fi
ARGS+=(--set-env-vars "$ENV_VARS")

gcloud run deploy fintechco-workbench "${ARGS[@]}"
RUN_URL=$(gcloud run services describe fintechco-workbench --project "$PROJECT" --region "$REGION" --format 'value(status.url)')

firebase hosting:sites:create "$SITE" --project "$PROJECT" >/dev/null 2>&1 || true
sed -i.bak "s/\"site\": \"[^\"]*\"/\"site\": \"$SITE\"/" firebase.json && rm -f firebase.json.bak
firebase deploy --only hosting --project "$PROJECT" --non-interactive

REVISION=$(gcloud run services describe fintechco-workbench --project "$PROJECT" --region "$REGION" --format 'value(status.latestReadyRevisionName)')
echo
echo "================ DEPLOY SUMMARY ================"
echo "Project:          $PROJECT"
echo "Cloud Run rev:    $REVISION"
echo "Cloud Run URL:    $RUN_URL"
echo "  serves:         $(curl -s "$RUN_URL/api/status" | grep -o '"version":"[^"]*","revision":"[^"]*"')"
echo "Published URL:    https://$SITE.web.app"
echo "  serves:         $(curl -s "https://$SITE.web.app/api/status?t=$(date +%s)" | grep -o '"version":"[^"]*","revision":"[^"]*"')"
echo "Both 'serves' lines should show $REVISION. If the web.app line differs or is empty,"
echo "the site $SITE belongs to another project: re-run as ./deploy.sh <that-project-id>."
echo "================================================"
