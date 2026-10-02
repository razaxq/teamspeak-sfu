import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessRegistry } from '../src/native/access-registry.js';
import { createStreamControl, parseControlCommand } from '../src/native/stream-control.js';
const setup = 'setupstream name=screen\\sshare type=2 bitrate=2000 accessibility=1 mode=2 viewer_limit=5 audio=1 return_code=12';
function fixture() {
  const clients = new Map(['1','2'].map(id => [id, {clientId:id,sessionId:'session-'+id,serverId:'server',channelId:'channel',uid:'uid-'+id,canPublish:true}]));
  const resolveClient = async id => clients.get(id);
  const registry = createAccessRegistry({resolveClient});
  const control = createStreamControl({registry,resolveClient,canPublish:async i=>i.canPublish,endpoint:'sfu.example.org:18344'});
  return {clients,registry,control};
}
test('native setup grants only its registered stream and stop enforces ownership', async () => {
  const {control,registry}=fixture();
  const first=await registry.issue('1'),second=await registry.issue('2');
  const result=await control.dispatch('1',setup);
  const {command,args}=parseControlCommand(result.notification);
  assert.equal(command,'notifystreamstarted');assert.equal(args.sfu_endpoint,'sfu.example.org:18344');
  assert.equal(args.sfu_user_id,first.userId);assert.equal(args.name,'screen share');assert.equal(args.access,'1');
  const request={token:first.token,cmd:'create-stream',args:{id:args.id}};
  assert.ok(await registry.authorize(request));
  assert.equal(await registry.authorize({...request,token:second.token}),null);
  assert.equal((await control.dispatch('2',`stopstream id=${args.id} reason=1`)).error,2568);
  assert.ok(await registry.authorize(request));
  assert.match((await control.dispatch('1',`stopstream id=${args.id} reason=1`)).notification,/^notifystreamstopped /);
  assert.equal(await registry.authorize(request),null);assert.equal(control.size,0);
});
test('stream admission honors an explicit denial policy and rejects malformed settings and concurrent duplicate setup', async () => {
  const {control,registry,clients}=fixture();
  await registry.issue('1');clients.get('1').canPublish=false;
  assert.equal((await control.dispatch('1',setup)).error,2568);
  clients.get('1').canPublish=true;
  for(const bad of [setup+' mode=2',setup.replace('viewer_limit=5','viewer_limit=999'),setup.replace('audio=1','audio=9'),setup+'|stopstream',setup.replace('name=screen\\sshare','name=bad\\nline')])
    assert.equal((await control.dispatch('1',bad)).error,256);
  assert.deepEqual(await control.dispatch('1',setup.replace('mode=2','mode=1')),{pass:true});
  const results=await Promise.all([control.dispatch('1',setup),control.dispatch('1',setup)]);
  assert.equal(results.filter(r=>r.notification).length,1);assert.equal(control.size,1);
  clients.get('1').sessionId='reconnected';
  await control.dispatch('2','stopstream id=unknown reason=1');
  assert.equal(control.size,0);
});
test('setup before access-info keeps stream identity and accepts empty TS string fields', async () => {
  const {control,registry}=fixture();
  const result=await control.dispatch('1',setup.replace('name=screen\\sshare','name').replace('return_code=12','return_code=1:12'));
  assert.ok(result.notification);
  const {args}=parseControlCommand(result.notification);
  assert.equal(args.name,'');assert.equal(args.return_code,'1:12');
  const credentials=await registry.issue('1');
  assert.equal(credentials.userId,args.sfu_user_id);
  assert.ok(await registry.authorize({token:credentials.token,cmd:'create-stream',args:{id:args.id}}));
  assert.equal(control.size,1);
});
test('observed official screen-share request accepts type 3 and zero viewer limit', async () => {
  const {control,registry}=fixture();
  const result=await control.dispatch('1','setupstream name=Screen type=3 bitrate=41248 accessibility=1 mode=2 viewer_limit=0 audio=0 return_code=1:3');
  assert.ok(result.notification);
  const {args}=parseControlCommand(result.notification);
  assert.equal(args.type,'3');assert.equal(args.viewer_limit,'16');assert.equal(args.audio,'0');
  const credential=await registry.issue('1');
  assert.ok(await registry.authorize({token:credential.token,cmd:'create-stream',args:{id:args.id}}));
});

