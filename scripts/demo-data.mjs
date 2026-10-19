// Demo data script: boots the app (no listening), then for every tenant and every enabled LOB generates
// deterministic synthetic scenarios, seeds their policies via coverage.seedPolicies and creates claims
// through ctx.forTenant(tenantId).modules (never SQL). Idempotent via per-claim idempotency keys.
// Synthetic, fictional data only.
//
// S6-BUG-05: the scenarios are made into one coherent story before they are stored:
// - every policy carries a phone, a varied ZIP and (for about a third of the book) the demo agent as producer;
// - the insured party on each claim is the policy's named insured (a business for fleet policies);
// - claims are reported over the last few weeks, days after the loss (the theft scenario keeps its deliberate
//   12-day delay), with acknowledgment, assignment, first contact and closure spread out in time;
// - claims arrive through the tenant's channels (phone, claimant web in English and Spanish, agent portal) and
//   some carry an evidence document whose AI-extracted fields count as automated capture.
// Usage: npm run demo   (FNOL_DB_PATH overrides the database location)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClock } from '../src/core/clock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
const HOUR = 3600000;

/** Status plan by claim ordinal: path of target statuses after the automatic pipeline settles. */
const PLANS = [
  { to: [] },
  { to: ['in_review'] },
  { to: ['in_review', 'pending_info'] },
  { to: ['in_review', 'closed'], closeReason: 'paid' },
  { to: ['in_review'] },
  { to: [] },
  { to: ['in_review', 'closed'], closeReason: 'denied' },
];
const NOTES = [
  'Called the insured to confirm details of the loss. Insured is cooperative.',
  'Reviewed the first notice and the policy snapshot. Coverage looks in order pending documents.',
  'Left a voicemail for the other party. Will retry tomorrow.',
];
const TASKS = [
  { type: 'request_document', title: 'Request repair estimate or photos', priority: 'normal' },
  { type: 'review_coverage', title: 'Review coverage and deductible', priority: 'normal' },
  { type: 'inspect', title: 'Schedule an inspection of the damage', priority: 'normal' },
];

/** Days between loss and report per scenario (the theft scenario's delay is the deliberate fraud demo). */
const REPORT_DELAY = {
  auto_rear_end_injury: [0, 1], auto_glass_only: [0, 2], auto_theft_late_report: [12, 12], auto_hit_and_run: [1, 2],
  home_water_small: [0, 1], home_fire_large: [0, 0], home_loss_before_inception: [6, 8], commercial_auto_fleet_collision: [0, 1],
};

/** Fictional towns with plausible ZIPs per state, and the area codes used with the reserved 555-01xx numbers. */
export const PLACES = {
  WI: { area: ['414', '608'], towns: [['Fairhaven', '53001'], ['Millbrook', '53002'], ['Stonebridge', '53003'], ['Alder Bay', '53151'], ['Pine Hollow', '53704'], ['Cobble Ridge', '54301'], ['Redfern Lake', '54911'], ['Oak Harbor', '53202']] },
  IL: { area: ['312', '217'], towns: [['Elmwood Park', '60001'], ['Westfield', '60002'], ['Ridgemont', '60003'], ['Brookhaven', '60101'], ['Larkspur', '60540'], ['Cedar Grove', '61701'], ['Maple Bend', '62701'], ['Foxridge', '60601']] },
  MI: { area: ['313', '616'], towns: [['Port Alder', '48001'], ['Cedar Falls', '48002'], ['Lakemont', '48003'], ['Birchwood', '48104'], ['Harbor Pines', '48201'], ['Willow Creek', '48823'], ['Granite Point', '49503'], ['Sandy Shores', '49684']] },
};

const DEMO_AGENTS = {
  'aurelia-mutual': { agentId: 'agt-aur-0142', name: 'Avery Lindqvist', agency: 'Lindqvist Insurance Agency (fictional)' },
  'kestrel-point': { agentId: 'agt-kpt-0217', name: 'Dana Whitcombe', agency: 'Whitcombe Commercial Insurance (fictional)' },
};

/** The tenant's demo agent (the agent persona produces part of the seeded book). */
export function demoAgent(tenantId) {
  if (DEMO_AGENTS[tenantId]) return { ...DEMO_AGENTS[tenantId] };
  const code = String(tenantId).replace(/[^a-z0-9]/gi, '').slice(0, 3).toLowerCase() || 'dev';
  return { agentId: `agt-${code}-0101`, name: 'Avery Lindqvist', agency: 'Lindqvist Insurance Agency (fictional)' };
}

