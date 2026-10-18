import { migrations } from './schema.mjs';
import { createService } from './service.mjs';
import { registerRoutes } from './routes.mjs';

export { parseMultipart, extractPdfText, detectKind } from './parse.mjs';

export default {
  name: 'evidence',
  migrations,

  /** Mounted at ctx.modules.evidence (tenant-bound per ctx.forTenant). */
  service: (ctx) => createService(ctx),

  routes(router) {
    registerRoutes(router);
  },

  subscribe(bus, ctx) {
    // Own event: run extraction asynchronously so upload returns fast. extract() is idempotent.
    bus.on('claim.evidence.added', async (evt, tctx) => {
      const t = tctx ?? ctx.forTenant(evt.tenantid ?? evt.tenantId);
      if (!t.ai) return; // no AI configured: stays pending
      await t.modules.evidence.extract(evt.data.documentId);
    }, { name: 'evidence:claim.evidence.added' });
  },
};
