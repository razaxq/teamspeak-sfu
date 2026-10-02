import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client,generateIdentity,noopLogger} from '@honeybbq/teamspeak-client';
import {protectVoiceClientIdentity} from '../src/native/voice-client-identity.js';

function fixture(nickname='SFU service') {
  const voice=new Client(generateIdentity(0),'127.0.0.1:9987',nickname,{logger:noopLogger});
  // Exercise the real SDK command parser without opening a network socket.
  voice.sendCommandNoWait=async()=>{};
  const assigned=[];voice.handler.setClientID=id=>assigned.push(id);
  const packet=(text,type=2)=>voice.handler.onPacket({typeFlagged:type,data:Buffer.from(text)});
  return {voice,assigned,packet};
}

test('the pinned SDK reproduces nickname suffix reassignment without the guard',()=>{
  const {voice,assigned,packet}=fixture('probe 1');
  packet('initserver aclid=7');
  packet('notifycliententerview clid=12 client_nickname=probe\\s12 cid=1 client_type=0');
  assert.equal(voice.clid,12);assert.equal(assigned.at(-1),12);
});

test('guard preserves the server-assigned ID for both SDK state and outgoing packets',()=>{
  const {voice,assigned,packet}=fixture('SFU 服务'),events=[];
  const binding=protectVoiceClientIdentity(voice,{onEvent:e=>events.push(e)});
  packet('initserver aclid=7');
  packet('notifycliententerview clid=12 client_nickname=SFU\\s服务1 cid=1 client_type=0');
  assert.equal(binding.clientId,7);assert.equal(voice.clid,7);
  assert.ok(assigned.every(id=>id===7));
  assert.deepEqual(events,[{event:'relay-client-id-change-blocked'}]);
});

test('only a valid command assignment can bind identity, and later announcements cannot rebind it',()=>{
  const {voice,packet,assigned}=fixture();
  const binding=protectVoiceClientIdentity(voice);
  packet('notifycliententerview clid=9 client_nickname=SFU\\sservice cid=1 client_type=0');
  assert.equal(binding.clientId,undefined);
  packet('initserver aclid=7',0);assert.equal(binding.clientId,undefined);
  for(const raw of ['0','-1','65536','7x']){packet('initserver aclid='+raw);assert.equal(binding.clientId,undefined);}
  packet('initserver aclid=7 clid=9');assert.equal(binding.clientId,7);
  packet('initserver aclid=11');assert.equal(binding.clientId,7);assert.equal(voice.clid,7);
  assert.equal(assigned.at(-1),7);
});

test('assignment and conflicting enter notification in one frame retain the assigned ID',()=>{
  const {voice,packet,assigned}=fixture();
  const binding=protectVoiceClientIdentity(voice);
  packet('initserver clid=8\0notifycliententerview clid=12 client_nickname=SFU\\sservice1 cid=1 client_type=0');
  assert.equal(binding.clientId,8);assert.equal(voice.clid,8);
  assert.ok(assigned.every(id=>id===8));
  assert.throws(()=>protectVoiceClientIdentity(voice),/fresh voice client/);
});
