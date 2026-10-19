// Module entry (the core loader looks for index.mjs). Implementation lives in the .js files.
import { createService, validateTenantConfig } from './service.js';
import { registerRoutes } from './routes.js';

export { validate, fileResolver } from './validator.js';
export { validateTenantConfig, changedSections, changedKeys, channelForCaller, humanizeActor, LIFECYCLE_STATES } from './service.js';

const CONFIG_KEYS = ['tenantId', 'lobs', 'questionSets', 'rules', 'queues', 'timers', 'branding', 'ai'];

export default {
  name: 'config',
  migrations: [], // tenant_configs is owned by core (ctx.tenants)

  /** Tenant-bound instances come from ctx.forTenant(id).modules.config. */
  service(ctx) {
    // Register once, from the root-context instance only.
    if (!ctx.tenant) {
      ctx.tenants.addValidator((config) => {
        // Bare stubs ({ id, displayName }) predate the full schema; leave them to core.
        if (!CONFIG_KEYS.some((k) => k in config)) return [];
        const report = validateTenantConfig(config, { rules: ctx.modules?.rules });
        return report.errors.map((e) => `${e.path}: ${e.message}`);
      });
    }
    return createService(ctx);
  },

  routes(router) {
    registerRoutes(router);
  },
};
