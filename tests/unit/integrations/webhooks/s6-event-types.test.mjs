// S6-BUG-05 / ADMIN-15: webhook subscriptions only accept event types the platform publishes (or '*').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntegrations } from './helpers.mjs';
import { KNOWN_EVENT_TYPES } from '../../../../src/modules/integrations/webhooks/service.mjs';

const input = (eventTypes) => ({ url: 'http://127.0.0.1:9/hook', eventTypes });

test('unknown event types are rejected with 422 and the known list', async () => {
  const app = await bootIntegrations();
  try {
    const svc = app.svc();
    for (const bad of [['claim.bogus'], ['claims.reported'], ['claim.reported', 'tenant.nothing']]) {
      await assert.rejects(svc.createSubscription(input(bad)), (e) => e.status === 422 && /(unknown|invalid) event type/.test(e.message), JSON.stringify(bad));
    }
    const ok = await svc.createSubscription(input(['claim.reported', 'claim.acknowledged', 'tenant.config.updated']));
    assert.deepEqual(ok.eventTypes, ['claim.reported', 'claim.acknowledged', 'tenant.config.updated']);
    assert.ok(await svc.createSubscription(input(['*'])));
    // The admin form's long-standing default 'claim.created' is stored as the canonical 'claim.reported'.
    assert.deepEqual((await svc.createSubscription(input(['claim.created', 'claim.reported']))).eventTypes, ['claim.reported']);
    await assert.rejects(svc.updateSubscription(ok.id, { eventTypes: ['claim.bogus'] }), (e) => e.status === 422);
  } finally { await app.close(); }
});

test('every published claim event is subscribable', () => {
  for (const t of ['claim.reported', 'claim.routed', 'claim.triaged', 'claim.status.changed', 'claim.timer.breached', 'claim.coverage.verified']) {
    assert.ok(KNOWN_EVENT_TYPES.includes(t), t);
  }
});
