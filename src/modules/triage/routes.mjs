// HTTP routes, matching architecture/contracts/openapi.yaml (triage tag). Roles from x-roles.
export function registerRoutes(router) {
  router.post('/api/v1/claims/:claimId/triage', async (req, res) => {
    const force = req.body?.force === true;
    const out = await req.ctx.modules.triage.runTriage(req.params.claimId, { force, actor: req.user.sub });
    res.json(200, out);
  }, { roles: ['adjuster', 'supervisor'] });

  router.get('/api/v1/claims/:claimId/triage', async (req, res) => {
    const svc = req.ctx.modules.triage;
    if (req.query.history === 'true') {
      res.json(200, { items: await svc.listTriage(req.params.claimId) });
      return;
    }
    const latest = await svc.getLatestTriage(req.params.claimId);
    if (!latest) throw new req.ctx.AppError('not_found', 'No triage result for this claim', 404);
    res.json(200, latest);
  }, { roles: ['adjuster', 'supervisor', 'auditor', 'csr'] });
}
