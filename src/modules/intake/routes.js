// HTTP routes for /intake (openapi.yaml tag intake). Claimants use a no-login bearer token with role
// `claimant` and can only reach sessions they started (enforced in the service). Additive route:
// POST /intake/sessions/{id}/narrative for conversational prefill.
const ROLES = ['claimant', 'csr', 'agent', 'integration', 'carrier_admin'];
const START_KEYS = new Set(['tenantId', 'lob', 'lossType', 'channel', 'locale', 'policyNumber']);
const ROLE_ORDER = ['csr', 'agent', 'integration', 'carrier_admin', 'platform_admin', 'claimant'];

const actorOf = (req) => {
  const role = ROLE_ORDER.find((r) => (req.user.roles ?? []).includes(r)) ?? req.user.roles?.[0];
  return { type: role === 'integration' ? 'integration' : 'user', id: req.user.sub, role };
};

export function registerRoutes(router) {
  const svc = (req) => req.ctx.modules.intake;
  const bad = (req, m) => new req.ctx.AppError('bad_request', m, 400);

  router.post('/api/v1/intake/sessions', async (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad(req, 'JSON body required');
    const extra = Object.keys(b).filter((k) => !START_KEYS.has(k));
    if (extra.length) throw bad(req, `Unknown properties: ${extra.join(', ')}`);
    if (b.tenantId && b.tenantId !== req.tenant.id) throw new req.ctx.AppError('tenant_mismatch', 'tenantId does not match the token', 403);
    for (const k of ['lob', 'channel']) if (typeof b[k] !== 'string' || !b[k]) throw bad(req, `${k} is required`);
    for (const k of ['lossType', 'locale', 'policyNumber']) if (b[k] !== undefined && typeof b[k] !== 'string') throw bad(req, `${k} must be a string`);
    const step = await svc(req).startSession({ lob: b.lob, lossType: b.lossType, channel: b.channel, locale: b.locale, policyNumber: b.policyNumber, actor: actorOf(req) });
    res.json(201, step);
  }, { roles: ROLES });

  router.get('/api/v1/intake/sessions/:sessionId', async (req, res) => {
    res.json(200, await svc(req).getSession(req.params.sessionId, { actor: actorOf(req) }));
  }, { roles: ROLES });

  router.get('/api/v1/intake/sessions/:sessionId/next-question', async (req, res) => {
    res.json(200, await svc(req).nextQuestion(req.params.sessionId, { actor: actorOf(req) }));
  }, { roles: ROLES });

  router.post('/api/v1/intake/sessions/:sessionId/answers', async (req, res) => {
    const b = req.body;
    if (!b || typeof b !== 'object') throw bad(req, 'JSON body required');
    let items;
    if (Array.isArray(b.answers)) items = b.answers;
    else if (typeof b.questionId === 'string') items = [{ questionId: b.questionId, value: b.value, provenance: b.provenance }];
    else throw bad(req, 'Provide questionId and value, or answers[]');
    if (items.some((i) => !i || typeof i !== 'object' || typeof i.questionId !== 'string' || !('value' in i))) throw bad(req, 'Each answer needs questionId and value');
    const step = await svc(req).answer(req.params.sessionId, items.map((i) => ({ questionId: i.questionId, value: i.value, provenance: i.provenance })), { actor: actorOf(req) });
    if (step.errors?.length) {
      res.json(422, { error: { code: 'validation_failed', message: `${step.errors.length} answer(s) were not accepted` }, ...step });
      return;
    }
    res.json(200, step);
  }, { roles: ROLES });

  router.post('/api/v1/intake/sessions/:sessionId/narrative', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string') throw bad(req, 'text is required');
    res.json(200, await svc(req).narrative(req.params.sessionId, text, { actor: actorOf(req) }));
  }, { roles: ROLES });

  router.post('/api/v1/intake/sessions/:sessionId/submit', async (req, res) => {
    const key = req.headers?.['idempotency-key'];
    const claim = await svc(req).submit(req.params.sessionId, { actor: actorOf(req), idempotencyKey: typeof key === 'string' && key ? key : undefined });
    res.json(201, claim);
  }, { roles: ROLES });
}
