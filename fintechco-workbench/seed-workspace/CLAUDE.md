# FinTechCo Enterprise Engineering Standards (CLAUDE.md)

Version-controlled policy. Claude Code loads this file at the start of every session in this repository.

- **Cloud Boundary:** All model requests route through GCP Vertex AI / AWS Bedrock private endpoints with Zero Data Retention. No source code or customer data leaves the FinTechCo VPC perimeter.
- **Rule 1 (PCI-DSS Req. 3.4 - SRE & Security):** NEVER log raw 16-digit Primary Account Numbers (PAN). Always mask PANs so only the last 4 digits are visible: `XXXX-XXXX-XXXX-1234`. Applies to Python, Go, and shell.
- **Rule 2 (DS-to-SWE Production Handoff):** Fraud scoring logic promoted from Data Science notebooks must use strict Python type annotations, dataclass/Pydantic schemas, an OpenAPI contract consumable from TypeScript and Java, and deterministic score bounds `[0.0, 1.0]` with decisions `APPROVE | REVIEW | DECLINE`.
- **Rule 3 (Observability):** SRE scripts emit structured JSON logs (`event`, `trace_id`, `severity`), never free-text f-strings containing customer data.
- **Rule 4 (Verification Gate):** Every code modification MUST pass `python3 -m pytest -q` before completion. Never edit `test_*.py` files to make a gate pass.
- **Rule 5 (Quant Reproducibility):** Board-facing statistics use the standard library only, are computed from the checked-in CSV, and report the sample size and p-value alongside every correlation.
