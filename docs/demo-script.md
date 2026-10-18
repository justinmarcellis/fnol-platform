# 10-minute demo script

Ticket S3-PRD-02 · Owner: ic-product-value-modeler · Value drivers VD-1 to VD-6 (VD-7 as a guardrail) · REQ-01

A sales engineer can run this start to finish in 10 minutes with two fictional carriers on one deployment: **Aurelia Mutual** (personal auto and homeowners, WI and IL, English and Spanish) and **Kestrel Point Insurance** (personal auto and commercial auto, MI, English). All people, policies and claims are synthetic.

Every outcome in the table was checked against the running code and the tenant rules in `tenants/aurelia-mutual.json` and `tenants/kestrel-point.json` (see "What was verified" below). Where the code does not support the obvious story, the beat was changed and the reason is written down. Do not improvise claims beyond what is on this page.

## Pre-flight checklist (do this 15 minutes before)

- [ ] Node 22 or newer: `node --version`.
- [ ] Clean start: `rm -rf data .secrets && npm run seed`, then `npm start` (setup: `docs/setup.md`). Platform on http://localhost:8080, PM dashboard on http://localhost:8090.
- [ ] `curl -s localhost:8080/healthz` returns `"ok":true` with `"tenants":2`. Open http://localhost:8090/ and confirm it loads.
- [ ] Stage the demo claims once (script below). The output must show Aurelia `fastTrack=true`, Kestrel glass `fastTrack=false` with "fraud score 15 above fast-track limit 10", and Kestrel rear-end `queue=injury`. If any line differs, stop and see "Reset".
- [ ] Open Kestrel admin and confirm "Version 1" and Maximum fraud score `10` (Rules tab). A previous run leaves it at 20.
- [ ] Browser: one window with a tab per app and tenant (URLs in the table). Each tab keeps its own dev sign-in, so open a new tab, never reload a tab, when you need another tenant.
- [ ] Zoom 125 percent, notifications off, terminal visible with the repo as working directory.
- [ ] Optional: keep `docs/cots-readiness.md` open for the "what is not built yet" question at the end.

### Stage the demo claims

The claimant web app and the CSR web script do not capture the insured vehicle or a policy number on the claimant path, so a claim made there cannot reach "coverage: covered" and cannot fast track (verified, see "What was verified"). The policy-verified glass claim therefore enters the way a partner or agent system would: through the public API on the `csr_phone` channel with the vehicle from the policy snapshot. Save the script outside the repo and run it:

```
cat > /tmp/stage-claims.mjs <<'EOF'
// Stages synthetic demo claims through the public API. Usage: node /tmp/stage-claims.mjs [all|kestrel-glass]
const BASE = process.env.BASE || 'http://localhost:8080';
const API = `${BASE}/api/v1`;
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const j = async (method, path, token, body) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': `stage-${Math.random()}` }, body: body && JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(out)}`);
  return out;
};
const token = async (tenantId, role) => (await j('POST', '/auth/token', '', { tenantId, sub: `dev-${tenantId}-${role}`, userId: `dev-${tenantId}-${role}`, roles: [role], name: role })).token;

async function pickPolicy(csr) {
  const { items } = await j('GET', '/policies?q=PA-', csr);
  for (const p of items) {
    if (p.status === 'in_force' && p.period.effectiveDate <= day(75) && p.period.expirationDate > day(0)) return p.policyNumber;
  }
  throw new Error('no suitable in-force policy');
}

