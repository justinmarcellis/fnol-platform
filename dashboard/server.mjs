// PMO dashboard server: static files plus /api/snapshot and /api/metrics.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshot, ORG } from '../org/fabric.mjs';
import { computeMetrics, parseValueDrivers } from './metrics.mjs';
import { computeFeed } from '../org/live-export.mjs';

// Live feed is rebuilt from the fabric at most every 3 s while agents work.
let feedCache = { at: 0, docs: null };
function liveFeed() {
  if (!feedCache.docs || Date.now() - feedCache.at > 3000) feedCache = { at: Date.now(), docs: computeFeed().docs };
  return feedCache.docs;
}

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

/** VD-1..VD-6 headings from product/value-propositions.md ([] when absent). */
export function readValueDrivers() {
  const p = join(ORG, '..', 'product', 'value-propositions.md');
  try { return existsSync(p) ? parseValueDrivers(readFileSync(p, 'utf8')) : []; } catch { return []; }
}

/** Snapshot plus computed metrics, as one object. */
export function build() {
  const snap = snapshot();
  return { snapshot: snap, metrics: computeMetrics(snap, { quality: readQuality(), valueDrivers: readValueDrivers() }) };
}

/** Start the dashboard server. Resolves to the listening http.Server. */
export function start({ port = Number(process.env.PORT) || 8090 } = {}) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (req.method !== 'GET') return send(405, 'application/json', '{"error":{"code":"method_not_allowed","message":"GET only"}}');
      if (path === '/api/snapshot') return send(200, 'application/json', JSON.stringify(snapshot()));
      if (path.startsWith('/api/live/')) {
        const doc = liveFeed()[path.slice('/api/live/'.length)];
        return doc ? send(200, 'application/json', JSON.stringify(doc)) : send(404, 'application/json', '{"error":{"code":"not_found","message":"Unknown feed document"}}');
      }
      if (path === '/live') {
        const page = readFileSync(join(DIR, 'live.html'), 'utf8').replace('__SEED__', () => JSON.stringify(liveFeed()).replace(/</g, '\\u003c'));
        return send(200, 'text/html; charset=utf-8', '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + page);
      }
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
