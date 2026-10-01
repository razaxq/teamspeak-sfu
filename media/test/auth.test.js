import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, verifyToken } from '../src/auth.js';
const secret = 'a'.repeat(32), now = 1000000;
test('signed tokens bind room, peer, role and expiry', () => {
  const token = issueToken(secret, { room: 'r', peer: 'p', role: 'view', ttl: 60 }, now);
  assert.equal(verifyToken(token, secret, now).room, 'r');
  assert.throws(() => verifyToken(token, 'b'.repeat(32), now), /INVALID_TOKEN/);
  assert.throws(() => verifyToken(token, secret, now + 60000), /INVALID_TOKEN/);
  const [body, sig] = token.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url')); claims.role = 'publish';
  assert.throws(() => verifyToken(Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + sig, secret, now));
  assert.throws(() => verifyToken(token + '.extra', secret, now));
});
test('invalid scope and excessive lifetime cannot be minted', () => {
  for (const claims of [{room: 'r', peer: 'p'}, {room:'../x', peer:'p',role:'view'},
    {peer:'p',role:'view'}, {room:'r',role:'view'}, {room:'r',peer:'p',role:'admin'},
    {room:'r',peer:'p',role:'view',ttl:0}, {room:'r',peer:'p',role:'view',ttl:86401}])
    assert.throws(() => issueToken(secret, claims, now));
  assert.throws(() => issueToken('short', {room:'r',peer:'p',role:'view'},now));
});
