// HTTP routes matching architecture/contracts/openapi.yaml (config tag).
// Roles: the contract names tenant_admin and auditor; core issues carrier_admin, so both are accepted.
const READ = ['tenant_admin', 'carrier_admin', 'supervisor', 'auditor'];
const WRITE = ['tenant_admin', 'carrier_admin'];
const PUBLIC = ['claimant', 'agent', 'csr', 'adjuster', 'supervisor', 'tenant_admin', 'carrier_admin', 'integration', 'auditor'];

const parseIfMatch = (h) => {
  if (h == null || h === '') return undefined;
  const n = Number(String(h).replace(/^W\//, '').replace(/"/g, ''));
  return Number.isInteger(n) ? n : NaN;
};

export function registerRoutes(router) {
  router.get('/api/v1/config', (req, res) => {
    const cfg = req.ctx.modules.config.getTenantConfig();
    res.setHeader('ETag', `"${cfg.version}"`);
    res.json(200, cfg);
  }, { roles: READ });

  router.put('/api/v1/config', (req, res) => {
    const expected = parseIfMatch(req.headers?.['if-match']);
    if (Number.isNaN(expected)) throw new req.ctx.AppError('bad_request', 'If-Match must be the numeric config version', 400);
    try {
      const saved = req.ctx.modules.config.putTenantConfig(req.body, { expectedVersion: expected, actor: req.user.sub });
      res.setHeader('ETag', `"${saved.version}"`);
      res.json(200, saved);
    } catch (e) {
      if (e.report) return res.json(422, e.report);
      throw e;
    }
  }, { roles: WRITE });

  router.post('/api/v1/config/validate', (req, res) => {
    res.json(200, req.ctx.modules.config.validateTenantConfig(req.body));
  }, { roles: WRITE });

  router.get('/api/v1/config/public', (req, res) => {
    res.json(200, req.ctx.modules.config.getPublicConfig());
  }, { roles: PUBLIC });
}
