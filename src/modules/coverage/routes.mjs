import { viewSnapshot } from './redact.mjs';
// HTTP routes, matching architecture/contracts/openapi.yaml (coverage tag).
const READ = ['csr', 'adjuster', 'supervisor', 'integration'];

const SEARCH = ['csr', 'agent', 'adjuster', 'supervisor'];

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
    res.json(200, { verification, policy: viewSnapshot(req.user, policy) });
  }, { roles: [...READ, 'auditor'] });

  // Free-text policy search: ?q= is a VIN, phone, postal code, policy-number prefix or last name.
  router.get('/api/v1/policies', async (req, res) => {
    const q = Array.isArray(req.query.q) ? req.query.q[0] : req.query.q;
    const { kind, items } = await req.ctx.modules.coverage.searchByQuery(q);
    res.json(200, { items, matchedOn: kind });
  }, { roles: SEARCH });

  router.get('/api/v1/policies/:policyNumber/snapshot', async (req, res) => {
    const snap = await req.ctx.modules.coverage.getPolicySnapshot({ policyNumber: req.params.policyNumber, asOf: req.query.asOf });
    res.json(200, viewSnapshot(req.user, snap));
  }, { roles: READ });
}
