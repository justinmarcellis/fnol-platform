// Smoke test: boot the server on a free port with a temp DB, wait for /healthz,
// issue tokens, report one claim end to end, then shut down. Exit non-zero on any failure.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Ask the OS for a free TCP port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the smoke flow. Resolves on success, rejects with a descriptive Error.
 * @param {{ serverPath?: string, timeoutMs?: number, tenantId?: string }} [opts]
 */
export async function runSmoke(opts = {}) {
  const serverPath = opts.serverPath ?? path.join(root, 'src', 'server.mjs');
  const timeoutMs = opts.timeoutMs ?? 20000;
  const tenantId = opts.tenantId ?? 'aurelia-mutual';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-smoke-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverPath], {
    cwd: root,
    env: { ...process.env, FNOL_DEV_MODE: '1', PORT: String(port), FNOL_DB_PATH: path.join(tmp, 'smoke.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = null;
  child.on('exit', (code, sig) => { exited = code ?? sig; });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const api = async (method, url, { token, body } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const step = (msg) => console.log(`smoke: ${msg}`);

  try {
    const deadline = Date.now() + timeoutMs;
    let healthy = false;
    while (Date.now() < deadline && exited === null && !healthy) {
      try { healthy = (await fetch(`${base}/healthz`)).ok; } catch { await sleep(100); }
    }
    if (!healthy) throw new Error(`server did not become healthy (exit=${exited})`);
    const health = (await api('GET', '/healthz')).json;
    step(`healthz ok (${health.modules.length} modules, ${health.tenants} tenants)`);

    const issue = async (roles) => {
      const r = await api('POST', '/api/v1/auth/token', { body: { userId: `smoke-${roles[0]}`, tenantId, roles } });
      if (r.status !== 201 || !r.json?.token) throw new Error(`token for ${roles} failed: ${r.status} ${r.text}`);
      return r.json.token;
    };
    const csr = await issue(['csr']);
    const adjuster = await issue(['adjuster']);
    step('tokens issued');

    const create = await api('POST', '/api/v1/claims', { token: csr, body: {
      tenantId, lob: 'personal_auto', lossType: 'glass', channel: 'csr_phone', policyNumber: 'PA-SMOKE-0001', riskState: 'WI',
      lossEvent: {
        lossDate: '2026-05-15', cause: 'glass', description: 'Synthetic smoke test: rock chip in windshield.',
        location: { description: '100 Example Way, Testville, WI 53001', state: 'WI' },
        injuriesReported: false, fatality: false, vehiclesInvolved: 1,
      },
      parties: [{ roles: ['insured', 'reporter'], kind: 'person', firstName: 'Sam', lastName: 'Smoketest', phone: '(555) 010-0000' }],
    } });
    if (create.status !== 201 || !create.json?.id) throw new Error(`create claim failed: ${create.status} ${create.text}`);
    const claimId = create.json.id;
    step(`claim created ${claimId}`);

    const got = await api('GET', `/api/v1/claims/${claimId}`, { token: adjuster });
    if (got.status !== 200 || got.json?.id !== claimId) throw new Error(`fetch claim failed: ${got.status} ${got.text}`);
    step('claim fetched by adjuster');
  } catch (e) {
    e.message += `\n--- server output ---\n${output.slice(-2000)}`;
    throw e;
  } finally {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
    if (exited === null) child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSmoke().then(() => { console.log('smoke: PASS'); process.exit(0); })
    .catch((e) => { console.error(`smoke: FAIL ${e.message}`); process.exit(1); });
}
