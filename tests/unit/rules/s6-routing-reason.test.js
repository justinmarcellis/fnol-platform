// S6-BUG-05 / ADJUSTER-18: when triage says fast-track eligible but no tenant rule asks for fast track, routing says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRouting } from '../../../src/modules/rules/routing.js';

const config = { queues: [{ id: 'general' }, { id: 'fast_track' }] };

test('eligible but not requested: the reasons explain why the claim was not fast tracked', () => {
  const d = decideRouting({ actions: [{ type: 'route_queue', queue: 'general', ruleId: 'R1' }], config, lob: 'homeowners', triage: { fastTrackEligible: true, severityScore: 10 }, coverage: { outcome: 'covered' } });
  assert.equal(d.fastTrack, false);
  assert.ok(d.reasons.some((r) => /fast-track eligible, but no fast-track rule/.test(r)), d.reasons.join('; '));
});

test('not eligible: no extra reason', () => {
  const d = decideRouting({ actions: [], config, lob: 'homeowners', triage: { fastTrackEligible: false }, coverage: { outcome: 'covered' } });
  assert.ok(!d.reasons.some((r) => /fast-track eligible/.test(r)));
});
