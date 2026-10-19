import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createApp } from '../../../src/server.mjs';
import { validate, fileResolver } from '../../../src/modules/config/validator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const href = (p) => pathToFileURL(p).href;

/** Boot with the real triage module and fake claims, evidence, coverage, rules; ctx.ai replaced by `ai`. */
export async function bootTriageApp(ai) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-triage-'));
  const modulesDir = path.join(dir, 'modules');
  const entries = [['triage', href(path.join(root, 'src/modules/triage/index.mjs'))]]
    .concat(['claims', 'evidence', 'coverage', 'rules'].map((m) => [m, href(path.join(here, `mod-${m}.mjs`))]));
  for (const [name, src] of entries) {
    fs.mkdirSync(path.join(modulesDir, name), { recursive: true });
    fs.writeFileSync(path.join(modulesDir, name, 'index.mjs'), `export { default } from '${src}';\n`);
  }
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  for (const id of ['alpha', 'beta']) fs.writeFileSync(path.join(tenantsDir, `${id}.json`), JSON.stringify({ id, displayName: `${id} Example` }));
  const app = await createApp({ dbPath: ':memory:', port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, modulesDir, logLevel: 'silent' });
  app.ctx.ai = ai;
  const close = app.close;
  app.close = async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); };
  app.token = (roles, tenantId = 'alpha') => app.ctx.auth.issueToken({ sub: 'u1', tenantId, roles });
  app.triage = (t = 'alpha') => app.ctx.forTenant(t).modules.triage;
  app.events = (type, t = 'alpha') => app.ctx.bus.outbox(t).map((r) => JSON.parse(r.event)).filter((e) => e.type === type);
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
  return { status: res.status, json };
}

/** TriageResult.schema.json plus the proposed additive subrogation.confidence (contract-change request). */
export function triageErrors(doc) {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'architecture/contracts/domain/TriageResult.schema.json'), 'utf8'));
  schema.properties.subrogation.properties.confidence = { type: 'number', minimum: 0, maximum: 1 };
  return validate(schema, doc, { resolve: fileResolver() }).errors;
}
