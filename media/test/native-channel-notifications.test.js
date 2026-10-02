import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAccessRegistry} from '../src/native/access-registry.js';
import {createStreamControl,parseControlCommand} from '../src/native/stream-control.js';
import {createChannelNotifications} from '../src/native/channel-notifications.js';
function fixture(send,options={}){
  const clients=new Map(['1','2','3'].map(id=>[id,{clientId:id,serverId:'server',channelId:id==='3'?'elsewhere':'channel',sessionId:'s'+id,uid:'u'+id}]));
  const resolveClient=async id=>clients.get(id),registry=createAccessRegistry({resolveClient});
  const control=createStreamControl({registry,resolveClient,canPublish:async()=>true,canView:async viewer=>viewer.clientId!=='1',endpoint:'sfu.example.org:18344'});
  const messages=[];
  const discovery=createChannelNotifications({control,listClientIds:async()=>[...clients.keys()],resolveClient,
    sendNotification:async notification=>{await send?.(notification,clients);messages.push(notification);},...options});
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


test('one failed recipient does not block later recipients and retry skips confirmed flags',async()=>{
  let fail=true;
  const {control,discovery,clients,messages}=fixture(async item=>{
    if(fail && item.recipient.clientId==='2' && item.notification.startsWith('notifystreamstarted'))throw new Error('recipient unavailable');
  },{includeStreamingStatus:true});
  clients.get('3').channelId='channel';
  await control.dispatch('1',setup);await discovery.flush();
  assert.ok(messages.some(m=>m.recipient.clientId==='3' && m.notification.startsWith('notifystreamstarted')));
  fail=false;await discovery.syncAll();
  assert.equal(messages.filter(m=>m.recipient.clientId==='2' && m.notification.endsWith('client_is_streaming=1')).length,1);
  assert.equal(messages.filter(m=>m.recipient.clientId==='2' && m.notification.startsWith('notifystreamstarted')).length,1);
  await discovery.close();control.close();
});

test('stop repairs a partially delivered start even when start acknowledgement was lost',async()=>{
  const attempts=[];
  const {control,discovery}=fixture(async item=>{
    attempts.push(item);
    if(item.notification.startsWith('notifystreamstarted'))throw new Error('acknowledgement lost');
  },{includeStreamingStatus:true});
  const stream=parseControlCommand((await control.dispatch('1',setup)).notification).args;
  await discovery.flush();
  await control.dispatch('1',`stopstream id=${stream.id} reason=1`);await discovery.flush();
  const viewer=attempts.filter(m=>m.recipient.clientId==='2').map(m=>m.notification);
  assert.equal(viewer.length,4);
  assert.ok(viewer[0].endsWith('client_is_streaming=1'));
  assert.ok(viewer[1].startsWith('notifystreamstarted'));
  assert.ok(viewer[2].startsWith('notifystreamstopped'));
  assert.ok(viewer[3].endsWith('client_is_streaming=0'));
  await discovery.close();control.close();
});

test('stop retries only the missing flag reset after the stop announcement succeeded',async()=>{
  let fail=true;
  const {control,discovery,messages}=fixture(async item=>{
    if(fail && item.recipient.clientId==='2' && item.notification.endsWith('client_is_streaming=0'))throw new Error('reset failed');
  },{includeStreamingStatus:true});
  const stream=parseControlCommand((await control.dispatch('1',setup)).notification).args;
  await discovery.flush();
  await control.dispatch('1',`stopstream id=${stream.id} reason=1`);await discovery.flush();
  fail=false;await discovery.syncAll();
  assert.equal(messages.filter(m=>m.recipient.clientId==='2' && m.notification.startsWith('notifystreamstopped')).length,1);
  assert.equal(messages.filter(m=>m.recipient.clientId==='2' && m.notification.endsWith('client_is_streaming=0')).length,1);
  await discovery.close();control.close();
});

test('recipient identity is checked between flag delivery and stream announcement',async()=>{
  const {control,discovery,messages}=fixture(async(item,clients)=>{
    if(item.recipient.clientId==='2' && item.notification.endsWith('client_is_streaming=1'))clients.get('2').sessionId='replacement';
  },{includeStreamingStatus:true});
  await control.dispatch('1',setup);await discovery.flush();
  assert.equal(messages.filter(m=>m.recipient.clientId==='2' && m.notification.startsWith('notifystreamstarted')).length,0);
  await discovery.syncClient('2');
  assert.ok(messages.some(m=>m.recipient.sessionId==='replacement' && m.notification.startsWith('notifystreamstarted')));
  await discovery.close();control.close();
});

test('bursts coalesce and a stop during flag delivery cannot announce a stopped stream',async()=>{
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  const events=[];
  const {control,discovery,messages}=fixture(async item=>{
    if(item.recipient.clientId==='2' && item.notification.endsWith('client_is_streaming=1')){started();await blocked;}
  },{includeStreamingStatus:true,maxPending:1,onEvent:e=>events.push(e)});
  const stream=parseControlCommand((await control.dispatch('1',setup)).notification).args;
  await entered;
  const scans=Array.from({length:100},()=>discovery.syncAll());
  assert.ok(scans.every(scan=>scan===scans[0]));
  await control.dispatch('1',`stopstream id=${stream.id} reason=1`);
  release();await Promise.all(scans);await discovery.flush();
  assert.equal(messages.filter(m=>m.recipient.clientId==='2' && m.notification.startsWith('notifystreamstarted')).length,0);
  assert.ok(messages.some(m=>m.recipient.clientId==='2' && m.notification.endsWith('client_is_streaming=0')));
  assert.deepEqual(events,[]);
  await discovery.close();control.close();
});


test('stop clears an attempted flag even when its acknowledgement was lost',async()=>{
  const attempts=[];
  const {control,discovery}=fixture(async item=>{
    if(item.recipient.clientId!=='2')return;
    attempts.push(item.notification);
    if(item.notification.endsWith('client_is_streaming=1'))throw new Error('acknowledgement lost');
  },{includeStreamingStatus:true});
  const stream=parseControlCommand((await control.dispatch('1',setup)).notification).args;
  await discovery.flush();
  await control.dispatch('1',`stopstream id=${stream.id} reason=1`);await discovery.flush();
  assert.deepEqual(attempts,['notifyclientupdated clid=1 client_is_streaming=1','notifyclientupdated clid=1 client_is_streaming=0']);
  await discovery.close();control.close();
});
