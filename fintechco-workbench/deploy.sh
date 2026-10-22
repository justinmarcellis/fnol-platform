#!/usr/bin/env bash
# One-command deploy to Cloud Run. Usage: ./deploy.sh [gcp-project-id]
#
# Optional environment:
#   REGION=us-central1        Cloud Run region
#   MIN_INSTANCES=1           keep one warm instance on demo day (no cold start)
#   ANTHROPIC_KEY_SECRET=name Secret Manager secret holding ANTHROPIC_API_KEY (enables Live CLI mode)
#   USE_VERTEX=1 VERTEX_PROJECT=... VERTEX_REGION=us-east5   run Live mode through Vertex AI instead
#   FIREBASE_SITE=fintechco-workbench  also publish at https://<site>.web.app (needs the firebase CLI;
#                                      use the Firebase project that hosts fintechco-roi.web.app)
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
ARGS=(--project "$PROJECT" --region "$REGION" --source . --allow-unauthenticated
      --memory 1Gi --cpu 1 --max-instances 1 --min-instances "${MIN_INSTANCES:-0}" --timeout 300)

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
gcloud run services describe fintechco-workbench --project "$PROJECT" --region "$REGION" --format 'value(status.url)'

SITE="${FIREBASE_SITE:-fintechco-workbench}"
if command -v firebase >/dev/null; then
  firebase hosting:sites:create "$SITE" --project "$PROJECT" 2>/dev/null || true
  sed -i.bak "s/\"site\": \"[^\"]*\"/\"site\": \"$SITE\"/" firebase.json && rm -f firebase.json.bak
  firebase deploy --only hosting --project "$PROJECT"
  echo "Published: https://$SITE.web.app"
else
  echo "firebase CLI not found (npm i -g firebase-tools) - skipping the web.app URL; the Cloud Run URL above works."
fi
