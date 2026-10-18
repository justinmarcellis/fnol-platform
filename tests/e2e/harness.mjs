import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const REAL_TENANTS_DIR = path.join(ROOT, 'tenants');
export const FRAUD_THRESHOLD = 50;

/** Thrown by steps when the thing under test is not built yet. Mapped to t.todo, never a failure. */
export class NotImplemented extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'NotImplemented';
  }
}

/**
 * Map an HTTP response to NotImplemented when the endpoint is missing (404 / 501).
 * @param {{status:number,json?:any}} res
 * @param {string} label e.g. 'POST /claims'
 * @returns {object} res unchanged when implemented
 */
export function requireImplemented(res, label) {
  if (res.status === 404 || res.status === 501) {
    throw new NotImplemented(`${label} returned ${res.status} (endpoint or module not implemented yet)`);
  }
  return res;
}

/**
 * Run one step under a node:test context. NotImplemented becomes t.todo(reason);
 * any other error (including assertion failures) propagates and fails the test.
 * @returns {Promise<boolean>} true when the step ran to completion
 */
export async function runStep(t, fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    if (err instanceof NotImplemented) {
      t.todo(err.message);
      return false;
    }
    throw err;
  }
}

/** Load tests/synthetic/index.mjs when present, else the local fake. */
export async function loadSynthetic() {
  try {
    const mod = await import('../synthetic/index.mjs');
    if (mod && typeof mod.generateScenario === 'function' && mod.SCENARIOS) return { ...mod, source: 'tests/synthetic' };
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  const mod = await import('./fakes/synthetic-fallback.mjs');
  return { ...mod, source: 'tests/e2e/fakes/synthetic-fallback.mjs' };
}

/** Normalise SCENARIOS (array or object; strings or objects) to [{name, lob}]. */
export function scenarioList(SCENARIOS) {
  const raw = Array.isArray(SCENARIOS) ? SCENARIOS : Object.entries(SCENARIOS).map(([k, v]) => (typeof v === 'object' && v ? { name: k, ...v } : k));
  return raw.map((e) => (typeof e === 'string' ? { name: e, lob: e } : { name: e.name ?? e.lob, lob: e.lob ?? e.name }));
}

/** Tenant ids in a tenants dir, with their parsed config. */
export function listTenants(dir = REAL_TENANTS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    let config = {};
    try { config = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* invalid tenant file is not our concern */ }
    return { id: config.id ?? f.replace(/\.json$/, ''), config };
  });
}

/** A scenario applies when the tenant declares lobs and lists this one, or declares none. */
export function scenarioAppliesTo(config, lob) {
  const lobs = config?.lobs;
  if (!Array.isArray(lobs) || lobs.length === 0) return true;
  return lobs.some((l) => (typeof l === 'string' ? l : l?.id) === lob);
}

/**
 * Boot the real app on port 0 with a temp db/secrets dir and the real tenants dir.
 * @returns {Promise<{app:any, ctx:any, dir:string, close():Promise<void>}>}
 */
export async function bootHarness({ tenantsDir = REAL_TENANTS_DIR } = {}) {
  const { createApp } = await import('../../src/server.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-e2e-'));
  let app;
  try {
    app = await createApp({
      dbPath: path.join(dir, 'e2e.db'), port: 0, secretsDir: path.join(dir, 'secrets'),
      tenantsDir, logLevel: 'silent', devMode: true,
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    app, ctx: app.ctx, dir,
    async close() {
      try { await app.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

/** HTTP client against /api/v1 with a dev token per (tenant, role). */
export function createApi(app, tenantId) {
  const tokens = new Map();
  const token = (role) => {
    if (!tokens.has(role)) tokens.set(role, app.ctx.auth.issueToken({ sub: `e2e-${role}`, tenantId, roles: [role], name: 'E2E' }));
    return tokens.get(role);
  };
  return async function api(method, route, { body, role = 'integration' } = {}) {
    const res = await fetch(`${app.url}/api/v1${route}`, {
      method,
      headers: { authorization: `Bearer ${token(role)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json, text };
  };
}

/** Outbox events (parsed envelopes) for a tenant, optionally filtered by type and claim. */
export function outboxEvents(ctx, tenantId, { type, claimId } = {}) {
  return ctx.bus.outbox(tenantId)
    .map((r) => (typeof r.event === 'string' ? JSON.parse(r.event) : r))
    .filter((e) => (!type || e.type === type) && (!claimId || e.subject === claimId || e.data?.claimId === claimId));
}

/** Assert at least one outbox event of `type` exists for the claim; returns it. */
export function assertEvent(ctx, tenantId, claimId, type) {
  const found = outboxEvents(ctx, tenantId, { type, claimId });
  assert.ok(found.length > 0, `expected outbox event ${type} for claim ${claimId} (tenant ${tenantId})`);
  return found[found.length - 1];
}

function matches(expected, actual) {
  return Array.isArray(expected) ? expected.some((e) => e === actual) : expected === actual;
}

/**
 * Compare scenario.expected to produced data. Only keys with produced (non-undefined) values are checked.
 * Expected values may be arrays meaning "any of". `fraud` boolean means triage fraud score >= FRAUD_THRESHOLD.
 * @param {object} expected scenario.expected
 * @param {object} actual {coverageStatus?, severityBand?, fraud?, subrogation?, fastTrack?}
 */
export function compareExpected(expected = {}, actual = {}) {
  for (const key of ['coverageStatus', 'severityBand', 'fraud', 'subrogation', 'fastTrack']) {
    if (actual[key] === undefined || expected[key] === undefined) continue;
    assert.ok(matches(expected[key], actual[key]), `expected.${key}: wanted ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`);
  }
}