test('stream info admits a viewer before or after access-info without granting publish', async () => {
  for (const credentialsFirst of [false, true]) {
    const {registry,clients}=fixture();
    const control=createStreamControl({registry,resolveClient:async id=>clients.get(id),
      canPublish:async()=>true,canView:async()=>true,endpoint:'sfu.example.org:18344'});
    const published=parseControlCommand((await control.dispatch('1',setup)).notification).args;
    let credential=credentialsFirst ? await registry.issue('2') : undefined;
    const response=await control.dispatch('2','requeststreaminfo clid=1 return_code=2:7');
    const {command,args}=parseControlCommand(response.notification);
    assert.equal(command,'notifystreaminfo');assert.equal(args.id,published.id);
    assert.equal(args.sfu_user_id,published.sfu_user_id);assert.equal(args.accessibility,'1');
    assert.equal(args.return_code,'2:7');assert.equal(args.viewer,'0');
    credential ??= await registry.issue('2');
    const request={token:credential.token,cmd:'join-request',args:{id:args.id}};
    const principal=await registry.authorize(request);
    assert.equal(principal.role,'view');assert.equal(principal.publisherPeer,published.sfu_user_id);
    assert.equal(await registry.authorize({...request,cmd:'create-stream'}),null);
    assert.ok((await control.dispatch('2','requeststreaminfo clid=1')).notification);
    await control.dispatch('1',`stopstream id=${args.id} reason=1`);
    assert.equal(await registry.authorize(request),null);
    control.close();
  }
});

test('stream info requires explicit viewing policy and same live channel', async () => {
  const {control,registry,clients}=fixture();
  await control.dispatch('1',setup);
  assert.equal((await control.dispatch('2','requeststreaminfo clid=1')).error,2568);
  const allowed=createStreamControl({registry,resolveClient:async id=>clients.get(id),
    canPublish:async()=>true,canView:async()=>true,endpoint:'sfu.example.org:18344'});
  // Use a fresh publisher record because each control owns its stream directory.
  registry.revokeClient('1');
  await allowed.dispatch('1',setup);
  clients.get('2').channelId='elsewhere';
  assert.equal((await allowed.dispatch('2','requeststreaminfo clid=1')).error,2568);
  clients.get('2').channelId='channel';clients.get('2').serverId='other';
  assert.equal((await allowed.dispatch('2','requeststreaminfo clid=1')).error,2568);
  assert.deepEqual(await allowed.dispatch('2','requeststreaminfo clid=999'),{pass:true});
  for(const input of ['requeststreaminfo id=abc','requeststreaminfo clid=1 extra=x',
    'requeststreaminfo clid=1 return_code=bad\\ncode','requeststreaminfo clid=1|clid=2'])
    assert.equal((await allowed.dispatch('2',input)).error,256);
  control.close();allowed.close();
});

test('stream info revokes admission when viewer reconnects during policy check', async () => {
  const {registry,clients}=fixture();
  const control=createStreamControl({registry,resolveClient:async id=>clients.get(id),canPublish:async()=>true,
    canView:async()=>{clients.get('2').sessionId='new';return true;},endpoint:'sfu.example.org:18344'});
  await control.dispatch('1',setup);
  const credential=await registry.issue('2');
  assert.equal((await control.dispatch('2','requeststreaminfo clid=1')).error,2568);
  assert.equal(await registry.authorize({token:credential.token,cmd:'join-request',args:{id:'anything'}}),null);
  control.close();
});

