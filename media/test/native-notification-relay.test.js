import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNotificationRelay} from '../src/native/notification-relay.js';
const identity=id=>({clientId:id,serverId:'server',channelId:'channel',sessionId:'session-'+id,uid:'uid-'+id});
const notification='notifystreamstarted clid=1 id=stream mode=2';
test('notification relay is bound to its driver and rechecks recipient connection before offering',async()=>{
  const driver=identity('1'),recipient=identity('2'),clients=new Map([['1',driver],['2',recipient]]);let relay,offer;
  const voice={async execCommand(command){
    assert.equal(command,'sfulabflush');assert.equal(await relay.takeNotification('2'),null);
    offer=await relay.takeNotification('1');assert.equal(await relay.takeNotification('1'),null);
  }};
  relay=createNotificationRelay({voice,identity:driver,resolveClient:async id=>clients.get(id)});
  await relay.sendNotification({recipient,notification});assert.equal(offer.clientId,'2');assert.equal(offer.notification,notification);
  const old={...recipient};recipient.sessionId='reconnected';
  await assert.rejects(relay.sendNotification({recipient:old,notification}),/connection changed/);
  await assert.rejects(relay.sendNotification({recipient,notification:'notifystreamstarted x\nstopstream'}),/Invalid notification/);
  await relay.close();await assert.rejects(relay.sendNotification({recipient,notification}),/unavailable/);
});
test('relay does not report delivery when a command succeeds without fetching and bounds its queue',async()=>{
  const driver=identity('1'),recipient=identity('2');let finish;
  const relay=createNotificationRelay({voice:{execCommand:()=>new Promise(r=>{finish=r;})},identity:driver,
    resolveClient:async id=>id==='1'?driver:recipient,maxPending:1});
  const send=assert.rejects(relay.sendNotification({recipient,notification}),/not fetched/);
  await new Promise(r=>setImmediate(r));
  await assert.rejects(relay.sendNotification({recipient,notification}),/unavailable/);
  finish();await send;await relay.close();
});

test('failed native sends mark the relay unhealthy for replacement',async()=>{
  const driver=identity('1'),recipient=identity('2'),events=[];let relay;
  relay=createNotificationRelay({voice:{async execCommand(){await relay.takeNotification('1');throw Object.assign(new Error('private detail'),{id:524});}},identity:driver,
    resolveClient:async id=>id==='1'?driver:recipient,onEvent:e=>events.push(e)});
  assert.equal(relay.healthy,true);
  await assert.rejects(relay.sendNotification({recipient,notification}));
  assert.equal(relay.healthy,false);
  assert.deepEqual(events,[{event:'notification-relay-send-failed',reason:'NATIVE_SEND_FAILED',errorCode:524}]);
  assert.equal(JSON.stringify(events).includes('private detail'),false);
  await relay.close();
});


test('an unhealthy relay fails queued work promptly without sending more native commands',async()=>{
  const driver=identity('1'),recipient=identity('2');let calls=0,release;
  const blocked=new Promise(resolve=>{release=resolve;});
  const relay=createNotificationRelay({voice:{async execCommand(){calls++;await blocked;throw new Error('timeout');}},identity:driver,
    resolveClient:async id=>id==='1'?driver:recipient});
  const first=assert.rejects(relay.sendNotification({recipient,notification}),/timeout/);
  const queued=assert.rejects(relay.sendNotification({recipient,notification}),/unavailable/);
  release();await Promise.all([first,queued]);
  await assert.rejects(relay.sendNotification({recipient,notification}),/unavailable/);
  assert.equal(calls,1);await relay.close();
});
