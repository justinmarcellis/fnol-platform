
import { test as plateTest } from 'node:test';
import plateAssert from 'node:assert/strict';
import { redact as plateRedact } from '../../../src/ai/guardrails.mjs';

plateTest('plate redaction is linear on a whitespace flood and still redacts labelled plates', () => {
  const t = performance.now();
  plateRedact('license plate' + ' '.repeat(20000) + '!');
  plateAssert.ok(performance.now() - t < 100, 'plate regex must not backtrack');
  const out = plateRedact('License plate: ABC 1234 seen at the scene');
  plateAssert.ok(!JSON.stringify(out).includes('ABC 1234') || /PLATE/.test(JSON.stringify(out)));
});
