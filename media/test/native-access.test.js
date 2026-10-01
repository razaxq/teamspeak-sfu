import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createAccessRegistry } from '../src/native/access-registry.js';
import { startAccessBridge } from '../src/native/access-bridge.js';
const identity = () => ({ serverId: 'server', clientId: '3', sessionId: 'connection-1', uid: 'identity', channelId: '1' });
const request = token => ({ token, cmd: 'create-stream', args: { id: 'stream' } });
test('issued credentials require trusted stream admission and stay bound to the connection', async () => {
  let live = identity(), time = 100000;
  const registry = createAccessRegistry({ resolveClient: async () => live, now: () => time, ttlSeconds: 60 });
  const credential = await registry.issue('3');
  assert.equal(await registry.authorize(request(credential.token)), null);
  await registry.grantPublisher({ clientId: '3', sessionId: live.sessionId, streamId: 'stream' });
  assert.equal((await registry.authorize(request(credential.token))).userId, credential.userId);
  assert.ok(await registry.authorize({ ...request(credential.token), cmd: 'close-stream' }));
  assert.equal(await registry.authorize({ ...request(credential.token), cmd: 'close-stream', args: { id: 'other' } }), null);
  assert.equal(await registry.authorize({ ...request('0'.repeat(64)), cmd: 'close-stream' }), null);
  assert.equal(await registry.authorize(request('0'.repeat(64))), null);
  assert.equal(await registry.authorize({ ...request(credential.token), args: { id: 'other' } }), null);
  assert.equal(await registry.authorize({ ...request(credential.token), args: { id: 'stream', userId: 'other' } }), null);
  assert.equal(await registry.authorize({ ...request(credential.token), cmd: 'consume' }), null);
  for (const key of ['uid', 'channelId', 'sessionId', 'serverId']) {
    live = { ...identity(), [key]: 'changed' };
    assert.equal(await registry.authorize(request(credential.token)), null);
  }
  live = identity(); time += 60000;
  assert.equal(await registry.authorize(request(credential.token)), null);
  assert.equal(registry.size, 0);
});
test('rotation, disconnect and asynchronous revocation cannot preserve authority', async () => {
  let live = identity(), gate;
  const registry = createAccessRegistry({ resolveClient: async () => { if (gate) await gate; return live; } });
  const first = await registry.issue('3'), second = await registry.issue('3');
  await registry.grantPublisher({ clientId: '3', sessionId: live.sessionId, streamId: 'stream' });
  assert.equal(await registry.authorize(request(first.token)), null);
  registry.revokeStream('stream');
  assert.equal(await registry.authorize(request(second.token)), null);
  await registry.grantPublisher({ clientId: '3', sessionId: live.sessionId, streamId: 'stream' });
  let release; gate = new Promise(resolve => { release = resolve; });
  const pending = registry.authorize(request(second.token));
  registry.revokeClient('3'); release();
  assert.equal(await pending, null);
  gate = new Promise(resolve => { release = resolve; });
  const issuance = registry.issue('3');
  registry.revokeClient('3'); release();
  await assert.rejects(issuance, /changed/);
  gate = undefined; live = null;
  await assert.rejects(registry.issue('3'), /unavailable/);
});
test('private bridge rejects forged requests and never grants stream access', async t => {
  const dir = await mkdtemp(tmpdir() + '/sfu-access-');
  const registry = createAccessRegistry({ resolveClient: async id => id === '3' ? identity() : null });
  const secret = 'a'.repeat(64), path = dir + '/access.sock';
  const bridge = await startAccessBridge({ path, secret, registry });
  t.after(async () => { await bridge.stop(); await rm(dir, { recursive: true, force: true }); });
  async function exchange(input) {
    const socket = net.createConnection(path); let result = '';
    socket.on('data', chunk => { result += chunk; });
    await once(socket, 'connect'); socket.write(input); await once(socket, 'close'); return result;
  }
  assert.equal(await exchange('b'.repeat(64) + ' 3\n'), '');
  assert.equal(await exchange(secret + ' 65536\n'), '');
  assert.equal(await exchange(secret + ' 4\n'), '');
  const response = await exchange(secret + ' 3\n');
  assert.match(response, /^[a-f0-9]{64} [a-f0-9]{32}\n$/);
  assert.equal(await registry.authorize(request(response.split(' ')[0])), null);
});