test('batch info preserves rows and one return code; rejects mixed or injected requests before admission',async()=>{
  const {registry,clients}=fixture();
  clients.set('3',{...clients.get('2'),clientId:'3',sessionId:'session-3',uid:'uid-3'});
  const control=createStreamControl({registry,resolveClient:async id=>clients.get(id),canPublish:async()=>true,
    canView:async()=>true,endpoint:'sfu.example.org:18344'});
  await control.dispatch('1',setup);await control.dispatch('2',setup);
  const batch=await control.dispatch('3','requeststreaminfo clid=1|clid=2 return_code=3:9');
  assert.ok(batch.notification);assert.equal(batch.notification.split('|').length,2);
  assert.equal((batch.notification.match(/return_code=/g)||[]).length,1);
  const rows=batch.notification.slice('notifystreaminfo '.length).split('|').map(row=>parseControlCommand('row '+row).args);
  const credential=await registry.issue('3');
  for(const row of rows)assert.equal((await registry.authorize({token:credential.token,cmd:'join-request',args:{id:row.id}})).role,'view');
  for(const input of ['requeststreaminfo clid=1|clid=1','requeststreaminfo clid=1|stopstream id=x',
    'requeststreaminfo clid=1 return_code=a|clid=2 return_code=b','requeststreaminfo clid=1|clid=999',
    'requeststreaminfo clid=1|','setupstream name=x|clid=1'])assert.equal((await control.dispatch('3',input)).error,256);
  assert.deepEqual(await control.dispatch('3','requeststreaminfo clid=98|clid=99'),{pass:true});
  control.close();
});

test('batch info checks the C bridge byte budget before allocating viewer credentials',async()=>{
  const clients=new Map(Array.from({length:11},(_,i)=>{
    const id=String(i+1);return [id,{clientId:id,sessionId:'session-'+id,uid:'uid-'+id,serverId:'server',channelId:'channel'}];
  }));
  const resolveClient=async id=>clients.get(id),registry=createAccessRegistry({resolveClient});
  const control=createStreamControl({registry,resolveClient,canPublish:async()=>true,canView:async()=>true,endpoint:'sfu.example.org:18344'});
  for(let i=1;i<=10;i++)assert.ok((await control.dispatch(String(i),setup.replace('screen\\sshare','😀'.repeat(64)))).notification);
  const input='requeststreaminfo '+Array.from({length:10},(_,i)=>'clid='+(i+1)).join('|');
  assert.equal((await control.dispatch('11',input)).error,256);
  assert.equal(registry.size,10);control.close();
});

test('viewer slots limit pending joins, count only activation, and release on revocation',async()=>{
  const {registry,clients}=fixture();
  clients.set('3',{...clients.get('2'),clientId:'3',sessionId:'session-3',uid:'uid-3'});
  const control=createStreamControl({registry,resolveClient:async id=>clients.get(id),canPublish:async()=>true,
    canView:async()=>true,endpoint:'sfu.example.org:18344'});
  const events=[];control.subscribeStreams(e=>events.push(e));
  const stream=parseControlCommand((await control.dispatch('1',setup.replace('viewer_limit=5','viewer_limit=1'))).notification).args;
  const principal=async id=>{
    await control.dispatch(id,'requeststreaminfo clid=1');const credential=await registry.issue(id);
    return registry.authorize({token:credential.token,cmd:'join-request',args:{id:stream.id}});
  };
  const first=await principal('2'),second=await principal('3');
  const count=async()=>parseControlCommand((await control.dispatch('1','requeststreaminfo clid=1')).notification).args.viewer;
  const lease=control.reserveViewer(first);
  assert.equal(await count(),'0');
  assert.throws(()=>control.reserveViewer(second),/VIEWER_LIMIT/);
  assert.throws(()=>control.reserveViewer(first),/VIEWER_ALREADY_RESERVED/);
  lease.activate();lease.activate();assert.equal(await count(),'1');
  registry.revokeClient('2');assert.equal(await count(),'0');
  assert.throws(()=>lease.activate(),/REVOKED/);lease.release();
  const next=control.reserveViewer(second);next.activate();assert.equal(await count(),'1');
  next.release();next.release();assert.equal(await count(),'0');
  const pending=control.reserveViewer(second);
  await control.dispatch('1',`stopstream id=${stream.id} reason=1`);
  assert.throws(()=>pending.activate(),/REVOKED/);pending.release();
  assert.equal(events[0].type,'started');assert.ok(!events[0].notification.includes('return_code'));
  assert.equal(events.at(-1).type,'stopped');assert.equal(events.at(-1).channelId,'channel');
  assert.equal(events.at(-1).reason,1);control.close();
});


