import { registerWebhookRoutes } from './webhooks/routes.mjs';

const ADMIN = ['tenant_admin', 'carrier_admin'];
const BASE = '/api/v1/integrations';
const svc = (req) => req.ctx.modules.integrations;
const actorOf = (req) => ({ type: 'user', id: req.user.sub, role: req.user.roles[0] });

/**
 * Register every integrations route: webhooks + outbox, the adapter routes from openapi
 * (list / preview / push), and any extra routes the adapter service defines.
 * @param {object} router core router
 * @param {object} ctx root ctx
 * @param {{ adapterService?: () => Promise<object|null> }} [deps] lazy accessor for the (optional) adapter service
 */
export function registerRoutes(router, ctx, deps = {}) {
  registerWebhookRoutes(router);

  router.get(`${BASE}/adapters`, async (req, res) => {
    res.json(200, { items: await svc(req).listAdapters() });
  }, { roles: [...ADMIN, 'supervisor'] });

  router.get(`${BASE}/adapters/:adapterId/preview/:claimId`, async (req, res) => {
    res.json(200, await svc(req).previewMapping(req.params.adapterId, req.params.claimId));
  }, { roles: [...ADMIN, 'supervisor', 'adjuster'] });

  router.post(`${BASE}/adapters/:adapterId/push/:claimId`, async (req, res) => {
    res.json(202, await svc(req).pushClaim(req.params.adapterId, req.params.claimId, { actor: actorOf(req) }));
  }, { roles: [...ADMIN, 'supervisor'] });

  // Extra routes defined by the adapter service (for example the fake core receiver).
  // The service may be created asynchronously, so register once it resolves.
  Promise.resolve(deps.adapterService?.()).then((adapters) => {
    if (!adapters?.routes) return;
    if (typeof adapters.routes === 'function') {
      adapters.routes(router, ctx);
      return;
    }
    for (const def of adapters.routes) {
      const method = String(def.method ?? 'get').toLowerCase();
      const opts = def.opts ?? { roles: def.roles, public: def.public };
      router[method](def.path ?? def.pattern, def.handler, opts);
    }
  }).catch((e) => ctx.log.warn('adapter routes failed to register', { error: e?.message }));
}
