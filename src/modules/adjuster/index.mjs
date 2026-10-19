import { migrations } from './schema.mjs';
import { createService } from './service.mjs';
import { registerRoutes } from './routes.mjs';
import { subscribeProjection } from './projection.mjs';

export default {
  name: 'adjuster',
  migrations,
  /** Mounted at ctx.modules.adjuster (tenant-bound per ctx.forTenant). */
  service: (ctx) => createService(ctx),
  routes(router) { registerRoutes(router); },
  subscribe(bus, ctx) { subscribeProjection(bus, ctx); },
};
