import crypto from 'node:crypto';
import { HttpError, unauthorized, forbidden, badRequest } from './errors.mjs';

// tenant_admin and auditor come from openapi x-roles; carrier_admin is kept as tenant_admin's original name.
export const ROLES = ['claimant', 'agent', 'csr', 'adjuster', 'supervisor', 'carrier_admin', 'tenant_admin', 'auditor', 'platform_admin', 'integration'];

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * HMAC-SHA256 signed dev tokens (JWT-shaped) and request authentication.
 * @param {object} ctx needs ctx.crypto, ctx.clock, ctx.tenants, ctx.config.devMode
 */
export function createAuth(ctx) {
  const secret = () => ctx.crypto.deriveKey('_system', 'token-signing');
  const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

  const auth = {
    ROLES,
    /**
     * Issue a signed token.
     * @param {{ sub: string, tenantId: string, roles: string[], name?: string, ttlSeconds?: number }} c
     * @returns {string}
     */
    issueToken({ sub, tenantId, roles, name, ttlSeconds = 8 * 3600 }) {
      const bad = (roles ?? []).filter((r) => !ROLES.includes(r));
      if (!sub || !tenantId || !Array.isArray(roles) || !roles.length || bad.length) {
        throw badRequest(`sub, tenantId and roles (${ROLES.join(', ')}) are required`);
      }
      const exp = Math.floor(ctx.clock.now().getTime() / 1000) + ttlSeconds;
      const head = enc({ alg: 'HS256', typ: 'JWT' });
      const body = enc({ sub, tenantId, roles, name: name ?? sub, exp });
      return `${head}.${body}.${sign(`${head}.${body}`)}`;
    },
    /** Verify signature and expiry. @returns {object} claims. Throws 401 HttpError. */
    verifyToken(token) {
      const parts = String(token).split('.');
      if (parts.length !== 3) throw unauthorized('Malformed token', 'invalid_token');
      const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
      const given = Buffer.from(parts[2]);
      if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        throw unauthorized('Invalid token signature', 'invalid_token');
      }
      let claims;
      try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw unauthorized('Malformed token', 'invalid_token'); }
      if (typeof claims.exp !== 'number' || claims.exp * 1000 <= ctx.clock.now().getTime()) {
        throw unauthorized('Token expired', 'token_expired');
      }
      return claims;
    },
    /**
     * Resolve req.user and req.tenant from the Bearer token (platform_admin may use X-Tenant-Id).
     * @returns {void}
     */
    authenticate(req) {
      const h = req.headers.authorization ?? '';
      const m = /^Bearer\s+(.+)$/i.exec(h);
      if (!m) throw unauthorized();
      const c = auth.verifyToken(m[1]);
      req.user = { sub: c.sub, tenantId: c.tenantId, roles: c.roles ?? [], name: c.name };
      let tenantId = c.tenantId;
      const override = req.headers['x-tenant-id'];
      if (override && override !== tenantId) {
        if (!req.user.roles.includes('platform_admin')) throw forbidden('X-Tenant-Id requires platform_admin', 'tenant_mismatch');
        tenantId = String(override);
      }
      req.tenant = { id: tenantId, config: ctx.tenants.get(tenantId) };
    },
    /** True if user holds any of the roles (platform_admin always passes). */
    hasRole(user, roles) {
      if (!roles || !roles.length) return true;
      return user.roles.includes('platform_admin') || roles.some((r) => user.roles.includes(r));
    },
    /** Throws 403 unless the user holds one of the roles. */
    requireRole(user, roles) {
      if (!auth.hasRole(user, roles)) throw forbidden(`Requires role: ${roles.join(' or ')}`, 'role_denied');
    },
  };
  return auth;
}

/** POST /api/v1/auth/token (public, dev mode only). */
export function registerAuthRoutes(router, ctx) {
  router.post('/api/v1/auth/token', (req, res) => {
    if (!ctx.config.devMode) throw new HttpError(404, 'not_found', 'Not found');
    // openapi names the fields userId/displayName; sub/name are accepted too.
    const b = req.body ?? {};
    const sub = b.userId ?? b.sub;
    const name = b.displayName ?? b.name;
    const token = ctx.auth.issueToken({ tenantId: b.tenantId, sub, roles: b.roles, name });
    const claims = ctx.auth.verifyToken(token);
    res.json(201, {
      token, tokenType: 'Bearer', expiresAt: new Date(claims.exp * 1000).toISOString(),
      principal: { userId: claims.sub, tenantId: claims.tenantId, roles: claims.roles, displayName: claims.name },
      claims,
    });
  }, { public: true });
}