/** Small stable string hash (FNV-1a). */
export function hash(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const ORG_HINT = /\b(co|company|inc|llc|ltd|corp|group|logistics|freight|delivery|services|transport)\b/i;
const isOrgName = (name) => ORG_HINT.test(String(name ?? '').replace(/\([^)]*\)/g, ' '));
const placesFor = (state) => PLACES[state] ?? PLACES.WI;

/** Fictional phone for a state: a local area code and the reserved 555-0100..0199 block. */
export function phoneFor(state, seed) {
  const p = placesFor(state);
  const h = hash(seed);
  return `(${p.area[h % p.area.length]}) 555-01${String(h % 100).padStart(2, '0')}`;
}

/** Town and ZIP for a seed, from the state's list. */
export function placeFor(state, seed) {
  const towns = placesFor(state).towns;
  const [city, postalCode] = towns[hash(seed) % towns.length];
  return { city, postalCode };
}

/**
 * Make a synthetic policy demo-ready (in place, and returned): named insured with kind, first/last name and phone,
 * varied garaging / property ZIPs, and the demo agent as producer when `produce` is true.
 * @param {object} policy PolicySnapshot-shaped synthetic policy
 * @param {{ tenantId: string, produce?: boolean }} o
 */
export function enrichPolicy(policy, { tenantId, produce = false } = {}) {
  if (!policy || typeof policy !== 'object') return policy;
  const state = policy.ratingState ?? 'WI';
  const key = policy.policyNumber;
  const ni = policy.namedInsureds?.[0];
  if (ni?.name) {
    if (isOrgName(ni.name)) ni.kind = 'organization';
    else {
      const words = ni.name.trim().split(/\s+/);
      Object.assign(ni, { kind: 'person', firstName: words.slice(0, -1).join(' '), lastName: words.at(-1) });
    }
    ni.phone = phoneFor(state, `${key}:insured`);
  }
  const home = placeFor(state, `${key}:home`);
  (policy.vehicles ?? []).forEach((v, i) => {
    // A household garages its cars at home; a fleet uses two depots.
    const at = policy.lob === 'commercial_auto' && i % 2 ? placeFor(state, `${key}:depot`) : home;
    v.garagingPostalCode = at.postalCode;
  });
  for (const pr of policy.properties ?? []) {
    if (pr.address) Object.assign(pr.address, home, { state });
  }
  if (produce) policy.producer = { ...demoAgent(tenantId) };
  return policy;
}

/**
 * The demo adjuster: the adjuster who works the most desks (queues other than fast track and SIU), first on ties.
 * The adjuster persona is this person, so its inbox holds a varied caseload (DATA-9, ADJUSTER-19).
 * @param {object} config tenant config
 * @returns {string|null}
 */
export function demoAdjuster(config) {
  const ft = config?.fastTrack?.queue ?? 'fast_track';
  const count = new Map();
  for (const q of config?.queues ?? []) {
    if (q.id === ft || q.id === 'siu' || q.assignment === 'manual') continue;
    for (const a of q.adjusters ?? []) count.set(a, (count.get(a) ?? 0) + 1);
  }
  let best = null;
  for (const [a, n] of count) if (!best || n > count.get(best)) best = a;
  return best;
}

/** Scenario documents worth attaching as evidence (police reports always; estimates whose damage areas match the narrative). */
const EVIDENCE_ESTIMATES = new Set(['auto_rear_end_injury', 'auto_glass_only', 'home_water_small']);

/** Deterministic share of the book the demo agent produces (about one policy in three). */
export const producedByAgent = (policyNumber) => hash(`${policyNumber}:producer`) % 3 === 0;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDaysIso = (day, n) => isoDay(Date.parse(`${day}T12:00:00Z`) + n * DAY);
const splitName = (name) => { const w = String(name ?? '').trim().split(/\s+/); return { firstName: w.slice(0, -1).join(' '), lastName: w.at(-1) ?? '' }; };

/**
 * Re-time and re-cast one generated scenario so it agrees with its policy and the demo calendar.
 * Mutates scenario.policy and scenario.claimCreate. Returns { reportedAt, lossDate }.
 * @param {object} scenario from generateScenario
 * @param {{ tenantId: string, reportedAt: number, produce?: boolean }} o
 */
