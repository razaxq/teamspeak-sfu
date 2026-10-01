import { WireError } from './wire.js';

// Correlates a viewer admission with an authenticated publisher's separate
// join-response command. A successful join-request RPC ack is NOT approval.
export function createViewerApprovalBroker({requestPublisher,subscribeRevocations,
  timeoutMs=5000,maxPending=32}) {
  if(typeof requestPublisher!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<1
      || !Number.isInteger(maxPending) || maxPending<1)throw new TypeError('Invalid approval broker');
  const pending=new Map(),departed=new Map();let closed=false;
  const key=(stream,user)=>JSON.stringify([stream,user]);
  function finish(k,value,error,expected) {
    const entry=pending.get(k);if(!entry || (expected && entry!==expected))return;
    pending.delete(k);clearTimeout(entry.timer);
    if(error)entry.reject(new WireError(error));else entry.resolve(value);
  }
  const unsubscribe=subscribeRevocations?.(event=>{
    for(const [k,entry] of pending)if((event.userId===entry.viewer || event.userId===entry.publisher)
      && (!event.streamId || event.streamId===entry.stream))finish(k,false,'VIEWER_APPROVAL_REVOKED');
  });
  return {
    approveJoin({principal,approvalData}) {
      if(closed)return Promise.reject(new WireError('APPROVAL_BROKER_CLOSED'));
      if(principal?.role!=='view' || !['streamId','userId','publisherPeer'].every(k=>typeof principal[k]==='string' && principal[k]))
        return Promise.reject(new WireError('INVALID_VIEWER_PRINCIPAL'));
      const k=key(principal.streamId,principal.userId);
      for(const [old,entry] of departed)if(entry.expires<=Date.now())departed.delete(old);
      // Native join-response has no attempt ID. Quarantine a departing identity
      // for one decision timeout to prevent late approval attaching to a retry.
      if(departed.has(k))return Promise.reject(new WireError('VIEWER_LEAVE_PENDING'));
      if(pending.has(k) || pending.size+departed.size>=maxPending)return Promise.reject(new WireError('APPROVAL_LIMIT'));
      // These fields remain opaque to this transport broker. The control plane
      // establishes identity; the original publisher decides whether to accept.
      const fields=Object.fromEntries(['signedIdentityType','signedIdentity','codecs']
        .filter(name=>Object.hasOwn(approvalData??{},name)).map(name=>[name,structuredClone(approvalData[name])]));
      return new Promise((resolve,reject)=>{
        const entry={viewer:principal.userId,publisher:principal.publisherPeer,stream:principal.streamId,resolve,reject};
        entry.timer=setTimeout(()=>finish(k,false,'VIEWER_APPROVAL_TIMEOUT',entry),timeoutMs);
        pending.set(k,entry);
        Promise.resolve().then(()=>pending.get(k)!==entry ? {err:0} : requestPublisher({streamId:principal.streamId,publisherUserId:principal.publisherPeer,
          cmd:'join-request',args:{...fields,isRemove:false,userId:principal.userId}})).then(response=>{
            if(response.err!==0)finish(k,false,'PUBLISHER_REQUEST_FAILED',entry);
          },()=>finish(k,false,'PUBLISHER_REQUEST_FAILED',entry));
      });
    },
    acceptPublisherDecision({principal,args}) {
      if(closed || principal?.role!=='publish' || args?.id!==principal.streamId
        || typeof args.userId!=='string' || typeof args.accepted!=='boolean')return false;
      const k=key(args.id,args.userId),entry=pending.get(k);
      const old=departed.get(k);
      if(!entry && old?.publisher===principal.userId && old.expires>Date.now())return true;
      if(!entry || entry.publisher!==principal.userId)return false;
      // Never forward publisher-supplied transportInfo as the receiver's ICE or
      // DTLS parameters. The viewer adapter allocates its own receive transport.
      finish(k,args.accepted);return true;
    },
    cancelJoin({principal}) {
      if(principal?.role!=='view')return;
      const k=key(principal.streamId,principal.userId),entry=pending.get(k);
      if(entry && entry.publisher===principal.publisherPeer){
        departed.set(k,{publisher:principal.publisherPeer,expires:Date.now()+timeoutMs});
        finish(k,false,'VIEWER_APPROVAL_CANCELLED',entry);
      }
    },
    async removeViewer({principal,approvalData}) {
      if(closed || principal?.role!=='view')return;
      const k=key(principal.streamId,principal.userId);
      for(const [old,entry] of departed)if(entry.expires<=Date.now())departed.delete(old);
      if(!departed.has(k) && departed.size<maxPending)
        departed.set(k,{publisher:principal.publisherPeer,expires:Date.now()+timeoutMs});
      const fields=Object.fromEntries(['signedIdentityType','signedIdentity','codecs']
        .filter(name=>Object.hasOwn(approvalData??{},name)).map(name=>[name,structuredClone(approvalData[name])]));
      const response=await requestPublisher({streamId:principal.streamId,publisherUserId:principal.publisherPeer,
        cmd:'join-request',args:{...fields,userId:principal.userId,isRemove:true}});
      if(response.err!==0)throw new WireError('PUBLISHER_REMOVE_FAILED');
    },
    close(){closed=true;unsubscribe?.();for(const k of pending.keys())finish(k,false,'APPROVAL_BROKER_CLOSED');departed.clear();},
  };
}
