import {test} from 'node:test';
import assert from 'node:assert/strict';
import {selfhostConfig,SERVER_IMAGE} from '../scripts/selfhost-config.js';
const base={SFU_PUBLIC_HOST:'stream.example.org',TSSERVER_LICENSE_ACCEPTED:'accept'};
test('self-host settings are independent of the lab instance',()=>{
  const c=selfhostConfig(base);
  assert.equal(c.host,'stream.example.org');assert.equal(c.image,SERVER_IMAGE);
  assert.equal(c.audioRefresh,false);
  assert.equal(selfhostConfig({...base,SFU_EXPERIMENTAL_AUDIO_REFRESH:'1'}).audioRefresh,true);
  assert.equal(c.name,'ts6-sfu-selfhost');assert.equal(c.dir,'/var/lib/ts6-sfu-selfhost/');
  const custom=selfhostConfig({...base,SFU_VOICE_PORT:'21987',SFU_STATE_DIR:'/tmp/test-sfu/',SFU_PUBLIC_HOST:'192.0.2.10'});
  assert.equal(custom.voicePort,21987);assert.equal(custom.dir,'/tmp/test-sfu/');
});
test('invalid deployment settings fail before any host changes',()=>{
  for(const change of [{SFU_PUBLIC_HOST:''},{SFU_PUBLIC_HOST:'sfu.example.com'},
    {SFU_PUBLIC_HOST:'ws://example.org:3344'},{SFU_PUBLIC_HOST:'example.org\nserveredit'},
    {TSSERVER_LICENSE_ACCEPTED:''},{SFU_VOICE_PORT:'0'},{SFU_VOICE_PORT:'65536'},
    {SFU_VOICE_PORT:'19125'},{SFU_MEDIA_PORT:'1e4'}, {SFU_CONTAINER_NAME:'--all'},
    {SFU_STATE_DIR:'/'},{SFU_STATE_DIR:'relative/path'},{SFU_STATE_DIR:'/tmp/a:b'},
    {SFU_SERVER_IMAGE:'image --privileged'},{SFU_EXPERIMENTAL_AUDIO_REFRESH:'true'}])assert.throws(()=>selfhostConfig({...base,...change}));
});
