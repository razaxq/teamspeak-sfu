import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestChannel } from '../src/native/request-channel.js';
import { decodeFrame } from '../src/native/wire.js';

test('server request correlation rejects unrelated and duplicate responses', async () => {
  const sent = [];
  const channel = createRequestChannel({ send: s => sent.push(decodeFrame(s)) });
  const result = channel.request('join-request', { id: 'stream', userId: 'viewer' });
  assert.equal(channel.accept({ type:'response', responseId:'foreign', err:0 }), false);
  const response = { type:'response', responseId:sent[0].requestId, err:0, args:{accepted:true} };
  assert.equal(channel.accept(response), true);
  assert.deepEqual(await result, response);
  assert.equal(channel.accept(response), false);
  assert.equal(Object.hasOwn(sent[0], 'token'), false);
  channel.close();
});

test('pending publisher requests are bounded and reclaimed on timeout or disconnect', async () => {
  const channel = createRequestChannel({ send: () => {}, timeoutMs:20, maxPending:1 });
  const timed = assert.rejects(channel.request('join-request', {id:'s'}), /CLIENT_RESPONSE_TIMEOUT/);
  await assert.rejects(channel.request('join-request', {id:'s'}), /QUEUE_LIMIT/);
  await timed;
  const disconnected = assert.rejects(channel.request('join-request', {id:'s'}), /CHANNEL_CLOSED/);
  channel.close(); await disconnected;
  await assert.rejects(channel.request('join-request', {id:'s'}), /CHANNEL_CLOSED/);
});
