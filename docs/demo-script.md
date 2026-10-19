# 10-minute demo script

Ticket S3-PRD-02, refreshed in S4-PRD-01 and S5-PRD-01 (2026-10-19) · Owner: ic-product-value-modeler, refreshed by ic-product-requirements-analyst · Value drivers VD-1 to VD-6 (VD-7 as a guardrail) · REQ-01

A sales engineer can run this start to finish in 10 minutes with two fictional carriers on one deployment: **Aurelia Mutual** (personal auto and homeowners, WI and IL, English and Spanish) and **Kestrel Point Insurance** (personal auto and commercial auto, MI, English). All people, policies and claims are synthetic.

Every outcome in the table was checked against the running code and the tenant rules in `tenants/aurelia-mutual.json` and `tenants/kestrel-point.json` (see "What was verified" below). Beats 1 to 6 are also run as an automated API-level test, `tests/e2e/demo-script.test.mjs` (`node --test --disable-warning=ExperimentalWarning tests/e2e/demo-script.test.mjs`, 6 subtests, 0 failures when last run); the numbers on this page are what that test asserts. Beat 7 and the browser clicks are not covered by it. Do not improvise claims beyond what is on this page.

**Where to run it.** Locally (below) or on the deployed PoC: a Cloud Run service in project `fnol-poc` behind Identity-Aware Proxy, URL `https://<your-service-url>` (the URL is not recorded in the repo; get it from the Cloud Run console or the runbook `docs/deploy-fnol-poc.md`). Open it in a browser signed in as the sponsor's Google account, the only account granted IAP access. Differences on the deployed service: the data is reseeded when the single instance restarts; `/healthz` is not reachable from outside (the run.app front end reserves it), so check that the page loads instead; the staging script and curl commands in this page assume `localhost:8080` and no IAP, so on the deployed service use the remote test mode in "Run against the deployed service" or demo the claims already staged there. The deployed service runs with `devMode` on (accepted PoC risk R2, `docs/cots-readiness.md`), which is why the dev sign-in screens appear; say so if asked. Before a demo, confirm the running revision includes the S5-EXP-01 and S5-WFL-04 fixes: the repo does not record a redeploy, and before those fixes the web apps showed "Service unavailable" on the deployed host (`org/hubs/incidents.jsonl`).

## Pre-flight checklist (do this 15 minutes before)

- [ ] Node 22 or newer: `node --version`.
- [ ] Clean start: `rm -rf data .secrets && npm run seed`, then `npm start` (setup: `docs/setup.md`). Platform on http://localhost:8080, PM dashboard on http://localhost:8090.
- [ ] Local run only: `curl -s localhost:8080/healthz` returns `"ok":true` with `"tenants":2`. Open http://localhost:8090/ and confirm it loads.
- [ ] Stage the demo claims once (script below). The output must show Aurelia `fastTrack=true`, Kestrel glass `fastTrack=false` with "fraud score 15 above fast-track limit 10", and Kestrel rear-end `queue=injury`. If any line differs, stop and see "Reset".
- [ ] Open Kestrel admin and confirm "Version 1" and Maximum fraud score `10` (Rules tab). A previous run leaves it at 20.
- [ ] Browser: one window with a tab per app and tenant (URLs in the table). Each tab keeps its own dev sign-in, so open a new tab, never reload a tab, when you need another tenant.
- [ ] Zoom 125 percent, notifications off, terminal visible with the repo as working directory.
- [ ] Optional: keep `docs/cots-readiness.md` open for the "what is not built yet" question at the end.

### Stage the demo claims

