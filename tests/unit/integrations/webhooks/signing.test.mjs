import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sign, verifySignature, buildHeaders, generateSecret, SIGNATURE_HEADER } from '../../../../src/modules/integrations/webhooks/signing.mjs';

test('sign is HMAC-SHA256 hex of the raw body', () => {
  const body = '{"id":"evt_1","type":"claim.reported"}';
  const expected = crypto.createHmac('sha256', 'whsec_test').update(body).digest('hex');
  assert.equal(sign('whsec_test', body), expected);
  assert.match(sign('whsec_test', body), /^[0-9a-f]{64}$/);
});

test('known vector (RFC 4231 style, independent of the implementation)', () => {
  // HMAC-SHA256(key="key", msg="The quick brown fox jumps over the lazy dog")
  assert.equal(
    sign('key', 'The quick brown fox jumps over the lazy dog'),
     'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
  );
});

test('verifySignature accepts the right signature and rejects tampering', () => {
  const body = '{"a":1}';
  const sig = sign('s3cret', body);
  assert.equal(verifySignature('s3cret', body, sig), true);
  assert.equal(verifySignature('s3cret', body, `sha256=${sig}`), true);
  assert.equal(verifySignature('s3cret', '{"a":2}', sig), false);
  assert.equal(verifySignature('other', body, sig), false);
  assert.equal(verifySignature('s3cret', body, 'abc'), false);
  assert.equal(verifySignature('s3cret', body, undefined), false);
});

test('buildHeaders signs the exact body and carries ids', () => {
  const body = '{"x":true}';
  const h = buildHeaders({ secret: 'k', body, eventId: 'evt_9', eventType: 'claim.routed', deliveryId: 'whd_1', attempt: 2 });
  assert.equal(h[SIGNATURE_HEADER], sign('k', body));
  assert.equal(h['X-FNOL-Event-Id'], 'evt_9');
  assert.equal(h['X-FNOL-Event-Type'], 'claim.routed');
  assert.equal(h['X-FNOL-Attempt'], '2');
  assert.equal(h['content-type'], 'application/json');
});

test('generateSecret is random and prefixed', () => {
  const a = generateSecret();
  assert.match(a, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, generateSecret());
});
