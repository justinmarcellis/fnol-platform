// HTTP routes matching architecture/contracts/openapi.yaml (routing tag).
// platform_admin passes every role check in core. carrier_admin may read routing but not write it (S3-WFL-02).
const WRITE = ['supervisor', 'adjuster'];
const READ = ['csr', 'adjuster', 'supervisor', 'auditor', 'carrier_admin'];
const OVERRIDE_ROLES = ['supervisor', 'carrier_admin', 'platform_admin'];

export function registerRoutes(router) {
  router.post('/api/v1/claims/:claimId/routing', async (req, res) => {
    const roles = req.user.roles ?? [];
    const role = roles.find((r) => OVERRIDE_ROLES.includes(r)) ?? roles[0];
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const decision = await req.ctx.modules.rules.route(req.params.claimId, {
      override: body.override,
      actor: { type: 'user', id: req.user.sub, role },
    });
    res.json(200, decision);
  }, { roles: WRITE });

  router.get('/api/v1/claims/:claimId/routing', async (req, res) => {
    const rules = req.ctx.modules.rules;
    const decision = await rules.getRoutingDecision(req.params.claimId);
    if (!decision) throw new req.ctx.AppError('not_found', 'No routing decision for this claim', 404);
    res.json(200, decision);
  }, { roles: READ });
}