export function alignScenario(scenario, { tenantId, reportedAt, produce = false }) {
  const policy = scenario.policy;
  const cc = scenario.claimCreate;
  const state = cc.riskState ?? policy.ratingState;
  const [lo, hi] = REPORT_DELAY[scenario.name] ?? [0, 2];
  const delay = lo + (hash(`${policy.policyNumber}:delay`) % (hi - lo + 1));
  const oldLoss = cc.lossEvent.lossDate;
  const lossDate = addDaysIso(isoDay(reportedAt), -delay);

  // Policy term: the loss falls well inside it, except for the loss-before-inception scenario.
  const eff = scenario.name === 'home_loss_before_inception'
    ? addDaysIso(lossDate, 3)
    : addDaysIso(lossDate, -(120 + (hash(`${policy.policyNumber}:term`) % 150)));
  policy.period = { ...policy.period, effectiveDate: eff, expirationDate: addDaysIso(eff, 365) };
  delete policy.period.cancellationDate;
  policy.asOfDate = lossDate;
  enrichPolicy(policy, { tenantId, produce });

  cc.lossEvent.lossDate = lossDate;
  // Loss location: the insured property, else a town in the risk state.
  const prop = policy.properties?.[0]?.address;
  const addr = cc.lossEvent.location?.address;
  if (addr) {
    Object.assign(addr, prop ? { line1: prop.line1, city: prop.city, postalCode: prop.postalCode } : placeFor(state, `${policy.policyNumber}:loss`));
    cc.lossEvent.location.description = `${addr.line1}, ${addr.city}, ${addr.state} ${addr.postalCode}`;
  }
  for (const p of cc.properties ?? []) if (prop) p.address = structuredClone(prop);

  // DATA-1: the insured on the claim is the policy's named insured (a business for fleets, with the driver from the policy).
  const ni = policy.namedInsureds?.[0] ?? {};
  const replaced = [];
  for (const p of cc.parties ?? []) {
    if (p.phone) p.phone = phoneFor(state, `${policy.policyNumber}:${p.id}`);
    if (!(p.roles ?? []).includes('insured')) continue;
    replaced.push(`${p.firstName} ${p.lastName}`);
    Object.assign(p, ni.kind === 'person' ? { firstName: ni.firstName, lastName: ni.lastName } : splitName(ni.name), { phone: ni.phone });
  }
  if (ni.kind === 'organization' && !(cc.parties ?? []).some((p) => (p.roles ?? []).includes('insured'))) {
    const driver = (cc.parties ?? []).find((p) => (p.roles ?? []).includes('driver') && p.isPolicyParty);
    if (driver && policy.drivers?.[0]?.name) {
      replaced.push(`${driver.firstName} ${driver.lastName}`);
      Object.assign(driver, splitName(policy.drivers[0].name));
    }
    cc.parties = [{ kind: 'organization', organizationName: ni.name, roles: ['insured'], isPolicyParty: true, phone: ni.phone, preferredContact: 'phone' }, ...(cc.parties ?? [])];
  }
  // Documents carry the same dates and names as the claim.
  const newName = ni.kind === 'person' ? `${ni.firstName} ${ni.lastName}` : policy.drivers?.[0]?.name;
  const shift = (d) => addDaysIso(lossDate, Math.round((Date.parse(d) - Date.parse(oldLoss)) / DAY));
  for (const doc of scenario.documents ?? []) {
    if (typeof doc.text !== 'string') continue;
    doc.text = doc.text.replace(/\b2\d{3}-\d{2}-\d{2}\b/g, (d) => shift(d));
    for (const n of replaced) if (n && newName) doc.text = doc.text.split(n).join(newName);
  }
  scenario.meta = { ...scenario.meta, lossDate, reportedDate: isoDay(reportedAt) };
  return { reportedAt, lossDate };
}

/**
 * Demo calendar: n report instants spread over the last `spanDays`, oldest first, on business hours, the newest
 * about two hours before `now`.
 */
export function reportTimes(n, { now, spanDays = 24, salt = '' } = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const daysAgo = n > 1 ? (spanDays * (n - 1 - i)) / (n - 1) : 0;
    const base = new Date(now - daysAgo * DAY);
    base.setUTCHours(14 + (hash(`${salt}:${i}:h`) % 7), hash(`${salt}:${i}:m`) % 60, 0, 0); // 9:00-15:59 Central
    let t = base.getTime();
    if (t > now - 2 * HOUR) t = now - 2 * HOUR - (hash(`${salt}:${i}`) % 40) * 60000;
    out.push(t);
  }
  for (let i = 1; i < out.length; i += 1) if (out[i] <= out[i - 1]) out[i] = out[i - 1] + 37 * 60000;
  return out;
}

