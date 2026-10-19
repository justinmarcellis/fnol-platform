// HTTP routes, matching architecture/contracts/openapi.yaml (claims tag).
import { isStaff, ownsClaim, viewFor } from './projection.mjs';

const BASE = '/api/v1/claims';
const PII_ROLES = ['csr', 'adjuster', 'supervisor', 'carrier_admin', 'platform_admin'];
const READ = ['csr', 'adjuster', 'supervisor', 'auditor', 'integration'];
const STATUS_TARGETS = ['in_review', 'pending_info', 'closed', 'withdrawn'];

const actorOf = (req) => ({ type: req.user.roles.includes('integration') ? 'integration' : 'user', id: req.user.sub, role: req.user.roles[0], roles: req.user.roles });
const canSeePii = (req) => req.user.roles.some((r) => PII_ROLES.includes(r));
const claims = (req) => req.ctx.modules.claims;
// ClaimCreate (openapi.yaml) is additionalProperties:false and defines no `answers`; unknown properties are rejected, never dropped.
const CLAIM_CREATE_KEYS = new Set(['tenantId', 'lob', 'lossType', 'channel', 'policyNumber', 'riskState', 'lossEvent', 'parties', 'vehicles', 'properties', 'externalRef']);
const REASON_CODE = /^[a-z][a-z0-9_]{1,39}$/;
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
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new req.ctx.AppError('bad_request', 'Claim body must be a JSON object', 400);
    const unknown = Object.keys(body).filter((k) => !CLAIM_CREATE_KEYS.has(k));
    if (unknown.length) throw new req.ctx.AppError('bad_request', `Unknown propert${unknown.length > 1 ? 'ies' : 'y'} not allowed in ClaimCreate: ${unknown.slice(0, 10).join(', ')}`, 400);
    const claim = await claims(req).createClaim(body, { actor: actorOf(req), idempotencyKey: key ? String(key).slice(0, 128) : undefined });
    const out = viewFor(req.user, canSeePii(req) ? claim : await claims(req).getClaim(claim.id, { include: ['parties', 'vehicles', 'properties'], redact: true }));
    res.setHeader('Location', `/api/v1/claims/${claim.id}`);
    etag(res, claim);
    res.json(201, out);
  }, { roles: ['integration', 'csr'] });

  router.get(BASE, async (req, res) => {
    const { limit, cursor, ...filter } = req.query;
    const staff = isStaff(req.user);
    const page = await claims(req).listClaims({ ...filter, redact: !canSeePii(req), ...(staff ? {} : { reportedById: req.user.sub }) }, { limit, cursor });
    res.json(200, staff ? page : { ...page, items: page.items.map((c) => viewFor(req.user, c)) });
  }, { roles: READ });

  router.get(`${BASE}/:claimId`, async (req, res) => {
    const include = [].concat(req.query.include ?? []).flatMap((s) => String(s).split(','));
    const claim = await claims(req).getClaim(req.params.claimId, { include, redact: !canSeePii(req) });
    // Non-staff read only their own claims; a foreign id is indistinguishable from a missing one.
    if (!isStaff(req.user) && !ownsClaim(claim, req.user)) throw new req.ctx.AppError('not_found', 'Claim not found', 404);
    etag(res, claim);
    res.json(200, viewFor(req.user, claim));
  }, { roles: ['claimant', ...READ] });

  router.post(`${BASE}/:claimId/status`, async (req, res) => {
    const b = req.body ?? {};
    if (!STATUS_TARGETS.includes(b.to)) throw new req.ctx.AppError('validation_failed', `to must be one of ${STATUS_TARGETS.join(', ')}`, 422);
    const claim = await claims(req).changeStatus(req.params.claimId, {
      to: b.to, reason: b.reason, reasonCode: b.reasonCode, closeReason: b.closeReason, expectedVersion: expectedVersion(req), actor: actorOf(req),
    });
    etag(res, claim);
    res.json(200, viewFor(req.user, canSeePii(req) ? claim : await claims(req).getClaim(claim.id, { redact: true })));
  }, { roles: ['adjuster', 'supervisor', 'csr'] });

  router.get(`${BASE}/:claimId/notes`, async (req, res) => {
    res.json(200, { items: await claims(req).listNotes(req.params.claimId, { redact: !canSeePii(req) }) });
  }, { roles: ['csr', 'adjuster', 'supervisor', 'auditor'] });

  router.post(`${BASE}/:claimId/notes`, async (req, res) => {
    // body.ai is never accepted over HTTP (SEC2-016): AI provenance is set only by the AI-assist code path.
    const { body, category, visibility } = req.body ?? {};
    res.json(201, await claims(req).addNote(req.params.claimId, { body, category, visibility }, { actor: actorOf(req) }));
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
