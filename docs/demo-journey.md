# Demo journey: a policyholder and an adjuster working one claim

Ten minutes, two people, one claim. A policyholder reports a parking-lot collision from a phone. The adjuster picks it up with the facts, coverage and timers already on screen and asks for photos. The policyholder answers from the claim page, and the adjuster carries on. Nobody phones anybody.

Everything is synthetic: fictional carriers (Aurelia Mutual, Kestrel Point), fictional people and policies. The illustrated version of this script, with the architecture diagram, is the "Dent to Decision Demo" page shared with the sponsor; the rehearsal screenshots are in `docs/demo/journey/`.

## Before you start (2 minutes)

| What | How |
| --- | --- |
| App | Deployed: https://fnol-platform-1033030652144.us-central1.run.app (sign in with the sponsor Google account; IAP admits nobody else). Local: `FNOL_DEV_MODE=1 node scripts/dev.mjs`, then http://localhost:8080 |
| Two windows side by side | **Left, narrow (phone width):** the policyholder. **Right, wide:** the adjuster. Two tabs also work: each tab keeps its own sign-in. |
| Fresh data | The instance seeds 29 demo claims on start. If it has been idle it restarts on the first request (about 10 seconds) and reseeds. |
| Rehearsal | `node scripts/demo-journey.mjs <out dir> <app url>` drives the whole journey in a browser and writes one screenshot per beat. Run it before a live demo; "journey ok" means every beat below works. |

The **Demo** bar at the top of every page switches tenant and persona. On a phone-width window it folds behind **Switch**.

## The cast

| Persona | Who | App | Demo bar choice |
| --- | --- | --- | --- |
| Policyholder | Taylor Dunmore, named insured on personal auto policy PA-IL-3644079 (Aurelia Mutual, Illinois) | Claimant web, mobile first | Tenant **Aurelia Mutual**, persona **Taylor Dunmore (Claimant)** |
| Adjuster | Jordan Reyes, auto physical damage adjuster | Adjuster workbench | Tenant **Aurelia Mutual**, persona **Jordan Reyes (Adjuster)** |

Names come from the seeded data and can differ on another tenant; the Demo bar shows the current ones.

## Run of show

| Time | Beat | Who and where | Do | Say |
| --- | --- | --- | --- | --- |
| 0:00 | **1. Report the loss** | Policyholder, left window | Demo bar: Aurelia Mutual, Taylor Dunmore. Click **Start my claim**. Keep **Personal auto**, **Collision** and **Guided questions**; the policy number is already filled in. Click **Continue**. | "Taylor has just found a dent in the driver's door and reports it from the car park, on a phone. No login to remember: the carrier knows the policy." |
| 1:00 | **2. Prove it is the policyholder** | Policyholder | The last name and ZIP are prefilled for the demo (Dunmore, 60601). Click **Find my vehicles**. Pick the **2023 Brightwell Pickup 1500** and **Continue**. | "Before we show anything from the policy we check the last name and ZIP. A stranger who types a policy number sees nothing, and repeated wrong answers lock the policy for 15 minutes. Then Taylor picks the insured vehicle from the policy instead of typing a VIN." |
| 1:45 | **3. Answer a few questions** | Policyholder | Answer each question: date (two days ago), what happened ("I was parked outside the grocery store when another car backed into my driver-side door. The other driver left a note with their insurance details."), injuries **No**, drivable **Yes**, police report **No**, the acknowledgement. The review screen lists every answer; click **Submit claim**. | "One question at a time, the questions come from Aurelia's configuration, not from code. The same flow runs in Spanish." |
| 3:00 | **4. Instant claim number** | Policyholder | Stop on "Your claim has been received". Point at the claim number (AUR-2026-0000NN), the status chip and the **What happens next** tracker. | "Taylor has a claim number in under three minutes and can see where it is. Behind that screen the platform has already checked coverage, scored it and routed it." |
| 3:30 | **5. The adjuster's first view** | Adjuster, right window | Demo bar: Aurelia Mutual, Jordan Reyes. In the inbox set **Show: All claims** and open the newest claim (the number from beat 4). | "This is what lands on the adjuster's desk, seconds after Taylor pressed Submit." |
| 4:00 | **6. Read the claim in 30 seconds** | Adjuster | Walk top to bottom: header chips (**Assigned**, severity **Moderate 25**, **Subrogation**, contact timer **4d 23h left**). **AI summary** with provider, model and confidence. **Next best actions**. **Coverage: Covered** with each check passed. **Policy** card with coverages and the $500 collision deductible. **Regulatory timers** (Illinois acknowledgement met, first contact, decision). **Routing**: Auto physical damage queue, rule names. | "Coverage is verified against the policy system at intake. The narrative says another driver backed into the car, so subrogation is flagged on day zero: that is recovery money. The Illinois clocks started on their own. The AI summary always says which model wrote it and how sure it is, and a person confirms it." |
| 5:30 | **7. Ask for photos** | Adjuster | In **Request information from the claimant**: What is needed **Photos of the damage**, message "Please add two photos of the driver-side door and one of the other driver's note." Click **Send request**. The status chip turns to **Pending info**. | "One action: the request is a note shared with the policyholder, and the claim moves to Pending info, so the queue shows it is waiting on the customer, not on us." |
| 6:15 | **8. The policyholder sees it** | Policyholder | On the claim page click **Refresh now** (it also refreshes on its own). A **Message from your claims team** card appears at the top with the adjuster's words. The tracker shows **We need more information**. | "No phone tag, no email chain. Taylor sees exactly what is needed, on the same page as the claim." |
| 7:00 | **9. Reply with a photo** | Policyholder | In **Add photos and documents** keep **Photo**, tap **Add photos or documents**, pick an image. It appears under the upload area as received. | "Taylor answers from the phone camera. The file is encrypted at rest and attached to the claim." |
| 7:45 | **10. The adjuster carries on** | Adjuster | Reload the claim. **Evidence** shows the photo (needs review); **Activity** shows "Document added". In **Claim actions** click **Start review**. | "The photo is on the claim with its history. The adjuster resumes the review, and every step, by both people, is in the audit trail." |
| 8:30 | **11. Close the loop** | Policyholder | **Refresh now**: the tracker is back on the review step. | "The customer always knows where the claim is, and the adjuster never had to pick up the phone." |
| 9:00 | **12. How it works** | Either | Open the architecture page and walk the journey diagram (next section). | "One platform, one database per environment, configuration per carrier, and an event for every step." |