The demo needs a repeatable fraud score so the two carriers differ on the same claim: a glass loss reported 21 days late carries `LATE_REPORT` (15 points), which is under Aurelia's fast-track limit of 25 and over Kestrel's 10. The staging script below creates those claims through the public API on the `csr_phone` channel, with the insured vehicle taken from the policy snapshot, the way a partner or agent system would. It is a repeatability tool, not a workaround: claims entered through the CSR and claimant intake now carry the policy number and, once the insured vehicle is picked, reach `covered` and fast track too (checked 22:15Z on the seed: CSR and claimant tokens, Aurelia glass, `fast_track`, fraud 0; the seeded policies have three vehicles, so the pick is required). Save the script outside the repo and run it:

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
| 0:00 to 2:00 | **1. Aurelia glass claim, Spanish, fast tracked** | 1) http://localhost:8080/?tenant=aurelia-mutual<br>2) http://localhost:8080/adjuster?lang=es | 1) Claimant (automatic dev sign-in, Aurelia Mutual)<br>2) Jordan Adjuster, tenant `aurelia-mutual`, role `adjuster` | 1) In the header pick **Español** in the language list (it only appears for Aurelia). The page turns to "Cuéntenos qué pasó".<br>2) Choose **Dano de cristales**, keep **Preguntas guiadas**, click **Comenzar**.<br>2b) With the policy number entered, the page asks for the last name on the policy and the ZIP code (S5); then the insured-vehicle picker appears. Mention it: "we confirm it is really the policyholder before showing vehicle details".<br>3) Answer the five questions (date of the break, **Parabrisas**, injuries **No**, drivable **Sí**, tick the acknowledgement), clicking **Continuar** each time, then **Enviar reclamo**. Stop on "Recibimos su reclamo" (claim number and status tracker).<br>4) Open tab 2. Select tenant `aurelia-mutual`, role `adjuster`, click **Entrar como ajustador**. Untick **Solo mis siniestros**. Click the staged claim `AUR-2026-000001` (the one in queue `fast_track`).<br>5) Scroll to **Enrutamiento**: "Vía rápida: Sí", rule `RT-FT-GLASS`, reason "fast track approved (severity 5, fraud 15)". | "A policyholder reports a broken windshield in Spanish, on a phone, with five questions and no call. The screen, the legal notice and the status wording are all Spanish. Next to it in the inbox is the same glass loss once the policy and vehicle are matched. Severity 5, coverage verified at intake, fraud score 15 under Aurelia's limit of 25, so it goes straight to the fast-track queue with an adjuster already assigned. Nobody touched it. The rule that did this is one line of configuration, `RT-FT-GLASS`." (Be candid if asked: this claim was entered through the API with a 21-day-late loss date so it can be compared with Kestrel. A claim typed into the claimant web app on a multi-vehicle policy is only fast tracked when the insured vehicle is picked. S5: the claimant web asks for the **last name on the policy and the ZIP code** before it shows the insured-vehicle picker, so a stranger who types a policy number sees nothing; give the policy holder's last name and a ZIP on that policy, then pick the vehicle. Ten wrong answers lock the picker for that policy for 15 minutes and the claimant falls back to entering the vehicle by hand. This step is covered by unit and UI tests (`tests/ui/claimant.test.mjs`), not run by me in a browser for this page.) | VD-1 (straight-through, no handling), VD-6 (Spanish self-service, instant claim number), VD-4 (coverage verified at intake) | Skip the live typing: open the printed `AUR-2026-000001` link with `?lang=es` on `/adjuster` and narrate the Spanish claimant screen from the first question only (stop after step 2). If the language list is missing, the URL lacks `?tenant=aurelia-mutual`. If the inbox is empty, untick **Solo mis siniestros**. If the staged claim is missing, run `node /tmp/stage-claims.mjs all` and refresh. |
| 2:00 to 3:30 | **2. Same glass claim at Kestrel goes to a queue** | http://localhost:8080/adjuster (new tab) | Jordan Adjuster, tenant `kestrel-point`, role `adjuster` | 1) Open a new tab at http://localhost:8080/adjuster, choose tenant `kestrel-point`, role `adjuster`, **Sign in as adjuster**.<br>2) Untick **Only my claims**.<br>3) Open `KPT-2026-000001` (queue `personal_auto_claims`, severity 5).<br>4) Scroll to **Routing**: Fast track **No**, Reasons "fast track blocked: fraud score 15 above fast-track limit 10". Point at **Triage / Fraud signals**: `LATE_REPORT: Reported 21 days after the loss`. | "Same loss, same rule, same product, different carrier. Kestrel's configuration caps fast track at fraud score 10, Aurelia's at 25, and a claim reported three weeks late carries 15 points. So at Kestrel an adjuster sees it first, in the normal auto queue, and the screen tells them exactly why. No code differs between these two carriers; two JSON documents do." | VD-3 (no-code, per-carrier rules on one deployment), VD-4 (fraud cue holds back automation), VD-1 | The claim is also readable from the API: `GET /api/v1/claims/<id>/routing` with a Kestrel adjuster token. If the claim shows `fast_track` instead, the fraud cap was left at 20: set Maximum fraud score back to 10 (beat 4 steps), then run `node /tmp/stage-claims.mjs kestrel-glass` and use the new link. |
| 3:30 to 6:00 | **3. CSR takes an injury rear-end call; subrogation flag; adjuster first view** | 1) http://localhost:8080/csr?tenant=kestrel-point<br>2) http://localhost:8080/adjuster (Kestrel session) | 1) Riley Csr, tenant `kestrel-point`<br>2) Jordan Adjuster | 1) Click **Sign in as CSR** (tenant `kestrel-point` is preselected).<br>2) In Policy number type `PA-`, click **Search**, click the first row (`PA-MI-1310724`). Intake opens and the right-hand panel lists what is still needed.<br>3) When the vehicle list appears, choose the insured vehicle (the first one). Record answers (**Record answer** after each): date of loss (two days ago); description "I was stopped at a red light when the car behind me hit me from behind. My neck hurts and the rear of my car is crushed."; injuries **Yes**; police report number `RB-26-0142` (optional); drivable **No**; tick the false-information acknowledgement.<br>4) Click **Submit claim**. Note the claim number.<br>5) Go to the adjuster tab, click **Refresh**. The new claim is in queue `injury` with chips **Injury** and **Subrogation**, and coverage **Covered** when the vehicle was picked (without the pick the chip reads **Coverage question**, reason `no_insured_vehicle`). Open it.<br>6) Walk the first view top to bottom: **AI summary** (with "Why this summary"), **Next best actions** ("Contact injured party", "Review subrogation potential"), **Triage** (Subrogation potential: `rear_ended_by_other`), **Routing** (`RT-INJURY-01`, fast track denied).<br>7) Open the staged `KPT-2026-000002` as well: same chips plus a **Tasks** entry "Check third-party recovery" from rule `PR-SUBRO-PA`, and coverage **Covered**. | "The CSR follows a script that adapts to the policy and tells them what is still missing, so handle time drops and nothing is forgotten. The moment the call ends the claim is scored, routed to the injury queue and flagged for subrogation, because the narrative says the other driver hit us from behind. The adjuster opens one screen: a summary that cites its facts, what to do next, and why. This is the money beat for recoveries: the flag exists on day zero, not at month three." On the staged claim show the recovery task: the rule `PR-SUBRO-PA` fires on a collision cause, which the staged claim has and the CSR script does not set (it records cause `other`). Not browser-tested: the vehicle pick and the Covered chip on the live CSR claim were checked through the API only. | VD-5 (subrogation flag at first notice, recovery task), VD-2 (routed to the right queue in seconds, timers started), VD-1 (adjuster first view replaces file reading), VD-4 | If a live step stalls, stop typing and open the staged `KPT-2026-000002` link from the stage output; it shows everything in step 6 and 7. If search returns nothing, type `PA-` with the dash. If sign-in shows only `northwind`, the URL lacks `?tenant=kestrel-point`. |
| 6:00 to 7:30 | **4. Admin changes an STP limit live; no deployment** | http://localhost:8080/admin | Dev sign-in as tenant admin (role `tenant_admin`), tenant `kestrel-point` | 1) Choose tenant `kestrel-point`, click **Sign in as tenant admin**. Note "Version 1".<br>2) Open the **Rules** tab. In "Straight-through processing limits" change **Maximum fraud score** from `10` to `20`.<br>3) Click **Validate and save**. The toast says "Saved as version 2".<br>4) In the terminal run `node /tmp/stage-claims.mjs kestrel-glass`. The line now reads `queue=fast_track fastTrack=true` and "fast track approved (severity 5, fraud 15)". Open the printed link in the adjuster tab to show it in the fast-track queue. | "Kestrel's claims lead decides the fraud cap is too tight for glass. She changes one number in the admin console, validates and saves. That is version 2 of her configuration, audited, no release, no restart. Here is the same claim again, a few seconds later: fast tracked. The change is hers, not an IT ticket." | VD-3 (business-owned configuration, minutes not sprints), VD-1 (more claims straight through), VD-4 (the guardrail is a visible, auditable number) | If saving shows a conflict or error, click Reload, repeat the edit once. If the console is down, narrate from the Rules tab screenshot and show the two numbers in `tenants/aurelia-mutual.json` (`fastTrack.maxFraudScore` 25) and `tenants/kestrel-point.json` (10). Do not edit the JSON files live: the running config lives in the database. |
| 7:30 to 8:15 | **5. KPIs panel** | http://localhost:8080/admin (same session, **KPIs** tab) | Same tenant admin | 1) Click **KPIs**, then **Refresh**.<br>2) Read the rows `metrics[0]` (`stp_rate`, VD-1): numerator 1 (before beat 4 it was 0). The denominator is every Kestrel claim so far, 4 if beat 3 was done live (value 0.25), 3 if it was skipped.<br>3) Find `median_minutes_to_acknowledgment` (VD-2): a number, not blank (near zero minutes). Every claim is acknowledged the moment it is reported; the platform records the acknowledgment and nothing is sent in this PoC.<br>4) Scroll to `subrogation_flag_rate` (VD-5) and `coverage_verified_at_intake_rate` (VD-4).<br>5) Optional if time: open a new tab at `/admin`, sign in as tenant `aurelia-mutual`, **KPIs**: `spanish_session_share` and `digital_self_service_share` (VD-6) are above 0 after beat 1. | "These are the numbers a claims VP asks for, per carrier, from the live system, each tied to a value driver. STP rate just moved because of the change we made two minutes ago. Subrogation flag rate and coverage-verified-at-intake sit next to it. In a pilot these are your before and after." (Be candid: the panel is a plain list in this PoC; a charted view is a next step. The figures come from claims in the last 30 days.) | VD-1, VD-2, VD-4, VD-5, VD-6 | If the panel says KPIs are unavailable, run `curl -s -H "Authorization: Bearer <token>" localhost:8080/api/v1/kpis` with a supervisor or admin token (setup guide, tokens) and read the `metrics` array. If the denominators are 0, run `node /tmp/stage-claims.mjs all` and refresh. |
| 8:15 to 9:15 | **6. Webhook and core adapter payload** | 1) http://localhost:8080/admin (**Webhooks** tab)<br>2) Terminal | Tenant admin (UI); `carrier_admin` token for the curl commands | 1) **Webhooks** tab, under "Add subscription" enter Endpoint URL `https://events.kestrel-point.example/hooks/claims`, Event types `claim.reported, claim.routed`, click **Create subscription**. A toast shows the signing secret once.<br>2) In the terminal: `TOKEN=$(curl -s -X POST localhost:8080/api/v1/auth/token -H 'content-type: application/json' -d '{"tenantId":"kestrel-point","sub":"dev-kestrel-point-carrier_admin","roles":["carrier_admin"],"name":"Taylor Admin"}' \| node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')`<br>3) Set `ID=` to the `clm_...` id in the beat 4 link, then: `curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/api/v1/integrations/adapters/core-claims-suite/preview/$ID \| node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).payload,null,2)'`<br>4) Then the event that webhooks and queues carry: `curl -s -H "Authorization: Bearer $TOKEN" "localhost:8080/api/v1/integrations/outbox?type=claim.routed&subject=$ID" \| node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).items[0].event,null,2)'` | "Your core claims system gets the claim as an ACORD-aligned notification: policy, occurrence, parties, our triage and routing as extension blocks, personal data masked in this preview. Anything else that wants to know subscribes to signed events: CloudEvents with ids and codes, never personal data, written to an outbox in the same transaction so nothing is lost. A subscription is one form; the secret is shown once. Swapping the core adapter is a configuration choice, not a rewrite." (Do not claim a live delivery: the endpoint is a fictional `.example` host, so the platform logs a blocked delivery. Signature verification code is in `docs/api-reference.md`, "Verifying the signature".) | VD-3 (core adapter and event fabric, no lock-in), VD-1 (no re-keying into the core system) | If creating the subscription fails, skip step 1 and run steps 2 to 4 only. If a curl returns 401, mint the token again (tokens expire). If `jq` is preferred over `node -pe`, pipe to `jq .payload`. |
| 9:15 to 10:00 | **7. PM dashboard and close** | http://localhost:8090/ | Anyone (no sign-in) | 1) Overview tab: tickets done, velocity, forecast.<br>2) Click **Value drivers**: VD-1 to VD-9 with the tickets and points behind each.<br>3) Close on the slide-free summary below. | "This is how the product was built: a small AI team, with every ticket tied to a value driver, tracked live. The six drivers we just walked, STP, cycle time, configuration, leakage, subrogation, claimant experience, each have shipped features and a number you can measure in a pilot. Next step: a two-tenant pilot on your sandbox, or a configuration workshop with your claims leads." | All of VD-1 to VD-6 traced to delivered work; VD-7 (compliance timers and audit) as the guardrail | If :8090 is not up, run `PORT=8090 node dashboard/server.mjs`, or open `dashboard/snapshot.html` from disk. If someone asks what is missing, open `docs/cots-readiness.md`. |

