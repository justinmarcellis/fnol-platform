// HTTP routes matching architecture/contracts/openapi.yaml (config tag).
// Roles: the contract names tenant_admin and auditor; core issues carrier_admin, so both are accepted.
const READ = ['tenant_admin', 'carrier_admin', 'supervisor', 'auditor'];
const WRITE = ['tenant_admin', 'carrier_admin'];
const PUBLIC = ['claimant', 'agent', 'csr', 'adjuster', 'supervisor', 'tenant_admin', 'carrier_admin', 'integration', 'auditor'];

import { channelForCaller } from './service.js';

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
      const saved = req.ctx.modules.config.putTenantConfig(req.body, { expectedVersion: expected, actor: req.user.sub, actorName: req.user.name });
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

  // Version history for the admin console: every stored version from 1 onward, newest first.
  router.get('/api/v1/config/versions', (req, res) => {
    res.json(200, req.ctx.modules.config.listVersions({ viewer: { sub: req.user?.sub, name: req.user?.name } }));
  }, { roles: READ });

  // availableLobs follows the caller's intake channel (claimant -> claimant_web), or ?channel= when it names a known channel.
  router.get('/api/v1/config/public', (req, res) => {
    const channel = channelForCaller(req.user?.roles ?? [], typeof req.query?.channel === 'string' ? req.query.channel : undefined);
    res.json(200, req.ctx.modules.config.getPublicConfig({ channel }));
  }, { roles: PUBLIC });
}
