import { createHmac, timingSafeEqual } from 'node:crypto';

const identifier = /^[A-Za-z0-9_-]{1,64}$/;
export function validateSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32)
    throw new Error('SFU_SECRET must contain at least 32 bytes');
  return secret;
}
function signature(body, secret) {
  return createHmac('sha256', validateSecret(secret)).update(body).digest();
}
export function issueToken(secret, { room, peer, role, ttl = 3600 }, now = Date.now()) {
  const claims = { aud: 'sfu-lab-v1', room, peer, role, exp: Math.floor(now / 1000) + ttl };
  validateClaims(claims, now);
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${signature(body, secret).toString('base64url')}`;
}
function validateClaims(c, now) {
  if (!c || c.aud !== 'sfu-lab-v1' || typeof c.room !== 'string' || !identifier.test(c.room) || typeof c.peer !== 'string' || !identifier.test(c.peer) ||
      !['publish', 'view'].includes(c.role) || !Number.isSafeInteger(c.exp) ||
      c.exp <= Math.floor(now / 1000) || c.exp > Math.floor(now / 1000) + 86400)
    throw new Error('INVALID_TOKEN');
}
export function verifyToken(token, secret, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length > 2048) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every(x => /^[A-Za-z0-9_-]+$/.test(x))) throw new Error();
    const expected = signature(parts[0], secret);
    const actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    validateClaims(claims, now);
    return claims;
  } catch { throw new Error('INVALID_TOKEN'); }
}
