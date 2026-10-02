import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaCore } from '../src/core.js';
import { createAccessRegistry } from '../src/native/access-registry.js';
import { createNativeViewerSession } from '../src/native/viewer-session.js';
import { createViewerMediaSession } from '../src/native/viewer-media.js';

async function fixture(t,port,approveJoin=async()=>true,approvalTimeoutMs=1000) {
  const live=new Map(['1','2','3'].map(clientId=>[clientId,{clientId,sessionId:'s'+clientId,
    serverId:'server',channelId:'channel',uid:'uid'+clientId}]));
  const registry=createAccessRegistry({resolveClient:async id=>live.get(id)});
  const core=await MediaCore.create({mediaPort:port});const sessions=[];
  t.after(async()=>{await Promise.all(sessions.map(s=>s.close()));core.close();});
  const publisher=await registry.issue('1');
  await registry.grantPublisher({clientId:'1',sessionId:'s1',streamId:'stream'});
  const viewers=[];
  for(const clientId of ['2','3']) {
    const credential=await registry.issue(clientId);
    await registry.grantViewer({clientId,sessionId:'s'+clientId,publisherClientId:'1',publisherSessionId:'s1',streamId:'stream'});
    const session=createViewerMediaSession({core,authorize:registry.authorize,approveJoin,
      subscribeRevocations:registry.subscribeRevocations,approvalTimeoutMs});sessions.push(session);
    viewers.push({session,auth:{token:credential.token,streamId:'stream'}});
  }
  return {core,registry,publisher,viewers};
}
test('viewer allocates nothing before approval, on denial, or on timeout',async t=>{
  let entered,release;
  const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const f=await fixture(t,19126,async()=>{entered();return await gate;});
  const v=f.viewers[0];const opening=v.session.open(v.auth);
  await ready;assert.equal(f.core.counts().transports,0);
  const denied=assert.rejects(opening,/VIEWER_NOT_APPROVED/);release(false);await denied;
  assert.equal(f.core.counts().peers,0);
  const timeout=createViewerMediaSession({core:f.core,authorize:f.registry.authorize,
    approveJoin:()=>new Promise(()=>{}),approvalTimeoutMs:10});
  await assert.rejects(timeout.open(f.viewers[1].auth),/VIEWER_APPROVAL_TIMEOUT/);
  assert.equal(f.core.counts().transports,0);await timeout.close();
});
test('publisher revocation while approval is pending prevents late allocation',async t=>{
  let entered,release;
  const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const f=await fixture(t,19127,async()=>{entered();return await gate;});
  const v=f.viewers[0];const rejected=assert.rejects(v.session.open(v.auth),/VIEWER_SESSION_CLOSED/);
  await ready;f.registry.revokeStream('stream');release(true);await rejected;
  assert.equal(f.core.counts().rooms,0);
});
test('two approved viewers consume only the admitted publisher and own their consumers',async t=>{
  const f=await fixture(t,19128);
  const principal=await f.registry.authorize({token:f.publisher.token,cmd:'create-stream',args:{id:'stream'}});
  const publisher=await f.core.join(principal);
  const send=await f.core.request(publisher,'createTransport',{direction:'send'});
  const produced=await f.core.request(publisher,'produce',{transportId:send.id,kind:'video',paused:true,
    rtpParameters:{codecs:[{mimeType:'video/AV1',payloadType:105,clockRate:90000,parameters:{}}],
      encodings:[{ssrc:1357911}],rtcp:{cname:'publisher'}}});
  const capabilities=await f.core.request(publisher,'getRouterRtpCapabilities');
  const consumers=[];
  for(const v of f.viewers) {
    const {transportInfo}=await v.session.open(v.auth);
    await v.session.connect({...v.auth,dtlsParameters:{role:'client',fingerprints:transportInfo.dtlsParameters.fingerprints}});
    const consumer=await v.session.consume({...v.auth,kind:'video',rtpCapabilities:capabilities});consumers.push(consumer);
    assert.equal(consumer.producerId,produced.id);assert.equal(consumer.sourcePaused,true);
    assert.equal(consumer.rtpParameters.codecs[0].mimeType,'video/AV1');
    await v.session.resume({...v.auth,consumerId:consumer.id});
  }
  assert.equal(f.core.counts().consumers,2);
  assert.equal(publisher.producers.get(produced.id).paused,true);
  await assert.rejects(f.viewers[0].session.resume({...f.viewers[0].auth,consumerId:consumers[1].id}),/CONSUMER_SCOPE_MISMATCH/);
  await assert.rejects(f.viewers[0].session.consume({...f.viewers[0].auth,kind:'audio',rtpCapabilities:capabilities}),/PUBLISHER_MEDIA_UNAVAILABLE/);
  f.registry.revokeViewer('2','stream');assert.equal(f.core.counts().consumers,1);
  f.registry.revokeClient('1');assert.equal(f.core.counts().consumers,0);
  // Publisher lifecycle belongs to its separate session; viewer revocation
  // cannot close the publisher's transport or resume its source.
  assert.equal(publisher.producers.get(produced.id).paused,true);
});


