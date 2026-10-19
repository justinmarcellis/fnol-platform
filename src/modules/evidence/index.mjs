import { migrations } from './schema.mjs';
import { createService } from './service.mjs';
import { registerRoutes } from './routes.mjs';

export { parseMultipart, extractPdfText, detectKind, sniffContentType } from './parse.mjs';

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
    // A missing claim or document is logged and skipped, never thrown (a retry cannot fix it).
    bus.on('claim.evidence.added', async (evt, tctx) => {
      const t = tctx ?? ctx.forTenant(evt.tenantid ?? evt.tenantId);
      const { claimId, documentId } = evt?.data ?? {};
      if (!claimId || !documentId) { t.log?.warn?.('evidence handler: event missing claimId/documentId', { eventId: evt?.id }); return; }
      if (!t.ai) return; // no AI configured: stays pending
      try {
        if ('claims' in t.modules) await t.modules.claims.getClaim(claimId);
        await t.modules.evidence.extract(documentId);
      } catch (e) {
        if (e?.status !== 404 && e?.code !== 'not_found') throw e; // transient: let the bus retry
        t.log?.warn?.('evidence handler: claim or document not found; skipped', { claimId, documentId });
      }
    }, { name: 'evidence:claim.evidence.added' });
  },
};