### If something goes wrong

| Symptom | Fix |
| --- | --- |
| Page says "Service unavailable" or spins on first load | The instance was asleep. Wait 10 seconds and reload. |
| Find my vehicles fails | The persona hint is on the claimant start page; type the last name and ZIP shown there. After five wrong tries start a new claim. |
| The adjuster's inbox is empty | Set **Show: All claims**. The claim is routed to a queue, not necessarily to Jordan. |
| The message card does not appear | Click **Refresh now** on the claim page. Check the adjuster pressed **Send request** (a toast says "Request sent to the claimant"). |
| Live typing stalls | Use the rehearsal screenshots in `docs/demo/journey/` to narrate the remaining beats. |

## How it works

```
 Policyholder (phone)                         Platform (one Cloud Run service, Node 22)                       Adjuster (desktop)
 ─────────────────────                        ─────────────────────────────────────────                       ──────────────────
 Claimant web  ──POST /intake/sessions──▶  Intake ──(questions from tenant config)
               ──GET  policy-vehicles──▶     │  holder check: last name + ZIP against Coverage
               ──POST submit────────────▶    └─▶ Claims.createClaim ──event claim.reported──┐
                                                                                             ├─▶ Claims: acknowledge, start state timers
                                                                                             ├─▶ Coverage: verify against policy snapshot ─event claim.coverage.verified─▶ Triage: severity, fraud, subrogation (AI with provenance)
                                                                                             │                                                                            └─event claim.triaged─▶ Rules: route to queue and adjuster
                                                                                             └─▶ Integrations: outbox ─▶ signed webhooks, core-system adapter
                                             Adjuster projection (inbox, first view, AI summary) ◀── every claim event ──────────────────▶  Adjuster workbench
 Claim page   ◀──GET /claims/{id}/messages──  Claims notes (shared_with_claimant)   ◀──POST /claims/{id}/notes + status pending_info──  Request information
              ──POST /claims/{id}/documents─▶ Evidence (encrypted blob, extraction) ──event claim.evidence.added──▶ Activity, Evidence panel
```

- **One service, modular inside.** `src/modules/*` (intake, claims, coverage, triage, rules, evidence, adjuster, integrations, config, kpi) talk through an in-process event bus. Each step is an event, so the same events feed the audit trail, the adjuster's views, the KPIs and outbound webhooks.
- **Per-carrier configuration, not code.** Questions, loss types, routing and fast-track rules, regulatory timers and branding come from each tenant's versioned configuration (`tenants/*.json` seeds it; the admin console edits it with an If-Match version check).
- **Tenant isolation.** Every table carries `tenant_id` and every query runs through a tenant context. Personal data is encrypted per field; staff and claimants get different projections of the same claim (the claimant never sees triage, fraud or internal notes; only notes marked shared).
- **AI with provenance.** Summaries and triage explanations always carry provider, model and confidence. In the PoC a local rules model runs; Vertex AI Claude plugs in once Model Garden is enabled for the project.
- **Deployment.** One Cloud Run service in `fnol-poc` (us-central1) behind Identity-Aware Proxy, one instance, SQLite on the instance disk, reseeded on start. Production gaps (Cloud SQL, Pub/Sub, KMS, SSO) are in `docs/cots-readiness.md`; the full design is `docs/architecture.html`.
