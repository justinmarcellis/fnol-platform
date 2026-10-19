// Demo data script: boots the app (no listening), then for every tenant and every enabled LOB generates
// deterministic synthetic scenarios, seeds their policies via coverage.seedPolicies and creates claims
// through ctx.forTenant(tenantId).modules (never SQL). Idempotent via per-claim idempotency keys.
// Synthetic, fictional data only.
// Usage: npm run demo   (FNOL_DB_PATH overrides the database location)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  { type: 'contact_insured', title: 'Call insured to confirm loss details', priority: 'high' },
  { type: 'request_document', title: 'Request repair estimate or photos', priority: 'normal' },
  { type: 'review_coverage', title: 'Review coverage and deductible', priority: 'normal' },
];

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

/**
 * @param {object} [opts] createApp(fn), appOpts, importSynthetic(fn), log(fn), minPerTenant (default 12), seed (default 7)
 * @returns {Promise<{tenants:string[], created:number, existing:number, failed:number, policies:number, perTenant:object, failures:Array}>}
 */
export async function demoData(opts = {}) {
  const log = opts.log ?? ((m) => console.log(m));
  const minPerTenant = opts.minPerTenant ?? 12;
  const baseSeed = opts.seed ?? 7;
  const createApp = opts.createApp ?? (await import('../src/server.mjs')).createApp;
  const importSynthetic = opts.importSynthetic ?? (() => import(pathToFileURL(path.join(root, 'tests', 'synthetic', 'index.mjs')).href));

  const result = { tenants: [], created: 0, existing: 0, failed: 0, policies: 0, perTenant: {}, failures: [] };
  let synthetic;
  try {
    synthetic = await importSynthetic();
    if (typeof synthetic?.generateScenario !== 'function' || !synthetic.SCENARIOS) throw new Error('generateScenario/SCENARIOS not exported');
  } catch (e) {
    log(`demo-data skipped: synthetic data unavailable (${e.code || e.message})`);
    return result;
  }

  if (!opts.createApp) fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const app = await createApp({ port: 0, ...(opts.appOpts ?? {}) });
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
          plan.push({ spec, seed: baseSeed + round, state: states[round % states.length] });
        }
      }

      const items = [];
      for (const p of plan) {
        try { items.push({ ...p, scenario: synthetic.generateScenario(p.spec.name, { seed: p.seed, tenantId, state: p.state }) }); }
        catch (e) { stats.failed += 1; result.failures.push({ tenantId, scenario: p.spec.name, error: e.message }); log(`fail ${tenantId}/${p.spec.name}#${p.seed}: ${e.message}`); }
      }

      // Policies first (replace-by-policy-number, so reruns are safe).
      if (typeof coverage?.seedPolicies === 'function') {
        try {
          const policies = items.map((i) => i.scenario.policy);
          await coverage.seedPolicies(policies);
          stats.policies = policies.length;
        } catch (e) { log(`policy seeding failed for ${tenantId}: ${e.message}`); }
      } else log(`skip policies for ${tenantId}: coverage service missing`);

      const actor = (role) => ({ type: 'user', id: `dev-${tenantId}-${role}`, role });
      let n = 0;
      for (const it of items) {
        const label = `${tenantId}/${it.spec.name}#${it.seed}`;
        const ordinal = n; n += 1;
        try {
          const input = { ...it.scenario.claimCreate, tenantId };
          const created = await claims.createClaim(input, { actor: actor('csr'), idempotencyKey: `demo:${tenantId}:${it.spec.name}:${it.seed}` });
          const claimId = created.id;
          if ((await claims.listNotes(claimId)).length > 0) { stats.existing += 1; continue; }

          await settle(ctx, claims, claimId, log);
          const plan2 = PLANS[ordinal % PLANS.length];
          for (const to of plan2.to) {
            const cur = await claims.getClaim(claimId);
            if (cur.status === to) continue;
            let moved = false;
            for (const role of ['adjuster', 'supervisor']) {
              try { await claims.changeStatus(claimId, { to, reason: 'Demo data', ...(to === 'closed' ? { closeReason: plan2.closeReason } : {}), actor: actor(role) }); moved = true; break; }
              catch { /* try next role */ }
            }
            if (!moved) { log(`  ${label}: could not move ${cur.status} -> ${to}`); break; }
          }
          const task = TASKS[ordinal % TASKS.length];
          if (ordinal % 3 !== 2) {
            const t = await claims.addTask(claimId, { ...task, description: 'Demo task' }, { actor: actor('adjuster') });
            if (ordinal % 4 === 3 && t?.id) await claims.updateTask(claimId, t.id, { status: 'done' }, { actor: actor('adjuster') });
          }
          await claims.addNote(claimId, { body: NOTES[ordinal % NOTES.length], category: 'general' }, { actor: actor('adjuster') });
          stats.created += 1;
        } catch (e) {
          stats.failed += 1;
          result.failures.push({ tenantId, scenario: it.spec.name, seed: it.seed, error: e.message });
          log(`fail ${label}: ${e.message}`);
        }
      }
      await ctx.bus?.drain?.();
      result.created += stats.created; result.existing += stats.existing; result.failed += stats.failed; result.policies += stats.policies;
      log(`${tenantId}: created ${stats.created}, existing ${stats.existing}, failed ${stats.failed}, policies ${stats.policies}`);
    }
    log(`demo-data summary: created ${result.created}, existing ${result.existing}, failed ${result.failed}, policies ${result.policies}`);
  } finally {
    await app.close();
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  demoData().then(() => process.exit(0), (e) => { console.error('demo-data failed:', e); process.exit(1); });
}
