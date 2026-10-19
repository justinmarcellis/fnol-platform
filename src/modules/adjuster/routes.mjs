// HTTP routes, matching architecture/contracts/openapi.yaml (adjuster tag).
const ROLES = ['adjuster', 'supervisor'];

export function registerRoutes(router) {
  router.get('/api/v1/adjuster/claims/:claimId/view', async (req, res) => {
    res.json(200, await req.ctx.modules.adjuster.getFirstView(req.params.claimId, { actor: req.user.sub }));
  }, { roles: ROLES });

  router.get('/api/v1/adjuster/inbox', async (req, res) => {
    const q = req.query ?? {};
    const mine = String(q.mine ?? 'true') !== 'false';
    const limit = q.limit === undefined ? 50 : parseInt(q.limit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new req.ctx.AppError('validation_error', 'limit must be an integer between 1 and 200', 400);
    }
    res.json(200, await req.ctx.modules.adjuster.getInbox({
      adjusterId: mine ? req.user.sub : undefined, queue: q.queue, limit, cursor: q.cursor,
    }));
  }, { roles: ROLES });
}
