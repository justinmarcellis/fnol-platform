import { migrations } from './schema.mjs';
import { createService } from './service.mjs';
import { registerRoutes } from './routes.mjs';

export { deterministicIndicators, mergeFraud } from './fraud.mjs';
export { buildTriageFacts } from './facts.mjs';

export default {
  name: 'triage',
  migrations,

  /** Mounted at ctx.modules.triage (tenant-bound per ctx.forTenant). */
  service: (ctx) => createService(ctx),

  routes(router) {
    registerRoutes(router);
  },

  subscribe(bus, ctx) {
    const tctxOf = (evt, tctx) => tctx ?? ctx.forTenant(evt.tenantid ?? evt.tenantId);
    // claim.triaged is deliberately not consumed here (no retrigger loop).
    bus.on('claim.coverage.verified', async (evt, tctx) => {
      await tctxOf(evt, tctx).modules.triage.onEvent('coverage', evt);
    }, { name: 'triage:claim.coverage.verified' });
    bus.on('claim.evidence.extracted', async (evt, tctx) => {
      await tctxOf(evt, tctx).modules.triage.onEvent('evidence', evt);
    }, { name: 'triage:claim.evidence.extracted' });
  },
};
