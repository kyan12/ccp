import crypto = require('crypto');

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hmacSha256Hex(secret: string, body: Buffer | string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function verifyHmacSha256(
  secret: string,
  body: Buffer | string,
  provided: string,
  prefix = '',
): boolean {
  if (!secret || !provided) return false;
  const expected = `${prefix}${hmacSha256Hex(secret, body)}`;
  return constantTimeEquals(provided.trim(), expected);
}

function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split('%', 1)[0];
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1';
}

module.exports = {
  constantTimeEquals,
  hmacSha256Hex,
  verifyHmacSha256,
  isLoopbackAddress,
};

export { constantTimeEquals, hmacSha256Hex, verifyHmacSha256, isLoopbackAddress };
