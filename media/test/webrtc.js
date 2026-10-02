// Real Chromium ICE/DTLS/SRTP test; synthetic canvas and oscillator avoid cameras/mics.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startServer } from '../src/server.js';
import { build } from 'esbuild';
import { randomBytes } from 'node:crypto';
import { startNativePublisherServer } from '../src/native/server.js';
import { issueToken } from '../src/auth.js';
import { collectMediaDiagnostics } from '../src/native/media-diagnostics.js';
import { createViewerMediaSession } from '../src/native/viewer-media.js';
const nativePublisher = process.env.NATIVE_PUBLISHER === '1';
const nativeViewer = process.env.NATIVE_VIEWER === '1';
const audioRefresh=process.env.NATIVE_AUDIO_REFRESH === '1';
const audioFirst=nativeViewer && process.env.NATIVE_AUDIO_FIRST!=='0';
if(audioRefresh&&!nativeViewer)throw new Error('Audio refresh test requires native viewers');
const viewerTokens=new Map();
const viewerMediaAdapter = process.env.VIEWER_MEDIA_ADAPTER === '1';
if(nativeViewer && (!nativePublisher || viewerMediaAdapter))throw new Error('Native viewer needs native publisher without bridge');
if(viewerMediaAdapter && !nativePublisher)throw new Error('Viewer adapter test requires native publisher');
const viewerSessions=[];
const videoCodec = process.env.NATIVE_VIDEO_CODEC;
if (videoCodec && (!nativePublisher || videoCodec !== 'video/AV1')) throw new Error('Unsupported forced codec test');
const externalUrl=process.env.SFU_TEST_URL;
if (nativePublisher && externalUrl) throw new Error('Native publisher test requires the local test core');
if (externalUrl && !/^http:\/\/127\.0\.0\.1:\d+$/.test(externalUrl)) throw new Error('Tests require a loopback HTTP URL');
const secret=externalUrl?process.env.SFU_SECRET:'webrtc-integration-secret-'.repeat(2);
const mediaPort=externalUrl?Number(process.env.MEDIA_PORT||19000):19110;
const app=externalUrl?null:await startServer({secret,port:0,coreOptions:{mediaPort}});
const url=externalUrl||`http://127.0.0.1:${app.port}`;
const nativeToken = randomBytes(32).toString('hex');
const nativeIdentity = { room: 'webrtc', peer: 'publisher', streamId: 'stream', userId: 'publisher',
  role: 'publish', exp: Math.floor(Date.now() / 1000) + 120 };
