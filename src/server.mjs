import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './core/store.mjs';
import { createCrypto } from './core/crypto.mjs';
import { createClock } from './core/clock.mjs';
import { createLogger } from './core/log.mjs';
import { createAudit, registerAuditRoutes, migrations as auditMigrations } from './core/audit.mjs';
import { createBus, migrations as busMigrations } from './core/bus.mjs';
import { createTenants, migrations as tenantMigrations } from './core/tenants.mjs';
import { createAuth, registerAuthRoutes } from './core/auth.mjs';
import { createRouter, attachJson } from './core/router.mjs';
import { HttpError } from './core/errors.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'src', 'web');
const APPS = { '/': 'claimant', '/csr': 'csr', '/adjuster': 'adjuster', '/admin': 'admin' };
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

function fileIfExists(p) {
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

/** Resolve a URL path to a file under src/web, or null. */
function resolveStatic(webDir, pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/';
  let rel;
  try { rel = decodeURIComponent(clean); } catch { return null; }
  if (rel.includes('\0')) return null;
  const candidates = [];
  if (APPS[clean]) candidates.push(path.join(webDir, APPS[clean], 'index.html'));
  if (clean === '/') candidates.push(path.join(webDir, 'index.html'));
  candidates.push(path.join(webDir, rel));
  candidates.push(path.join(webDir, rel, 'index.html'));
  // Claimant app is served at /, so its relative assets resolve from the root as well.
  candidates.push(path.join(webDir, 'claimant', rel));
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (abs !== webDir && !abs.startsWith(webDir + path.sep)) continue;
    const f = fileIfExists(abs);
    if (f) return f;
  }
  return null;
}

/**
 * Build the app context, load modules and start the HTTP server.
 * @param {{ dbPath?: string, port?: number, secretsDir?: string, tenantsDir?: string, modulesDir?: string, webDir?: string,
 *   devMode?: boolean, logLevel?: string, clock?: object, host?: string }} [opts]
 * @returns {Promise<{ server: import('node:http').Server, ctx: object, port: number, url: string, close: () => Promise<void> }>}
 */
export async function createApp(opts = {}) {
  const dbPath = opts.dbPath ?? process.env.FNOL_DB_PATH ?? path.join(ROOT, 'data', 'fnol.db');
  const secretsDir = opts.secretsDir ?? path.join(ROOT, '.secrets');
  const tenantsDir = opts.tenantsDir ?? path.join(ROOT, 'tenants');
  const modulesDir = opts.modulesDir ?? path.join(ROOT, 'src', 'modules');
  const webDir = path.resolve(opts.webDir ?? WEB_DIR);

  const clock = opts.clock ?? createClock();
  const log = createLogger({ level: opts.logLevel, clock });
  const ctx = {
    config: { devMode: opts.devMode ?? process.env.NODE_ENV !== 'production', dbPath, secretsDir, tenantsDir },
    clock, log, modules: {}, moduleNames: [], ai: null, HttpError,
  };
  ctx.db = createStore(dbPath);
  ctx.crypto = createCrypto({ secretsDir });

  // Core migrations first, then each module's.
  ctx.db.migrate('core.audit', auditMigrations);
  ctx.db.migrate('core.bus', busMigrations);
  ctx.db.migrate('core.tenants', tenantMigrations);
  ctx.audit = createAudit(ctx);
  ctx.bus = createBus(ctx);
  ctx.tenants = createTenants(ctx, { tenantsDir });
  ctx.auth = createAuth(ctx);
  ctx.router = createRouter({ auth: ctx.auth, log });

  // Optional AI cascade from src/ai (owned by the AI team); absent in the core runtime.
  const aiEntry = path.join(ROOT, 'src', 'ai', 'index.mjs');
  if (fs.existsSync(aiEntry)) {
    try {
      const mod = await import(pathToFileURL(aiEntry).href);
      if (typeof mod.createAi === 'function') ctx.ai = await mod.createAi(ctx);
    } catch (e) { log.warn('ai layer failed to load', { error: e.message }); }
  }

  // Load modules (sorted) per ADR-001.
  const loaded = [];
  if (fs.existsSync(modulesDir)) {
    for (const dir of fs.readdirSync(modulesDir).sort()) {
      const entry = path.join(modulesDir, dir, 'index.mjs');
      if (!fileIfExists(entry)) continue;
      const mod = (await import(pathToFileURL(entry).href)).default;
      if (!mod?.name) throw new Error(`Module ${dir} must export a default object with a name`);
      loaded.push(mod);
    }
  }
  ctx.moduleNames = loaded.map((m) => m.name);
  for (const mod of loaded) ctx.db.migrate(mod.name, mod.migrations ?? []);
  ctx.tenants.loadDir();
  registerAuthRoutes(ctx.router, ctx);
  registerAuditRoutes(ctx.router, ctx);
  for (const mod of loaded) {
    // modules.md names the hook service(ctx); init(ctx) is the original name, both work
    const factory = mod.service ?? mod.init;
    if (typeof factory === 'function') {
      const svc = await factory(ctx);
      if (svc) ctx.modules[mod.name] = svc;
    }
  }
  for (const mod of loaded) {
    mod.routes?.(ctx.router, ctx);
    mod.subscribe?.(ctx.bus, ctx);
  }
  ctx.bus.recover(ctx.tenants.list());

  const server = http.createServer(async (req, res) => {
    try {
      attachJson(res);
      if (await ctx.router.handle(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        const file = resolveStatic(webDir, url.pathname);
        if (file) {
          const body = fs.readFileSync(file);
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'content-length': body.length });
          res.end(req.method === 'HEAD' ? undefined : body);
          return;
        }
      }
      ctx.router.sendError(res, new HttpError(404, 'not_found', 'Not found'));
    } catch (e) {
      ctx.router.sendError(res, e);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8080, opts.host ?? '127.0.0.1', resolve);
  });
  const port = server.address().port;

  return {
    server, ctx, port, url: `http://127.0.0.1:${port}`,
    async close() {
      await ctx.bus.drain();
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
      ctx.db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp({ port: Number(process.env.PORT || 8080) });
  console.log(`FNOL platform listening on ${app.url}`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
}
