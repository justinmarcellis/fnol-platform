import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { bootApp } from './helpers.mjs';
import { migrations } from '../../../src/core/bus.mjs';

test('outbox seq: monotonic and gapless per tenant, independent across tenants', async () => {
  const app = await bootApp({ isolated: true });
  try {
    for (let i = 0; i < 3; i++) app.ctx.bus.publish('alpha', 'x.happened', `s${i}`, {});
    app.ctx.bus.publish('beta', 'x.happened', 'b0', {});
    app.ctx.bus.publish('alpha', 'x.happened', 's3', {});
    await app.ctx.bus.drain();
    assert.deepEqual(app.ctx.bus.outbox('alpha').map((r) => r.seq), [1, 2, 3, 4]);
    assert.deepEqual(app.ctx.bus.outbox('beta').map((r) => r.seq), [1]);
    assert.deepEqual(app.ctx.bus.outbox('alpha', 'delivered').map((r) => r.subject), ['s0', 's1', 's2', 's3']);
  } finally { await app.close(); }
});

test('outbox seq: unique (tenant_id, seq) index is enforced', async () => {
  const app = await bootApp({ isolated: true });
  try {
    app.ctx.bus.publish('alpha', 'x.happened', 's', {});
    await app.ctx.bus.drain();
    assert.throws(() => app.ctx.db.raw.prepare(
      "INSERT INTO outbox (id, tenant_id, type, event, created_at, seq) VALUES ('dup', 'alpha', 't', '{}', 'now', 1)").run());
  } finally { await app.close(); }
});

test('outbox seq: migration backfills existing rows per tenant in created order', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migrations[0].sql);
  const ins = db.prepare("INSERT INTO outbox (id, tenant_id, type, event, created_at) VALUES (?, ?, 't', '{}', ?)");
  ins.run('a2', 'alpha', '2026-01-02'); ins.run('b1', 'beta', '2026-01-01');
  ins.run('a1', 'alpha', '2026-01-01'); ins.run('a3', 'alpha', '2026-01-03');
  db.exec(migrations[1].sql);
  db.exec(migrations[2].sql);
  const rows = db.prepare('SELECT id, seq FROM outbox ORDER BY tenant_id, seq').all().map((r) => `${r.id}:${r.seq}`);
  assert.deepEqual(rows, ['a1:1', 'a2:2', 'a3:3', 'b1:1']);
  db.close();
});
