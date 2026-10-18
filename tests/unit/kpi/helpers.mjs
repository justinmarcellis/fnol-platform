import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = (...p) => pathToFileURL(path.resolve(here, ...p)).href;
const fakes = url('fakes.mjs');

/** Boot an isolated app: the real kpi module plus fakes for the modules it reads. */
export async function bootKpiApp(tenantIds = ['alpha', 'beta', 'empty', 'flaky']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-kpi-'));
  const modulesDir = path.join(dir, 'modules');
  const mods = [['kpi', url('../../../src/modules/kpi/index.mjs'), 'default'],
    ...['claims', 'rules', 'triage', 'evidence', 'coverage', 'intake'].map((n) => [n, fakes, n])];
  for (const [name, src, exp] of mods) {
    fs.mkdirSync(path.join(modulesDir, name), { recursive: true });
    fs.writeFileSync(path.join(modulesDir, name, 'index.mjs'), exp === 'default'
      ? `export { default } from '${src}';\n` : `export { ${exp} as default } from '${src}';\n`);
  }
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  for (const id of tenantIds) fs.writeFileSync(path.join(tenantsDir, `${id}.json`), JSON.stringify({ id, displayName: `${id} Example` }));
  const app = await createApp({ dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, modulesDir, logLevel: 'silent' });
  const close = app.close;
  app.close = async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  app.token = (roles, tenantId = 'alpha', sub = 'u1') => app.ctx.auth.issueToken({ sub, tenantId, roles });
  return app;
}

export async function get(app, urlPath, token) {
  const res = await fetch(app.url + urlPath, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

export const byId = (metrics) => Object.fromEntries(metrics.map((m) => [m.id, m]));
