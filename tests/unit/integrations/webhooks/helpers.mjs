import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { bootApp } from '../../core/helpers.mjs';

process.env.FNOL_WEBHOOK_TICK_MS = '0'; // tests drive worker.tick() themselves

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODULE_SRC = path.resolve(HERE, '../../../../src/modules/integrations');

/**
 * Boot the platform with ONLY the integrations module (a private copy, so other teams' modules
 * cannot interfere with the bus) and optionally a stub adapters service.
 * @param {{ adaptersSource?: string, devMode?: boolean, clock?: object }} [opts]
 */
export async function bootIntegrations({ adaptersSource, ...extra } = {}) {
  const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnol-int-mods-'));
  const dest = path.join(modulesDir, 'integrations');
  fs.cpSync(MODULE_SRC, dest, { recursive: true, filter: (src) => !src.includes(`${path.sep}adapters`) });
  if (adaptersSource) {
    fs.mkdirSync(path.join(dest, 'adapters'));
    fs.writeFileSync(path.join(dest, 'adapters', 'index.mjs'), adaptersSource);
  }
  let app;
  try {
    app = await bootApp({ modulesDir, ...extra });
  } catch (e) {
    fs.rmSync(modulesDir, { recursive: true, force: true });
    throw e;
  }
  const close = app.close;
  app.close = async () => {
    app.ctx.modules.integrations?.worker.stop();
    await close();
    fs.rmSync(modulesDir, { recursive: true, force: true });
  };
  app.tctx = (tenantId = 'alpha') => app.ctx.forTenant(tenantId);
  app.svc = (tenantId = 'alpha') => app.ctx.forTenant(tenantId).modules.integrations;
  return app;
}

/** Publish an event as a tenant and wait for all handlers (including webhook deliveries). */
export async function publish(app, type, subject = 'clm_test_1', data = { claimId: subject }, tenantId = 'alpha') {
  const evt = app.tctx(tenantId).bus.publish(type, subject, data);
  await app.ctx.bus.drain();
  return evt;
}

/** A fake fetch that records calls and answers from a queue of statuses/errors (last one repeats). */
export function fakeFetch(...script) {
  const calls = [];
  const fn = async (url, init) => {
    const step = script[Math.min(calls.length, script.length - 1)] ?? 200;
    calls.push({ url, init, body: init.body, headers: init.headers });
    if (step instanceof Error) throw step;
    return { status: step, body: { cancel: async () => {} } };
  };
  fn.calls = calls;
  return fn;
}

/** Local HTTP receiver (node:http) that records requests; `respond` picks the status per request. */
export async function startReceiver(respond = () => 200) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ headers: req.headers, raw, json: JSON.parse(raw || 'null'), url: req.url });
      res.writeHead(respond(requests.length, req));
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/hooks/fnol`,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

/** Set notifications.webhooks.allowedHosts on a tenant (SEC2-015). */
export function allowHosts(app, hosts, tenantId = 'alpha') {
  const cfg = structuredClone(app.ctx.tenants.get(tenantId));
  cfg.notifications = { ...(cfg.notifications ?? {}), webhooks: { ...(cfg.notifications?.webhooks ?? {}), allowedHosts: hosts } };
  app.ctx.tenants.put(tenantId, cfg, 'test');
}
