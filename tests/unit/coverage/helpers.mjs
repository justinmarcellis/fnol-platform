import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';
import { claims } from './fake-claims.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const coverageEntry = pathToFileURL(path.resolve(here, '../../../src/modules/coverage/index.mjs')).href;
const fakeClaims = pathToFileURL(path.join(here, 'fake-claims.mjs')).href;

/**
 * Boot an isolated app with the real coverage module and a fake claims module.
 * Tenants: alpha, beta (default time zone), pacific (America/Los_Angeles), broken (unknown policy adapter).
 */
export async function bootCoverageApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-cov-'));
  const modulesDir = path.join(dir, 'modules');
  for (const [name, src] of [['coverage', coverageEntry], ['claims', fakeClaims]]) {
    fs.mkdirSync(path.join(modulesDir, name), { recursive: true });
    fs.writeFileSync(path.join(modulesDir, name, 'index.mjs'), `export { default } from '${src}';\n`);
  }
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  const tenants = {
    alpha: { id: 'alpha', displayName: 'Alpha Mutual' },
    beta: { id: 'beta', displayName: 'Beta Casualty' },
    pacific: { id: 'pacific', displayName: 'Pacific Example', timeZone: 'America/Los_Angeles' },
    broken: { id: 'broken', displayName: 'Broken Adapter', integrations: { policyPort: { adapter: 'no-such-adapter' } } },
  };
  for (const [id, cfg] of Object.entries(tenants)) fs.writeFileSync(path.join(tenantsDir, `${id}.json`), JSON.stringify(cfg));
  const app = await createApp({
    dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, modulesDir, logLevel: 'silent',
  });
  const close = app.close;
  app.close = async () => { claims.clear(); await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  app.token = (roles, tenantId = 'alpha', sub = 'u1') => app.ctx.auth.issueToken({ sub, tenantId, roles });
  app.cov = (tenantId = 'alpha') => app.ctx.forTenant(tenantId).modules.coverage;
  return app;
}

export async function call(app, method, url, { token, body } = {}) {
  const res = await fetch(app.url + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
