import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { MediaCore } from '../src/core.js';
import { startNativePublisherServer } from '../src/native/server.js';
import { createViewerApprovalBroker } from '../src/native/viewer-approval.js';
const principal = () => ({ room: 'native-test', peer: 'publisher', streamId: 'stream',
  userId: 'publisher', role: 'publish', exp: Math.floor(Date.now() / 1000) + 60 });
async function open(port, options) { const ws = new WebSocket(`ws://127.0.0.1:${port}/`, options); await once(ws, 'open'); return ws; }
async function rpc(ws, cmd, args, token = 'synthetic') {
  const result = once(ws, 'message');
  ws.send(JSON.stringify({ cmd, args, token, requestId: '1' }));
  return JSON.parse((await result)[0]);
}
test('native WebSocket publishes initially paused audio and applies set-paused', { timeout: 5000 }, async t => {
  const core = await MediaCore.create({ mediaPort: 19120 });
  const identity = principal();
  const server = await startNativePublisherServer({ core, authorize: request => request.token === 'synthetic' && identity });
  t.after(async () => { await server.stop(); core.close(); });
  const ws = await open(server.port);
  const { args: transport } = await rpc(ws, 'create-stream', { id: 'stream' });
  await rpc(ws, 'transport-connect', { id: 'stream', dtlsParameters: {
    role: 'client', fingerprints: transport.dtlsParameters.fingerprints,
  } });
  const produced = await rpc(ws, 'transport-produce', { id: 'stream', kind: 'audio', paused: true,
    rtpParameters: { codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2,
      parameters: {} }], encodings: [{ ssrc: 123123 }], rtcp: { cname: 'native-test' } } });
  assert.equal(produced.err, 0); assert.equal(typeof produced.args.id, 'string');
  const producer = core.rooms.get(identity.room).peers.get(identity.peer).producers.get(produced.args.id);
  assert.equal(producer.paused, true);
  await rpc(ws, 'set-paused', { id: 'stream', audio: false, video: false });
  assert.equal(producer.paused, false);
  await rpc(ws, 'set-paused', { id: 'stream', audio: true, video: false });
  assert.equal(producer.paused, true);
  const closed = once(ws, 'close'); ws.close(); await closed;
  for (let i = 0; i < 100 && core.counts().peers; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(core.counts().peers, 0); assert.equal(core.counts().producers, 0);
});
test('native endpoint refuses absent verifier, invalid auth, binary frames and untrusted origins', { timeout: 5000 }, async t => {
  await assert.rejects(startNativePublisherServer({}), /verifier required/);
  const core = await MediaCore.create({ mediaPort: 19121 });
  const desktopOrigin = 'ws://sfu.example.org:18344';
  const server = await startNativePublisherServer({ core, authorize: () => null, allowedOrigins: [desktopOrigin] });
  t.after(async () => { await server.stop(); core.close(); });
  const origin = new WebSocket(`ws://127.0.0.1:${server.port}/`, { origin: 'https://invalid.example' });
  assert.match((await once(origin, 'error'))[0].message, /403/);
  // The observed desktop Origin passes the handshake, but still needs a valid token.
  const unauthorized = await open(server.port, { origin: desktopOrigin }), rejected = once(unauthorized, 'close');
  unauthorized.send(JSON.stringify({ cmd: 'create-stream', requestId: '1', args: { id: 'stream' }, token: 'trustme' }));
  assert.equal((await rejected)[0], 1008);
  const binary = await open(server.port), closed = once(binary, 'close'); binary.send(Buffer.from('{}'));
  assert.equal((await closed)[0], 1008);
  assert.equal(core.counts().rooms, 0);
});
test('publisher abort acknowledges close-stream before normal WebSocket shutdown', { timeout: 5000 }, async t => {
  const core = await MediaCore.create({ mediaPort: 19122 });
  const server = await startNativePublisherServer({ core, authorize: () => principal() });
  t.after(async () => { await server.stop(); core.close(); });
  const ws = await open(server.port);
  await rpc(ws, 'create-stream', { id: 'stream' });
  const closed = once(ws, 'close');
  assert.equal((await rpc(ws, 'close-stream', { id: 'stream' })).err, 0);
  assert.equal((await closed)[0], 1000);
  assert.equal(core.counts().transports, 0);
  assert.equal(core.counts().rooms, 0);
});
test('server requests reach only a bound publisher and responses stay on its socket', { timeout: 5000 }, async t => {
  const core = await MediaCore.create({ mediaPort: 19123 });
  const server = await startNativePublisherServer({ core, authorize: () => principal() });
  t.after(async () => { await server.stop(); core.close(); });
  const target = {streamId:'stream',publisherUserId:'publisher',cmd:'join-request',args:{userId:'viewer'}};
  const ws = await open(server.port);
  await assert.rejects(server.requestPublisher(target), /unavailable/);
  await rpc(ws, 'create-stream', {id:'stream'});
  await assert.rejects(server.requestPublisher({...target,publisherUserId:'someone-else'}), /unavailable/);
  const received = once(ws, 'message');
  const response = server.requestPublisher(target);
  const request = JSON.parse((await received)[0]);
  assert.equal(request.cmd,'join-request'); assert.equal(request.args.id,'stream');
  assert.equal(Object.hasOwn(request,'token'),false);
  ws.send(JSON.stringify({responseId:request.requestId,err:0}));
  assert.equal((await response).err,0);
  const disconnected = assert.rejects(server.requestPublisher(target), /CHANNEL_CLOSED/);
  ws.close(); await disconnected;
});
test('native publisher join-response completes the separately correlated viewer approval', { timeout: 5000 }, async t => {
  const core=await MediaCore.create({mediaPort:19129});let server;
  const broker=createViewerApprovalBroker({requestPublisher:request=>server.requestPublisher(request)});
  server=await startNativePublisherServer({core,authorize:()=>principal(),onJoinResponse:broker.acceptPublisherDecision});
  t.after(async()=>{broker.close();await server.stop();core.close();});
  const ws=await open(server.port);await rpc(ws,'create-stream',{id:'stream'});
  const incoming=once(ws,'message');
  const approval=broker.approveJoin({principal:{role:'view',streamId:'stream',userId:'viewer',publisherPeer:'publisher'},approvalData:{codecs:5}});
  const request=JSON.parse((await incoming)[0]);assert.equal(request.cmd,'join-request');
  ws.send(JSON.stringify({responseId:request.requestId,err:0}));
  const response=await rpc(ws,'join-response',{id:'stream',userId:'viewer',accepted:true});
  assert.equal(response.err,0);assert.equal(await approval,true);ws.close();
});

