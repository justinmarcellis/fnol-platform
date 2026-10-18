// HTTP routes, matching architecture/contracts/openapi.yaml (claims tag).
const BASE = '/api/v1/claims';
const PII_ROLES = ['csr', 'adjuster', 'supervisor', 'carrier_admin', 'platform_admin'];
const READ = ['csr', 'adjuster', 'supervisor', 'auditor', 'integration'];
const STATUS_TARGETS = ['in_review', 'pending_info', 'closed', 'withdrawn'];

const actorOf = (req) => ({ type: req.user.roles.includes('integration') ? 'integration' : 'user', id: req.user.sub, role: req.user.roles[0], roles: req.user.roles });
const canSeePii = (req) => req.user.roles.some((r) => PII_ROLES.includes(r));
const claims = (req) => req.ctx.modules.claims;
const etag = (res, claim) => res.setHeader('ETag', `"${claim.version}"`);

function expectedVersion(req) {
  const h = req.headers['if-match'];
  if (h === undefined) return undefined;
  const v = Number(String(h).replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(v)) throw new req.ctx.AppError('bad_request', 'If-Match must be a claim version', 400);
  return v;
}

export function registerRoutes(router) {
  router.post(BASE, async (req, res) => {
    const key = req.headers['idempotency-key'];
    const claim = await claims(req).createClaim(req.body, { actor: actorOf(req), idempotencyKey: key ? String(key).slice(0, 128) : undefined });
    const out = canSeePii(req) ? claim : await claims(req).getClaim(claim.id, { include: ['parties', 'vehicles', 'properties'], redact: true });
    res.setHeader('Location', `/api/v1/claims/${claim.id}`);
    etag(res, claim);
    res.json(201, out);
  }, { roles: ['integration', 'csr'] });

  router.get(BASE, async (req, res) => {
    const { limit, cursor, ...filter } = req.query;
    const page = await claims(req).listClaims({ ...filter, redact: !canSeePii(req) }, { limit, cursor });
    res.json(200, page);
  }, { roles: READ });

  router.get(`${BASE}/:claimId`, async (req, res) => {
    const include = [].concat(req.query.include ?? []).flatMap((s) => String(s).split(','));
    const claim = await claims(req).getClaim(req.params.claimId, { include, redact: !canSeePii(req) });
    etag(res, claim);
    res.json(200, claim);
  }, { roles: ['claimant', ...READ] });

  router.post(`${BASE}/:claimId/status`, async (req, res) => {
    const b = req.body ?? {};
    if (!STATUS_TARGETS.includes(b.to)) throw new req.ctx.AppError('validation_failed', `to must be one of ${STATUS_TARGETS.join(', ')}`, 422);
    const claim = await claims(req).changeStatus(req.params.claimId, {
      to: b.to, reason: b.reason, closeReason: b.closeReason, expectedVersion: expectedVersion(req), actor: actorOf(req),
    });
    etag(res, claim);
    res.json(200, canSeePii(req) ? claim : await claims(req).getClaim(claim.id, { redact: true }));
  }, { roles: ['adjuster', 'supervisor', 'csr'] });

  router.get(`${BASE}/:claimId/notes`, async (req, res) => {
    res.json(200, { items: await claims(req).listNotes(req.params.claimId, { redact: !canSeePii(req) }) });
  }, { roles: ['csr', 'adjuster', 'supervisor', 'auditor'] });

  router.post(`${BASE}/:claimId/notes`, async (req, res) => {
    res.json(201, await claims(req).addNote(req.params.claimId, req.body ?? {}, { actor: actorOf(req) }));
  }, { roles: ['csr', 'adjuster', 'supervisor'] });

  router.get(`${BASE}/:claimId/tasks`, async (req, res) => {
    res.json(200, { items: await claims(req).listTasks(req.params.claimId) });
  }, { roles: ['csr', 'adjuster', 'supervisor', 'auditor'] });

  router.patch(`${BASE}/:claimId/tasks/:taskId`, async (req, res) => {
    const { status, assigneeId } = req.body ?? {};
    res.json(200, await claims(req).updateTask(req.params.claimId, req.params.taskId, { status, assigneeId }, { actor: actorOf(req) }));
  }, { roles: ['adjuster', 'supervisor'] });

  router.get(`${BASE}/:claimId/timers`, async (req, res) => {
    res.json(200, { items: await claims(req).listTimers(req.params.claimId) });
  }, { roles: ['csr', 'adjuster', 'supervisor', 'auditor'] });
}
