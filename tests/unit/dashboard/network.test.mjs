import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../../dashboard/server.mjs';
import { computeFeed } from '../../../org/live-export.mjs';
import { renderSnapshotHtml } from '../../../dashboard/export.mjs';

test('build() carries the same graph as org/live-export.mjs', () => {
  const b = build();
  const g = computeFeed().docs.graph;
  assert.equal(b.graph.nodes.length, g.nodes.length);
  assert.equal(b.graph.edges.length, g.edges.length);
  assert.equal(b.snapshot.graph.nodes.length, g.nodes.length);
});

test('snapshot html embeds the graph and the network tab', () => {
  const html = renderSnapshotHtml(build());
  assert.match(html, /Decision network/);
  assert.match(html, /"graph":\{"generatedAt"/);
  assert.ok(Buffer.byteLength(html) < 2 * 1024 * 1024);
});
