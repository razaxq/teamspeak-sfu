import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createViewerApprovalBroker} from '../src/native/viewer-approval.js';
const viewer={role:'view',streamId:'stream',userId:'viewer',publisherPeer:'publisher'};
const publisher={role:'publish',streamId:'stream',userId:'publisher'};
const decision={id:'stream',userId:'viewer',accepted:true};
test('RPC acknowledgment alone does not approve viewing; only the bound publisher can decide',async()=>{
  let sent;const broker=createViewerApprovalBroker({requestPublisher:async r=>{sent=r;return {err:0};}});
  const result=broker.approveJoin({principal:viewer,approvalData:{signedIdentity:'opaque',codecs:5,token:'never-forward'}});
  await new Promise(r=>setImmediate(r));
  assert.equal(sent.args.userId,'viewer');assert.equal(Object.hasOwn(sent.args,'token'),false);
  assert.equal(broker.acceptPublisherDecision({principal:{...publisher,userId:'impostor'},args:decision}),false);
  assert.equal(broker.acceptPublisherDecision({principal:publisher,args:{...decision,userId:'other-viewer'}}),false);
  assert.equal(broker.acceptPublisherDecision({principal:publisher,args:decision}),true);
  assert.equal(await result,true);
  assert.equal(broker.acceptPublisherDecision({principal:publisher,args:decision}),false);broker.close();
});
test('publisher denial, revocation, missing decision and broker shutdown release pending requests',async()=>{
  let revoke;const broker=createViewerApprovalBroker({requestPublisher:async()=>({err:0}),timeoutMs:15,
    subscribeRevocations:fn=>{revoke=fn;return ()=>{};}});
  const denied=broker.approveJoin({principal:viewer});
  assert.equal(broker.acceptPublisherDecision({principal:publisher,args:{...decision,accepted:false}}),true);
  assert.equal(await denied,false);
  const revoked=assert.rejects(broker.approveJoin({principal:viewer}),/VIEWER_APPROVAL_REVOKED/);
  revoke({userId:'publisher',streamId:'stream'});await revoked;
  await assert.rejects(broker.approveJoin({principal:viewer}),/VIEWER_APPROVAL_TIMEOUT/);
  const stopped=assert.rejects(broker.approveJoin({principal:viewer}),/APPROVAL_BROKER_CLOSED/);
  broker.close();await stopped;
});

test('cancelled viewer ignores late approval and quarantines retry; removal stays scoped',async()=>{
  const requests=[];
  const broker=createViewerApprovalBroker({requestPublisher:async r=>{requests.push(r);return {err:0};},timeoutMs:30,maxPending:2});
  const approval=assert.rejects(broker.approveJoin({principal:viewer}),/CANCELLED/);
  await new Promise(r=>setImmediate(r));broker.cancelJoin({principal:viewer});await approval;
  assert.equal(broker.acceptPublisherDecision({principal:publisher,args:decision}),true);
  await assert.rejects(broker.approveJoin({principal:viewer}),/LEAVE_PENDING/);
  await broker.removeViewer({principal:viewer,approvalData:{signedIdentity:'opaque',signedIdentityType:0,codecs:[],token:'private',userId:'forged'}});
  const removal=requests.at(-1);
  assert.equal(removal.args.isRemove,true);assert.equal(removal.args.userId,'viewer');
  assert.equal(removal.publisherUserId,'publisher');assert.equal(removal.args.token,undefined);
  assert.equal(broker.acceptPublisherDecision({principal:{...publisher,userId:'wrong'},args:decision}),false);
  await new Promise(r=>setTimeout(r,35));
  const retried=broker.approveJoin({principal:viewer});
  assert.equal(broker.acceptPublisherDecision({principal:publisher,args:decision}),true);
  assert.equal(await retried,true);broker.close();
});
