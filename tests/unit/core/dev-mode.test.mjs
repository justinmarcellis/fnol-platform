import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDevMode } from '../../../src/server.mjs';
import { bootApp, call } from './helpers.mjs';

test('resolveDevMode: only opts.devMode true or FNOL_DEV_MODE=1 enable it, NODE_ENV never does', () => {
  assert.equal(resolveDevMode(undefined, {}), false);
  for (const v of ['0', '', 'true', 'yes', '2', ' 1']) assert.equal(resolveDevMode(undefined, { FNOL_DEV_MODE: v }), false, `FNOL_DEV_MODE=${JSON.stringify(v)}`);
  assert.equal(resolveDevMode(undefined, { FNOL_DEV_MODE: '1' }), true);
  for (const n of ['development', 'production', 'test', undefined]) assert.equal(resolveDevMode(undefined, { NODE_ENV: n }), false, `NODE_ENV=${n}`);
  assert.equal(resolveDevMode(undefined, { NODE_ENV: 'development', FNOL_DEV_MODE: '1' }), true);
  assert.equal(resolveDevMode(true, {}), true);
  assert.equal(resolveDevMode(false, { FNOL_DEV_MODE: '1' }), false);
});

async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('createApp: unset env, NODE_ENV=development and FNOL_DEV_MODE=0 all leave dev mode off and the token endpoint 404', async () => {
  for (const env of [{ FNOL_DEV_MODE: undefined, NODE_ENV: undefined }, { FNOL_DEV_MODE: undefined, NODE_ENV: 'development' }, { FNOL_DEV_MODE: '0', NODE_ENV: 'development' }]) {
    await withEnv(env, async () => {
      const app = await bootApp();
      try {
        assert.equal(app.ctx.config.devMode, false);
        const r = await call(app, 'POST', '/api/v1/auth/token', { body: { userId: 'x', tenantId: 'alpha', roles: ['platform_admin'] } });
        assert.equal(r.status, 404);
        assert.equal((await call(app, 'GET', '/api/v1/dev/personas')).status, 404);
      } finally { await app.close(); }
    });
  }
});

test('createApp: FNOL_DEV_MODE=1 or opts.devMode=true enables dev mode and logs one warning', async () => {
  await withEnv({ FNOL_DEV_MODE: '1', NODE_ENV: 'production' }, async () => {
    const app = await bootApp();
    try {
      assert.equal(app.ctx.config.devMode, true);
      const r = await call(app, 'POST', '/api/v1/auth/token', { body: { userId: 'x', tenantId: 'alpha', roles: ['csr'] } });
      assert.equal(r.status, 201);
    } finally { await app.close(); }
  });
  await withEnv({ FNOL_DEV_MODE: undefined }, async () => {
    const lines = [];
    const orig = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    const grab = (c) => { lines.push(String(c)); return true; };
    process.stderr.write = grab; process.stdout.write = grab;
    let app;
    try { app = await bootApp({ devMode: true, logLevel: 'warn' }); } finally { process.stderr.write = orig; process.stdout.write = origOut; }
    try {
      assert.equal(app.ctx.config.devMode, true);
      const warns = lines.filter((l) => l.includes('DEV MODE ON'));
      assert.equal(warns.length, 1);
      assert.doesNotMatch(warns[0], /eyJ|Bearer/);
    } finally { await app.close(); }
  });
});