## What was verified, and what changed since Sprint 3

The first outline had claims the code did not support. Sprint 4 fixed some of them; each row says what the code does now (re-read and, where noted, re-run in the 22:15Z check).

| Topic | What the code does now | What the script does |
| --- | --- | --- |
| Policy and vehicle on UI claims (was: UI claims could not reach `covered` or fast track) | Fixed S4. Intake carries the policy number and the picked insured vehicle into the claim (`enrichClaimCreate`, `src/modules/intake/mapping.js`). Seeded policies have three vehicles, so without the pick coverage stays `needs_review` (`no_insured_vehicle`) and the claim is not fast tracked. With the pick, an Aurelia glass claim from CSR and claimant tokens is `covered` and `fast_track`. | Beat 1 and 2 still use staged API claims, only for the 21-day-late contrast. Beat 3 picks the vehicle in the CSR screen. S5: the claimant web picker now reads `GET /intake/sessions/{id}/policy-vehicles` after the claimant gives the last name and ZIP (S5-WFL-04); wrong answers get one uniform 404 and 10 failures lock the policy for 15 minutes (S5-WFL-05). |
| Same glass claim at Kestrel routes to a queue | A plain glass claim is fast tracked at both carriers. The difference is `fastTrack.maxFraudScore` 25 (Aurelia) against 10 (Kestrel) with the claim reported 21 days late (`LATE_REPORT`, 15 points, `src/modules/triage/fraud.mjs`). Kestrel: "fast track blocked: fraud score 15 above fast-track limit 10", queue `personal_auto_claims`. | As scripted in beat 2 (asserted by the e2e test). |
| CSR rear-end claim shows the subrogation flag | Triage sets `subrogation.flag` from the narrative (`rear_ended_by_other`). The recovery task `PR-SUBRO-PA` fires only for a collision cause, which the CSR script does not set (cause `other`). Aurelia's `PR-SUBRO-AUTO` needs the "other party" answer, which the CSR UI now sends as a structured party (S4-EXP-01, UI not browser-tested here). | The live CSR call runs at Kestrel; the recovery task is shown on the staged rear-end claim. |
| Admin raises an STP threshold and the next claim flips | Works: `fastTrack.maxFraudScore` 10 to 20 flips the Kestrel late-reported glass claim to `fast_track` immediately, no cache. Seed-once loading (fixed S4) means a restart no longer reverts a console save. | As scripted in beat 4. |
| KPI acknowledgment time (was: always null) | Fixed S4. On `claim.reported` the platform records an acknowledgment: audit entry, done `acknowledge_claimant` task (meets the timer) and `claim.acknowledged` event, when the tenant lists a claimant channel. `median_minutes_to_acknowledgment` is non-null. Nothing is sent. | Beat 5 reads it. |
| Webhook payload | Subscriptions are created in the admin console and events are in the outbox. `allowedHosts` is enforced at create (422 for a host outside the list); the beat-6 host `events.kestrel-point.example` is on Kestrel's list. Delivery to the fictional `.example` host fails ("host could not be resolved"). The adapter preview now differs per tenant (`fieldMapProfile` `mapping-a` Aurelia, `mapping-b` Kestrel). | Beat 6 shows the form, the adapter preview and the signed-event envelope, not a live delivery. |
| Claimant vehicle picker (S5) | `holderMatches` (`src/modules/intake/service.js:332`): the last name equals the last word of a named insured and the ZIP is on the policy. Success returns only year, make, model and last 4 of the VIN. Unknown policy, wrong name, wrong ZIP and another tenant's policy are indistinguishable (`tests/security/s5-regressions.test.mjs`). | Beat 1 mentions the step; staging stays on the API. Not re-run in a browser for this page. |

