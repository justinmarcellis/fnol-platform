// HTTP routes, matching architecture/contracts/openapi.yaml (coverage tag).
const READ = ['csr', 'adjuster', 'supervisor', 'integration'];

export function registerRoutes(router) {
  router.post('/api/v1/claims/:claimId/coverage/verify', async (req, res) => {
    const out = await req.ctx.modules.coverage.verifyCoverage(req.params.claimId, { actor: req.user.sub });
    res.json(200, out);
  }, { roles: READ });

  router.get('/api/v1/claims/:claimId/coverage', async (req, res) => {
    const cov = req.ctx.modules.coverage;
    const verification = await cov.getLatestVerification(req.params.claimId);
    if (!verification) throw new req.ctx.AppError('not_found', 'No coverage verification for this claim', 404);
    const policy = verification.policySnapshotId ? await cov.getSnapshotById(verification.policySnapshotId) : null;
    res.json(200, { verification, policy });
  }, { roles: [...READ, 'auditor'] });

  router.get('/api/v1/policies/:policyNumber/snapshot', async (req, res) => {
    const snap = await req.ctx.modules.coverage.getPolicySnapshot({ policyNumber: req.params.policyNumber, asOf: req.query.asOf });
    res.json(200, snap);
  }, { roles: READ });
}
