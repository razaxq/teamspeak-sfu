import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.js';
import { issueToken } from '../src/auth.js';
const secret = 'test-secret-'.repeat(4);
function rpc(ws, id, method, data = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('RPC timeout')); }, 5000);
    function receive(bytes) { const msg=JSON.parse(bytes); if (msg.id === id) { clearTimeout(timer); ws.off('message', receive); resolve(msg); } }
    ws.on('message', receive); ws.send(JSON.stringify({id,method,data}));
  });
}
async function socket(port) { const ws=new WebSocket(`ws://127.0.0.1:${port}/lab/ws`); await once(ws,'open'); return ws; }
const token = (peer, room='one', role='view', ttl=60) => issueToken(secret,{peer,room,role,ttl});
const audioParameters = { codecs:[{mimeType:'audio/opus',payloadType:111,clockRate:48000,channels:2,parameters:{}}],
  encodings:[{ssrc:12345678}],rtcp:{cname:'test'} };

test('health, authentication, room and resource ownership, disconnect cleanup', async t => {
  const app=await startServer({secret,port:0,coreOptions:{mediaPort:19100}}); t.after(()=>app.stop());
  const health=await (await fetch(`http://127.0.0.1:${app.port}/health`)).json();
  assert.equal(health.nativeTeamspeak,'NOT_IMPLEMENTED');
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/requestsfuaccessinfo`)).status,501);
  const p=await socket(app.port), v=await socket(app.port), other=await socket(app.port);
  assert.equal((await rpc(v,1,'stats')).error,'NOT_JOINED');
  assert.equal((await rpc(v,2,'join',{token:'bad'})).error,'INVALID_TOKEN');
  assert.equal((await rpc(v,3,'join',{token:token('v')})).ok,true);
  assert.equal((await rpc(v,4,'createTransport',{direction:'send'})).error,'FORBIDDEN');
  assert.equal((await rpc(p,1,'join',{token:token('p','one','publish')})).ok,true);
  await rpc(other,1,'join',{token:token('o','two')});
  const duplicate=await socket(app.port);
  assert.equal((await rpc(duplicate,1,'join',{token:token('p','one','publish')})).error,'PEER_EXISTS'); duplicate.close();
  const transport=(await rpc(p,2,'createTransport',{direction:'send'})).data;
  assert.equal((await rpc(p,3,'createTransport',{direction:'send'})).error,'TRANSPORT_LIMIT');
  const produced=await rpc(p,4,'produce',{transportId:transport.id,kind:'audio',rtpParameters:audioParameters});
  assert.equal(produced.ok,true);
  assert.equal((await rpc(v,5,'listProducers')).data.length,1);
  assert.deepEqual((await rpc(other,2,'listProducers')).data,[]);
  assert.equal((await rpc(v,6,'closeProducer',{producerId:produced.data.id})).error,'NOT_FOUND');
  assert.equal((await rpc(v,7,'restartIce',{transportId:transport.id})).error,'NOT_FOUND');
  const recv=(await rpc(other,3,'createTransport',{direction:'recv'})).data;
  assert.equal((await rpc(other,4,'consume',{transportId:recv.id,producerId:produced.data.id,rtpCapabilities:health})).error,'NOT_FOUND');
  assert.equal((await rpc(v,8,'produce',{transportId:transport.id,kind:'audio',rtpParameters:audioParameters})).error,'FORBIDDEN');
  p.close(); v.close(); other.close();
  for (let i=0;i<100 && app.core.counts().peers;i++) await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(app.core.counts(),{rooms:0,peers:0,transports:0,producers:0,consumers:0});
});

test('token expiry closes established sessions and frees transports', async t => {
  const app=await startServer({secret,port:0,coreOptions:{mediaPort:19101}}); t.after(()=>app.stop());
  const ws=await socket(app.port);
  assert.equal((await rpc(ws,1,'join',{token:token('short','one','view',2)})).ok,true);
  await rpc(ws,2,'createTransport',{direction:'recv'});
  const [code]=await once(ws,'close'); assert.equal(code,1008);
  for(let i=0;i<100 && app.core.counts().peers;i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(app.core.counts().transports,0); assert.equal(app.core.counts().rooms,0);
});

test('invalid origins, binary frames and unbounded queues are rejected', async t => {
  const app=await startServer({secret,port:0,coreOptions:{mediaPort:19102}}); t.after(()=>app.stop());
  const bad=new WebSocket(`ws://127.0.0.1:${app.port}/lab/ws`,{origin:'https://untrusted.invalid'});
  const [err]=await once(bad,'error'); assert.match(err.message,/403/);
  const ws=await socket(app.port); const closed=once(ws,'close'); ws.send(Buffer.from('binary'));
  assert.equal((await closed)[0],1008);
  const flood=await socket(app.port); const end=once(flood,'close');
  for(let i=0;i<50;i++) flood.send(JSON.stringify({id:i,method:'stats'}));
  assert.equal((await end)[0],1008);
});
