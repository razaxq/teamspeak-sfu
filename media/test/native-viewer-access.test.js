import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessRegistry } from '../src/native/access-registry.js';

async function fixture() {
  const live = new Map(['1','2','3'].map(clientId => [clientId, {
    clientId, sessionId:'connection-'+clientId, serverId:'server', channelId:'channel', uid:'uid-'+clientId,
  }]));
  const registry = createAccessRegistry({resolveClient:async id=>live.get(id)});
  const publisher = await registry.issue('1'), viewer = await registry.issue('2');
  await registry.grantPublisher({clientId:'1',sessionId:'connection-1',streamId:'stream'});
  const grant = {clientId:'2',sessionId:'connection-2',publisherClientId:'1',publisherSessionId:'connection-1',streamId:'stream'};
  const request = {token:viewer.token,cmd:'join-request',args:{id:'stream'}};
  return {live,registry,publisher,viewer,grant,request};
}
test('viewing requires trusted admission and remains separate from publication', async () => {
  const {registry,grant,request,publisher,viewer} = await fixture();
  assert.equal(await registry.authorize(request),null);
  await registry.grantViewer(grant);
  const principal = await registry.authorize(request);
  assert.equal(principal.role,'view');assert.equal(principal.publisherPeer,publisher.userId);
  assert.equal((await registry.authorize({...request,cmd:'set-paused',args:{id:'stream',userId:publisher.userId,audio:false,video:false}})).role,'view');
  const owner = await registry.authorize({token:publisher.token,cmd:'create-stream',args:{id:'stream'}});
  assert.equal(principal.room,owner.room);
  for (const cmd of ['create-stream','transport-produce'])
    assert.equal(await registry.authorize({...request,cmd}),null);
  assert.equal(await registry.authorize({...request,args:{id:'another-stream'}}),null);
  assert.equal((await registry.authorize({...request,args:{id:'stream',userId:publisher.userId}})).role,'view');
  assert.equal(await registry.authorize({...request,args:{id:'stream',userId:viewer.userId}}),null);
  registry.revokeViewer('2','stream');
  assert.equal(await registry.authorize(request),null);
  assert.ok(await registry.authorize({token:publisher.token,cmd:'create-stream',args:{id:'stream'}}));
});
test('publisher rotation, stream stop and connection loss revoke downstream viewers', async () => {
  for (const action of ['rotate','stop','disconnect']) {
    const {registry,grant,request,viewer} = await fixture();
    await registry.grantViewer(grant);const events=[];
    registry.subscribeRevocations(e=>events.push(e));
    if(action==='rotate')await registry.issue('1');
    if(action==='stop')registry.revokeStream('stream');
    if(action==='disconnect')registry.revokeClient('1');
    assert.equal(await registry.authorize(request),null);
    assert.ok(events.some(e=>e.userId===viewer.userId && e.streamId==='stream'));
  }
});
test('viewer grants reject cross-channel, cross-server and stale connection identities', async () => {
  for(const key of ['channelId','serverId','sessionId']) {
    const {registry,grant,live,request}=await fixture();
    live.set('2',{...live.get('2'),[key]:'changed'});
    await assert.rejects(registry.grantViewer(grant),/unavailable/);
    assert.equal(await registry.authorize(request),null);
  }
});
test('viewer authorization cannot survive revocation during its final identity check', async () => {
  const live=new Map(['1','2'].map(clientId=>[clientId,{clientId,sessionId:'s'+clientId,uid:'u'+clientId,serverId:'s',channelId:'c'}]));
  let armed=false,checks=0,entered,release;
  const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  const registry=createAccessRegistry({resolveClient:async id=>{
    if(armed && id==='2' && ++checks===2){entered();await gate;}
    return live.get(id);
  }});
  await registry.issue('1');const viewer=await registry.issue('2');
  await registry.grantPublisher({clientId:'1',sessionId:'s1',streamId:'stream'});
  await registry.grantViewer({clientId:'2',sessionId:'s2',publisherClientId:'1',publisherSessionId:'s1',streamId:'stream'});
  armed=true;
  const result=registry.authorize({token:viewer.token,cmd:'consume-stream',args:{id:'stream'}});
  await ready;registry.revokeStream('stream');release();assert.equal(await result,null);
});

test('auth diagnostics distinguish identity mismatch and unknown credentials without logging secrets', async () => {
  const events=[];let time=100000;
  const clients=new Map(['1','2'].map(clientId=>[clientId,{clientId,sessionId:'s'+clientId,uid:'u'+clientId,serverId:'s',channelId:'c'}]));
  const registry=createAccessRegistry({resolveClient:async id=>clients.get(id),onEvent:e=>events.push(e),now:()=>time});
  const publisher=await registry.issue('1'),viewer=await registry.issue('2');
  await registry.grantPublisher({clientId:'1',sessionId:'s1',streamId:'private-stream'});
  const request={token:viewer.token,cmd:'join-request',args:{id:'private-stream',userId:viewer.userId,isRemove:false}};
  assert.equal(await registry.authorize(request),null);
  assert.equal(await registry.authorize(request),null);
  assert.deepEqual(events,[{event:'native-auth-rejected',reason:'USER_ID_MISMATCH'}]);
  time+=5000;assert.equal(await registry.authorize(request),null);assert.equal(events.length,2);
  assert.equal(await registry.authorize({...request,token:'0'.repeat(64)}),null);
  assert.equal(events.at(-1).reason,'CREDENTIAL_UNKNOWN');
  for(const secret of [viewer.token,viewer.userId,publisher.token,publisher.userId,'private-stream'])
    assert.equal(JSON.stringify(events).includes(secret),false);
});
