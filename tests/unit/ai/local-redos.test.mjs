import { test } from 'node:test';
import assert from 'node:assert/strict';
import createLocal, { MAX_TEXT } from '../../../src/ai/providers/local.mjs';

const ATTACKS = [
  'Total' + ' '.repeat(20000) + '!',
  'total estimate' + ' '.repeat(20000) + 'x',
  'cited' + ' '.repeat(20000) + '!',
  'cited driver' + ' '.repeat(10000) + '#' + ' '.repeat(10000) + '!',
  'at fault' + ' '.repeat(20000) + '!',
  'Date of loss' + ' '.repeat(20000) + '!',
  'report' + ' '.repeat(20000) + 'x',
  'shop:' + ' '.repeat(20000) + 'x',
  'at ' + 'A '.repeat(10000),
  'on 1 ' + 'Aa.'.repeat(6000),
  '$' + ' '.repeat(20000) + 'x',
  'a. '.repeat(7000),
  'Total: $' + '1,'.repeat(10000),
  'cited ' + 'Aa '.repeat(6000),
];

const TASKS = ['extract_narrative', 'extract_document', 'classify_photo', 'severity', 'fraud_signals', 'subrogation', 'summarize', 'next_best_actions'];

test('local provider regexes are linear on crafted documents and narratives', async () => {
  const provider = createLocal({}, {});
  for (const text of ATTACKS) {
    for (const task of TASKS) {
      const input = { kind: 'estimate', text, filename: text, metadata: { description: text }, facts: { narrative: text, description: text, text } };
      const t0 = performance.now();
      try { await provider.run(task, input); } catch { /* shape errors fine; only timing matters */ }
      const ms = performance.now() - t0;
      assert.ok(ms < 200, `${task} took ${ms.toFixed(0)}ms on ${JSON.stringify(text.slice(0, 20))}`);
    }
  }
});

test('local provider caps input to MAX_TEXT', async () => {
  const provider = createLocal({}, {});
  const r = await provider.run('extract_document', { kind: 'estimate', text: 'x'.repeat(MAX_TEXT + 5000) + ' Total: $999.00' });
  assert.equal(r.output.fields.find((f) => f.name === 'estimateTotal'), undefined);
});
