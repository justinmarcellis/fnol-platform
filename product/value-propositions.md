# Value propositions and value-driver ranking

Owner: dir-product · Ticket: S0-PRD-01 · Status: for review (ceo) · Date: 2026-10-18

This document says who buys and uses a COTS First Notice of Loss (FNOL) platform, what each of them values, how much each candidate value driver is worth to a model carrier, and which drivers the proof of concept (PoC) will prove. Drivers carry stable IDs `VD-1` to `VD-9` in rank order. Tickets reference them in `valueDrivers` (see `org/playbooks/standards.md`).

**Every dollar figure here is an estimate** built on the model carrier below. Public benchmarks are cited by source name. Several of them are vendor or consultant figures, or are old, and are labelled that way. All carriers, tenants and people are fictional.

---

## 1. Stakeholders and what each values

| # | Stakeholder | Role in the buying decision | What they value | How they will judge the PoC |
|---|---|---|---|---|
| 1a | **Carrier claims VP / Chief Claims Officer** | Economic sponsor, budget owner | Loss and LAE ratio, cycle time, claimant satisfaction (J.D. Power-style scores), adjuster capacity, fewer complaints | Before/after KPIs: time to first contact, STP rate, adjuster minutes per new claim, leakage flags caught |
| 1b | **CIO / CTO** | Technical veto, integration owner | Fits the core claims suite, low integration effort, security, no vendor lock-in, cloud posture, configuration owned by the business and not by IT backlog | Event/webhook contract, sample core adapter, tenant isolation, how fast a config change ships without a release |
| 1c | **CFO** | Approves the business case | Payback period, hard LAE savings versus soft benefits, indemnity leakage, subrogation cash, licence cost per claim | A business case with explicit assumptions (this document, §3), measurable in pilot |
| 1d | **Compliance / legal / market conduct** | Gatekeeper | State acknowledgment and contact deadlines met, complete audit trail, PII protection, explainable AI with no automated adverse decisions, unfair-claims-practices exposure | Regulatory timers per state, immutable audit log, AI explanations, RBAC, PII encryption |
| 2 | **Adjusters / claim handlers** | Daily user, change-adoption risk | Complete and structured first reports, less re-contact, one screen showing what matters, triage they can trust, override control | Adjuster first view: AI summary, timeline, flags with reasons, next best actions |
| 3 | **CSRs / call-center FNOL reps** | Daily user | Guided scripts that adapt to the line of business, shorter handle time, fewer "where is my claim" calls, surge relief | Guided LOB-adaptive intake, handle time, call deflection by self-service status |
| 4 | **Independent agents / brokers** | Channel partner, influences retention | Report a loss on behalf of a client in minutes, see status without calling the carrier, look good to the client | Agent channel intake, status visibility, notifications |
| 5 | **Claimants (insureds and third parties)** | End user | Easy reporting at any hour, in their language, on any device; fast human contact; knowing what happens next; fast payment | Mobile-friendly conversational intake, instant acknowledgment, status page, Spanish support |
| 6 | **TPAs / MGAs** | Licensee or operator on behalf of several carriers | Multi-carrier (multi-tenant) operation, per-client configuration and SLAs, per-client reporting, low cost per claim | Two differently configured tenants on one deployment, strict isolation, per-tenant rules and timers |

**Product implication:** the claims VP and CFO buy on economics, the CIO and compliance can veto, and adjusters and CSRs decide adoption. The PoC has to show hard numbers (VD-1, VD-2, VD-4, VD-5) and pass the vetoes (VD-3, VD-7) in one demo.

---

## 2. Model carrier (assumptions used by every estimate)

"Model Carrier MC-1" is fictional. Its figures are round numbers chosen to look like a mid-size US personal-lines-heavy writer.

