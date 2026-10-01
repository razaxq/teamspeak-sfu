import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaCore } from '../src/core.js';
import { createNativePublisherSession } from '../src/native/publisher-session.js';
import { collectMediaDiagnostics } from '../src/native/media-diagnostics.js';

test('paused AV1 producer remains visible before its first RTP packet', async t => {
  const core = await MediaCore.create({ mediaPort: 19124 });
  const exp=Math.floor(Date.now()/1000)+60;
  const session = createNativePublisherSession({ core, authorize: () => ({
    room: 'private-room', peer: 'private-peer', streamId: 'private-stream', userId: 'private-user',
    role: 'publish', exp }) });
  t.after(async () => { await session.close(); core.close(); });
  const rpc = async (cmd,args) => JSON.parse(await session.dispatch(JSON.stringify({cmd,
    requestId:'private-request',token:'private-token',args:{id:'private-stream',...args}})));
  const {args:transport} = await rpc('create-stream');
  await rpc('transport-connect',{dtlsParameters:{role:'client',fingerprints:transport.dtlsParameters.fingerprints}});
  await rpc('transport-produce',{kind:'video',paused:true,rtpParameters:{codecs:[{
    mimeType:'video/AV1',payloadType:105,clockRate:90000,parameters:{}}],
    encodings:[{ssrc:987654}],rtcp:{cname:'private-cname'}}});
  const snapshot = await collectMediaDiagnostics(core);
  assert.deepEqual(snapshot.producers,[{kind:'video',paused:true,mimeType:'video/AV1',rtpObserved:false}]);
  assert.ok(!JSON.stringify(snapshot).includes('private-'));
  await rpc('set-paused',{audio:false,video:false});
  assert.equal((await collectMediaDiagnostics(core)).producers[0].paused,false);
  assert.equal((await collectMediaDiagnostics(core)).producers[0].rtpObserved,false);
  const viewer=await core.join({room:'private-room',peer:'private-viewer',role:'view',exp});
  const recv=await core.request(viewer,'createTransport',{direction:'recv'});
  const producer=[...core.rooms.get('private-room').peers.get('private-peer').producers.values()][0];
  await core.request(viewer,'consume',{transportId:recv.id,producerId:producer.id,rtpCapabilities:await core.request(viewer,'getRouterRtpCapabilities')});
  const diagnostics=await collectMediaDiagnostics(core);
  assert.equal(diagnostics.consumers[0].kind,'video');assert.equal(diagnostics.consumers[0].paused,true);
  assert.equal(diagnostics.consumers[0].sourcePaused,false);assert.equal(diagnostics.consumers[0].rtpSent,false);
  assert.equal(JSON.stringify(diagnostics).includes('private-'),false);
  core.leave(viewer);
});
