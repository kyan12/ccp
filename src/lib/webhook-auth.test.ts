import assert = require('node:assert/strict');
import test = require('node:test');
import {
  constantTimeEquals,
  hmacSha256Hex,
  verifyHmacSha256,
  isLoopbackAddress,
} from './webhook-auth';

test('HMAC verification accepts exact raw-body signatures and rejects tampering', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"event":"push","value":1}');
  const signature = `sha256=${hmacSha256Hex(secret, body)}`;

  assert.equal(verifyHmacSha256(secret, body, signature, 'sha256='), true);
  assert.equal(verifyHmacSha256(secret, Buffer.from('{"event":"push","value":2}'), signature, 'sha256='), false);
  assert.equal(verifyHmacSha256('', body, signature, 'sha256='), false);
  assert.equal(verifyHmacSha256(secret, body, '', 'sha256='), false);
});

test('unprefixed HMAC verification supports Linear and Sentry signatures', () => {
  const secret = 'provider-secret';
  const body = Buffer.from('{"type":"Issue"}');
  const signature = hmacSha256Hex(secret, body);
  assert.equal(verifyHmacSha256(secret, body, signature), true);
});

test('constant-time equality handles unequal lengths safely', () => {
  assert.equal(constantTimeEquals('abc', 'abc'), true);
  assert.equal(constantTimeEquals('abc', 'abcd'), false);
});

test('loopback detection accepts only local addresses', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.68.1'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});
