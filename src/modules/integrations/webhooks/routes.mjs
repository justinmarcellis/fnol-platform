import { listOutbox } from './outbox.mjs';
import { KNOWN_EVENT_TYPES } from './service.mjs';

const ADMIN = ['tenant_admin', 'carrier_admin'];
const OUTBOX_ROLES = [...ADMIN, 'auditor', 'integration'];
const BASE = '/api/v1/integrations';

const actorOf = (req) => ({ type: 'user', id: req.user.sub, role: req.user.roles[0] });
const svc = (req) => req.ctx.modules.integrations;

/**
 * Register webhook subscription, delivery and outbox routes.
 * Roles follow openapi x-roles; carrier_admin is the runtime name for the contract's tenant_admin.
 * @param {object} router core router
 */
export function registerWebhookRoutes(router) {
  router.get(`${BASE}/webhooks`, async (req, res) => {
    res.json(200, { items: await svc(req).listSubscriptions() });
  }, { roles: ADMIN });

  router.post(`${BASE}/webhooks`, async (req, res) => {
    res.json(201, await svc(req).createSubscription(req.body, { actor: actorOf(req) }));
  }, { roles: ADMIN });

  // Event types a subscription may name, so the admin UI can offer them as choices (ADMIN-15).
  router.get(`${BASE}/event-types`, async (req, res) => {
    res.json(200, { items: [...KNOWN_EVENT_TYPES], wildcard: '*' });
  }, { roles: ADMIN });

  router.get(`${BASE}/webhooks/:webhookId`, async (req, res) => {
    res.json(200, await svc(req).getSubscription(req.params.webhookId));
  }, { roles: ADMIN });

  router.patch(`${BASE}/webhooks/:webhookId`, async (req, res) => {
    res.json(200, await svc(req).updateSubscription(req.params.webhookId, req.body, { actor: actorOf(req) }));
  }, { roles: ADMIN });

  router.delete(`${BASE}/webhooks/:webhookId`, async (req, res) => {
    await svc(req).deleteSubscription(req.params.webhookId, { actor: actorOf(req) });
    res.writeHead(204);
    res.end();
  }, { roles: ADMIN });

  router.get(`${BASE}/webhooks/:webhookId/deliveries`, async (req, res) => {
    const { limit, cursor } = req.query;
    res.json(200, await svc(req).listDeliveries(req.params.webhookId, { limit, cursor }));
  }, { roles: ADMIN });

  router.get(`${BASE}/outbox`, async (req, res) => {
    const { type, subject, afterSequence, limit } = req.query;
    res.json(200, await svc(req).listOutbox({ type, subject, afterSequence, limit }));
  }, { roles: OUTBOX_ROLES });
}

export { listOutbox };