async function report(tenantId, kind) {
  const csr = await token(tenantId, 'csr');
  const state = tenantId === 'kestrel-point' ? 'MI' : 'WI';
  const policyNumber = await pickPolicy(csr);
  const snap = await j('GET', `/policies/${policyNumber}/snapshot?asOf=${day(0)}`, csr);
  const v = snap.vehicles[0];
  const glass = kind === 'glass';
  const claim = await j('POST', '/claims', csr, {
    tenantId, lob: 'personal_auto', lossType: glass ? 'glass' : 'collision', channel: 'csr_phone', policyNumber, riskState: state,
    lossEvent: {
      lossDate: glass ? day(21) : day(2), cause: glass ? 'glass' : 'collision',
      description: glass ? 'A stone from a truck cracked the windshield on the highway. The car is drivable.' : 'I was stopped at a red light when the car behind me hit me hard. My neck hurts and the rear of my car is crushed.',
      location: { description: `100 Example Way, Testville, ${state}`, state }, injuriesReported: !glass, fatality: false, vehiclesInvolved: glass ? 1 : 2,
    },
    vehicles: [{ role: 'insured', policyVehicleId: v.unitId, vin: v.vin, year: v.year, make: v.make, model: v.model, drivable: glass, damageAreas: [glass ? 'glass' : 'rear'], damageDescription: glass ? 'Windshield crack' : 'Rear bumper and trunk crushed' }],
    parties: [{ roles: ['insured', 'reporter'], kind: 'person', firstName: 'Avery', lastName: 'Fenwick', phone: '(555) 010-0119' }],
  });
  await new Promise((r) => setTimeout(r, 1200));
  const adj = await token(tenantId, 'adjuster');
  const route = await j('GET', `/claims/${claim.id}/routing`, adj);
  console.log(`${tenantId.padEnd(15)} ${kind.padEnd(10)} ${claim.claimNumber}  queue=${route.queue} fastTrack=${route.fastTrack}  open: ${BASE}/adjuster#/claim/${claim.id}`);
  console.log(`                 why: ${route.reasons.filter((r) => /fast track (approved|blocked)/.test(r)).join('; ') || route.reasons.join('; ')}`);
}

const what = process.argv[2] || 'all';
if (what === 'all') {
  await report('aurelia-mutual', 'glass');
  await report('kestrel-point', 'glass');
  await report('kestrel-point', 'rear-end');
} else if (what === 'kestrel-glass') {
  await report('kestrel-point', 'glass');
} else throw new Error('usage: node stage-claims.mjs [all|kestrel-glass]');
EOF
node /tmp/stage-claims.mjs all
```

Expected output (claim ids differ; the claim numbers are 000001 to 000003 on a fresh database):

```
aurelia-mutual  glass      AUR-2026-000001  queue=fast_track fastTrack=true  open: http://localhost:8080/adjuster#/claim/clm_...
                 why: fast track approved (severity 5, fraud 15)
kestrel-point   glass      KPT-2026-000001  queue=personal_auto_claims fastTrack=false  open: ...
                 why: fast track blocked: fraud score 15 above fast-track limit 10
kestrel-point   rear-end   KPT-2026-000002  queue=injury fastTrack=false  open: ...
                 why: RT-INJURY-01: route to injury; RT-INJURY-01: fast track denied (injury); ...
