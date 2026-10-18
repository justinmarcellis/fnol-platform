import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/server.mjs';
import { createLogger } from '../../src/core/log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const OPENAPI_PATH = path.join(ROOT, 'architecture', 'contracts', 'openapi.yaml');
export const API_BASE = '/api/v1';

/** Two fictional tenants. */
export const TENANT_A = 'sec-alder-mutual';
export const TENANT_B = 'sec-birch-casualty';

/** Distinct, synthetic PII values (none is a real person, number or address). */
export const PII = {
  A: {
    fullName: 'Zephyrine Quillfeather',
    email: 'zephyrine.quillfeather@example.invalid',
    phone: '555-0142-7781',
    dob: '1971-02-29',
    address: '9917 Imaginary Lantern Row',
    license: 'SYNLIC-A-48151623',
    plate: 'ZQF-0A77',
  },
  B: {
    fullName: 'Thaddeus Marblewick',
    email: 'thaddeus.marblewick@example.invalid',
    phone: '555-0199-3302',
    dob: '1984-11-03',
    address: '4402 Fictional Orchard Court',
    license: 'SYNLIC-B-23421108',
    plate: 'TMW-9B31',
  },
};
export const piiValues = (who) => Object.values(PII[who]);
export const allPiiValues = () => [...piiValues('A'), ...piiValues('B')];

/**
 * Boot an isolated platform: temp dir (db, secrets, tenants), two synthetic tenants, port 0, captured logs.
 * `app.close()` stops the server and removes the temp dir.
 */
export async function bootSecurityApp(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-sec-'));
  const tenantsDir = path.join(dir, 'tenants');
  fs.mkdirSync(tenantsDir);
  fs.writeFileSync(path.join(tenantsDir, `${TENANT_A}.json`), JSON.stringify({ id: TENANT_A, displayName: 'Alder Mutual (fictional)' }));
  fs.writeFileSync(path.join(tenantsDir, `${TENANT_B}.json`), JSON.stringify({ id: TENANT_B, displayName: 'Birch Casualty (fictional)' }));
  let app;
  try {
    app = await createApp({
      dbPath: path.join(dir, 'sec.db'), port: 0, secretsDir: path.join(dir, 'secrets'), tenantsDir, logLevel: 'silent', ...extra,
    });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  // Capture log lines with the core logger (same redaction) by swapping ctx.log's methods.
  const logLines = [];
  const captured = createLogger({ level: 'debug', write: (l) => logLines.push(l), clock: app.ctx.clock });
  Object.assign(app.ctx.log, captured);
  const close = app.close;
  let closed = false;
  app.close = async () => {
    if (closed) return;
    closed = true;
    try { await close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  app.dir = dir;
  app.logLines = logLines;
  app.tokenFor = (tenantId, roles, sub = 'sec-user') => app.ctx.auth.issueToken({ sub, tenantId, roles });
  return app;
}

/** Roles that the running auth layer can actually issue tokens for. */
export const issuableRoles = (app) => app.ctx.auth.ROLES;

/** HTTP call helper. */
export async function call(app, method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(app.url + url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

/**
 * Minimal OpenAPI path parser (no YAML dependency). Reads only `paths:` and, per operation,
 * operationId, x-roles, x-module and whether `security: []` marks it public.
 * @returns {{ method: string, path: string, operationId: string|null, roles: string[], module: string|null, public: boolean }[]}
 */
export function parseOpenApi(text = fs.readFileSync(OPENAPI_PATH, 'utf8')) {
  const ops = [];
  let inPaths = false;
  let curPath = null;
  let cur = null;
  const list = (s) => s.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const line of text.split('\n')) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (!inPaths) continue;
    if (/^\S/.test(line) && !line.startsWith('#')) break; // next top-level key
    let m;
    if ((m = /^ {2}(\/\S*):\s*$/.exec(line))) { curPath = m[1]; cur = null; continue; }
    if ((m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line)) && curPath) {
      cur = { method: m[1].toUpperCase(), path: curPath, operationId: null, roles: [], module: null, public: false, hasRoles: false };
      ops.push(cur);
      continue;
    }
    if (!cur) continue;
    if ((m = /^ {6}operationId:\s*(\S+)/.exec(line))) cur.operationId = m[1];
    else if ((m = /^ {6}x-roles:\s*(\[.*\])\s*$/.exec(line))) { cur.roles = list(m[1]); cur.hasRoles = true; }
    else if ((m = /^ {6}x-module:\s*(\S+)/.exec(line))) cur.module = m[1];
    else if (/^ {6}security:\s*\[\]\s*$/.test(line)) cur.public = true;
  }
  return ops;
}

/** Concrete URL for an openapi path: `{id}` becomes a sample value. */
export function concretePath(p, sample = (name) => `sec_${name}`) {
  return API_BASE + p.replace(/\{(\w+)\}/g, (_, n) => sample(n));
}

/** Find the registered route (core router) for an openapi operation, or null when not implemented. */
export function findRoute(app, op) {
  const url = concretePath(op.path).split('?')[0];
  return app.ctx.router.match(op.method, url)?.route ?? null;
}

/** Why an operation has no route in this tree, for skip messages. */
export function skipReason(app, op) {
  const mod = op.module;
  if (mod && mod !== 'core' && !app.ctx.moduleNames.includes(mod)) return `module '${mod}' not implemented yet (ctx.moduleNames=${app.ctx.moduleNames.join(',') || 'none'})`;
  return `route ${op.method} ${API_BASE}${op.path} is not registered in this tree`;
}

/** Dump every row of every user table as a single string, for plaintext scans. */
export function dumpDatabase(app) {
  const raw = app.ctx.db.raw;
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = raw.prepare(`SELECT * FROM "${t}"`).all();
  return out;
}
export const dumpText = (app) => JSON.stringify(dumpDatabase(app));