async function publishAudioVideo(f) {
  const principal=await f.registry.authorize({token:f.publisher.token,cmd:'create-stream',args:{id:'stream'}});
  const peer=await f.core.join(principal),transport=await f.core.request(peer,'createTransport',{direction:'send'});
  for(const kind of ['audio','video'])await f.core.request(peer,'produce',{transportId:transport.id,kind,paused:false,
    rtpParameters:{codecs:[kind==='audio'?{mimeType:'audio/opus',payloadType:111,clockRate:48000,channels:2,parameters:{}}:{mimeType:'video/AV1',payloadType:105,clockRate:90000,parameters:{}}],
      encodings:[{ssrc:kind==='audio'?987001:987002}],rtcp:{cname:'replacement-test'}}});
  return peer;
}

test('consumer replacement and cleanup are scoped, idempotent, and preserve the other track',async t=>{
  const f=await fixture(t,0),publisher=await publishAudioVideo(f),v=f.viewers[0],other=f.viewers[1];
  const {transportInfo}=await v.session.open(v.auth),caps=transportInfo.routerCapabilities;
  const audio=await v.session.consume({...v.auth,kind:'audio',rtpCapabilities:caps});
  const video=await v.session.consume({...v.auth,kind:'video',rtpCapabilities:caps});
  await other.session.open(other.auth);
  const foreign=await other.session.consume({...other.auth,kind:'audio',rtpCapabilities:caps});
  await assert.rejects(v.session.closeConsumer({...v.auth,consumerId:foreign.id}),/CONSUMER_SCOPE_MISMATCH/);
  await assert.rejects(v.session.consume({...v.auth,kind:'audio',rtpCapabilities:caps,replaceConsumerId:video.id}),/CONSUMER_SCOPE_MISMATCH/);
  const renewed=await v.session.consume({...v.auth,kind:'audio',rtpCapabilities:caps,replaceConsumerId:audio.id});
  assert.notEqual(renewed.id,audio.id);assert.equal(renewed.producerId,audio.producerId);
  assert.equal(f.core.counts().consumers,3);assert.equal(publisher.producers.size,2);
  await v.session.closeConsumer({...v.auth,consumerId:audio.id});
  await v.session.closeConsumer({...v.auth,consumerId:audio.id});
  assert.equal(f.core.counts().consumers,3);
  await assert.rejects(v.session.closeConsumer({...v.auth,consumerId:audio.producerId}),/CONSUMER_SCOPE_MISMATCH/);
  await v.session.closeConsumer({...v.auth,consumerId:renewed.id});
  assert.equal(f.core.counts().consumers,2);
  f.registry.revokeClient('2');
  await assert.rejects(v.session.closeConsumer({...v.auth,consumerId:audio.id}),/VIEWER_SESSION_CLOSED/);
});

for(const closeFirst of [false,true])test(`opt-in audio refresh replaces once with old cleanup ${closeFirst?'before':'after'} consume`,async t=>{
  const f=await fixture(t,0);await publishAudioVideo(f);
  const auth=f.viewers[0].auth,requests=[],events=[];
  const session=createNativeViewerSession({core:f.core,authorize:f.registry.authorize,approveJoin:async()=>true,
    requestClient:async(cmd,args)=>{requests.push({cmd,args});return {err:0};},audioRefresh:true,onEvent:e=>events.push(e)});
  t.after(()=>session.close());
  let seq=0;
  const rpc=async(cmd,args)=>{const response=JSON.parse(await session.dispatch(JSON.stringify({cmd,args:{id:'stream',...args},token:auth.token,requestId:String(++seq)})));session.afterResponse();return response.args;};
  const until=async predicate=>{for(let i=0;i<200&&!predicate();i++)await new Promise(r=>setTimeout(r,5));assert.ok(predicate());};
  await rpc('join-request',{isRemove:false,signedIdentityType:0,signedIdentity:'synthetic',codecs:['AV1']});
  await until(()=>requests.some(r=>r.cmd==='join-response'));
  const {transportInfo}=requests.find(r=>r.cmd==='join-response').args;
  const initial=await rpc('consume-stream',{rtpCapabilities:transportInfo.routerCapabilities});
  await rpc('transport-connect',{dtlsParameters:{role:'client',fingerprints:transportInfo.dtlsParameters.fingerprints}});
  await rpc('set-paused',{audio:false,video:false});
  await until(()=>requests.some(r=>r.cmd==='main-producer-changed'));
  assert.deepEqual(requests.find(r=>r.cmd==='main-producer-changed').args,{id:'stream',userId:session.principal.publisherPeer,kind:'audio',codec:'opus'});
  if(closeFirst)await rpc('close-consumer-producer',{kind:'consumer',consumerProducerId:initial.audio.id});
  const refreshed=await rpc('consume-stream',{filter:'audio',rtpCapabilities:transportInfo.routerCapabilities});
  assert.notEqual(refreshed.audio.id,initial.audio.id);assert.equal(refreshed.video,undefined);
  await rpc('close-consumer-producer',{kind:'consumer',consumerProducerId:initial.audio.id});
  await rpc('set-paused',{audio:false,video:false});
  const again=await rpc('consume-stream',{filter:'audio',rtpCapabilities:transportInfo.routerCapabilities});
  assert.equal(again.audio.id,refreshed.audio.id);
  const unchanged=await rpc('consume-stream',{filter:'video',rtpCapabilities:transportInfo.routerCapabilities});
  assert.equal(unchanged.video.id,initial.video.id);assert.equal(f.core.counts().consumers,2);
  assert.equal(events.filter(e=>e.event==='native-viewer-audio-refreshed').length,1);
  await assert.rejects(rpc('close-consumer-producer',{kind:'producer',consumerProducerId:initial.audio.producerId}),/INVALID_CONSUMER_CLOSE/);
});
