// Harness for the admin console UI test (own copy; does not import other teams' harnesses).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const TENANT = 'aurelia-mutual';

/**
 * Load Playwright and launch chromium, or return {skip: reason}. Never throws.
 * Looks for the package normally, then in common global tool locations.
 */
export async function launchBrowser() {
  const require = createRequire(import.meta.url);
  const candidates = ['playwright', '/opt/node-tools/node_modules/playwright', path.join(os.homedir(), '.npm-global/lib/node_modules/playwright')];
  let pw = null;
  for (const c of candidates) {
    try { pw = require(c); break; } catch { /* try the next location */ }
  }
  if (!pw?.chromium) return { skip: 'playwright is not installed' };
  try {
    const browser = await pw.chromium.launch({ headless: true });
    return { browser };
  } catch (err) {
    return { skip: `chromium could not launch: ${String(err.message).split('\n')[0]}` };
  }
}

/** Boot the real app on port 0 with a temp db, secrets dir and a temp copy of the tenants. */
export async function bootApp() {
  const { createApp } = await import('../../src/server.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-admui-'));
  // Tests never touch repo config: copy the tenants into the temp dir and boot from the copy.
  const tenantsDir = path.join(dir, 'tenants');
  fs.cpSync(path.join(ROOT, 'tenants'), tenantsDir, { recursive: true });
  let app;
  try {
    app = await createApp({
      dbPath: path.join(dir, 'ui.db'), port: 0, secretsDir: path.join(dir, 'secrets'),
      tenantsDir, logLevel: 'silent', devMode: true,
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    app,
    async close() {
      try { await app.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

/** Tiny API client with a dev token per role. */
export function apiClient(app, tenantId = TENANT) {
  const tokens = new Map();
  const token = (role, sub) => {
    const k = `${role}:${sub}`;
    if (!tokens.has(k)) tokens.set(k, app.ctx.auth.issueToken({ sub, tenantId, roles: [role], name: 'UI Test' }));
    return tokens.get(k);
  };
  return async (method, route, { body, role = 'integration', sub = `ui-${role}` } = {}) => {
    const res = await fetch(`${app.url}/api/v1${route}`, {
      method,
      headers: { authorization: `Bearer ${token(role, sub)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
}

/** Current config for a tenant straight from the running app (API, tenant_admin token). */
export async function readConfig(app, tenantId) {
  const api = apiClient(app, tenantId);
  const r = await api('GET', '/config', { role: 'tenant_admin' });
  if (r.status !== 200) throw new Error(`GET /config returned ${r.status}`);
  return r.json;
}
