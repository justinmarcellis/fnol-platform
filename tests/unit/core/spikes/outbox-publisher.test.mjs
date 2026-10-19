import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutboxPublisher, createPubSubRestPublisher } from '../../../../src/core/outbox-publisher.mjs';

const row = (tenant, seq) => ({ id: `evt_${tenant}_${seq}`, tenant_id: tenant, seq, type: 'claim.reported', event: JSON.stringify({ id: `evt_${tenant}_${seq}` }) });

function harness(rows, publishImpl) {
  const state = { rows: [...rows], acked: [], sent: [], resumed: [] };
  const publisher = {
    async publish(m) { await publishImpl?.(m, state); state.sent.push(m); return { messageId: 'm' + state.sent.length }; },
    resumePublish(k) { state.resumed.push(k); },
  };
  const pub = createOutboxPublisher({
    readUndelivered: () => state.rows.filter((r) => !state.acked.includes(r.id)),
    markPublished: (ids) => { state.acked.push(...ids); },
    publisher,
  });
  return { state, pub };
}

test('orders by (tenant_id, seq) with ordering key and attributes', async () => {
  const { state, pub } = harness([row('b', 2), row('a', 2), row('b', 1), row('a', 1)]);
  const r = await pub.publishPending();
  assert.deepEqual(r.published, ['evt_a_1', 'evt_a_2', 'evt_b_1', 'evt_b_2']);
  assert.equal(state.sent[0].orderingKey, 'a');
  assert.deepEqual(state.sent[0].attributes, { outboxId: 'evt_a_1', tenant_id: 'a', type: 'claim.reported', seq: '1' });
});

test('marks published only after ack', async () => {
  const { state, pub } = harness([row('a', 1)], async (m, s) => { assert.deepEqual(s.acked, []); });
  await pub.publishPending();
  assert.deepEqual(state.acked, ['evt_a_1']);
});

test('per-tenant halt at first failure, other tenants continue; retry has no duplicate acks and resumes key', async () => {
  let fail = true;
  const { state, pub } = harness([row('a', 1), row('a', 2), row('a', 3), row('b', 1)], async (m) => {
    if (fail && m.attributes.outboxId === 'evt_a_2') throw new Error('unavailable');
  });
  const r1 = await pub.publishPending();
  assert.deepEqual(r1.published, ['evt_a_1', 'evt_b_1']);
  assert.deepEqual(r1.halted, ['a']);
  assert.equal(r1.failed[0].id, 'evt_a_2');
  assert.ok(!state.sent.some((m) => m.attributes.outboxId === 'evt_a_3'));
  fail = false;
  const r2 = await pub.publishPending();
  assert.deepEqual(r2.published, ['evt_a_2', 'evt_a_3']);
  assert.deepEqual(state.resumed, ['a']);
  assert.equal(new Set(state.acked).size, state.acked.length);
  assert.deepEqual((await pub.publishPending()).published, []);
});

test('empty batch', async () => {
  const { pub } = harness([]);
  assert.deepEqual(await pub.publishPending(), { published: [], failed: [], halted: [] });
});

test('REST publisher request shape, pause and resume', async () => {
  const calls = [];
  const replies = [{ ok: true, status: 200, json: async () => ({ messageIds: ['42'] }) }, { ok: false, status: 503 }];
  const fetch = async (url, init) => { calls.push({ url, init }); return replies.shift() ?? { ok: true, status: 200, json: async () => ({ messageIds: ['43'] }) }; };
  const p = createPubSubRestPublisher({ project: 'example-project', topic: 'fnol-events', tokenProvider: { getToken: async () => 'tok' }, fetch });
  const out = await p.publish({ data: '{"a":1}', attributes: { outboxId: 'e1', tenant_id: 'a' }, orderingKey: 'a' });
  assert.deepEqual(out, { messageId: '42' });
  assert.equal(calls[0].url, 'https://pubsub.googleapis.com/v1/projects/example-project/topics/fnol-events:publish');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { messages: [{ data: Buffer.from('{"a":1}').toString('base64'), attributes: { outboxId: 'e1', tenant_id: 'a' }, orderingKey: 'a' }] });
  await assert.rejects(p.publish({ data: 'x', orderingKey: 'a' }), /HTTP 503/);
  await assert.rejects(p.publish({ data: 'x', orderingKey: 'a' }), /paused/);
  assert.equal(calls.length, 2);
  p.resumePublish('a');
  assert.deepEqual(await p.publish({ data: 'x', orderingKey: 'a' }), { messageId: '43' });
});
