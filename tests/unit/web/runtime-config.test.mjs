import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from '../core/helpers.mjs';
import { isDevMode } from '../../../src/web/shared/devlogin.js';

for (const devMode of [true, false]) {
  test(`/runtime-config.js reflects devMode=${devMode}`, async () => {
    const app = await bootApp({ devMode });
    try {
      const res = await fetch(`${app.url}/runtime-config.js`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /javascript/);
      assert.match(res.headers.get('cache-control'), /no-store/);
      assert.equal((await res.text()).trim(), `window.__FNOL_DEV__ = ${devMode};`);
      // the flag drives isDevMode on a non-localhost host
      assert.equal(isDevMode({ __FNOL_DEV__: devMode, location: { hostname: 'x.run.app' } }), devMode);
    } finally { await app.close(); }
  });
}

test('every app index.html loads runtime-config.js before its module script', async () => {
  const { readFileSync } = await import('node:fs');
  for (const a of ['claimant', 'csr', 'adjuster', 'admin']) {
    const html = readFileSync(new URL(`../../../src/web/${a}/index.html`, import.meta.url), 'utf8');
    const i = html.indexOf('/runtime-config.js');
    assert.ok(i > 0 && i < html.indexOf('type="module"'), a);
  }
});