test('announcement-only viewer joins use verified directory admission without an info query', async () => {
  for (const denied of [null,'policy','channel','server','session','owner','stop','token','user','command','remove']) {
    const clients=new Map(['1','2'].map(clientId=>[clientId,{clientId,sessionId:'s'+clientId,serverId:'s',channelId:'c',uid:'u'+clientId}]));
    let allowed=true,calls=0;
    const registry=createAccessRegistry({resolveClient:async id=>clients.get(id),
      resolveViewerGrant:(viewer,id)=>{calls++;return control.resolveViewerGrant(viewer,id);}});
    const control=createStreamControl({registry,resolveClient:async id=>clients.get(id),
      canPublish:async()=>true,canView:async()=>allowed,endpoint:'sfu.example.org:18344'});
    const stream=parseControlCommand((await control.dispatch('1',setup)).notification).args;
    const viewer=await registry.issue('2');
    const request={token:viewer.token,cmd:'join-request',args:{id:stream.id,userId:stream.sfu_user_id,isRemove:false}};
    if(denied==='policy')allowed=false;
    if(denied==='channel')clients.get('2').channelId='other';
    if(denied==='server')clients.get('2').serverId='other';
    if(denied==='session')clients.get('2').sessionId='other';
    if(denied==='owner')clients.get('1').sessionId='other';
    if(denied==='stop')await control.dispatch('1',`stopstream id=${stream.id} reason=1`);
    if(denied==='token')request.token='0'.repeat(64);
    if(denied==='user')request.args.userId=viewer.userId;
    if(denied==='command')request.cmd='consume-stream';
    if(denied==='remove')request.args.isRemove=true;
    const principal=await registry.authorize(request);
    if(denied)assert.equal(principal,null,denied);
    else {
      assert.equal(principal.role,'view');assert.equal(principal.publisherPeer,stream.sfu_user_id);
      assert.equal(await registry.authorize({...request,cmd:'create-stream'}),null);
      const lease=control.reserveViewer(principal);lease.activate();lease.release();
    }
    if(['token','user','command','remove'].includes(denied))assert.equal(calls,0,denied);
    control.close();registry.clear();
  }
});

test('join admission fails if credentials rotate or the stream stops during policy lookup', async () => {
  for(const change of ['rotate','stop']) {
    const clients=new Map(['1','2'].map(clientId=>[clientId,{clientId,sessionId:'s'+clientId,serverId:'s',channelId:'c',uid:'u'+clientId}]));
    let enter,release;
    const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
    const registry=createAccessRegistry({resolveClient:async id=>clients.get(id),
      resolveViewerGrant:async(viewer,id)=>{enter();await gate;return control.resolveViewerGrant(viewer,id);}});
    const control=createStreamControl({registry,resolveClient:async id=>clients.get(id),
      canPublish:async()=>true,canView:async()=>true,endpoint:'sfu.example.org:18344'});
    const stream=parseControlCommand((await control.dispatch('1',setup)).notification).args;
    const viewer=await registry.issue('2');
    const result=registry.authorize({token:viewer.token,cmd:'join-request',args:{id:stream.id,isRemove:false}});
    await entered;
    if(change==='rotate')await registry.issue('2');
    else await control.dispatch('1',`stopstream id=${stream.id} reason=1`);
    release();assert.equal(await result,null);control.close();registry.clear();
  }
});