```

Keep this output on screen: the three `open:` links are the fallbacks for beats 1 to 3. The glass claim is dated 21 days before today on purpose (it is the "reported late" cue, see beat 2). The script picks an in-force policy that is more than 75 days old, so the fraud score stays at exactly 15.

## Run of show

All sign-ins are the development sign-in on localhost (no passwords; setup guide, "Dev users and tokens"). The seeded fictional people are Casey Claimant, Riley Csr, Jordan Adjuster, Morgan Supervisor and Taylor Admin for each tenant; each web app signs in with its own dev role. Default ports: platform 8080, dashboard 8090.

| Time | Beat | URL | User | Clicks and actions | Say | Proves | Fallback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0:00 to 2:00 | **1. Aurelia glass claim, Spanish, fast tracked** | 1) http://localhost:8080/?tenant=aurelia-mutual<br>2) http://localhost:8080/adjuster?lang=es | 1) Claimant (automatic dev sign-in, Aurelia Mutual)<br>2) Jordan Adjuster, tenant `aurelia-mutual`, role `adjuster` | 1) In the header pick **Español** in the language list (it only appears for Aurelia). The page turns to "Cuéntenos qué pasó".<br>2) Choose **Dano de cristales**, keep **Preguntas guiadas**, click **Comenzar**.<br>3) Answer the five questions (date of the break, **Parabrisas**, injuries **No**, drivable **Sí**, tick the acknowledgement), clicking **Continuar** each time, then **Enviar reclamo**. Stop on "Recibimos su reclamo" (claim number and status tracker).<br>4) Open tab 2. Select tenant `aurelia-mutual`, role `adjuster`, click **Entrar como ajustador**. Untick **Solo mis siniestros**. Click the staged claim `AUR-2026-000001` (the one in queue `fast_track`).<br>5) Scroll to **Enrutamiento**: "Vía rápida: Sí", rule `RT-FT-GLASS`, reason "fast track approved (severity 5, fraud 15)". | "A policyholder reports a broken windshield in Spanish, on a phone, with five questions and no call. The screen, the legal notice and the status wording are all Spanish. Next to it in the inbox is the same glass loss once the policy and vehicle are matched. Severity 5, coverage verified at intake, fraud score 15 under Aurelia's limit of 25, so it goes straight to the fast-track queue with an adjuster already assigned. Nobody touched it. The rule that did this is one line of configuration, `RT-FT-GLASS`." (Be candid if asked: self-service as built has no policy field, so that claim lands in the standard queue until the policy is matched; the fast-tracked one arrived on the CSR/agent/API path.) | VD-1 (straight-through, no handling), VD-6 (Spanish self-service, instant claim number), VD-4 (coverage verified at intake) | Skip the live typing: open the printed `AUR-2026-000001` link with `?lang=es` on `/adjuster` and narrate the Spanish claimant screen from the first question only (stop after step 2). If the language list is missing, the URL lacks `?tenant=aurelia-mutual`. If the inbox is empty, untick **Solo mis siniestros**. If the staged claim is missing, run `node /tmp/stage-claims.mjs all` and refresh. |
| 2:00 to 3:30 | **2. Same glass claim at Kestrel goes to a queue** | http://localhost:8080/adjuster (new tab) | Jordan Adjuster, tenant `kestrel-point`, role `adjuster` | 1) Open a new tab at http://localhost:8080/adjuster, choose tenant `kestrel-point`, role `adjuster`, **Sign in as adjuster**.<br>2) Untick **Only my claims**.<br>3) Open `KPT-2026-000001` (queue `personal_auto_claims`, severity 5).<br>4) Scroll to **Routing**: Fast track **No**, Reasons "fast track blocked: fraud score 15 above fast-track limit 10". Point at **Triage / Fraud signals**: `LATE_REPORT: Reported 21 days after the loss`. | "Same loss, same rule, same product, different carrier. Kestrel's configuration caps fast track at fraud score 10, Aurelia's at 25, and a claim reported three weeks late carries 15 points. So at Kestrel an adjuster sees it first, in the normal auto queue, and the screen tells them exactly why. No code differs between these two carriers; two JSON documents do." | VD-3 (no-code, per-carrier rules on one deployment), VD-4 (fraud cue holds back automation), VD-1 | The claim is also readable from the API: `GET /api/v1/claims/<id>/routing` with a Kestrel adjuster token. If the claim shows `fast_track` instead, the fraud cap was left at 20: set Maximum fraud score back to 10 (beat 4 steps), then run `node /tmp/stage-claims.mjs kestrel-glass` and use the new link. |
| 3:30 to 6:00 | **3. CSR takes an injury rear-end call; subrogation flag; adjuster first view** | 1) http://localhost:8080/csr?tenant=kestrel-point<br>2) http://localhost:8080/adjuster (Kestrel session) | 1) Riley Csr, tenant `kestrel-point`<br>2) Jordan Adjuster | 1) Click **Sign in as CSR** (tenant `kestrel-point` is preselected).<br>2) In Policy number type `PA-`, click **Search**, click the first row (`PA-MI-1310724`). Intake opens and the right-hand panel lists what is still needed.<br>3) Record answers (**Record answer** after each): date of loss (two days ago); description "I was stopped at a red light when the car behind me hit me from behind. My neck hurts and the rear of my car is crushed."; injuries **Yes**; police report number `RB-26-0142` (optional); drivable **No**; tick the false-information acknowledgement.<br>4) Click **Submit claim**. Note the claim number.<br>5) Go to the adjuster tab, click **Refresh**. The new claim is in queue `injury` with chips **Injury**, **Subrogation**, **Coverage question**. Open it.<br>6) Walk the first view top to bottom: **AI summary** (with "Why this summary"), **Next best actions** ("Contact injured party", "Review subrogation potential"), **Triage** (Subrogation potential: `rear_ended_by_other`), **Routing** (`RT-INJURY-01`, fast track denied).<br>7) Open the staged `KPT-2026-000002` as well: same chips plus a **Tasks** entry "Check third-party recovery" from rule `PR-SUBRO-PA`, and coverage **Covered**. | "The CSR follows a script that adapts to the policy and tells them what is still missing, so handle time drops and nothing is forgotten. The moment the call ends the claim is scored, routed to the injury queue and flagged for subrogation, because the narrative says the other driver hit us from behind. The adjuster opens one screen: a summary that cites its facts, what to do next, and why. This is the money beat for recoveries: the flag exists on day zero, not at month three." On the live claim say plainly: "Coverage question is on because this CSR script does not capture the vehicle; the staged claim, which comes in through the integration path with the vehicle, shows the verified-coverage version and the recovery task." | VD-5 (subrogation flag at first notice, recovery task), VD-2 (routed to the right queue in seconds, timers started), VD-1 (adjuster first view replaces file reading), VD-4 | If a live step stalls, stop typing and open the staged `KPT-2026-000002` link from the stage output; it shows everything in step 6 and 7. If search returns nothing, type `PA-` with the dash. If sign-in shows only `northwind`, the URL lacks `?tenant=kestrel-point`. |
| 6:00 to 7:30 | **4. Admin changes an STP limit live; no deployment** | http://localhost:8080/admin | Dev sign-in as tenant admin (role `tenant_admin`), tenant `kestrel-point` | 1) Choose tenant `kestrel-point`, click **Sign in as tenant admin**. Note "Version 1".<br>2) Open the **Rules** tab. In "Straight-through processing limits" change **Maximum fraud score** from `10` to `20`.<br>3) Click **Validate and save**. The toast says "Saved as version 2".<br>4) In the terminal run `node /tmp/stage-claims.mjs kestrel-glass`. The line now reads `queue=fast_track fastTrack=true` and "fast track approved (severity 5, fraud 15)". Open the printed link in the adjuster tab to show it in the fast-track queue. | "Kestrel's claims lead decides the fraud cap is too tight for glass. She changes one number in the admin console, validates and saves. That is version 2 of her configuration, audited, no release, no restart. Here is the same claim again, a few seconds later: fast tracked. The change is hers, not an IT ticket." | VD-3 (business-owned configuration, minutes not sprints), VD-1 (more claims straight through), VD-4 (the guardrail is a visible, auditable number) | If saving shows a conflict or error, click Reload, repeat the edit once. If the console is down, narrate from the Rules tab screenshot and show the two numbers in `tenants/aurelia-mutual.json` (`fastTrack.maxFraudScore` 25) and `tenants/kestrel-point.json` (10). Do not edit the JSON files live: the running config lives in the database. |
| 7:30 to 8:15 | **5. KPIs panel** | http://localhost:8080/admin (same session, **KPIs** tab) | Same tenant admin | 1) Click **KPIs**, then **Refresh**.<br>2) Read the rows `metrics[0]` (`stp_rate`, VD-1): numerator 1 (before beat 4 it was 0). The denominator is every Kestrel claim so far, 4 if beat 3 was done live (value 0.25), 3 if it was skipped.<br>3) Scroll to `subrogation_flag_rate` (VD-5) and `coverage_verified_at_intake_rate` (VD-4).<br>4) Optional if time: open a new tab at `/admin`, sign in as tenant `aurelia-mutual`, **KPIs**: `spanish_session_share` and `digital_self_service_share` (VD-6) are above 0 after beat 1. | "These are the numbers a claims VP asks for, per carrier, from the live system, each tied to a value driver. STP rate just moved because of the change we made two minutes ago. Subrogation flag rate and coverage-verified-at-intake sit next to it. In a pilot these are your before and after." (Be candid: the panel is a plain list in this PoC; a charted view is a next step. The figures come from claims in the last 30 days.) | VD-1, VD-2, VD-4, VD-5, VD-6 | If the panel says KPIs are unavailable, run `curl -s -H "Authorization: Bearer <token>" localhost:8080/api/v1/kpis` with a supervisor or admin token (setup guide, tokens) and read the `metrics` array. If the denominators are 0, run `node /tmp/stage-claims.mjs all` and refresh. |
| 8:15 to 9:15 | **6. Webhook and core adapter payload** | 1) http://localhost:8080/admin (**Webhooks** tab)<br>2) Terminal | Tenant admin (UI); `carrier_admin` token for the curl commands | 1) **Webhooks** tab, under "Add subscription" enter Endpoint URL `https://events.kestrel-point.example/hooks/claims`, Event types `claim.reported, claim.routed`, click **Create subscription**. A toast shows the signing secret once.<br>2) In the terminal: `TOKEN=$(curl -s -X POST localhost:8080/api/v1/auth/token -H 'content-type: application/json' -d '{"tenantId":"kestrel-point","sub":"dev-kestrel-point-carrier_admin","roles":["carrier_admin"],"name":"Taylor Admin"}' \| node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')`<br>3) Set `ID=` to the `clm_...` id in the beat 4 link, then: `curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/api/v1/integrations/adapters/core-claims-suite/preview/$ID \| node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).payload,null,2)'`<br>4) Then the event that webhooks and queues carry: `curl -s -H "Authorization: Bearer $TOKEN" "localhost:8080/api/v1/integrations/outbox?type=claim.routed&subject=$ID" \| node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).items[0].event,null,2)'` | "Your core claims system gets the claim as an ACORD-aligned notification: policy, occurrence, parties, our triage and routing as extension blocks, personal data masked in this preview. Anything else that wants to know subscribes to signed events: CloudEvents with ids and codes, never personal data, written to an outbox in the same transaction so nothing is lost. A subscription is one form; the secret is shown once. Swapping the core adapter is a configuration choice, not a rewrite." (Do not claim a live delivery: the endpoint is a fictional `.example` host, so the platform logs a blocked delivery. Signature verification code is in `docs/api-reference.md`, "Verifying the signature".) | VD-3 (core adapter and event fabric, no lock-in), VD-1 (no re-keying into the core system) | If creating the subscription fails, skip step 1 and run steps 2 to 4 only. If a curl returns 401, mint the token again (tokens expire). If `jq` is preferred over `node -pe`, pipe to `jq .payload`. |
| 9:15 to 10:00 | **7. PM dashboard and close** | http://localhost:8090/ | Anyone (no sign-in) | 1) Overview tab: tickets done, velocity, forecast.<br>2) Click **Value drivers**: VD-1 to VD-9 with the tickets and points behind each.<br>3) Close on the slide-free summary below. | "This is how the product was built: a small AI team, with every ticket tied to a value driver, tracked live. The six drivers we just walked, STP, cycle time, configuration, leakage, subrogation, claimant experience, each have shipped features and a number you can measure in a pilot. Next step: a two-tenant pilot on your sandbox, or a configuration workshop with your claims leads." | All of VD-1 to VD-6 traced to delivered work; VD-7 (compliance timers and audit) as the guardrail | If :8090 is not up, run `PORT=8090 node dashboard/server.mjs`, or open `dashboard/snapshot.html` from disk. If someone asks what is missing, open `docs/cots-readiness.md`. |

