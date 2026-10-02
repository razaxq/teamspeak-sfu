import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configureServerSlots} from '../scripts/server-slots.js';
import {selfhostConfig} from '../scripts/selfhost-config.js';

test('TeamSpeak slot settings are preserved except for the explicit legacy migration or override',async()=>{
  for(const [initial,requested,migrateLegacy,expected] of [[32,0,false,32],[128,0,true,128],[8,0,true,32],[8,0,false,8],[32,64,false,64]]){
    let slots=initial;const edits=[];
    const reader={request:async command=>{
      if(command==='serverinfo')return `virtualserver_maxclients=${slots}\nerror id=0 msg=ok\n`;
      edits.push(command);slots=Number(command.split('=')[1]);return 'error id=0 msg=ok\n';
    }};
    assert.equal(await configureServerSlots({reader,requested,migrateLegacy}),expected);
    assert.equal(edits.length,initial===expected?0:1);
  }
});

test('a server-side slot rejection is propagated, not bypassed',async()=>{
  const reader={request:async command=>{
    if(command==='serverinfo')return 'virtualserver_maxclients=32\n';
    throw new Error('Server slot ceiling');
  }};
  await assert.rejects(configureServerSlots({reader,requested:1000}),/slot ceiling/);
  const base={SFU_PUBLIC_HOST:'sfu.example.org',TSSERVER_LICENSE_ACCEPTED:'accept'};
  assert.equal(selfhostConfig(base).tsMaxClients,0);
  assert.equal(selfhostConfig({...base,SFU_TS_MAXCLIENTS:'64'}).tsMaxClients,64);
  for(const value of ['-1','no','1e3','2147483648'])assert.throws(()=>selfhostConfig({...base,SFU_TS_MAXCLIENTS:value}));
});
