import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.mjs';

export const migrations = [{
  // Keyed by tenant but read across tenants at boot, so it is a system table.
  sql: `
CREATE TABLE IF NOT EXISTS tenant_configs (
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  config TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, version)
);`,
  systemTables: ['tenant_configs'],
}];

/**
 * Versioned tenant configuration registry.
 * @param {object} ctx
 * @param {{ tenantsDir: string }} opts
 */
export function createTenants(ctx, { tenantsDir }) {
  const validators = [];
  const { db } = ctx;

  const latest = (id) => db.system.get('SELECT * FROM tenant_configs WHERE tenant_id = ? ORDER BY version DESC LIMIT 1', id);

  const api = {
    /** Register a validator: (config) => string[] | void. Return/throw problems to reject a put. */
    addValidator(fn) { validators.push(fn); },
    /** Validate a config against all registered validators. @returns {string[]} problems */
    validate(config) {
      const problems = [];
      if (!config || typeof config !== 'object' || Array.isArray(config)) return ['config must be an object'];
      for (const v of validators) {
        try {
          const r = v(config);
          if (Array.isArray(r)) problems.push(...r);
        } catch (e) { problems.push(e.message); }
      }
      return problems;
    },
    /** Latest config for a tenant (parsed) or null. */
    get(tenantId) {
      const row = latest(tenantId);
      return row ? db.parseJson(row.config) : null;
    },
    /** Latest version number or 0. */
    version: (tenantId) => latest(tenantId)?.version ?? 0,
    /** All versions for a tenant, newest first. */
    history: (tenantId) => db.system.all('SELECT version, actor, created_at FROM tenant_configs WHERE tenant_id = ? ORDER BY version DESC', tenantId),
    /** Ids of all known tenants. */
    list: () => db.system.all('SELECT DISTINCT tenant_id FROM tenant_configs ORDER BY tenant_id').map((r) => r.tenant_id),
    /**
     * Store a new config version (no-op if identical to latest).
     * @returns {{ version: number, changed: boolean }}
     */
    put(tenantId, config, actor = 'system') {
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(tenantId)) throw new HttpError(400, 'invalid_tenant_id', 'tenantId must be alphanumeric, dash or underscore');
      const problems = api.validate(config);
      if (problems.length) throw new HttpError(400, 'invalid_tenant_config', problems.join('; '));
      const json = JSON.stringify(config);
      const cur = latest(tenantId);
      if (cur && cur.config === json) return { version: cur.version, changed: false };
      const version = (cur?.version ?? 0) + 1;
      db.system.insert('tenant_configs', { tenant_id: tenantId, version, config: json, actor, created_at: ctx.clock.nowIso() });
      ctx.audit.record(tenantId, { actor, action: 'tenant.config.put', entityType: 'tenant', entityId: tenantId, details: { version } });
      return { version, changed: true };
    },
    /** Load tenants/*.json (tenant id = config.id or file name). */
    loadDir() {
      if (!fs.existsSync(tenantsDir)) return [];
      const loaded = [];
      for (const f of fs.readdirSync(tenantsDir).filter((n) => n.endsWith('.json')).sort()) {
        const config = JSON.parse(fs.readFileSync(path.join(tenantsDir, f), 'utf8'));
        const id = config.id ?? path.basename(f, '.json');
        api.put(id, config, 'boot');
        loaded.push(id);
      }
      return loaded;
    },
  };
  return api;
}
