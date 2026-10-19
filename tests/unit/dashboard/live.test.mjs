import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start, build, metricsDoc } from '../../../dashboard/server.mjs';
import { renderSnapshotHtml } from '../../../dashboard/export.mjs';

const get = async (server, p) => { const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`); return { status: r.status, body: await r.json() }; };

test('metricsDoc is computeMetrics output plus generatedAt', () => {
  const m = metricsDoc();
  assert.ok(!Number.isNaN(Date.parse(m.generatedAt)));
  assert.ok(m.tickets && m.cost);
  assert.ok(Buffer.byteLength(JSON.stringify(m)) < 600 * 1024);
});

test('server serves the five live documents under /api/live/<name>', async () => {
  const server = await start({ port: 0 });
  try {
    for (const n of ['board', 'rank', 'graph', 'events', 'metrics']) {
      const r = await get(server, `/api/live/${n}`);
      assert.equal(r.status, 200, n);
      assert.ok(r.body.generatedAt, n);
    }
    assert.equal((await get(server, '/api/live/nope')).status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});

test('liveDir overrides documents and is read fresh on every request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-dir-'));
  fs.writeFileSync(path.join(dir, 'rank.json'), JSON.stringify({ generatedAt: 'x', items: [{ rank: 1 }] }));
  const server = await start({ port: 0, liveDir: dir });
  try {
    assert.equal((await get(server, '/api/live/rank')).body.items.length, 1);
    fs.writeFileSync(path.join(dir, 'rank.json'), JSON.stringify({ generatedAt: 'y', items: [] }));
    assert.equal((await get(server, '/api/live/rank')).body.generatedAt, 'y');
  } finally { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('exported snapshot embeds the live documents, has no d3/CDN and no external URLs to fetch', () => {
  const b = build();
  assert.ok(b.live.board.tickets.length && b.live.rank.items.length && b.live.events.items.length && b.live.metrics.generatedAt);
  const html = renderSnapshotHtml(b);
  assert.match(html, /"live":\{"board"/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /d3\.min|cdnjs/);
  assert.ok(Buffer.byteLength(html) < 2 * 1024 * 1024);
});

test('app.js subscribes to the db once, outside render, and polls every 5 s', () => {
  const js = fs.readFileSync(new URL('../../../dashboard/app.js', import.meta.url), 'utf8');
  assert.equal((js.match(/onSnapshot\(/g) || []).length, 1);
  const render = js.slice(js.indexOf('  function render() {'), js.indexOf('// ---- data layer'));
  assert.doesNotMatch(render, /onSnapshot|window\.claude/);
  assert.match(js, /setTimeout\(poll, 5000\)/);
  assert.match(js, /window\.claude\.use\('db'\)/);
});
