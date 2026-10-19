# Personas

Owner: ic-product-personas · Ticket: S0-PRD-02 · Status: for review (dir-product) · Date: 2026-10-18

All names, carriers and situations are fictional. Value drivers (`VD-n`) are defined in `value-propositions.md`; requirements (`REQ-xx`) in `requirements.md`. Quantities are hypotheses unless a source is cited.

Buying roles: claims VP (economic buyer), CIO/architect and compliance (veto), adjuster and CSR (adoption), agent and TPA/MGA (channel and multi-tenant use), claimants (outcome).

---

## P1. Dana Whitcomb, VP of Claims (economic buyer), Aurelia Mutual (fictional regional carrier)
- **Goals:** cut loss adjustment expense (LAE) and cycle time without hurting claimant satisfaction; show the CFO a number within two quarters. (VD-1, VD-2, VD-4, VD-5)
- **Pains:** adjusters spend time re-keying FNOL data; simple claims wait in the same queue as complex ones; a core-suite FNOL module is an 18-month program; leakage and missed subrogation are found only in audits.
- **Key FNOL moments:** weekly review of STP rate and time-to-first-contact; a surge day after a storm; a regulator or board question about a slow claim.
- **Success looks like:** a measurable STP rate on defined claim types, first contact within hours, fewer reassignments, and a KPI view she can show without analyst help (REQ-11, REQ-23).
- **Accessibility/language:** executive dashboard readable on a phone; exportable KPIs.

## P2. Raj Venkataraman, CIO / enterprise architect, Aurelia Mutual
- **Goals:** add a modern intake layer without replacing the core claims suite; keep data in carrier-controlled environments; avoid vendor lock-in on AI models. (VD-3)
- **Pains:** integration backlog; every vendor wants a core replacement; AI features that cannot be switched off, swapped or audited; security reviews that take months.
- **Key FNOL moments:** vendor due diligence (tenancy, encryption, SSO, data residency); first adapter go-live; incident when an AI provider is unavailable.
- **Success looks like:** events and webhooks into the existing core with a field map, graceful fallback when AI is down, tenant isolation proven by tests, a go-live in weeks (REQ-06 degrade, REQ-16, REQ-17, REQ-18).
- **Accessibility/language:** needs OpenAPI contracts and event schemas more than UI.

## P3. Marisol Okafor, Chief Compliance Officer, Kestrel Point Insurance (fictional)
- **Goals:** meet state acknowledgment and contact deadlines; keep a defensible audit trail; ensure AI never makes an adverse decision on its own. (VD-7)
- **Pains:** deadlines differ by state and line; evidence of "when we first acknowledged" is scattered; black-box AI scoring; unfair-claims-practice exposure.
- **Key FNOL moments:** a timer approaching breach; a market-conduct exam asking for a claim history; a complaint about a denied claim.
- **Success looks like:** timers visible per claim with warning and breach events, append-only audit export, every AI output carrying model, confidence and explanation, and a human required for any adverse action (REQ-14, REQ-21, REQ-25). Seeded deadlines are illustrative; her team confirms them.
- **Accessibility/language:** claimant notices must be available in the languages the carrier serves; plain-language notices.

## P4. Tomas Brandt, Property and casualty adjuster (field and desk), Aurelia Mutual
- **Goals:** open a claim and know what happened, what is covered, and what to do next; spend time on judgment rather than data entry. (VD-1, VD-4, VD-5)
- **Pains:** incomplete FNOL, missing police report or photos, no coverage check until later, scores he cannot explain or override, alert fatigue.
- **Key FNOL moments:** first view of a newly assigned claim; reviewing a fraud or subrogation flag; calling the claimant within the timer window.
- **Success looks like:** one screen with summary, coverage result, severity, flags with reasons, timers, evidence and next best actions; he can accept or dismiss flags with a note (REQ-15).
- **Accessibility/language:** keyboard-first, high-density layout that remains readable on a tablet in the field; English summary plus original-language text for non-English claimants.

