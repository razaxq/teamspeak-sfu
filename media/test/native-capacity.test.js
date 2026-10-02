import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {MediaCore} from '../src/core.js';
import {isLiveExpiry,earliestExpiry} from '../src/expiry.js';
import {createAccessRegistry} from '../src/native/access-registry.js';
import {createStreamControl,parseControlCommand} from '../src/native/stream-control.js';
import {startNativePublisherServer} from '../src/native/server.js';
import {createNativePublisherSession} from '../src/native/publisher-session.js';
import {createViewerMediaSession} from '../src/native/viewer-media.js';

const identity=id=>({clientId:id,sessionId:'s'+id,serverId:'server',channelId:'channel',uid:'uid'+id});

test('connection lifetime is explicit; malformed and expired principals fail closed',()=>{
  assert.equal(isLiveExpiry(null),true);
  for(const exp of [undefined,NaN,Infinity,'9999999999',0,-1,1.5])assert.equal(isLiveExpiry(exp),false);
  assert.equal(earliestExpiry(null,123),123);
  assert.equal(earliestExpiry(123,null),123);
  assert.equal(earliestExpiry(null,null),null);
  assert.equal(earliestExpiry(456,123),123);
});

test('connection-bound credentials exceed old quotas and survive two hours but not revocation',async()=>{
  let now=Date.now();
  const registry=createAccessRegistry({resolveClient:async id=>identity(id),now:()=>now});
  const credentials=[];
  for(let i=1;i<=140;i++)credentials.push(await registry.issue(String(i)));
  assert.equal(registry.size,140);
  for(let i=0;i<6;i++) {
    await registry.grantPublisher({clientId:'1',sessionId:'s1',streamId:'stream'+i});
    await registry.grantViewer({clientId:'2',sessionId:'s2',publisherClientId:'1',publisherSessionId:'s1',streamId:'stream'+i});
  }
  now+=2*3600*1000;
  const request={token:credentials[1].token,cmd:'consume-stream',args:{id:'stream5'}};
  assert.equal((await registry.authorize(request)).exp,null);
  registry.revokeClient('1');
  assert.equal(await registry.authorize(request),null);
  registry.clear();assert.equal(registry.size,0);
});

test('more than four publishers and sixteen viewers are admitted without weakening ownership',async t=>{
  const registry=createAccessRegistry({resolveClient:async id=>identity(id)});
  const control=createStreamControl({registry,resolveClient:async id=>identity(id),canPublish:async()=>true,
    canView:async()=>true,endpoint:'sfu.example.org:18344'});
  t.after(()=>{control.close();registry.clear();});
  let first;
  for(let i=1;i<=6;i++){
    const result=await control.dispatch(String(i),'setupstream name=screen type=3 bitrate=2000 accessibility=1 mode=2 viewer_limit=0 audio=0');
    const stream=parseControlCommand(result.notification).args;
    assert.equal(stream.viewer_limit,'0');first??=stream;
  }
  assert.equal(control.size,6);
  const reservations=[];
  for(let i=10;i<=30;i++){
    const clientId=String(i),credential=await registry.issue(clientId);
    await registry.grantViewer({clientId,sessionId:'s'+clientId,publisherClientId:'1',publisherSessionId:'s1',streamId:first.id});
    const principal=await registry.authorize({token:credential.token,cmd:'join-request',args:{id:first.id}});
    const reservation=control.reserveViewer(principal);reservation.activate();reservations.push(reservation);
  }
  const info=parseControlCommand((await control.dispatch('10','requeststreaminfo clid=1')).notification).args;
  assert.equal(info.viewer,'21');
  assert.equal((await control.dispatch('2',`stopstream id=${first.id} reason=1`)).error,2568);
  for(const reservation of reservations)reservation.release();
  assert.equal(parseControlCommand((await control.dispatch('10','requeststreaminfo clid=1')).notification).args.viewer,'0');
});

test('native WebSocket and media admission exceed the previous eight-connection cap',async t=>{
  const core=await MediaCore.create({mediaPort:19521,maxRooms:0,maxPeers:0});
  const server=await startNativePublisherServer({core,authorize:async ({token,args})=>args.id===token ?
    {room:token,peer:token,streamId:token,userId:token,role:'publish',exp:null}:null});
  t.after(async()=>{await server.stop();core.close();});
  for(let i=0;i<12;i++){
    const ws=new WebSocket(`ws://127.0.0.1:${server.port}/`);await once(ws,'open');
    const response=once(ws,'message');
    ws.send(JSON.stringify({cmd:'create-stream',requestId:'1',token:'stream'+i,args:{id:'stream'+i}}));
    assert.equal(JSON.parse((await response)[0]).err,0);
  }
  assert.equal(core.counts().peers,12);assert.equal(core.counts().rooms,12);
});

test('publisher and viewer media remain usable after two hours and revoke on disconnect',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const core=await MediaCore.create({mediaPort:19522,maxRooms:0,maxPeers:0});
  const registry=createAccessRegistry({resolveClient:async id=>identity(id)});
  const pub=await registry.issue('1'),view=await registry.issue('2');
  await registry.grantPublisher({clientId:'1',sessionId:'s1',streamId:'stream'});
  await registry.grantViewer({clientId:'2',sessionId:'s2',publisherClientId:'1',publisherSessionId:'s1',streamId:'stream'});
  const publisher=createNativePublisherSession({core,authorize:registry.authorize});
  const viewer=createViewerMediaSession({core,authorize:registry.authorize,approveJoin:async()=>true,subscribeRevocations:registry.subscribeRevocations});
  t.after(async()=>{await publisher.close();await viewer.close();registry.clear();core.close();});
  const rpc=async(cmd,args)=>JSON.parse(await publisher.dispatch(JSON.stringify({cmd,args:{id:'stream',...args},requestId:'1',token:pub.token})));
  const transport=(await rpc('create-stream',{})).args;
  assert.equal((await rpc('transport-connect',{dtlsParameters:{role:'client',fingerprints:transport.dtlsParameters.fingerprints}})).err,0);
  const produced=await rpc('transport-produce',{kind:'video',paused:true,rtpParameters:{codecs:[{mimeType:'video/AV1',payloadType:105,clockRate:90000,parameters:{}}],encodings:[{ssrc:22334455}],rtcp:{cname:'lifetime'}}});
  assert.equal(produced.err,0);
  const auth={token:view.token,streamId:'stream'},opened=await viewer.open(auth);
  await viewer.connect({...auth,dtlsParameters:{role:'client',fingerprints:opened.transportInfo.dtlsParameters.fingerprints}});
  const consumer=await viewer.consume({...auth,kind:'video',rtpCapabilities:opened.transportInfo.routerCapabilities});
  now+=2*3600*1000;
  assert.equal((await rpc('set-paused',{audio:false,video:false})).err,0);
  await viewer.resume({...auth,consumerId:consumer.id});
  assert.equal(core.counts().consumers,1);
  registry.revokeClient('1');assert.equal(core.counts().consumers,0);
  await assert.rejects(viewer.resume({...auth,consumerId:consumer.id}),/CLOSED/);
});