test('candidate viewer wire acknowledges join before approval and returns native audio consume shape', {timeout:8000}, async t=>{
  const core=await MediaCore.create({mediaPort:19140});
  let reservations=0,active=0;
  const pub=principal(),view={...pub,peer:'viewer',userId:'viewer',role:'view',publisherPeer:'publisher'};
  const server=await startNativePublisherServer({core,enableViewers:true,audioActivation:true,
    reserveViewer:()=>{reservations++;let activated=false,released=false;return {
      activate(){if(!activated){activated=true;active++;}},release(){if(!released){released=true;reservations--;if(activated)active--;}}
    };},
    authorize:r=>r.token==='publisher-token'?pub:r.token==='viewer-token'?view:null});
  t.after(async()=>{await server.stop();core.close();});
  const publisher=await open(server.port);
  const send=(ws,cmd,args,token,id)=>ws.send(JSON.stringify({cmd,args,token,requestId:id}));
  const transport=(await rpc(publisher,'create-stream',{id:'stream'},'publisher-token')).args;
  await rpc(publisher,'transport-connect',{id:'stream',dtlsParameters:{role:'client',fingerprints:transport.dtlsParameters.fingerprints}},'publisher-token');
  await rpc(publisher,'transport-produce',{id:'stream',kind:'audio',paused:true,
    rtpParameters:{codecs:[{mimeType:'audio/opus',payloadType:111,clockRate:48000,channels:2,parameters:{}}],
      encodings:[{ssrc:909090}],rtcp:{cname:'viewer-wire-test'}}},'publisher-token');
  await rpc(publisher,'transport-produce',{id:'stream',kind:'video',paused:true,
    rtpParameters:{codecs:[{mimeType:'video/AV1',payloadType:105,clockRate:90000,parameters:{}}],
      encodings:[{ssrc:909091}],rtcp:{cname:'viewer-wire-test'}}},'publisher-token');
  const viewer=await open(server.port),messages=[],waiters=[];
  viewer.on('message',data=>{const value=JSON.parse(data);if(waiters.length)waiters.shift()(value);else messages.push(value);});
  const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise(resolve=>waiters.push(resolve));
  const joinAtPublisher=once(publisher,'message');
  send(viewer,'join-request',{id:'stream',userId:'publisher',signedIdentityType:0,signedIdentity:'synthetic',isRemove:false,codecs:['audio/opus']},'viewer-token','join');
  assert.deepEqual(await next(),{responseId:'join',err:0});
  assert.equal(reservations,1);assert.equal(active,0);
  const forwarded=JSON.parse((await joinAtPublisher)[0]);
  assert.equal(forwarded.args.isRemove,false);assert.equal(forwarded.args.userId,'viewer');
  assert.equal(core.counts().transports,1);
  publisher.send(JSON.stringify({responseId:forwarded.requestId,err:0}));
  assert.equal(core.counts().transports,1); // RPC ack alone cannot allocate media.
  await rpc(publisher,'join-response',{id:'stream',userId:'viewer',accepted:true},'publisher-token');
  const joined=await next();assert.equal(joined.cmd,'join-response');assert.equal(joined.args.userId,'publisher');
  assert.equal(joined.args.accepted,true);assert.equal(joined.args.videoCodec,'AV1');assert.equal(joined.args.audioCodec,'opus');const recv=joined.args.transportInfo;
  viewer.send(JSON.stringify({responseId:joined.requestId,err:0}));
  send(viewer,'consume-stream',{id:'stream',userId:'publisher',filter:'audio',rtpCapabilities:recv.routerCapabilities},'viewer-token','consume');
  const consumed=await next();assert.equal(consumed.responseId,'consume');
  assert.equal(consumed.args.audio.kind,'audio');assert.equal(consumed.args.audio.sourcePaused,true);
  assert.equal(consumed.args.video,undefined);
  send(viewer,'set-paused',{id:'stream',userId:'publisher',audio:true,video:false},'viewer-token','pause-before-connect');
  assert.equal((await next()).err,0);
  send(viewer,'transport-connect',{id:'stream',dtlsParameters:{role:'client',fingerprints:recv.dtlsParameters.fingerprints}},'viewer-token','connect');
  assert.equal((await next()).err,0);
  const source=[...core.rooms.get(pub.room).peers.get('publisher').producers.values()][0];
  const receiver=[...core.rooms.get(pub.room).peers.get('viewer').consumers.values()][0];
  assert.equal(receiver.paused,true);
  await core.request(core.rooms.get(pub.room).peers.get('publisher'),'setProducerPaused',{producerId:source.id,paused:false});
  send(viewer,'set-paused',{id:'stream',userId:'publisher',audio:false,video:false},'viewer-token','ready');
  assert.equal((await next()).err,0);
  const sourceState=await next();
  assert.equal(sourceState.cmd,'set-paused');
  assert.deepEqual(sourceState.args,{id:'stream',userId:'publisher',audio:true,video:true});
  assert.equal(receiver.paused,true);assert.equal(source.paused,false);
  // Native receiver echoes its effective state before acknowledging the update.
  send(viewer,'set-paused',{id:'stream',audio:true,video:true},'viewer-token','activation-echo');
  assert.equal((await next()).responseId,'activation-echo');
  viewer.send(JSON.stringify({responseId:sourceState.requestId,err:0}));
  const restored=await next();assert.equal(restored.cmd,'set-paused');
  assert.deepEqual(restored.args,{id:'stream',userId:'publisher',audio:false,video:true});
  assert.equal(receiver.paused,false);
  viewer.send(JSON.stringify({responseId:restored.requestId,err:0}));
  send(viewer,'set-paused',{id:'stream',userId:'publisher',audio:true},'viewer-token','pause');
  assert.equal((await next()).err,0);assert.equal(receiver.paused,true);
  send(viewer,'set-paused',{id:'stream',userId:'publisher',audio:false},'viewer-token','resume');
  assert.equal((await next()).err,0);assert.equal(receiver.paused,false);
  assert.equal(source.paused,false); // Activation cannot change the publisher's state.
  assert.equal(active,1);
  const removed=once(publisher,'message');
  send(viewer,'join-request',{id:'stream',isRemove:true},'viewer-token','close');
  assert.equal((await next()).responseId,'close');
  const departure=JSON.parse((await removed)[0]);
  assert.equal(departure.cmd,'join-request');assert.equal(departure.args.isRemove,true);
  assert.equal(departure.args.userId,'viewer');assert.equal(departure.args.signedIdentity,'synthetic');
  publisher.send(JSON.stringify({responseId:departure.requestId,err:0}));
  assert.equal(active,0);assert.equal(reservations,0);
  assert.equal(core.counts().consumers,0);assert.equal(core.counts().transports,1);
});

