import { migrations } from './schema.mjs';
import { createService } from './service.mjs';
import { registerRoutes } from './routes.mjs';

export { evaluateCoverage } from './verify.mjs';
export { policies as fixturePolicies } from './fixtures.mjs';

export default {
  name: 'coverage',
  migrations,

  /** Mounted at ctx.modules.coverage (tenant-bound per ctx.forTenant). */
  service: (ctx) => createService(ctx),

  routes(router) {
    registerRoutes(router);
  },

  subscribe(bus, ctx) {
    // claim.reported -> verifyCoverage once. Named handler dedupes on evt.id in core;
    // verifyCoverage also dedupes on source_event_id so replays are no-ops.
    bus.on('claim.reported', async (evt, tctx) => {
      const t = tctx ?? ctx.forTenant(evt.tenantid ?? evt.tenantId);
      await t.modules.coverage.verifyCoverage(evt.data.claimId, { sourceEventId: evt.id });
    }, { name: 'coverage:claim.reported' });
  },
};