| Assumption | Value | Basis |
|---|---|---|
| Direct written premium (DWP) | $1.0B (≈ earned) | Brief |
| Mix | Personal auto 70% ($700M) · homeowners 25% ($250M) · commercial auto 5% ($50M) | Personal-lines heavy, per brief and ADR-002 |
| Claims reported per year | **~120,000** (auto 100k incl. glass, home 16k incl. CAT, commercial auto 4k) | ≈470k auto policies at ~$1,500 with ~21 claims/100 policy-years, ~165k home policies with ~10/100. Estimate |
| Loss ratio | 65% → **$650M** paid losses (avg ≈ $5,400/claim) | Order of magnitude consistent with NAIC-based industry aggregates as reported by S&P Global Market Intelligence. Estimate |
| LAE ratio | **12% → $120M**: DCC 4% ($40M), A&O 8% ($80M ≈ $667/claim) | Typical personal-lines range of 10–14%. Estimate |
| FNOL channel mix today | CSR phone 70% · agent 20% · digital 10% | Estimate |
| Fully loaded cost | CSR $38/h · adjuster $60/h | Estimate |
| Claims leakage | **5% of paid losses ≈ $32.5M** | Consultant and vendor studies commonly cite 2–10% (for example the Hyland/Nuxeo claims-leakage brief). Estimate within that range |
| Fraud | Coalition Against Insurance Fraud headline: ~10% of P&C losses + LAE | Disputed: a 2024 Rutgers Law report (Feinman) traces it to 1980s adjuster opinion. Used only as an upper bound |
| Subrogation recovery today | 3.0% of paid losses ≈ $19.5M | Ward/NASP benchmarks cited in trade press: high performers recover ~24–27% of paid auto collision versus ~11–15% average. Also often cited: ~15% of P&C claims with valid subrogation potential close unpursued (older, partly vendor-sourced figure) |
| Cycle time | Home FNOL-to-final-payment 44+ days; repair 32.4 days | J.D. Power 2025 U.S. Property Claims Satisfaction Study |
| CAT | 2 events/year × ~8k claims each, arriving within ~72h | Estimate |

Rule against double counting: each dollar is counted under one driver only. For example, adjuster time saved by STP sits in VD-1, not in VD-2.

---

## 3. Candidate value drivers: estimated impact

### VD-1 LAE reduction through straight-through processing (STP) and automated capture
- **Mechanism:** complete, structured FNOL on the first contact. AI extracts evidence data instead of people retyping it. Simple claims (glass, minor property damage under a threshold, small non-CAT home claims with verified coverage) go straight through to payment-ready. The adjuster first view replaces 20+ minutes of file reading.
- **Estimate (MC-1), ≈ $5.6M/yr, range $3–7M:**
  - Intake: 25 points of FNOL move to digital or conversational (30k × $12 saved = $0.36M); guided scripts cut CSR handle time 25% ($0.19M); re-contacts for missing information halve (120k × $15 × 50% = $0.9M). **≈ $1.45M**
  - Adjuster first view saves 20 min per new claim: 120k × $20 = **$2.4M** of capacity (realized as avoided hires).
  - STP on 12% of claims saves ~2 adjuster hours each: 14.4k × $120 = **$1.73M**
  - Total ≈ 7% of A&O, ≈ 0.56 points of LAE ratio.
- **Key assumptions:** a 12% STP rate is achievable for personal lines with conservative thresholds; digital adoption reaches 35%; capacity savings are realized through attrition.

### VD-2 Cycle-time reduction (loss to first contact, FNOL to settlement)
- **Mechanism:** instant acknowledgment; routing and assignment when the report is filed, not the next morning; first human contact SLA under 4 business hours for non-STP claims; STP claims payment-ready in under 2 days instead of ~10; complete intake removes about 1.5 days of back-and-forth.
- **Estimate (MC-1), ≈ $2.5M/yr direct, range $1.5–4M:** auto rental 30k rentals × 1.5 days × $40 = $1.8M; tow/storage on ~5k total-loss-type claims × 2 days × $50 = $0.5M; home additional living expense 1.6k × 1 day × $150 = $0.24M.
- **Not quantified:** earlier contact is widely associated in industry commentary with less attorney representation on bodily injury, which may be worth more than the direct figure. Satisfaction effects are counted under VD-6.
- **Key assumptions:** a 1.5-day average reduction on auto rental claims; the carrier staffs to the contact SLA.

### VD-3 Speed to deploy as COTS (no-code configuration, core adapters, multi-line)
- **Mechanism:** a carrier is configured (branding, lines of business, questions, rules, thresholds, state timers) rather than built. Events/webhooks plus adapters to the core suite. One platform covers personal auto, homeowners and commercial auto.
- **Estimate (MC-1):** FNOL modules inside large core-suite programs commonly take 9–18 months (estimate from analyst and trade commentary). A config-first go-live in about 12 weeks pulls the VD-1, VD-2, VD-4 and VD-5 benefits (~$18.6M/yr) forward ~9 months: **≈ $14M one-time pulled forward**, plus an estimated $1–3M lower implementation cost. Business changes (a new question, a threshold, a state timer) go from release cycles (weeks) to same-day.
- **Also the vendor's growth driver:** every additional carrier, MGA or TPA tenant costs us configuration, not code.
- **Key assumptions:** the carrier keeps its core suite and FNOL sits in front of it; an adapter exists or can be mapped from the canonical event contract.

