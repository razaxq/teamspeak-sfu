import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAccessRegistry} from '../src/native/access-registry.js';
import {createStreamControl,parseControlCommand} from '../src/native/stream-control.js';
import {createChannelNotifications} from '../src/native/channel-notifications.js';
function fixture(send){
  const clients=new Map(['1','2','3'].map(id=>[id,{clientId:id,serverId:'server',channelId:id==='3'?'elsewhere':'channel',sessionId:'s'+id,uid:'u'+id}]));
  const resolveClient=async id=>clients.get(id),registry=createAccessRegistry({resolveClient});
  const control=createStreamControl({registry,resolveClient,canPublish:async()=>true,canView:async viewer=>viewer.clientId!=='1',endpoint:'sfu.example.org:18344'});
  const messages=[];
  const discovery=createChannelNotifications({control,listClientIds:async()=>[...clients.keys()],resolveClient,
    sendNotification:async notification=>{await send?.(notification,clients);messages.push(notification);}});
  return {clients,registry,control,discovery,messages};
}
const setup='setupstream name=screen type=3 bitrate=2000 accessibility=1 mode=2 viewer_limit=2 audio=1 return_code=private-correlation';
test('channel discovery selects live authorized recipients, deduplicates, and synchronizes late joiners',async()=>{
  const {control,discovery,clients,messages,registry}=fixture();
  const stream=parseControlCommand((await control.dispatch('1',setup)).notification).args;
  await discovery.flush();assert.equal(messages.length,1);assert.equal(messages[0].recipient.clientId,'2');
  assert.ok(!messages[0].notification.includes('return_code'));assert.equal(registry.size,1);
  await discovery.syncAll();assert.equal(messages.length,1);
  clients.get('3').channelId='channel';await discovery.syncClient('3');assert.equal(messages.length,2);
  clients.get('2').sessionId='new';await discovery.syncClient('2');assert.equal(messages.length,3);
  assert.equal(messages.at(-1).recipient.sessionId,'new');
  await control.dispatch('1',`stopstream id=${stream.id} reason=1`);await discovery.flush();
  assert.equal(messages.filter(m=>m.notification.startsWith('notifystreamstopped ')).length,2);
  await discovery.close();control.close();
});
test('failed native notification is retried by synchronization without granting media access',async()=>{
  let fail=true;
  const {control,discovery,messages}=fixture(async()=>{if(fail)throw new Error('sender unavailable');});
  await control.dispatch('1',setup);await discovery.flush();assert.equal(messages.length,0);
  fail=false;await discovery.syncAll();assert.equal(messages.length,1);
  await discovery.close();control.close();
});

test('streaming flags accompany announcements and include the publisher without duplicate starts',async()=>{
 const clients=new Map(['1','2'].map(clientId=>[clientId,{clientId,serverId:'s',channelId:'c',sessionId:'s'+clientId,uid:'u'+clientId}]));
 const resolveClient=async id=>clients.get(id),registry=createAccessRegistry({resolveClient});
 const control=createStreamControl({registry,resolveClient,canPublish:async()=>true,canView:async()=>true,endpoint:'test:1234'});
 const messages=[];
 const discovery=createChannelNotifications({control,includeStreamingStatus:true,listClientIds:async()=>[...clients.keys()],resolveClient,sendNotification:async m=>messages.push(m)});
 const stream=parseControlCommand((await control.dispatch('1',setup)).notification).args;
 await discovery.flush();
 assert.equal(messages.filter(m=>m.notification==='notifyclientupdated clid=1 client_is_streaming=1').length,2);
 assert.equal(messages.filter(m=>m.notification.startsWith('notifystreamstarted')).length,1);
 const count=messages.length;await discovery.syncAll();assert.equal(messages.length,count);
 clients.set('3',{...clients.get('2'),clientId:'3',sessionId:'s3',uid:'u3'});await discovery.syncClient('3');
 assert.ok(messages.some(m=>m.recipient.clientId==='3'&&m.notification==='notifyclientupdated clid=1 client_is_streaming=1'));
 await control.dispatch('1',`stopstream id=${stream.id} reason=1`);await discovery.flush();
 assert.equal(messages.filter(m=>m.notification==='notifyclientupdated clid=1 client_is_streaming=0').length,3);
 await discovery.close();control.close();
});
