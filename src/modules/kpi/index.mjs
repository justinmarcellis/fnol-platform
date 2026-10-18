// KPI module (REQ-23): read-only operational KPIs per tenant, tied to value drivers.
import { createService } from './service.mjs';
import { registerRoutes } from './routes.mjs';

export { METRIC_DEFS, computeMetrics, median, ratio } from './metrics.mjs';

export default {
  name: 'kpi',
  migrations: [],

  /** Mounted at ctx.modules.kpi (tenant-bound per ctx.forTenant). */
  service: (ctx) => createService(ctx),

  routes(router) {
    registerRoutes(router);
  },

  subscribe() {
    // Read-only: consumes nothing, publishes nothing.
  },
};
