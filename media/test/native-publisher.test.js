import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaCore } from '../src/core.js';
import { createNativePublisherSession } from '../src/native/publisher-session.js';
const empty = { rooms: 0, peers: 0, transports: 0, producers: 0, consumers: 0 };
const claims = (peer = 'publisher') => ({ room: 'server/channel/stream', peer,
  streamId: 'stream', userId: peer, role: 'publish', exp: Math.floor(Date.now() / 1000) + 60 });
const frame = (cmd, args = { id: 'stream' }) => JSON.stringify({ cmd, requestId: 'request', token: 'synthetic', args });
async function setup(t, port) {
  const core = await MediaCore.create({ mediaPort: port });
  t.after(() => core.close()); return core;
}
function session(t, core, principal = claims(), extra = {}) {
  // Static callbacks support success=0; authorization remains synthetic.
  const s = createNativePublisherSession({ core, successCode: 0, authorize: async () => principal, ...extra });
  t.after(() => s.close()); return s;
}
test('native publisher creates real transport, scopes IDs and installs DTLS parameters', async t => {
  const core = await setup(t, 19110), s = session(t, core);
  await assert.rejects(s.dispatch(frame('transport-connect')), /STREAM_NOT_CREATED/);
  const created = JSON.parse(await s.dispatch(frame('create-stream')));
  assert.equal(created.responseId, 'request');
  assert.equal(created.args.iceParameters.iceLite, true);
  assert.ok(created.args.iceCandidates.length);
  assert.ok(created.args.dtlsParameters.fingerprints.length);
  assert.ok(created.args.routerCapabilities.codecs.some(c => c.mimeType === 'audio/opus'));
  await assert.rejects(s.dispatch(frame('create-stream')), /STREAM_ALREADY_CREATED/);
  await assert.rejects(s.dispatch(frame('transport-connect', { id: created.args.id })), /STREAM_SCOPE_MISMATCH/);
  await assert.rejects(s.dispatch(frame('transport-connect', { id: 'stream', userId: 'other' })), /USER_SCOPE_MISMATCH/);
  const response = JSON.parse(await s.dispatch(frame('transport-connect', { id: 'stream',
    userId: 'publisher', dtlsParameters: { role: 'client', fingerprints: created.args.dtlsParameters.fingerprints } })));
  assert.deepEqual(response, { responseId: 'request', err: 0 });
  // Parameter installation is not an actual remote DTLS handshake.
  const peer = core.rooms.values().next().value.peers.values().next().value;
  assert.equal(peer.transports.get(created.args.id).dtlsParameters.role, 'server');
  await assert.rejects(s.dispatch(frame('transport-connect')), /TRANSPORT_ALREADY_CONNECTED/);
  await s.close(); assert.deepEqual(core.counts(), empty);
});
test('missing verifier, changed scope and revoked authorization protect media resources', async t => {
  const core = await setup(t, 19111);
  const unverified = session(t, core, claims(), { authorize: undefined });
  await assert.rejects(unverified.dispatch(frame('create-stream')), /NATIVE_AUTH_UNAVAILABLE/);
  assert.deepEqual(core.counts(), empty);
  let principal = claims();
  const s = session(t, core, null, { authorize: async () => principal });
  await s.dispatch(frame('create-stream'));
  principal = { ...principal, room: 'another-server' };
  await assert.rejects(s.dispatch(frame('transport-connect')), /SESSION_SCOPE_MISMATCH/);
  principal = null;
  await assert.rejects(s.dispatch(frame('transport-connect')), /NATIVE_AUTH_REJECTED/);
  assert.deepEqual(core.counts(), empty);
});
test('concurrent sessions share a router and duplicate create allocates once', async t => {
  const core = await setup(t, 19112);
  const a = session(t, core, claims('a')), b = session(t, core, claims('b'));
  const result = await Promise.allSettled([a.dispatch(frame('create-stream')),
    a.dispatch(frame('create-stream')), b.dispatch(frame('create-stream'))]);
  assert.deepEqual(result.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.match(result[1].reason.message, /STREAM_ALREADY_CREATED/);
  assert.deepEqual(core.counts(), { ...empty, rooms: 1, peers: 2, transports: 2 });
  await Promise.all([a.close(), b.close()]); assert.deepEqual(core.counts(), empty);
});
test('close during allocation cleans up; bounded queue rejects excess work', async t => {
  const core = await setup(t, 19113);
  let entered, release;
  const ready = new Promise(r => { entered = r; }), gate = new Promise(r => { release = r; });
  const adapter = { async join(...args) { entered(); await gate; return core.join(...args); },
    request: (...args) => core.request(...args), leave: peer => core.leave(peer) };
  const s = session(t, adapter, claims(), { maxPending: 1 });
  const creating = assert.rejects(s.dispatch(frame('create-stream')), /SESSION_CLOSED/);
  await ready;
  await assert.rejects(s.dispatch(frame('create-stream')), /QUEUE_LIMIT/);
  const closing = s.close(); release();
  await Promise.all([closing, creating]); assert.deepEqual(core.counts(), empty);
});
test('idle publisher expiry reclaims resources without another request', async t => {
  const core = await setup(t, 19114);
  const principal = { ...claims(), exp: Math.floor(Date.now() / 1000) + 2 };
  const s = session(t, core, principal);
  await s.dispatch(frame('create-stream'));
  await new Promise(r => setTimeout(r, principal.exp * 1000 - Date.now() + 40));
  assert.deepEqual(core.counts(), empty);
  await assert.rejects(s.dispatch(frame('transport-connect')), /SESSION_CLOSED/);
});
test('close-stream cannot close another stream or publisher', async t => {
  const core = await setup(t, 19115), s = session(t, core);
  await s.dispatch(frame('create-stream'));
  await assert.rejects(s.dispatch(frame('close-stream', { id: 'other' })), /STREAM_SCOPE_MISMATCH/);
  await assert.rejects(s.dispatch(frame('close-stream', { id: 'stream', userId: 'other' })), /USER_SCOPE_MISMATCH/);
  assert.equal(core.counts().transports, 1);
  assert.equal(JSON.parse(await s.dispatch(frame('close-stream'))).err, 0);
  assert.deepEqual(core.counts(), empty);
  await assert.rejects(s.dispatch(frame('create-stream')), /SESSION_CLOSED/);
});
