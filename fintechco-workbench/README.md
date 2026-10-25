# FinTechCo Agentic Engineering Workbench

One-page demo app for the "Live Workbench" section of the FinTechCo executive briefing. Three one-click scenarios show headless Claude Code (`claude -p`) fixing real files in `/tmp/demo-workspace`, with real `pytest` gates, a before/after diff, and a business-impact artifact per scenario.

| # | Team | What runs | Gate |
|---|------|-----------|------|
| 1 | SRE & Security (20) | Masks raw PANs in `sre_payment_worker.py` + `sre_log_check.go`, structured JSON logs | `test_pci_compliance.py` 0/4 → 4/4 |
| 2 | Data Science → SWE (40 + 120) | Untyped notebook → typed scoring module + FastAPI route + TS contract; live contract tester | `test_fraud_api.py` 0/4 → 4/4 |
| 3 | Every engineering team | Reviews pull request #1427 (refund feature): fixes query injection, a hardcoded key, a missing permission check and refund limits; writes REVIEW.md | `test_refund_service.py` 0/4 → 4/4 |

## Modes

- **Live CLI**: enabled when the `claude` CLI is installed and `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_USE_VERTEX=1` / `CLAUDE_CODE_USE_BEDROCK=1`) is set. Streams `stream-json` events into the terminal. If the CLI goes quiet for 15s (`LIVE_IDLE_TIMEOUT_MS`), errors, or runs past 150s (`LIVE_MAX_MS`), the run switches to Safe Mode mid-stream. If Claude's edit doesn't clear the gate, the verified patch is applied and the gate re-runs.
- **Deterministic Safe Mode**: no model call. It writes the verified patch from `verified-patches/<id>/`, and every `pytest` run, file read, diff and the Scenario 3 statistics are executed for real. The terminal narration is scripted and the token cost is an estimate (marked `est.`). If you're asked, describe it as a replay of a verified Claude Code run.

## Run locally

```sh
npm install
pip install pytest          # or apt install python3-pytest
npm run dev                 # http://localhost:3000
npm run verify:seed         # shows the 12 seed tests failing before any fix
```

Everything is one click: **Run Claude Code** on each card, **Governance** and **Reset Workspace** in the header. Live CLI is used automatically when available, otherwise Safe Mode. Presenter notes (talk track + CTO objection answers) are hidden; press `?` to open them if you want them.
**Reset** restores `/tmp/demo-workspace` from `seed-workspace/`, so you can re-run the demo any number of times. A single scenario can also be re-run on its own.

## Deploy to Cloud Run

```sh
./deploy.sh <gcp-project-id>                         # Safe Mode only
ANTHROPIC_KEY_SECRET=anthropic-api-key ./deploy.sh <project>   # + Live CLI (key in Secret Manager)
USE_VERTEX=1 ./deploy.sh <project>                   # + Live CLI through Vertex AI (grant the runtime SA roles/aiplatform.user)
MIN_INSTANCES=1 ./deploy.sh <project>                # demo day: no cold start
```

To match `fintechco-roi.web.app`, install the Firebase CLI (`npm i -g firebase-tools`, then `firebase login`) and run `./deploy.sh <firebase-project-id>` with the same project that hosts the ROI calculator. The script deploys Cloud Run, creates the Hosting site `fintechco-workbench`, and proxies it, so the demo is served at **https://fintechco-workbench.web.app**. Override the name with `FIREBASE_SITE=...`.

Uses `--max-instances 1` so the in-memory `/tmp` workspace stays consistent. Keep `npm run dev` running locally as a backup tab.
