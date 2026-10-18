// PMO dashboard server: static files plus /api/snapshot and /api/metrics.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshot, ORG } from '../org/fabric.mjs';
import { computeMetrics } from './metrics.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

/** Read org/quality.json if present. */
export function readQuality() {
  const p = join(ORG, 'quality.json');
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; } catch { return null; }
}

/** Snapshot plus computed metrics, as one object. */
export function build() {
  const snap = snapshot();
  return { snapshot: snap, metrics: computeMetrics(snap, { quality: readQuality() }) };
}

/** Start the dashboard server. Resolves to the listening http.Server. */
export function start({ port = Number(process.env.PORT) || 8090 } = {}) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (req.method !== 'GET') return send(405, 'application/json', '{"error":{"code":"method_not_allowed","message":"GET only"}}');
      if (path === '/api/snapshot') return send(200, 'application/json', JSON.stringify(snapshot()));
      if (path === '/api/metrics') return send(200, 'application/json', JSON.stringify(build().metrics));
      const f = FILES[path];
      if (f) return send(200, f[1], readFileSync(join(DIR, f[0])));
      send(404, 'application/json', '{"error":{"code":"not_found","message":"Not found"}}');
    } catch (e) {
      send(500, 'application/json', JSON.stringify({ error: { code: 'internal', message: String(e.message) } }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const s = await start();
  console.log(`PMO dashboard on http://localhost:${s.address().port}`);
}
