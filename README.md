# FNOL Intake Platform

AI-assisted first notice of loss intake for agents and policyholders on Google Cloud
and Firebase. A cascade of Gemini and Claude models on Vertex AI listens to the call,
fills the claim form, and a versioned rules engine checks that each claim meets
Wisconsin, Illinois and Michigan requirements and company SOPs before it reaches
Guidewire ClaimCenter or the in-house claims system.

- `docs/architecture.html` – architecture design (tiers, AI cascade, data movement, network, infrastructure)
- `infra/` – Terraform landing zone for the jmarcellis.com organization (Phase 0). See `infra/README.md`.

## Decisions

| Topic | Decision |
| --- | --- |
| Claims and policy systems | Guidewire (ClaimCenter, PolicyCenter) and in-house, behind one adapter interface |
| Contact center | Google Customer Engagement Suite (Agent Assist, Conversational Insights) |
| Models | Gemini and Claude side by side on Vertex AI, chosen per task by evaluation |
| Launch states | Wisconsin, Illinois, Michigan; personal auto first |
| Cloud | jmarcellis.com Google Cloud organization |