/** A pinned clock that moves forward a few seconds on every read, so pipeline steps get distinct, plausible times. */
function demoClock(stepMs = 4000) {
  const base = createClock();
  let pinned = null;
  return {
    now() { if (pinned === null) return base.now(); pinned += stepMs; return new Date(pinned); },
    nowIso() { return this.now().toISOString(); },
    set(date) { pinned = new Date(date).getTime(); },
    advance(ms) { pinned = (pinned ?? Date.now()) + ms; },
    reset() { pinned = null; },
  };
}

async function settle(ctx, claims, claimId, log) {
  // Wait for the outbox-driven pipeline (validating -> triaged -> assigned/fast_tracked) to finish.
  for (let i = 0; i < 40; i += 1) {
    await ctx.bus?.drain?.();
    const c = await claims.getClaim(claimId);
    if (!['reported', 'validating', 'triaged'].includes(c?.status)) return c;
    await new Promise((r) => setTimeout(r, 50));
  }
  log(`  ${claimId}: pipeline did not settle in time`);
  return claims.getClaim(claimId);
}

/** Channel and reporter for a claim, from the tenant's enabled channels (phone, claimant web, agent portal). */
function channelPlan(lobCfg, { ordinal, scenario, produced, tenantId, locales }) {
  const ch = lobCfg?.channels ?? [];
  const web = ch.includes('claimant_web');
  if (web && scenario === 'auto_glass_only') return { channel: 'claimant_web', locale: 'en', via: 'intake' };
  if (web && scenario === 'home_water_small' && locales.includes('es')) return { channel: 'claimant_web', locale: 'es', via: 'intake' };
  if (web && scenario === 'auto_hit_and_run' && locales.includes('es') && ordinal % 2) return { channel: 'claimant_web', locale: 'es', via: 'intake' };
  if (produced && ch.includes('agent_portal')) return { channel: 'agent_portal', reporter: { type: 'user', id: demoAgent(tenantId).agentId, role: 'agent' } };
  return { channel: ch.includes('csr_phone') || !ch.length ? 'csr_phone' : ch[0], reporter: { type: 'user', id: `dev-${tenantId}-csr`, role: 'csr' } };
}

/** Answer a guided intake session from the scenario, as a claimant would online, and submit it. */
async function fileThroughIntake(tctx, it, plan, actor, idempotencyKey) {
  const intake = tctx.modules.intake;
  const cc = it.scenario.claimCreate;
  const pv = it.scenario.policy.vehicles?.[0];
  const ans = it.scenario.intakeAnswers ?? {};
  const third = (cc.parties ?? []).find((p) => (p.roles ?? []).includes('third_party'));
  const value = (q) => {
    const id = q.id;
    switch (q.type) {
      case 'date': return cc.lossEvent.lossDate;
      case 'time': return cc.lossEvent.lossTime;
      case 'longtext': return cc.lossEvent.description;
      case 'disclosure': return true;
      case 'currency': case 'number': return 1800;
      case 'vehicle': return pv ? { policyVehicleId: pv.unitId, unitId: pv.unitId, year: pv.year, make: pv.make, model: pv.model } : undefined;
      case 'party': return third ? { kind: 'person', roles: ['third_party'], firstName: third.firstName, lastName: third.lastName, insurerName: third.insurerName } : { kind: 'person', roles: ['witness'], lastName: 'Unknown' };
      case 'select': {
        const opts = (q.options ?? []).map((o) => o.value);
        return opts.find((o) => o === cc.lossEvent.cause || o === cc.lossType) ?? opts[0];
      }
      case 'multiselect': return (q.options ?? []).slice(0, 1).map((o) => o.value);
      case 'boolean': {
        if (/injur/.test(id)) return cc.lossEvent.injuriesReported === true;
        if (/drivable/.test(id)) return ans.drivable !== false;
        if (/other_party/.test(id)) return Boolean(third);
        if (/police/.test(id)) return cc.lossEvent.policeReport?.filed === true;
        if (/livable|habitable/.test(id)) return ans.habitable !== false;
        if (/stopped|mitigat/.test(id)) return true;
        return false;
      }
      case 'text': return /police/.test(id) ? (cc.lossEvent.policeReport?.reportNumber ?? 'None') : /unit/.test(id) ? (pv?.unitId ?? 'veh-1') : 'Not known';
      default: return undefined;
    }
  };
  let step = await intake.startSession({ lob: cc.lob, lossType: cc.lossType, channel: plan.channel, locale: plan.locale, policyNumber: cc.policyNumber, actor });
  const sessionId = step.sessionId;
  const picker = (step.optional ?? []).find((q) => q.type === 'vehicle');
  if (picker && value(picker)) step = await intake.answer(sessionId, [{ questionId: picker.id, value: value(picker) }], { actor });
  for (let i = 0; i < 40 && step.question; i += 1) {
    const v = value(step.question);
    if (v === undefined) throw new Error(`no demo answer for ${step.question.id}`);
    step = await intake.answer(sessionId, [{ questionId: step.question.id, value: v }], { actor });
    if (step.errors?.length) throw new Error(`intake answer rejected: ${step.errors.map((e) => e.questionId).join(', ')}`);
  }
  return intake.submit(sessionId, { actor, idempotencyKey });
}