## What was verified, and what changed from the first outline

The first outline had five claims that the code does not support as written. Each was checked by running the platform with the seed data and the tenant files.

| Outline said | What the code does | What the script does instead |
| --- | --- | --- |
| Glass claim is fast tracked at Aurelia through the claimant app | Claimant web has no policy number and no vehicle question, so coverage is `needs_review` ("no_insured_vehicle") and rule `RT-FT-GLASS` needs `coverage.outcome = covered`. The claim goes to `auto_physical_damage`. | Beat 1 shows the Spanish self-service on screen, then the fast-tracked claim from a policy-verified source (staged through the API on the `csr_phone` channel). Said out loud in the talk track. |
| Same glass claim at Kestrel routes to a queue | A plain glass claim is fast tracked at both carriers (severity 5 is under both limits of 30 and 15). Kestrel's `prior_damage` answer cannot be sent through the API, and glass severity cannot reach 15 with the inputs available. | Differentiate on the fraud cap that is in both tenants: `fastTrack.maxFraudScore` 25 (Aurelia) against 10 (Kestrel), with the glass claim reported 21 days late (`LATE_REPORT`, 15 points, `src/modules/triage/fraud.mjs`). Aurelia: fraud 15 is under 25, fast track approved. Kestrel: 15 is over 10, "fast track blocked", queue `personal_auto_claims`. |
| CSR rear-end claim shows the subrogation flag | True on both paths: triage sets `subrogation.flag` from the narrative (`rear_ended_by_other`), and the inbox and view show the chip. The rule task `PR-SUBRO-PA` ("Check third-party recovery") only fires for a collision cause, which the staged claim has and the CSR script does not set (cause `other`). Aurelia's `PR-SUBRO-AUTO` needs the "other party" answer, a structured party that the CSR text field cannot enter. | The live CSR call runs at Kestrel (no party question). The recovery task is shown on the staged rear-end claim. |
| Admin raises an STP threshold and the next claim flips | Works. `fastTrack.maxFraudScore` 10 to 20 flips the Kestrel late-reported glass claim to `fast_track` immediately; there is no cache to flush. | As scripted in beat 4. Note the severity limit does not move the demo claim (severity 5 against limits 15 and 30). |
| Webhook payload | Subscriptions are created in the admin console and events are in the outbox. Delivery to the fictional `.example` host is blocked by the platform ("host could not be resolved"). | Beat 6 shows the subscription form, the core adapter preview payload and the signed-event envelope, not a live delivery. |

Other checks that the script relies on: the adjuster inbox defaults to "Only my claims" and the dev adjuster has no assigned claims, so it must be unticked; the CSR page lists only `northwind` unless `?tenant=` is given; the policy search hint text mentions `AUT-1000`, but the seeded policies are numbered `PA-WI-...` (Aurelia) and `PA-MI-...` (Kestrel), so search `PA-`.

## Reset between runs

```
# stop npm start (Ctrl-C), then
rm -rf data .secrets && npm run seed && npm start
node /tmp/stage-claims.mjs all
```

To undo only beat 4 without a full reset: admin console, Rules tab, Maximum fraud score back to `10`, **Validate and save**.

## If someone asks

- **Is the AI real?** The PoC runs a deterministic local provider and shows its provider, model and confidence on every output; the cascade to hosted models is configured per tenant (`ai` section of the tenant file) and a person confirms (`humanConfirmRequired`).
- **Is the Spanish complete?** The screens, notices and status wording are Spanish; AI-written summary text is English in this PoC.
- **What would a pilot need?** See `docs/cots-readiness.md` and `docs/deployment.md`.
- **How do we change a rule?** `docs/configuration-guide.md`.