test('candidate viewing rejects publisher denial and cancels disconnect while approval is pending', {timeout:5000},async t=>{
  const core=await MediaCore.create({mediaPort:19141});
  const pub=principal(),view={...pub,peer:'viewer',userId:'viewer',role:'view',publisherPeer:'publisher'};
  const server=await startNativePublisherServer({core,enableViewers:true,
    authorize:r=>r.token==='pub'?pub:r.token==='view'?view:null});
  t.after(async()=>{await server.stop();core.close();});
  const publisher=await open(server.port);
  await rpc(publisher,'create-stream',{id:'stream'},'pub');
  for(const deny of [true,false]) {
    const viewer=await open(server.port),forwarded=once(publisher,'message');
    assert.equal((await rpc(viewer,'join-request',{id:'stream',signedIdentityType:0,signedIdentity:'synthetic',isRemove:false,codecs:[]},'view')).err,0);
    const message=JSON.parse((await forwarded)[0]);
    publisher.send(JSON.stringify({responseId:message.requestId,err:0}));
    assert.equal(core.counts().transports,1);
    const closed=once(viewer,'close');
    if(deny) await rpc(publisher,'join-response',{id:'stream',userId:'viewer',accepted:false},'pub');
    else viewer.close();
    await closed;
    assert.equal(core.counts().transports,1);assert.equal(core.counts().consumers,0);
  }
});