### VD-4 Leakage reduction (early severity scoring, coverage verification at intake, fraud and anomaly flags)
- **Mechanism:** check policy status, listed vehicle or driver, peril and deductible at intake; score severity and complexity so complex claims reach the right desk on day 0; raise explainable fraud and anomaly indicators for an early SIU referral. There are no automated denials; a human decides.
- **Estimate (MC-1), ≈ $7.2M/yr, range $4–11M:** about 30% of $32.5M leakage is addressable at FNOL ($9.75M).
  - Coverage verification: incorrect payments avoided at 0.25% of losses = $1.6M
  - Severity routing: complex claims (~8% of count, ~55% of dollars ≈ $357M) at 1% lower severity = $3.6M
  - Fraud flags: extra early-SIU catch at 0.3% of losses = $2.0M (well below the contested CAIF 10% upper bound)
- **Key assumptions:** the leakage baseline is a consulting-range estimate; the PoC uses rules and explainable heuristics, not models trained on carrier data, so production lift depends on carrier data.

### VD-5 Subrogation recovery through third-party liability detection at FNOL
- **Mechanism:** ask liability-relevant questions (another vehicle, its plate and carrier, police report, rear-end, parked, product or contractor cause for home claims) and extract them from narratives and police reports. Set a subrogation flag with reasons on day 0 and notify the subrogation unit by event.
- **Estimate (MC-1), ≈ $3.3M/yr, range $2–5M:** incremental recoveries of 0.5 points of paid losses ($650M × 0.5%) on top of today's 3.0%. Trade-press benchmarks (high performers about 2× the average, ~15% of claims with subrogation potential missed) suggest this is conservative.
- **Breadth:** strongest for auto-heavy writers; weaker for homeowners.

### VD-6 Claimant experience and retention (NPS, self-service, status, multilingual)
- **Mechanism:** 24/7 mobile intake, conversational in English and Spanish, instant acknowledgment, status page and notifications, agent visibility.
- **Estimate (MC-1), ≈ $1.6M/yr, range $0.8–3M:** J.D. Power claims studies link satisfaction to renewal intent. +1 point retention on ~100k first-party claimants = 1,000 policies × $1,500 = $1.5M premium kept per year, worth ≈ $0.85M/yr (margin over ~5-year life plus ~$400 acquisition cost avoided). "Where is my claim" call deflection: 120k × 2 calls × 50% × $6 = $0.72M.
- **Key assumptions:** the retention uplift is directional, and only part of it is attributable to FNOL.

### VD-7 Regulatory compliance (state acknowledgment and contact deadlines, audit trail)
- **Mechanism:** per-state, per-line timers (acknowledgment, first contact, coverage decision or communication) start at FNOL, warn and escalate before breach; immutable audit of every state change and AI output; PII encryption and RBAC.
- **Estimate (MC-1), ≈ $0.3–1M/yr:** market-conduct penalties and remediation avoided, plus audit-preparation effort (estimate). It is low in dollars but **table stakes**: compliance can veto a purchase without it.
- **Note:** deadline values seeded for WI, IL and MI (ADR-002) are illustrative configuration and must be confirmed by each carrier's compliance team. They are not legal advice.

### VD-8 Catastrophe surge handling
- **Mechanism:** self-service and conversational intake absorb volume spikes; auto-acknowledgment; CAT-event tagging; triage that puts emergencies (habitability, injuries) first.
- **Estimate (MC-1), ≈ $0.5–1M/yr:** 40% of 16k CAT claims self-served avoids overflow vendor costs of ~$35/claim ($0.22M) plus ~$0.3M CSR overtime, and keeps time to first contact under control. Higher for property-heavy, coastal or regional writers.
- **Breadth:** uneven. It matters most to homeowners-heavy carriers.

### VD-9 Early mitigation and vendor dispatch (driver we added)
- **Mechanism:** at FNOL, dispatch tow, glass, rental or water-mitigation vendors. Water mitigation within 24h limits secondary damage.
- **Estimate (MC-1), ≈ $1–2M/yr** (home water claims and auto storage), but it needs a vendor network and contracts that the PoC cannot credibly simulate.

---

## 4. Ranking

Score = Impact (1–5) × Breadth across carriers (1–5) × PoC feasibility (1–5); the maximum is 125. Ties are broken by Impact.