Other checks that the script relies on: the adjuster inbox defaults to "Only my claims" and the dev adjuster has no assigned claims, so it must be unticked; the CSR page lists only `northwind` unless `?tenant=` is given; the policy search hint text mentions `AUT-1000`, but the seeded policies are numbered `PA-WI-...` (Aurelia) and `PA-MI-...` (Kestrel), so search `PA-`.


## Reset between runs

```
# stop npm start (Ctrl-C), then
rm -rf data .secrets && npm run seed && npm start
node /tmp/stage-claims.mjs all
```

To undo only beat 4 without a full reset: admin console, Rules tab, Maximum fraud score back to `10`, **Validate and save**.

## If someone asks

- **Is the AI real?** The PoC runs a deterministic local provider and shows its provider, model and confidence on every output; the cascade to hosted models is configured per tenant (`ai` section of the tenant file) and with `humanConfirmRequired` every result is marked unconfirmed for a person to confirm; `redactPiiBeforeModel` and `maxTokensPerClaim` are honoured too (the token limit is best-effort under concurrent calls). The offline Vertex results in `docs/ai-evaluation.md` are replayed recordings. S5: a first live run against two Gemini models exists (`docs/ai-evaluation-live.md`); neither met the selection rule (12.5% invalid outputs, and 31 to 32 of 80 adversarial runs departed from the label), so the demo runs on the local provider and no hosted model is claimed as chosen. Claude models have not been run (not enabled in the project).
- **Is the Spanish complete?** The screens, notices and status wording are Spanish; AI-written summary text is English in this PoC.
- **What would a pilot need?** See `docs/cots-readiness.md` and `docs/deployment.md`.
- **How do we change a rule?** `docs/configuration-guide.md`.

