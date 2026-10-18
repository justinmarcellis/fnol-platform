# FNOL Platform

A proof of concept for a commercial off-the-shelf (COTS) First Notice of Loss platform that any property and casualty insurer could license. One deployment serves several carriers ("tenants"). A carrier differs from the next in configuration, not in code: intake questions, routing and straight-through-processing rules, regulatory timers, languages, branding, integrations and AI settings all live in one tenant document that the carrier's own admin edits.

The PoC takes a loss from first contact to a triaged, routed claim handed to the carrier's core claims system, with these parts:

- **Intake**: a claimant web app (English and Spanish), a CSR assisted-intake desk, and a public API for agent and partner channels.
- **Decisioning**: coverage verification, severity and fraud triage, subrogation detection, and a rules engine that routes each claim or sends it straight through.
- **Workbench**: an adjuster inbox and first view with an AI summary, next best actions, regulatory timers and an audit trail.
- **Administration**: a carrier admin console for no-code configuration, webhooks and KPIs.
- **Integration**: ports and adapters for the policy system and the core claims system, signed webhooks, and a CloudEvents outbox.

Everything is synthetic. The two demo carriers, Aurelia Mutual and Kestrel Point Insurance, and all people, policies and claims are fictional. Nothing calls a real carrier system, and no secrets are stored in git.

Stack: Node 22, plain JavaScript ES modules, built-in `node:sqlite`, zero runtime dependencies in the core (ADR-001). The AI layer is a cascade that works offline with a deterministic local provider and can add hosted models per tenant.

## Quick start

```
npm run seed    # optional: seeds policies and writes data/dev-users.json
npm start       # platform on :8080, PM dashboard on :8090
```

Then open:

| App | URL |
| --- | --- |
| Claimant | http://localhost:8080/ (add `?tenant=aurelia-mutual` or `kestrel-point`) |
| CSR desk | http://localhost:8080/csr?tenant=kestrel-point |
| Adjuster workbench | http://localhost:8080/adjuster |
| Carrier admin console | http://localhost:8080/admin |
| PM dashboard | http://localhost:8090/ |
| Health | http://localhost:8080/healthz |

Requires Node 22 or newer. There is nothing to install and no database server. Full instructions, environment variables and troubleshooting: [docs/setup.md](docs/setup.md).

```
npm test            # everything
npm run test:unit
npm run test:e2e
```

## Run the demo

[docs/demo-script.md](docs/demo-script.md) is a timed 10-minute script that tells the value-driver story with both carriers: a Spanish glass claim fast tracked at one carrier and held for review at the other by configuration alone, an injury rear-end call with a subrogation flag, a live admin change, KPIs, the core adapter payload and the PM dashboard.

## Repository layout

| Path | What is there |
| --- | --- |
| `src/core/`, `src/server.mjs` | Core runtime: HTTP router, auth, tenants, store, event bus, audit, scheduler |
| `src/modules/` | Product modules: intake, claims, coverage, evidence, triage, rules, adjuster, config, integrations, kpi, health |
| `src/ai/` | AI cascade, providers, guardrails, evaluation harness |
| `src/web/` | Claimant, CSR, adjuster and admin apps, plus the shared component kit |
| `tenants/` | One JSON configuration per demo carrier ([tenants/README.md](tenants/README.md)) |
| `architecture/` | Overview, domain model, threat model, and the API, domain and event contracts |
| `product/` | Value drivers, requirements, personas, packaging and competitive landscape |
| `docs/` | User and operator documentation ([docs/README.md](docs/README.md)) |
| `tests/` | Unit, end-to-end and security tests, and the synthetic data generator |
| `scripts/` | Dev start, seed and smoke test |
| `dashboard/` | PM dashboard for the program |
| `org/` | How the AI-staffed team works: decisions (ADRs), playbooks, board and hubs |
| `infra/`, `Dockerfile` | Terraform landing zone and container for the Google Cloud deployment target |

## Documentation

Start at [docs/README.md](docs/README.md). The most useful pages are [docs/setup.md](docs/setup.md), [docs/configuration-guide.md](docs/configuration-guide.md), [docs/api-reference.md](docs/api-reference.md) and [docs/demo-script.md](docs/demo-script.md). The architecture is in [architecture/overview.md](architecture/overview.md) and the earlier design dossier [docs/architecture.html](docs/architecture.html).

## Original jmarcellis.com design decisions

The platform began as an AI-assisted FNOL intake design for agents and policyholders on Google Cloud and Firebase. That design (`docs/architecture.html`) and its Terraform landing zone (`infra/`, see `infra/README.md`) remain the deployment target. The proof of concept generalizes it to a multi-tenant product (ADR-002); Guidewire becomes one adapter example among others.

| Topic | Decision |
| --- | --- |
| Claims and policy systems | Guidewire (ClaimCenter, PolicyCenter) and in-house, behind one adapter interface |
| Contact center | Google Customer Engagement Suite (Agent Assist, Conversational Insights) |
| Models | Gemini and Claude side by side on Vertex AI, chosen per task by evaluation |
| Launch states | Wisconsin, Illinois, Michigan; personal auto first |
| Cloud | jmarcellis.com Google Cloud organization |
