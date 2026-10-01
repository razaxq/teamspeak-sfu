import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeUserId} from '../src/native/user-id.js';
import {createAccessRegistry} from '../src/native/access-registry.js';
import {createViewerApprovalBroker} from '../src/native/viewer-approval.js';
test('native identity is parseable TS routing metadata while credentials remain connection-bound',async()=>{
 const identity={clientId:'12',uid:'test/uid=',serverUid:'server/uid=',serverId:'s',sessionId:'a',channelId:'c'};
 const registry=createAccessRegistry({resolveClient:async()=>({...identity}),makeUserId:nativeUserId});
 const first=await registry.issue('12');
 assert.deepEqual(JSON.parse(first.userId),{version:1,type:1,vs_uid:'server/uid=',uid:'test/uid=',id:12});
 await registry.grantPublisher({clientId:'12',sessionId:'a',streamId:'stream'});
 const req={token:first.token,cmd:'create-stream',args:{id:'stream'}};
 assert.ok(await registry.authorize(req));
 const second=await registry.issue('12');assert.equal(second.userId,first.userId);assert.notEqual(second.token,first.token);
 assert.equal(await registry.authorize(req),null);
 identity.sessionId='b';assert.equal(await registry.authorize({...req,token:second.token}),null);
 assert.throws(()=>nativeUserId({...identity,serverUid:undefined}));
});
test('repeated removal cannot perpetually extend the late-decision quarantine',async()=>{
 const principal={role:'view',streamId:'s',userId:'v',publisherPeer:'p'};
 const broker=createViewerApprovalBroker({requestPublisher:async()=>({err:0}),timeoutMs:40});
 await broker.removeViewer({principal});
 await new Promise(r=>setTimeout(r,25));await broker.removeViewer({principal});
 await new Promise(r=>setTimeout(r,20));
 const joined=broker.approveJoin({principal});
 assert.equal(broker.acceptPublisherDecision({principal:{role:'publish',streamId:'s',userId:'p'},args:{id:'s',userId:'v',accepted:true}}),true);
 assert.equal(await joined,true);broker.close();
});