## Run against the deployed service

Ticket S5-QE-01. The automated beats (1 to 6) can run over HTTP(S) against a deployed service instead of an in-process app, so every sprint proves the live system. The deployment must run with `devMode` on (it mints demo tokens at `POST /api/v1/auth/token`) and carry the seed data.

| Variable | Meaning |
| --- | --- |
| `FNOL_BASE_URL` | Service root, for example `https://<your-service-url>`. Unset means the default local run (in-process app, real seed). |
| `FNOL_IAP_TOKEN` | Optional. When set, every request also sends `Proxy-Authorization: Bearer <token>` so an identity-aware proxy can authenticate the caller; the app token stays in `Authorization`. Obtain it from your own tooling; never commit it. |

```
FNOL_BASE_URL=https://<your-service-url> FNOL_IAP_TOKEN="$(<your token command>)" \
  node --test --disable-warning=ExperimentalWarning tests/e2e/demo-script.test.mjs
```

Behaviour in remote mode:

- App tokens come from the remote `POST /auth/token`, one per tenant and role. Nothing is seeded locally.
- The run prints no IAP token, no app token and no response body. A failure reads `remote beat failed: Beat N (last HTTP status S, ErrorName)`.
- Beat 4's Kestrel config change is reverted in `after()`, as locally, and the Beat 6 webhook subscription is deleted. Claims staged by the run stay on the service (they are synthetic and cannot be deleted through the API).
- Beat 5 skips the exact stp_rate counts (1 of 3), which assume an empty database, and checks the counts are at least that. No beat needs in-process access, so none is skipped outright.
- Run it only against a demo deployment: it changes the Kestrel fraud limit for the duration of the run.

Proving remote mode without the service: `FNOL_REMOTE_SELFTEST=1 node --test --disable-warning=ExperimentalWarning tests/e2e/demo-script.test.mjs` starts a fresh seeded `devMode` app on a local port behind a small gate that refuses requests lacking `Proxy-Authorization`, then re-runs the beats against it with `FNOL_BASE_URL=http://127.0.0.1:<port>`. It checks the credential is sent on every request, nothing secret is printed, a run without `FNOL_IAP_TOKEN` fails, and the Kestrel config is restored. It is skipped unless that variable is set.