| Rank / ID | Driver | Est. annual impact (MC-1) | Impact | Breadth | Feasibility | **Score** | Rationale for scores |
|---|---|---|---|---|---|---|---|
| **VD-1** | LAE reduction via STP and automated capture | ~$5.6M (hard LAE) | 5 | 5 | 4 | **100** | Every carrier has LAE pressure; extraction and STP rules can be demoed end to end with the local provider |
| **VD-2** | Cycle-time reduction | ~$2.5M direct, plus BI and NPS effects | 4 | 5 | 5 | **100** | The KPI every claims VP tracks; timestamps make it fully measurable in the PoC |
| **VD-3** | Speed to deploy as COTS | ~$14M benefits pulled forward (one-time) plus $1–3M implementation | 4 | 5 | 4 | **80** | Our core differentiation and the CIO's question; proved by two tenants configured without code |
| **VD-4** | Leakage reduction (severity, coverage, fraud) | ~$7.2M | 5 | 5 | 3 | **75** | Largest dollars, but PoC lift is shown with rules and heuristics; real lift needs carrier data |
| **VD-5** | Subrogation detection at FNOL | ~$3.3M | 4 | 4 | 4 | **64** | Cash-positive and CFO-friendly; strongest in auto |
| **VD-6** | Claimant experience and retention | ~$1.6M | 3 | 5 | 4 | **60** | Universal, but the dollar link is indirect |
| VD-7 | Regulatory compliance | ~$0.3–1M | 2 | 5 | 5 | 50 | Table stakes and a veto item, not a headline value |
| VD-8 | CAT surge handling | ~$0.5–1M | 3 | 3 | 4 | 36 | Matters to property-heavy writers; realistic surge proof needs load infrastructure |
| VD-9 | Early mitigation and vendor dispatch | ~$1–2M | 3 | 3 | 2 | 18 | Needs a real vendor network |

Total recurring hard and semi-hard value for VD-1, VD-2, VD-4 and VD-5 is about $18.6M/yr (estimate), about 1.9 points of combined ratio on $1B DWP. The VD-1 dollars alone would cover a licence priced well under $1M/yr several times over (pricing hypotheses are in S0-PRD-02 `product/packaging.md`).

---

## 5. PoC scope decision

**In scope (value claims the PoC must demonstrate): VD-1 to VD-6.**

1. **VD-1 and VD-2 are the headline.** They carry the claims VP's and CFO's numbers, and both are measurable within one demo: STP rate, adjuster minutes, time to acknowledgment and contact.
2. **VD-3 is what makes it a product rather than a project.** Two differently configured demo tenants on one deployment, with no code changes, are the proof.
3. **VD-4 and VD-5 come from the same triage engine.** Severity, coverage, fraud and subrogation indicators share inputs and the explanation format, so the marginal cost is low and the CFO story gets much stronger.
4. **VD-6 comes almost free** from omnichannel and conversational intake plus a status page. Spanish is included because it reaches many US claimants.

**Included as guardrails, not as value claims:** VD-7 (state timers, audit, RBAC, PII encryption). Compliance and the CIO veto without them, and the capability list requires them. They are scored low because they protect the deal rather than create the business case.

**Deliberately out of scope for the PoC:**
- VD-8 CAT surge: no load or scale engineering beyond a basic intake throughput check. CAT-event tagging only.
- VD-9 vendor dispatch: next-best-action can say "dispatch tow" but nothing is dispatched.
- Production ML fraud or severity models trained on real data. The PoC uses explainable rules and heuristics plus optional LLMs, and runs on synthetic data only.
- Automated coverage denial or any adverse decision without a human. Coverage is *verified* and *flagged*, never decided.
- Payments, reserving, settlement, estimating or total-loss valuation; we hand off to the core suite.
- Real carrier or core-suite connections. One sample adapter maps to a fictional core claims suite.
- Telephony/IVR voice and telematics crash detection (possible later stretch). Languages beyond English and Spanish.
- Lines beyond personal auto and homeowners. Commercial auto is a stretch.

**PoC success measures (shown on synthetic data):** STP rate ≥ 10% of demo claims; median time to acknowledgment < 1 min; 100% of claims routed at intake; every flag carries a reason; a tenant configuration change takes effect without a deploy; zero cross-tenant reads in tests.

---

## Sources (public, cited by name; all treated as data)
- J.D. Power, *2025 U.S. Property Claims Satisfaction Study* and *2025 U.S. Auto Claims Satisfaction Study* (press releases).
- S&P Global Market Intelligence, analysis of NAIC statutory personal auto loss ratios (2022).
- Coalition Against Insurance Fraud, fraud cost estimates (10% of P&C losses and LAE; $308.6B all lines, 2022), with the critique in J. Feinman, *Misinformation About Insurance Fraud*, Rutgers Law (2024).
- Ward / NASP subrogation benchmarks as reported in PropertyCasualty360 and CLM Magazine; CLARA Analytics on subrogation leakage (vendor source).
- Hyland (Nuxeo) insurance brief on claims leakage (vendor source).
