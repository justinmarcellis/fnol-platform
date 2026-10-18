import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers.mjs';

test('scheduler wiring: ctx.scheduler exists and runs tasks', async () => {
  const app = await bootApp({ isolated: true });
  try {
    assert.equal(typeof app.ctx.scheduler.every, 'function');
    let runs = 0;
    app.ctx.scheduler.every(5, () => { runs++; }, { name: 'wiring' });
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(runs >= 1);
  } finally { await app.close(); }
});

test('scheduler wiring: close() calls stopAll', async () => {
  const app = await bootApp({ isolated: true });
  let runs = 0;
  app.ctx.scheduler.every(5, () => { runs++; }, { name: 'stopme' });
  assert.equal(app.ctx.scheduler.list().length, 1);
  await app.close();
  assert.equal(app.ctx.scheduler.list().length, 0);
  const after = runs;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runs, after);
});