let nativeServer;
async function counts() {
  if (app) return app.core.counts();
  const health=await (await fetch(url+'/health')).json();
  return Object.fromEntries(['rooms','peers','transports','producers','consumers'].map(k=>[k,health[k]]));
}
let browser;
const report={time:new Date().toISOString(),nativeTeamspeakTested:false,mediaPort,container:!!externalUrl,nativePublisherEnvelope:nativePublisher,syntheticNativeAuthorization:nativePublisher};
try {
  if(nativeViewer){
    report.nativeViewerEnvelope=true;report.syntheticPublisherApproval=true;report.officialViewerWireTested=false;
    await build({entryPoints:['test/native-viewer-browser-client.js'],bundle:true,format:'iife',outfile:'.runtime/native-viewer-browser-client.js'});
  }
  if(viewerMediaAdapter){
    report.viewerMediaAdapter=true;report.syntheticPublisherApproval=true;report.officialViewerWireTested=false;
    await build({entryPoints:['test/viewer-media-browser-client.js'],bundle:true,format:'iife',outfile:'.runtime/viewer-media-browser-client.js'});
  }
  if (nativePublisher) {
    nativeServer = await startNativePublisherServer({ core: app.core, allowedOrigins: [url],enableViewers:nativeViewer,audioFirst,audioRefresh,
      authorize: request => request.token === nativeToken ? nativeIdentity : viewerTokens.get(request.token) });
    await build({ entryPoints: ['test/native-browser-client.js'], bundle: true, format: 'iife',
      outfile: '.runtime/native-browser-client.js' });
  }
  browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  report.browser=browser.version();
  async function client(peer,role) {
    const page=await browser.newPage();
    await page.goto(url+'/lab');
    await page.waitForFunction(()=>!!window.LabClient);
    if(nativeViewer && role==='view'){
      const token=randomBytes(32).toString('hex');
      viewerTokens.set(token,{...nativeIdentity,peer,userId:peer,role:'view',publisherPeer:'publisher'});
      await page.addScriptTag({path:'.runtime/native-viewer-browser-client.js'});
      await page.evaluate(async options=>{window.lab=new window.NativeViewer();await window.lab.connect(options);},
        {url:`ws://127.0.0.1:${nativeServer.port}/`,token,streamId:'stream',expectAudioRefresh:audioRefresh});
      return page;
    }
    if(viewerMediaAdapter && role==='view'){
      const token=randomBytes(32).toString('hex');
      const identity={...nativeIdentity,peer,userId:peer,role:'view',publisherPeer:'publisher'};
      const auth={token,streamId:'stream'};
      const session=createViewerMediaSession({core:app.core,
        authorize:request=>request.token===token && request.args.id==='stream' && identity,
        approveJoin:async()=>true,
        onEvent:message=>{void page.evaluate(m=>window.lab?.onEvent(m),message).catch(()=>{});}});
      viewerSessions.push(session);page.on('close',()=>{void session.close();});
      await page.exposeFunction('viewerMediaRpc',async(method,data)=>{
        if(method==='open')return session.open(auth);
        if(method==='connect')return session.connect({...auth,dtlsParameters:data.dtlsParameters});
        if(method==='consume'){
          const source=app.core.rooms.get('webrtc')?.peers.get('publisher')?.producers.get(data.producerId);
          assert.ok(source);return session.consume({...auth,kind:source.kind,rtpCapabilities:data.rtpCapabilities});
        }
        if(method==='resume')return session.resume({...auth,consumerId:data.consumerId});
        if(method==='close')return session.close();
        throw new Error('Unknown test bridge method');
      });
      await page.addScriptTag({path:'.runtime/viewer-media-browser-client.js'});
      await page.evaluate(async()=>{window.lab=new window.ViewerMediaTestClient();await window.lab.connect();});
      return page;
    }
    if (nativePublisher && role === 'publish') {
      await page.addScriptTag({ path: '.runtime/native-browser-client.js' });
      await page.evaluate(async options => { window.lab = new window.NativePublisher(); await window.lab.connect(options); },
        { url: `ws://127.0.0.1:${nativeServer.port}/`, token: nativeToken, streamId: 'stream',syntheticApproveJoins:nativeViewer });
      return page;
    }
    await page.evaluate(async token=>{window.lab=new window.LabClient(); await window.lab.connect(token);},
      issueToken(secret,{room:'webrtc',peer,role}));
    return page;
  }
  const publisher=await client('publisher','publish');
  const tracks=await publisher.evaluate(async videoCodec=>{
    const canvas=document.createElement('canvas'); canvas.width=320;canvas.height=180;
    document.body.append(canvas); const ctx=canvas.getContext('2d'); let frame=0;
    window.drawTimer=setInterval(()=>{ctx.fillStyle=`hsl(${frame++%360} 80% 50%)`;ctx.fillRect(0,0,320,180);
      ctx.fillStyle='white';ctx.font='30px sans-serif';ctx.fillText(String(frame),20,60);},33);
    const video=canvas.captureStream(30).getVideoTracks()[0];
    window.audioContext=new AudioContext(); await window.audioContext.resume();
    const oscillator=window.audioContext.createOscillator(), destination=window.audioContext.createMediaStreamDestination();
    window.oscillator=oscillator; window.audioDestination=destination;
    oscillator.connect(destination);oscillator.start();
    return [await window.lab.publish(video,videoCodec),await window.lab.publish(destination.stream.getAudioTracks()[0])];
  },videoCodec);
  if (videoCodec) {
    const actualCodec = app.core.rooms.get('webrtc').peers.get('publisher').producers.get(tracks[0]).rtpParameters.codecs[0].mimeType;
    assert.equal(actualCodec.toLowerCase(),videoCodec.toLowerCase());
    report.videoCodec = actualCodec;
  }
  async function watch(page) {
    await page.evaluate(async tracks=>{
      for(const id of tracks) {
        const consumer=await window.lab.consume(id);
        const element=document.createElement(consumer.kind==='video'?'video':'audio');
        element.autoplay=true; element.muted=true;
        if (consumer.kind==='audio') {
          const context=new AudioContext();await context.resume();
          const input=context.createMediaStreamSource(new MediaStream([consumer.track]));
          const analyser=context.createAnalyser();input.connect(analyser);
          window.audioMeasurement={context,input,analyser};
        }
        element.srcObject=new MediaStream([consumer.track]);document.body.append(element);await element.play();
      }
    },tracks);
    if(nativeViewer){
      const order=await page.evaluate(()=>window.lab.creationOrder);
      assert.deepEqual(order,['audio','video']);report.nativeAudioFirstCreationOrder=order;
    }
    let result;
    for (let attempt=0;attempt<100;attempt++) {
      result=await page.evaluate(async()=>{
        const stats=await window.lab.recvTransport.getStats();
        const samples=new Float32Array(2048);window.audioMeasurement.analyser.getFloatTimeDomainData(samples);
        const audioRms=Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length);
        return [...stats.values()].filter(s=>s.type==='inbound-rtp')
          .map(s=>({kind:s.kind,packetsReceived:s.packetsReceived,bytesReceived:s.bytesReceived,framesDecoded:s.framesDecoded,totalSamplesReceived:s.totalSamplesReceived,totalAudioEnergy:s.totalAudioEnergy,...(s.kind==='audio'?{audioRms}: {})}));
      });
      if (result.some(s=>s.kind==='video'&&s.framesDecoded>5) && result.some(s=>s.kind==='audio'&&s.packetsReceived>10&&s.totalSamplesReceived>0&&s.audioRms>0.005)) return result;
      await new Promise(r=>setTimeout(r,100));
    }
    throw new Error('Missing decoded audio/video: '+JSON.stringify(result));
  }
  const viewer1=await client('viewer1','view'); report.viewer1=await watch(viewer1);
  if (nativePublisher) {
    await publisher.evaluate(() => window.lab.rpc('set-paused', { id: 'stream', audio: true, video: false }));
    await viewer1.waitForFunction(() => {
      const samples = new Float32Array(2048); window.audioMeasurement.analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, x) => sum + x*x, 0) / samples.length) < 0.005;
    }, undefined, { timeout: 10000 });
    await publisher.evaluate(() => window.lab.rpc('set-paused', { id: 'stream', audio: false, video: false }));
    await viewer1.waitForFunction(() => {
      const samples = new Float32Array(2048); window.audioMeasurement.analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, x) => sum + x*x, 0) / samples.length) > 0.005;
    }, undefined, { timeout: 10000 });
    report.nativeAudioPauseResume = 'PASS';
  }
  const publisherStats = () => nativePublisher
    ? app.core.request(app.core.rooms.get('webrtc').peers.get('publisher'), 'stats')
    : publisher.evaluate(()=>window.lab.rpc('stats'));
  const before=await publisherStats();
  const viewer2=await client('viewer2','view'); report.viewer2=await watch(viewer2);
  if(nativeViewer) {
    const audioLevel=async(page,silent)=>page.waitForFunction(silent=>{
      const samples=new Float32Array(2048);window.audioMeasurement.analyser.getFloatTimeDomainData(samples);
      const rms=Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length);
      return silent ? rms<0.005 : rms>0.005;
    },silent,{timeout:10000});
    await viewer1.evaluate(()=>window.lab.rpc('set-paused',{audio:true,video:false}));
    await audioLevel(viewer1,true);await audioLevel(viewer2,false);
    assert.equal([...app.core.rooms.get('webrtc').peers.get('publisher').producers.values()].find(p=>p.kind==='audio').paused,false);
    await viewer1.evaluate(()=>window.lab.rpc('set-paused',{audio:false,video:false}));
    await audioLevel(viewer1,false);report.nativeViewerIndependentPauseResume='PASS';
  }
  if(nativeViewer){
    const diagnostics=await collectMediaDiagnostics(app.core);
    const outgoing=diagnostics.consumers.filter(c=>c.kind==='audio');
    assert.equal(outgoing.length,2);
    assert.ok(outgoing.every(c=>!c.paused && !c.sourcePaused && c.rtpSent && c.packetCount>0 && c.byteCount>0));
    report.audioConsumerDiagnostics=outgoing;
  }
  const after=await publisherStats();
  assert.equal(before.transports.length,1);assert.equal(after.transports.length,1);
  assert.equal(after.producers.length,2);
  if(audioRefresh){
    report.audioRefreshCounts=await Promise.all([viewer1,viewer2].map(page=>page.evaluate(()=>window.lab.audioRefreshCount)));
    assert.deepEqual(report.audioRefreshCounts,[1,1]);
  }
  report.active=await counts();
  assert.deepEqual(report.active,{rooms:1,peers:3,transports:3,producers:2,consumers:4});
  report.publisherTransports=after.transports.length;
  report.publisherStats=after.transports.flat().map(s=>({type:s.type,bytesReceived:s.bytesReceived,
    rtpBytesReceived:s.rtpBytesReceived,dtlsState:s.dtlsState,iceState:s.iceState}));
  // Verify actual ICE traffic terminates at the mediasoup listener, not another browser.
  report.remoteCandidates=await publisher.evaluate(async()=>{
    const stats=await window.lab.sendTransport.getStats();
    return [...stats.values()].filter(s=>s.type==='candidate-pair'&&s.state==='succeeded')
      .map(s=>stats.get(s.remoteCandidateId)).map(s=>({address:s.address,port:s.port,protocol:s.protocol}));
  });
  assert.ok(report.remoteCandidates.some(c=>c.port===mediaPort));
  await viewer2.close();
  for(let i=0;i<100&&(await counts()).consumers!==2;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal((await counts()).consumers,2);
  if (nativePublisher) await publisher.evaluate(() => window.lab.close());
  else await publisher.evaluate(async()=>{for(const id of [...window.lab.producers.keys()])await window.lab.stopProducer(id);});
  await viewer1.waitForFunction(()=>window.lab.consumers.size===0);
  assert.equal((await counts()).producers,0);assert.equal((await counts()).consumers,0);
  await browser.close();browser=null;
  for(let i=0;i<100&&(await counts()).rooms;i++)await new Promise(r=>setTimeout(r,10));
  report.final=await counts();assert.equal(report.final.rooms,0);assert.equal(report.final.transports,0);
  report.experimentalAudioRefresh=audioRefresh;
  report.experimentalAudioFirst=audioFirst;
  report.result='PASS';
  writeFileSync(new URL(audioRefresh?'../evidence/webrtc-audio-refresh-test.json':nativeViewer?'../evidence/webrtc-native-viewer-test.json':viewerMediaAdapter?'../evidence/webrtc-viewer-media-test.json':nativePublisher?'../evidence/webrtc-native-publisher-test.json':externalUrl?'../evidence/webrtc-container-test.json':'../evidence/webrtc-test.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally { await browser?.close();await Promise.all(viewerSessions.map(s=>s.close()));await nativeServer?.stop();await app?.stop(); }
