# COTS packaging and pricing hypotheses

Owner: ic-product-personas · Ticket: S0-PRD-02 · Status: for review (dir-product) · Date: 2026-10-18

**Every number in this document is a hypothesis.** None has been validated with a buyer. They exist to be tested in discovery calls and revised. Benchmarks use the model carrier in `value-propositions.md` (about $1B direct written premium, DWP). Value estimates there are also estimates (about $18.6M/yr for VD-1, 2, 4, 5).

## 1. Principles
1. Price on a metric that rises with value delivered and is easy for a carrier to forecast. Primary metric: **claims reported (FNOL records created) per year**, banded; carriers recognize it and it scales with TPA/MGA volume.
2. Alternative metric for carriers that dislike usage: **DWP band** flat fee, covering a stated claim volume with overage.
3. Keep the licence a small share of the value: target price at about 3 to 6 percent of estimated annual value (hypothesis), so the business case stays obvious.
4. AI features are add-ons so a buyer can start rules-only, and model costs pass through transparently (model-pluggable; the carrier may bring its own cloud model account).

## 2. Tiers (hypotheses)
| Tier | Scope | Value metric | Price hypothesis |
|---|---|---|---|
| **Foundation** | Omnichannel intake (web, CSR, agent, API), LOB-adaptive questions, coverage check, rules-based routing and STP, status page, state timers, audit, RBAC, one core adapter, 1 tenant, 2 lines of business | Claims reported per year, in bands | Platform fee $120k/yr plus $2.50 per claim up to 100k claims, $1.75 per claim above (hypothesis) |
| **Professional** | Foundation plus conversational intake, multilingual (up to 3 languages), evidence capture with extraction, severity/complexity scoring, fraud and subrogation indicators, KPI dashboard, 3 lines of business, webhooks | Claims reported per year, in bands | Platform fee $250k/yr plus $4.00 per claim to 100k, $3.00 above (hypothesis) |
| **Enterprise** | Professional plus multi-tenant (TPA/MGA), unlimited languages and lines, SSO, customer-managed keys, dedicated environment, premium support, custom adapter work | DWP band flat fee, or per tenant plus per claim | $500k to $900k/yr for $1B to $3B DWP (hypothesis); TPA/MGA: $30k/yr per tenant plus $2.00 per claim (hypothesis) |

Worked example, model carrier at ~$1B DWP and an assumed 150,000 FNOLs/yr (assumption): Professional = $250k + (100k x $4.00) + (50k x $3.00) = $800k/yr (hypothesis), about 4 percent of the ~$18.6M estimated annual value.

## 3. Add-ons (hypotheses)
| Add-on | What it adds | Priced on | Value driver | Price hypothesis |
|---|---|---|---|---|
| AI triage pack | Model-based severity, complexity, summaries, next best actions, with explanations | Per claim triaged (usage) | VD-1, VD-4 | $0.60 to $1.20 per claim, plus pass-through model cost at list |
| Fraud/anomaly and subrogation pack | Indicators with reasons, SIU routing, third-party liability flags | Per claim scored, or percent of identified recoveries as an alternative pilot structure | VD-4, VD-5 | $0.40 per claim, or 3 to 5 percent of incremental recoveries in a pilot |
| Document AI pack | Photo/PDF extraction (police reports, estimates) | Per document processed | VD-1, VD-4 | $0.15 to $0.40 per document |
| CAT surge pack | Surge capacity reservation, burst scaling, surge triage queue, mass-event templates and outbound updates | Annual reservation by expected peak daily claims, plus per-claim only when surge is used | VD-8, VD-2 | $40k to $120k/yr reservation by peak band (hypothesis) |
| Multilingual pack | Extra languages with reviewed translations | Per language per year | VD-6 | $15k per language per year |
| Adapter pack | Prebuilt connectors to core suites and policy admin systems | Per adapter, one-time plus annual maintenance | VD-3 | $40k one-time and $10k/yr per adapter |
| Voice/contact-center connector | Integration with a carrier's existing conversational AI or telephony | Per connector | VD-6 | $25k/yr |
| Bring-your-own-model | Use the carrier's own Claude/Gemini or other model account | Included; model cost billed by the carrier's cloud | VD-3 | $0 licence uplift |

## 4. Implementation model (hypotheses)
- **Config-first, 12-week target** (matches VD-3): weeks 1-2 discovery and tenant config baseline; 3-6 questions, routing, STP criteria, timers; 5-9 adapter mapping and integration test; 9-11 UAT and compliance review; 12 go-live with one line of business, then expand.
- **Delivery:** fixed-fee implementation of $150k to $350k depending on adapters and lines of business (hypothesis), by the vendor or a systems-integrator partner. Compare the estimated 9 to 18 months for FNOL inside a core-suite program (estimate in `value-propositions.md`).
- **Hosting:** multi-tenant SaaS on a cloud region of the carrier's choice; dedicated environment in Enterprise. Self-hosted option is deferred.
- **Pilot offer:** paid 90-day pilot on one line of business and one state at 25 percent of annual platform fee, credited against year 1 (hypothesis).
- **Contract:** three-year term with annual uplift capped at 5 percent (hypothesis); claim-volume true-up quarterly.

## 5. Pricing tied to value drivers
| Driver | What we claim | Priced through |
|---|---|---|
| VD-1 LAE via STP | Fewer touches per claim | Per-claim fee (Foundation/Professional); document AI per document |
| VD-2 Cycle time | Faster acknowledgment and contact | Included in tier; shown in KPI dashboard |
| VD-3 Speed to deploy | Config instead of code | Fixed implementation fee; adapter pack |
| VD-4 Leakage | Early severity, coverage, fraud | AI triage and fraud packs per claim |
| VD-5 Subrogation | Early third-party detection | Fraud/subrogation pack; optional recovery share in pilots |
| VD-6 Claimant experience | Self-service, multilingual | Multilingual pack per language |
| VD-7 Compliance | Timers, audit | Included in all tiers (veto item, not an upsell) |
| VD-8 CAT surge | Burst capacity | CAT surge reservation |

## 6. Open questions to validate
1. Do buyers prefer per-claim or DWP-band pricing? Test with 5 to 8 discovery calls.
2. Is a recovery-share structure acceptable to carrier finance?
3. How do systems integrators price the implementation, and do they resell?
4. What claim volume does the typical target carrier (mid-size, $500M to $3B DWP) really have?
