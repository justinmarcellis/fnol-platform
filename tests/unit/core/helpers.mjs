import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../../src/server.mjs';

/** Boot an isolated app (temp secrets/tenants, in-memory db, port 0). */
export async function bootApp(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-test-'));
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  fs.writeFileSync(path.join(tenantsDir, 'alpha.json'), JSON.stringify({ id: 'alpha', displayName: 'Alpha Mutual' }));
  fs.writeFileSync(path.join(tenantsDir, 'beta.json'), JSON.stringify({ id: 'beta', displayName: 'Beta Casualty' }));
  const app = await createApp({
    dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, logLevel: 'silent', ...extra,
  });
  const close = app.close;
  app.close = async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  app.token = (roles, tenantId = 'alpha', sub = 'u1') => app.ctx.auth.issueToken({ sub, tenantId, roles });
  return app;
}

export async function call(app, method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(app.url + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
