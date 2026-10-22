#!/usr/bin/env bash
# One-command deploy to Cloud Run. Usage: ./deploy.sh [gcp-project-id]
#
# Optional environment:
#   REGION=us-central1        Cloud Run region
#   MIN_INSTANCES=1           keep one warm instance on demo day (no cold start)
#   ANTHROPIC_KEY_SECRET=name Secret Manager secret holding ANTHROPIC_API_KEY (enables Live CLI mode)
#   USE_VERTEX=1 VERTEX_PROJECT=... VERTEX_REGION=us-east5   run Live mode through Vertex AI instead
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
ARGS=(--project "$PROJECT" --region "$REGION" --source . --allow-unauthenticated
      --memory 1Gi --cpu 1 --max-instances 1 --min-instances "${MIN_INSTANCES:-0}" --timeout 300)

ENV_VARS="LIVE_IDLE_TIMEOUT_MS=15000"
if [[ -n "${ANTHROPIC_KEY_SECRET:-}" ]]; then
  ARGS+=(--set-secrets "ANTHROPIC_API_KEY=${ANTHROPIC_KEY_SECRET}:latest")
fi
if [[ "${USE_VERTEX:-0}" == "1" ]]; then
  ENV_VARS+=",CLAUDE_CODE_USE_VERTEX=1,ANTHROPIC_VERTEX_PROJECT_ID=${VERTEX_PROJECT:-$PROJECT},CLOUD_ML_REGION=${VERTEX_REGION:-us-east5}"
fi
ARGS+=(--set-env-vars "$ENV_VARS")

gcloud run deploy fintechco-workbench "${ARGS[@]}"
gcloud run services describe fintechco-workbench --project "$PROJECT" --region "$REGION" --format 'value(status.url)'
