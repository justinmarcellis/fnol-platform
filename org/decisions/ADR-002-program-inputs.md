# ADR-002: Program inputs left blank by the sponsor

Status: accepted · Owner: orchestrator · Date: 2026-10-18

The brief's input section was not filled in. Defaults chosen, to be changed by the sponsor at any milestone:

| Input | Default | Why |
| --- | --- | --- |
| Budget | $250 at Anthropic list prices, split by sprint in `org/config.json` | Enough for ~5 sprints of mostly mid-tier agents; red flag at 80% |
| Max concurrent agents | 6 | Harness limit (ADR-000) |
| Stack | Node 22 JavaScript, SQLite, GCP target (ADR-001) | Matches the existing GCP / Firebase architecture and runs offline |
| AI providers | Claude and Gemini on Vertex AI, plus a local deterministic provider | Sponsor's earlier decision; local provider keeps the PoC runnable without credentials |
| Lines of business | Personal auto and homeowners first, then commercial auto | Highest FNOL volume across carriers; earlier sponsor decision named personal auto |
| States | WI, IL, MI regulatory timers seeded; framework supports any state | Sponsor's earlier decision |
| Sponsor channel | This chat, milestone-only | Brief §7 |

## Relationship to the earlier jmarcellis.com design
The earlier architecture (`docs/architecture.html`) and Terraform (`infra/`) remain the GCP deployment target. This PoC generalizes the product to COTS: multi-tenant, fictional carriers, synthetic data only. Guidewire becomes one adapter example among others; no real carrier systems are called.
