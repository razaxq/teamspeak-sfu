import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, decodeFrame, encodeRequest, encodeResponse, summarizeFrame } from '../src/native/wire.js';
import { createNativeDispatcher } from '../src/native/dispatch.js';

test('native request/response envelope preserves string IDs and optional response args', () => {
  for (const cmd of COMMANDS) {
    const req=decodeFrame(encodeRequest({cmd,requestId:'00042',token:'private-token',args:{id:'stream'}}));
    assert.equal(req.requestId,'00042');assert.equal(req.recognized,true);assert.equal(req.token,'private-token');
  }
  assert.deepEqual(decodeFrame(encodeResponse({responseId:'00042',err:17})),{type:'response',responseId:'00042',err:17});
  assert.equal(decodeFrame(encodeResponse({responseId:'x',err:0,args:null})).args,null);
});
test('hostile or mismatched frames do not enter the native dispatcher', () => {
  for (const text of ['null','[]','{"cmd":"create-stream","requestId":1,"args":{}}',
    '{"responseId":"1","err":0,"cmd":"create-stream"}',
    '{"responseId":"1","err":"0"}','{"cmd":"create-stream","requestId":"1"}']) assert.throws(()=>decodeFrame(text));
  assert.throws(()=>decodeFrame(Buffer.from([0xff])),/INVALID_JSON/);
  assert.throws(()=>decodeFrame(' '.repeat(65537)),/FRAME_TOO_LARGE/);
  assert.throws(()=>decodeFrame('['.repeat(40)+'0'+']'.repeat(40)),/NESTING_LIMIT/);
  assert.throws(()=>encodeResponse({responseId:'1',err:NaN}),/NON_JSON_VALUE/);
  const cyclic={};cyclic.self=cyclic;
  assert.throws(()=>encodeRequest({cmd:'create-stream',requestId:'1',args:cyclic}),/CYCLIC_VALUE/);
  assert.throws(()=>decodeFrame('{"id":1,"method":"join","data":{}}'),/INVALID_COMMAND/);
});
test('no native verifier means no handler calls and no invented success', async () => {
  let called=false;
  const handlers=new Map([['create-stream',()=>{called=true;return {err:0};}]]);
  const input=encodeRequest({cmd:'create-stream',requestId:'1',token:'trustme',args:{}});
  await assert.rejects(createNativeDispatcher({handlers})(input),/NATIVE_AUTH_UNAVAILABLE/);
  await assert.rejects(createNativeDispatcher({handlers,authorize:async()=>null})(input),/NATIVE_AUTH_REJECTED/);
  assert.equal(called,false);
});
test('explicit verifier controls dispatch identity; metadata never echoes credentials', async () => {
  const input=encodeRequest({cmd:'transport-connect',requestId:'private-id',token:'private-token',args:{signedIdentity:'private-identity'}});
  let checked=0;
  const dispatch=createNativeDispatcher({authorize:async request=>{checked++;assert.equal(request.token,'private-token');return {peer:'trusted'};},
    handlers:new Map([['transport-connect',async({principal,args})=>{assert.equal(principal.peer,'trusted');assert.equal(args.signedIdentity,'private-identity');return {err:17,args:{test:true}};}]])});
  const out=decodeFrame(await dispatch(input));assert.equal(checked,1);assert.equal(out.responseId,'private-id');assert.equal(out.err,17);
  const summary=JSON.stringify(summarizeFrame(decodeFrame(input)));assert.ok(!summary.includes('private'));
  const unknown=decodeFrame('{"cmd":"new-secret-command","requestId":"x","args":{}}');
  assert.equal(summarizeFrame(unknown).command,'[UNKNOWN]');
  await assert.rejects(dispatch('{"cmd":"new-command","requestId":"x","args":{}}'),/UNSUPPORTED_COMMAND/);
});