## P5. Priya Nandakumar, Customer service representative (call center), Kestrel Point
- **Goals:** capture a loss quickly and correctly while the claimant is upset; hit handle-time and quality targets.
- **Pains:** long scripted calls, duplicate keying across systems, no guidance when the claimant describes a loss in their own words, no live policy check.
- **Key FNOL moments:** the first 90 seconds of a call; confirming the policy and drivers; reading back the next steps and giving a claim number.
- **Success looks like:** she types or dictates the narrative, the console fills fields and asks only what is missing, coverage shows on screen, and the claim number and acknowledgment go out at once (REQ-01, REQ-02, REQ-12).
- **Accessibility/language:** screen-reader and keyboard support; language switch mid-call; scripts tenant-configurable (REQ-13).

## P6. Greg Halloran, Independent agent, agency principal serving several carriers
- **Goals:** report a client's loss once and see status without calling the carrier; keep the client from leaving.
- **Pains:** each carrier has a different portal, claim status requires phone calls, clients call him first and angry.
- **Key FNOL moments:** a client calls him from the roadside; a client asks for status two days later.
- **Success looks like:** an agent channel with his login, scoped to his own agency's claims only, status visible, outstanding items listed (REQ-01, REQ-12).
- **Accessibility/language:** mobile-friendly, short forms; branded with the carrier, not the platform.

## P7a. Jess Moreno, Digital-first claimant (insured driver, age 31)
- **Goals:** report from a phone in minutes, upload photos, know what happens next, and not repeat herself.
- **Pains:** forced phone calls, forms that ask for known information, silence after submission.
- **Key FNOL moments:** after a fender-bender in a parking lot; uploading photos and a repair estimate; checking status the next day.
- **Success looks like:** chat-like or form intake with AI prefill she can correct, claim number within 60 seconds, a status page with next steps (REQ-02, REQ-05, REQ-12).
- **Accessibility/language:** mobile first, camera upload, WCAG 2.2 AA, works on a weak signal, no account creation required.

## P7b. Rosa Delgado, Stressed, low-digital, Spanish-speaking claimant (homeowner, age 67)
- **Goals:** report a burst pipe in her own language, know someone is coming, keep her home safe.
- **Pains:** English-only forms, phone trees, jargon, fear of making a mistake that costs her the claim, shaky smartphone skills; relies on her grandson.
- **Key FNOL moments:** the first call or text at night; confirming what to do right now (stop water, mitigation); receiving a clear acknowledgment.
- **Success looks like:** Spanish prompts, plain language, large type, short steps, phone or SMS and a CSR path as alternatives to the app, an acknowledgment she can show her grandson (REQ-04, REQ-12). Adjuster sees an English summary plus her original words.
- **Accessibility/language:** Spanish at minimum (other languages by configuration), large touch targets, high contrast, screen-reader support, low-literacy wording, option for a human at any step. Translation quality must be reviewed by a human before launch.

## P8. Leila Haddad, TPA/MGA operations lead (third-party administrator running claims for several carriers)
- **Goals:** run FNOL for many carrier clients with each one's rules, branding and reporting, on one deployment. (VD-3)
- **Pains:** a new client means a new custom build; carriers demand their own questions and deadlines; data must never cross between clients; onboarding takes months.
- **Key FNOL moments:** onboarding a new carrier client; a client audit; a shared surge event across clients.
- **Success looks like:** a new tenant configured, not coded, with isolated data, per-tenant KPIs and a priced-per-claim model that scales with her volume (REQ-13, REQ-18, REQ-22).
- **Accessibility/language:** per-tenant languages and branding.

---

## Persona-to-value map (hypothesis)
| Persona | Primary drivers | Role in the deal |
|---|---|---|
| P1 Claims VP | VD-1, 2, 4, 5 | Economic buyer |
| P2 CIO | VD-3 | Veto / champion |
| P3 Compliance | VD-7 | Veto |
| P4 Adjuster, P5 CSR | VD-1, 2 | Adoption |
| P6 Agent | VD-6 | Channel influence |
| P7a, P7b Claimants | VD-6 | Outcome |
| P8 TPA/MGA | VD-3 | Buyer and reseller-like user |
