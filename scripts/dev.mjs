// One-command dev start: ensure .secrets, seed if db empty, start platform (:8080) and dashboard (:8090) if present.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8080);
const dbPath = process.env.FNOL_DB_PATH || path.join(root, 'data', 'fnol.db');
const nodeArgs = ['--disable-warning=ExperimentalWarning'];

fs.mkdirSync(path.join(root, '.secrets'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const seed = path.join(root, 'scripts', 'seed.mjs');
const dbEmpty = !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0;
if (fs.existsSync(seed) && dbEmpty) {
  console.log('Database empty: running scripts/seed.mjs');
  const r = spawnSync(process.execPath, [...nodeArgs, seed], { cwd: root, stdio: 'inherit', env: process.env });
  if (r.status !== 0) console.warn(`seed exited with status ${r.status}; continuing`);
}

const { createApp } = await import('../src/server.mjs');
const app = await createApp({ port, dbPath });
const children = [];

const dash = path.join(root, 'dashboard', 'server.mjs');
if (fs.existsSync(dash)) {
  const child = spawn(process.execPath, [...nodeArgs, dash], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: '8090' } });
  child.on('exit', (code) => console.warn(`dashboard exited (${code})`));
  children.push(child);
}

console.log(`Platform:  http://localhost:${app.port}/   (health: /healthz)`);
console.log(`Apps:      /  /csr  /adjuster  /admin`);
if (children.length) console.log('Dashboard: http://localhost:8090/');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  children.forEach((c) => c.kill());
  await app.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
