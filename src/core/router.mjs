import { HttpError, badRequest, notFound } from './errors.mjs';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
export const BODY_LIMIT = 15 * 1024 * 1024;

function compile(pattern) {
  const names = [];
  const re = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { names, re: new RegExp(`^${re}/?$`) };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'payload_too_large', 'Request body exceeds 15MB')); req.pause(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Add res.json(status, body) to a response. */
export function attachJson(res) {
  res.json = (status, body) => {
    if (res.headersSent) return;
    const data = JSON.stringify(body ?? null);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  };
}

/**
 * Minimal router. Handlers are (req, res); res.json(status, body) is available.
 * @param {{ auth: object, log?: object, limit?: number }} deps
 */
export function createRouter({ auth, log, limit = BODY_LIMIT, bindTenant = null }) {
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    routes.push({ method, pattern, handler, opts, ...compile(pattern) });
  };
  const router = {
    get: (p, h, o) => add('GET', p, h, o),
    post: (p, h, o) => add('POST', p, h, o),
    put: (p, h, o) => add('PUT', p, h, o),
    patch: (p, h, o) => add('PATCH', p, h, o),
    delete: (p, h, o) => add('DELETE', p, h, o),
    routes,
    /** Find a route. @returns {{route: object, params: object}|null} */
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = route.re.exec(pathname);
        if (m) {
          const params = {};
          route.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
          return { route, params };
        }
      }
      return null;
    },
    /**
     * Handle a request. @returns {Promise<boolean>} false if no route matched (caller falls through).
     */
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost');
      attachJson(res);
      const found = router.match(req.method, url.pathname);
      if (!found) return false;
      req.params = found.params;
      req.path = url.pathname;
      req.query = {};
      for (const [k, v] of url.searchParams) {
        req.query[k] = k in req.query ? [].concat(req.query[k], v) : v;
      }
      try {
        const { opts } = found.route;
        if (!opts.public) {
          auth.authenticate(req);
          auth.requireRole(req.user, opts.roles);
          // Tenant-bound context for module code (modules.md rule 3).
          if (bindTenant && req.tenant?.id) req.ctx = bindTenant(req.tenant.id);
        }
        req.body = undefined;
        if (BODY_METHODS.has(req.method)) {
          const buf = await readBody(req, limit);
          req.rawBody = buf;
          // Binary uploads keep only rawBody; everything else must be JSON.
          const type = String(req.headers['content-type'] ?? '');
          if (buf.length && !/^(multipart\/|application\/octet-stream|application\/pdf|image\/|video\/)/.test(type)) {
            try { req.body = JSON.parse(buf.toString('utf8')); } catch { throw badRequest('Invalid JSON body', 'invalid_json'); }
          }
        }
        await found.route.handler(req, res);
      } catch (e) {
        router.sendError(res, e);
      }
      return true;
    },
    /** Write the standard error envelope. */
    sendError(res, e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) log?.error('request failed', { error: e?.message, stack: e?.stack });
      res.json(status, { error: { code: e.code ?? 'internal_error', message: status >= 500 && !(e instanceof HttpError) ? 'Internal server error' : e.message } });
    },
    notFound: (res) => router.sendError(res, notFound()),
  };
  return router;
}