/**
 * @param {object} [opts] createApp(fn), appOpts, importSynthetic(fn), log(fn), minPerTenant (default 12), seed (default 7), now (ms)
 * @returns {Promise<{tenants:string[], created:number, existing:number, failed:number, policies:number, perTenant:object, failures:Array}>}
 */
export async function demoData(opts = {}) {
  const log = opts.log ?? ((m) => console.log(m));
  const minPerTenant = opts.minPerTenant ?? 12;
  const baseSeed = opts.seed ?? 7;
  const createApp = opts.createApp ?? (await import('../src/server.mjs')).createApp;
  const importSynthetic = opts.importSynthetic ?? (() => import(pathToFileURL(path.join(root, 'tests', 'synthetic', 'index.mjs')).href));
  const realNow = opts.now ?? Date.now();

  const result = { tenants: [], created: 0, existing: 0, failed: 0, policies: 0, perTenant: {}, failures: [] };
  let synthetic;
  try {
    synthetic = await importSynthetic();
    if (typeof synthetic?.generateScenario !== 'function' || !synthetic.SCENARIOS) throw new Error('generateScenario/SCENARIOS not exported');
  } catch (e) {
    log(`demo-data skipped: synthetic data unavailable (${e.code || e.message})`);
    return result;
  }

  if (!opts.createApp && !process.env.FNOL_DB_PATH) fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const clock = opts.appOpts?.clock ?? demoClock();
  const app = await createApp({ port: 0, ...(opts.appOpts ?? {}), clock });
  const at = (ms) => { if (typeof clock.set === 'function') clock.set(Math.min(ms, realNow - 60000)); };
  try {
    const ctx = app.ctx;
    result.tenants = [...(ctx.tenants?.list?.() ?? [])].sort();
    for (const tenantId of result.tenants) {
      const stats = { created: 0, existing: 0, failed: 0, policies: 0 };
      result.perTenant[tenantId] = stats;
      const config = ctx.tenants.get(tenantId) ?? {};
      const lobs = (config.lobs ?? []).filter((l) => l && l.enabled !== false);
      const tctx = ctx.forTenant(tenantId);
      const { claims, coverage } = tctx.modules ?? {};
      if (!claims) { log(`skip ${tenantId}: claims service missing`); continue; }

      // One round = every scenario whose LOB is enabled, with a distinct seed (and rotating state).
      const plan = [];
      const perRound = Object.values(synthetic.SCENARIOS).filter((s) => lobs.some((l) => l.id === s.lob)).length;
      const rounds = perRound ? Math.ceil(minPerTenant / perRound) : 0;
      for (let round = 0; round < rounds; round += 1) {
        for (const spec of Object.values(synthetic.SCENARIOS)) {
          const lob = lobs.find((l) => l.id === spec.lob);
          if (!lob) continue;
          const states = lob.states?.length ? lob.states : ['WI'];
          plan.push({ spec, lob, seed: baseSeed + round, state: states[round % states.length] });
        }
      }

      const times = reportTimes(plan.length, { now: realNow, salt: tenantId });
      const items = [];
      plan.forEach((p, i) => {
        try {
          const scenario = synthetic.generateScenario(p.spec.name, { seed: p.seed, tenantId, state: p.state });
          const produced = producedByAgent(scenario.policy.policyNumber) || (p.lob.channels ?? []).includes('agent_portal') && i % 5 === 4;
          alignScenario(scenario, { tenantId, reportedAt: times[i], produce: produced });
          items.push({ ...p, scenario, reportedAt: times[i], produced });
        } catch (e) { stats.failed += 1; result.failures.push({ tenantId, scenario: p.spec.name, error: e.message }); log(`fail ${tenantId}/${p.spec.name}#${p.seed}: ${e.message}`); }
      });

      // Policies first (replace-by-policy-number, so reruns are safe).
      if (typeof coverage?.seedPolicies === 'function') {
        try {
          const policies = items.map((i) => i.scenario.policy);
          await coverage.seedPolicies(policies);
          stats.policies = policies.length;
        } catch (e) { log(`policy seeding failed for ${tenantId}: ${e.message}`); }
      } else log(`skip policies for ${tenantId}: coverage service missing`);

      let n = 0;
      for (const it of items) {
        const label = `${tenantId}/${it.spec.name}#${it.seed}`;
        const ordinal = n; n += 1;
        const t0 = it.reportedAt;
        const age = realNow - t0;
        try {
          const cc = it.scenario.claimCreate;
          const key = `demo:${tenantId}:${it.spec.name}:${it.seed}`;
          const how = channelPlan(it.lob, { ordinal, scenario: it.spec.name, produced: it.produced, tenantId, locales: config.locales ?? ['en'] });
          let created = null;
          if (how.via === 'intake') {
            const prior = (await claims.listClaims({ q: cc.policyNumber }, { limit: 1 })).items[0];
            if (prior) { stats.existing += 1; continue; }
            const claimant = { type: 'user', id: `clmt-${hash(cc.policyNumber).toString(36)}`, role: 'claimant' };
            at(t0 - 9 * 60000);
            try { created = await fileThroughIntake(tctx, it, how, claimant, key); }
            catch (e) { log(`  ${label}: online intake failed (${e.message}); filing by phone`); how.channel = 'csr_phone'; how.reporter = { type: 'user', id: `dev-${tenantId}-csr`, role: 'csr' }; }
          }
          if (!created) {
            at(t0);
            created = await claims.createClaim({ ...cc, tenantId, channel: how.channel }, { actor: how.reporter, idempotencyKey: key });
          }
          const claimId = created.id;
          if ((await claims.listNotes(claimId)).length > 0) { stats.existing += 1; continue; }

          const settled = await settle(ctx, claims, claimId, log);
          let owner = settled?.routing?.adjusterId;
          let fastTracked = settled?.status === 'fast_tracked';
          // Workload balancing: two desk claims in three go to the demo adjuster (a supervisor reassignment, with its reason).
          const senior = demoAdjuster(config);
          if (!fastTracked && settled?.status === 'assigned' && senior && owner !== senior && ordinal % 3 !== 1 && tctx.modules.rules?.route) {
            at(t0 + 25 * 60000);
            try {
              await tctx.modules.rules.route(claimId, { override: { adjusterId: senior, reason: 'Workload balanced to the senior adjuster on this desk' }, actor: { type: 'user', id: `dev-${tenantId}-supervisor`, role: 'supervisor' } });
              await ctx.bus?.drain?.();
              owner = (await claims.getClaim(claimId))?.routing?.adjusterId ?? owner;
            } catch (e) { log(`  ${label}: reassignment skipped (${e.message})`); }
          }
          // Adjuster work is done by the assigned adjuster; an unassigned claim (e.g. the manual SIU queue) by the supervisor persona.
          const actor = (role) => (role === 'adjuster' && owner ? { type: 'user', id: owner, role }
            : { type: 'user', id: `dev-${tenantId}-supervisor`, role: 'supervisor' });

          // Evidence for about half the claims: the adjuster uploads the scenario's text documents.
          const evidence = tctx.modules.evidence;
          if (evidence && ordinal % 2 === 0) {
            at(t0 + 40 * 60000);
            const docs = (it.scenario.documents ?? []).filter((d) => d.contentType === 'text/plain' && d.text
              && (/^police-report/.test(d.filename) || EVIDENCE_ESTIMATES.has(it.spec.name)));
            for (const doc of docs) {
              try { await evidence.addDocument(claimId, { kind: doc.kind, filename: doc.filename, contentType: 'text/plain', bytes: Buffer.from(doc.text), source: 'adjuster_upload' }, { actor: actor('adjuster') }); }
              catch (e) { log(`  ${label}: document skipped (${e.message})`); }
            }
            await ctx.bus?.drain?.();
            // New evidence re-runs triage and routing (a small estimate can fast track the claim).
            const now = await claims.getClaim(claimId);
            if (now?.routing) owner = now.routing.adjusterId;
            fastTracked = now?.status === 'fast_tracked';
          }

          if (fastTracked) {
            // Straight-through: an automated first contact and a system note, no manual task.
            if (age > 6 * HOUR) {
              at(t0 + 2 * HOUR);
              const fc = await claims.addTask(claimId, { type: 'first_contact', title: 'Automated first contact (fast track)', priority: 'normal', description: 'Fast-track text and email sent' }, { actor: { type: 'system', id: 'fast-track' } });
              if (fc?.id) await claims.updateTask(claimId, fc.id, { status: 'done' }, { actor: { type: 'system', id: 'fast-track' } });
            }
            at(t0 + 30 * 60000);
            await claims.addNote(claimId, { body: 'Fast track: coverage verified and the claim is handled straight through.', category: 'general' }, { actor: { type: 'system', id: 'fast-track' } });
            await ctx.bus?.drain?.();
            stats.created += 1;
            continue;
          }
          // First contact within hours for all but the newest claims.
          if (age > 6 * HOUR) {
            at(t0 + (2 + (hash(`${claimId}:fc`) % 20)) * HOUR);
            const fc = await claims.addTask(claimId, { type: 'first_contact', title: 'First contact with the insured', priority: 'high', description: 'Demo task' }, { actor: actor('adjuster') });
            if (fc?.id) await claims.updateTask(claimId, fc.id, { status: 'done' }, { actor: actor('adjuster') });
          }
          at(t0 + 3 * HOUR + (hash(`${claimId}:note`) % 30) * HOUR);
          await claims.addNote(claimId, { body: NOTES[ordinal % NOTES.length], category: 'general' }, { actor: actor('adjuster') });

          const plan2 = PLANS[ordinal % PLANS.length];
          const steps = plan2.to.filter((to) => to !== 'closed' || age > 5 * DAY);
          let k = 1;
          for (const to of steps) {
            const cur = await claims.getClaim(claimId);
            if (cur.status === to) continue;
            at(to === 'closed' ? t0 + Math.min(age - 6 * HOUR, (4 + (hash(claimId) % 6)) * DAY) : t0 + (6 * k) * HOUR);
            k += 1;
            let moved = false;
            for (const role of ['adjuster', 'supervisor']) {
              try { await claims.changeStatus(claimId, { to, reason: 'Demo data', ...(to === 'closed' ? { closeReason: plan2.closeReason } : {}), actor: actor(role) }); moved = true; break; }
              catch { /* try next role */ }
            }
            if (!moved) { log(`  ${label}: could not move ${cur.status} -> ${to}`); break; }
          }
          if (ordinal % 3 !== 2) {
            at(t0 + 5 * HOUR);
            const task = TASKS[ordinal % TASKS.length];
            const t = await claims.addTask(claimId, { ...task, description: 'Demo task' }, { actor: actor('adjuster') });
            if (ordinal % 4 === 3 && t?.id) await claims.updateTask(claimId, t.id, { status: 'done' }, { actor: actor('adjuster') });
          }
          await ctx.bus?.drain?.();
          stats.created += 1;
        } catch (e) {
          stats.failed += 1;
          result.failures.push({ tenantId, scenario: it.spec.name, seed: it.seed, error: e.message });
          log(`fail ${label}: ${e.message}`);
        }
      }
      if (typeof clock.reset === 'function') clock.reset();
      await ctx.bus?.drain?.();
      result.created += stats.created; result.existing += stats.existing; result.failed += stats.failed; result.policies += stats.policies;
      log(`${tenantId}: created ${stats.created}, existing ${stats.existing}, failed ${stats.failed}, policies ${stats.policies}`);
    }
    log(`demo-data summary: created ${result.created}, existing ${result.existing}, failed ${result.failed}, policies ${result.policies}`);
  } finally {
    if (typeof clock.reset === 'function') clock.reset();
    await app.close();
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  demoData().then(() => process.exit(0), (e) => { console.error('demo-data failed:', e); process.exit(1); });
}
