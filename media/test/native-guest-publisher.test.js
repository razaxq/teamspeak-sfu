import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createClientDirectory} from '../src/native/client-directory.js';
import {createAccessRegistry} from '../src/native/access-registry.js';
import {createStreamControl,parseControlCommand} from '../src/native/stream-control.js';

test('guest publishing retains connection, channel and stream ownership checks',async t=>{
  const directory=createClientDirectory({serverId:'server',revokeClient:id=>registry.revokeClient(id)});
  const resolveClient=async id=>directory.get(id);
  const registry=createAccessRegistry({resolveClient});
  const control=createStreamControl({registry,resolveClient,canPublish:async i=>i.canPublish,
    canView:async()=>true,endpoint:'sfu.example.org:18344'});
  t.after(()=>{control.close();directory.invalidate();});
  directory.snapshot('clid=3 cid=1 client_type=0 client_unique_identifier=guest client_servergroups=8 client_lastconnected=100|clid=4 cid=2 client_type=0 client_unique_identifier=other client_servergroups=8 client_lastconnected=100|clid=5 cid=1 client_type=1 client_unique_identifier=query');
  const setup='setupstream name=Guest type=3 bitrate=2000 accessibility=1 mode=2 viewer_limit=2 audio=0';
  assert.equal((await control.dispatch('99',setup)).error,2568);
  assert.equal((await control.dispatch('5',setup)).error,2568);
  const result=await control.dispatch('3',setup);
  assert.ok(result.notification);
  const {args}=parseControlCommand(result.notification);
  const credential=await registry.issue('3');
  const request={token:credential.token,cmd:'create-stream',args:{id:args.id}};
  assert.ok(await registry.authorize(request));
  assert.equal((await control.dispatch('4','requeststreaminfo clid=3')).error,2568);
  assert.equal((await control.dispatch('4',`stopstream id=${args.id} reason=1`)).error,2568);
  directory.notification('notifyclientleftview clid=3 reasonid=8');
  assert.equal(await registry.authorize(request),null);
  assert.equal(control.size,0);
  assert.equal((await control.dispatch('3',setup)).error,2568);
});