test('candidate viewer token cannot publish or escape its bound stream', {timeout:5000},async t=>{
  const core=await MediaCore.create({mediaPort:19142});
  const view={...principal(),role:'view',publisherPeer:'publisher',peer:'viewer',userId:'viewer'};
  const server=await startNativePublisherServer({core,enableViewers:true,authorize:()=>view});
  t.after(async()=>{await server.stop();core.close();});
  for(const [cmd,args] of [['create-stream',{id:'stream'}],['join-request',{id:'other'}]]){
    const ws=await open(server.port),closed=once(ws,'close');
    ws.send(JSON.stringify({cmd,args,token:'viewer',requestId:'test'}));
    assert.equal((await closed)[0],1008);assert.equal(core.counts().transports,0);
  }
});

test('viewer can remove a pending join and a late publisher decision does not disconnect the publisher',{timeout:5000},async t=>{
  const core=await MediaCore.create({mediaPort:19143}),pub=principal();
  const view={...pub,peer:'viewer',userId:'viewer',role:'view',publisherPeer:'publisher'};
  const server=await startNativePublisherServer({core,enableViewers:true,authorize:r=>r.token==='pub'?pub:view});
  t.after(async()=>{await server.stop();core.close();});
  const publisher=await open(server.port),viewer=await open(server.port);
  await rpc(publisher,'create-stream',{id:'stream'},'pub');
  const forwarded=once(publisher,'message');
  await rpc(viewer,'join-request',{id:'stream',isRemove:false,signedIdentityType:0,signedIdentity:'test',codecs:[]},'view');
  const request=JSON.parse((await forwarded)[0]);publisher.send(JSON.stringify({responseId:request.requestId,err:0}));
  const removed=once(publisher,'message');
  assert.equal((await rpc(viewer,'join-request',{id:'stream',isRemove:true},'view')).err,0);
  const departure=JSON.parse((await removed)[0]);assert.equal(departure.args.isRemove,true);
  publisher.send(JSON.stringify({responseId:departure.requestId,err:0}));
  assert.equal((await rpc(publisher,'join-response',{id:'stream',userId:'viewer',accepted:true},'pub')).err,0);
  assert.equal(publisher.readyState,WebSocket.OPEN);assert.equal(core.counts().transports,1);
});

test('idle viewer expiry releases its counted slot and receive transport',{timeout:5000},async t=>{
  const core=await MediaCore.create({mediaPort:19144}),pub=principal();let slots=0,active=0;
  const view={...pub,peer:'viewer',userId:'viewer',role:'view',publisherPeer:'publisher',exp:Math.floor(Date.now()/1000)+2};
  const server=await startNativePublisherServer({core,enableViewers:true,authorize:r=>r.token==='pub'?pub:view,
    reserveViewer:()=>{slots++;let counted=false,released=false;return {
      activate(){counted=true;active++;},release(){if(released)return;released=true;slots--;if(counted)active--;}
    };}});
  t.after(async()=>{await server.stop();core.close();});
  const publisher=await open(server.port),viewer=await open(server.port);
  await rpc(publisher,'create-stream',{id:'stream'},'pub');
  const requestAtPublisher=once(publisher,'message');
  await rpc(viewer,'join-request',{id:'stream',isRemove:false,signedIdentityType:0,signedIdentity:'test',codecs:[]},'view');
  const request=JSON.parse((await requestAtPublisher)[0]);publisher.send(JSON.stringify({responseId:request.requestId,err:0}));
  const joined=once(viewer,'message');
  await rpc(publisher,'join-response',{id:'stream',userId:'viewer',accepted:true},'pub');
  const message=JSON.parse((await joined)[0]);viewer.send(JSON.stringify({responseId:message.requestId,err:0}));
  for(let i=0;i<100&&!active;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(active,1);assert.equal(slots,1);
  const departure=once(publisher,'message');assert.equal((await once(viewer,'close'))[0],1008);
  const remove=JSON.parse((await departure)[0]);publisher.send(JSON.stringify({responseId:remove.requestId,err:0}));
  assert.equal(slots,0);assert.equal(active,0);assert.equal(core.counts().transports,1);
});
