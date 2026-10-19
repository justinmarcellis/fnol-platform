import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../../../../src/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const url = (p) => pathToFileURL(p).href;

/**
 * Boot an isolated app with the real integrations module and fake claims/triage/coverage modules.
 * Tenants: alpha (profile A by default), bravo (profile B), manual (pushOn manual), early (pushOn claim.reported),
 * other (adapter "other-suite", not registered), httpt (target set by tests), beta (default).
 */
export async function bootAdapters() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-adp-'));
  const modulesDir = path.join(dir, 'modules');
  const mods = [
    ['integrations', url(path.join(repo, 'src/modules/integrations/index.mjs')), 'default'],
    ['claims', url(path.join(here, 'fakes.mjs')), 'claimsModule'],
    ['triage', url(path.join(here, 'fakes.mjs')), 'triageModule'],
    ['coverage', url(path.join(here, 'fakes.mjs')), 'coverageModule'],
  ];
  for (const [name, src, exp] of mods) {
    fs.mkdirSync(path.join(modulesDir, name), { recursive: true });
    fs.writeFileSync(path.join(modulesDir, name, 'index.mjs'), `export { ${exp} as default } from '${src}';\n`);
  }
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  const lobs = [{ id: 'personal_auto', enabled: true, label: { en: 'Auto' }, acordLobCd: 'AUTOP' }];
  const tenants = {
    alpha: { id: 'alpha', displayName: 'Alpha Mutual', lobs },
    bravo: { id: 'bravo', displayName: 'Bravo Casualty', lobs, integrations: { claimsPort: { adapter: 'core-claims-suite', pushOn: 'claim.routed', settings: { profile: 'B' } } } },
    manual: { id: 'manual', displayName: 'Manual Push', integrations: { claimsPort: { pushOn: 'manual' } } },
    early: { id: 'early', displayName: 'Early Push', integrations: { claimsPort: { pushOn: 'claim.reported' } } },
    other: { id: 'other', displayName: 'Other Suite', integrations: { claimsPort: { adapter: 'other-suite' } } },
    httpt: { id: 'httpt', displayName: 'Http Target' },
    beta: { id: 'beta', displayName: 'Beta Casualty' },
  };
  for (const [id, cfg] of Object.entries(tenants)) fs.writeFileSync(path.join(tenantsDir, `${id}.json`), JSON.stringify(cfg));
  const app = await createApp({ dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, modulesDir, logLevel: 'silent', devMode: true });
  const close = app.close;
  app.close = async () => {
    app.ctx.modules.integrations?.worker?.stop?.();
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  app.token = (roles, tenantId = 'alpha', sub = 'u1') => app.ctx.auth.issueToken({ sub, tenantId, roles });
  app.tctx = (tenantId = 'alpha') => app.ctx.forTenant(tenantId);
  app.svc = (tenantId = 'alpha') => app.ctx.forTenant(tenantId).modules.integrations;
  app.tenantConfigs = tenants;
  return app;
}

export async function call(app, method, urlPath, { token, body } = {}) {
  const res = await fetch(app.url + urlPath, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

/** Local HTTP "core system" that records requests and answers with a scripted status. */
export async function startCore() {
  const requests = [];
  const core = { requests, status: 201, number: 'EXT-0001', url: '' };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
      res.writeHead(core.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(core.status < 300 ? { coreClaimNumber: core.number } : { error: 'boom' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  core.url = `http://127.0.0.1:${server.address().port}/claims`;
  core.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return core;
}

/** Publish an event as a tenant and wait for handlers. */
export async function publish(app, tenantId, type, data) {
  const evt = app.tctx(tenantId).bus.publish(type, data.claimId, data);
  await app.ctx.bus.drain();
  return evt;
}

export const routed = (claimId) => ({ claimId, decisionId: 'rtd_0000000000000000', outcome: 'assigned', queue: 'q1', ruleIds: [] });
