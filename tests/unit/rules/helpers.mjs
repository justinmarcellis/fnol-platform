import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';
import { validate } from '../../../src/modules/config/validator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
export const href = (p) => pathToFileURL(p).href;

/** Validate data against a domain schema file (contracts/domain/<name>.schema.json). */
export function schemaErrors(name, data) {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'architecture/contracts/domain', `${name}.schema.json`), 'utf8'));
  return validate(schema, data).errors;
}

export const loadTenant = (name) => JSON.parse(fs.readFileSync(path.join(root, 'tenants', `${name}.json`), 'utf8'));

/**
 * Boot an isolated app with the real rules module, fake claims/triage/coverage (and optionally config).
 * Tenants: aurelia (copy of aurelia-mutual), kestrel (copy of kestrel-point), other (second tenant for isolation).
 */
export async function bootRulesApp({ withConfig = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-rules-'));
  const modulesDir = path.join(dir, 'modules');
  const wrap = (name, file, fake) => {
    fs.mkdirSync(path.join(modulesDir, name), { recursive: true });
    const src = fake
      ? `import { fakes } from '${href(file)}';\nexport default fakes.${fake};\n`
      : `export { default } from '${href(file)}';\n`;
    fs.writeFileSync(path.join(modulesDir, name, 'index.mjs'), src);
  };
  wrap('rules', path.join(root, 'src/modules/rules/index.mjs'));
  for (const n of ['claims', 'triage', 'coverage', ...(withConfig ? ['config'] : [])]) wrap(n, path.join(here, 'fakes.mjs'), n);
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  const tenants = {
    aurelia: { ...loadTenant('aurelia-mutual'), id: 'aurelia' },
    kestrel: { ...loadTenant('kestrel-point'), id: 'kestrel' },
    other: { ...loadTenant('aurelia-mutual'), id: 'other' },
  };
  for (const [id, cfg] of Object.entries(tenants)) fs.writeFileSync(path.join(tenantsDir, `${id}.json`), JSON.stringify(cfg));
  const app = await createApp({ dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, modulesDir, logLevel: 'silent' });
  const close = app.close;
  app.close = async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  app.token = (roles, tenantId = 'aurelia', sub = 'u1') => app.ctx.auth.issueToken({ sub, tenantId, roles });
  app.rules = (tenantId = 'aurelia') => app.ctx.forTenant(tenantId).modules.rules;
  app.tenantConfig = (id) => structuredClone(app.ctx.tenants.get(id));
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
