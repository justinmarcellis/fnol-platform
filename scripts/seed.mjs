// Seed script: boots the app (no listening), seeds synthetic policies per tenant and enabled LOB,
// writes data/dev-users.json and prints dev tokens. Idempotent. Synthetic, fictional data only.
// Usage: npm run seed   (FNOL_DB_PATH, FNOL_DEV_USERS_PATH override locations)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { enrichPolicy, producedByAgent } from './demo-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where dev users are written: FNOL_DEV_USERS_PATH, else next to FNOL_DB_PATH (a temporary db keeps its users with it,
 * DATA-18), else data/dev-users.json in the repo.
 */
export function defaultDevUsersPath(env = process.env) {
  if (env.FNOL_DEV_USERS_PATH) return env.FNOL_DEV_USERS_PATH;
  if (env.FNOL_DB_PATH && env.FNOL_DB_PATH !== ':memory:') return path.join(path.dirname(path.resolve(env.FNOL_DB_PATH)), 'dev-users.json');
  return path.join(root, 'data', 'dev-users.json');
}

/** Fictional dev users: one per role, per tenant. Names are invented; emails use the reserved .example domain. */
export const DEV_ROLES = [
  ['claimant', 'Casey Claimant'],
  ['csr', 'Riley Csr'],
  ['adjuster', 'Jordan Adjuster'],
  ['supervisor', 'Morgan Supervisor'],
  ['carrier_admin', 'Taylor Admin'],
  ['platform_admin', 'Sam Platform'],
];

export function devUsersFor(tenantId) {
  return DEV_ROLES.map(([role, name]) => ({
    sub: `dev-${tenantId}-${role}`,
    name,
    email: `${role}@${tenantId}.example`,
    tenantId,
    roles: [role],
  }));
}

async function loadSynthetic(importer, log) {
  try {
    const mod = await importer();
    if (typeof mod?.generatePolicies !== 'function') throw new Error('generatePolicies not exported');
    return mod;
  } catch (e) {
    log(`skip policies: synthetic data unavailable (${e.code || e.message})`);
    return null;
  }
}

/**
 * @param {object} [opts] createApp(fn), appOpts, importSynthetic(fn), devUsersPath, log(fn), count, seed
 * @returns {Promise<{tenants:string[], seeded:Array, skipped:string[], users:object[], tokens:object[]}>}
 */
export async function seed(opts = {}) {
  const log = opts.log ?? ((m) => console.log(m));
  const count = opts.count ?? 25;
  const seedValue = opts.seed ?? 42;
  const devUsersPath = opts.devUsersPath ?? defaultDevUsersPath();
  const createApp = opts.createApp ?? (await import('../src/server.mjs')).createApp;
  const importSynthetic = opts.importSynthetic ?? (() => import(pathToFileURL(path.join(root, 'tests', 'synthetic', 'index.mjs')).href));

  const result = { tenants: [], seeded: [], skipped: [], users: [], tokens: [] };
  if (!opts.createApp && !process.env.FNOL_DB_PATH) fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const app = await createApp({ port: 0, ...(opts.appOpts ?? {}) });
  try {
    const ctx = app.ctx;
    const synthetic = await loadSynthetic(importSynthetic, log);
    if (!synthetic) result.skipped.push('synthetic');
    result.tenants = [...(ctx.tenants?.list?.() ?? [])].sort();

    for (const tenantId of result.tenants) {
      const config = ctx.tenants.get(tenantId) ?? {};
      const lobs = (config.lobs ?? []).filter((l) => l && l.enabled !== false);
      const coverage = (() => { try { return ctx.forTenant?.(tenantId)?.modules?.coverage; } catch { return null; } })();
      for (const lob of lobs) {
        const key = `${tenantId}/${lob.id}`;
        if (!synthetic) { result.skipped.push(key); continue; }
        if (typeof coverage?.seedPolicies !== 'function') { result.skipped.push(key); log(`skip ${key}: coverage service missing`); continue; }
        const state = lob.states?.[0];
        try {
          // Phones, varied ZIPs and the demo agent as producer of about a third of the book (CSR-4, CSR-9, DATA-12).
          const policies = synthetic.generatePolicies({ tenantId, lob: lob.id, count, seed: seedValue, state })
            .map((p) => enrichPolicy(p, { tenantId, produce: producedByAgent(p.policyNumber) }));
          const r = await coverage.seedPolicies(policies);
          result.seeded.push({ tenantId, lob: lob.id, state, count: policies.length, inserted: r?.inserted });
          log(`seeded ${key}: ${policies.length} policies (${state ?? 'no state'})`);
        } catch (e) {
          result.skipped.push(key);
          log(`skip ${key}: ${e.message}`);
        }
      }
      for (const u of devUsersFor(tenantId)) {
        result.users.push(u);
        try {
          result.tokens.push({ sub: u.sub, tenantId, role: u.roles[0], token: ctx.auth.issueToken({ sub: u.sub, tenantId, roles: u.roles, name: u.name }) });
        } catch (e) { log(`no token for ${u.sub}: ${e.message}`); }
      }
    }

    fs.mkdirSync(path.dirname(devUsersPath), { recursive: true });
    fs.writeFileSync(devUsersPath, JSON.stringify({ note: 'Fictional dev users. Tokens are not stored; run npm run seed to print fresh ones.', users: result.users }, null, 2) + '\n');
    log(`wrote ${devUsersPath} (${result.users.length} users)`);
    for (const t of result.tokens) log(`token ${t.tenantId} ${t.role}: ${t.token}`);
  } finally {
    await app.close();
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  seed().then(() => process.exit(0), (e) => { console.error('seed failed:', e); process.exit(1); });
}
