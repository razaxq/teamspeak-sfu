import { WireError } from './wire.js';

const requireValue = (ok, code) => { if (!ok) throw new WireError(code); };
const fields = ['room','peer','streamId','userId','publisherPeer','role','exp'];

// Media-side viewer adapter, not a complete native wire endpoint. Its open()
// result is for a future join-response notification, not a join-request RPC ack.
// No resource is allocated before BOTH trusted admission and publisher approval.
export function createViewerMediaSession({core,authorize,approveJoin,subscribeRevocations,
  onEvent=()=>{},approvalTimeoutMs=5000,maxPending=16}) {
  if(!core || typeof authorize!=='function' || typeof approveJoin!=='function'
      || !Number.isInteger(approvalTimeoutMs) || approvalTimeoutMs<1
      || !Number.isInteger(maxPending) || maxPending<1) throw new TypeError('Viewer admission and approval required');
  let binding,peer,transportId,connected=false,closed=false,expiryTimer;
  let tail=Promise.resolve(),pending=0;
  const consumers=new Map();
  const cleanup=()=>{clearTimeout(expiryTimer);if(peer)core.leave(peer);consumers.clear();};
  const invalidate=({userId,streamId})=>{
    if(closed || !binding || binding.userId!==userId || (streamId && binding.streamId!==streamId))return false;
    closed=true;cleanup();return true;
  };
  const unsubscribe=subscribeRevocations?.(invalidate);
  function live() {
    if(binding && binding.exp*1000<=Date.now()){closed=true;cleanup();}
    requireValue(!closed,'VIEWER_SESSION_CLOSED');
  }
  async function check(token,streamId,cmd) {
    live();
    const principal=await authorize({token,cmd,args:{id:streamId}});live();
    if(!principal){closed=true;cleanup();throw new WireError('VIEWER_AUTH_REJECTED');}
    requireValue(principal.role==='view' && principal.streamId===streamId
      && ['room','peer','streamId','userId','publisherPeer'].every(k=>typeof principal[k]==='string' && principal[k].length>0)
      && Number.isSafeInteger(principal.exp) && principal.exp*1000>Date.now(),'INVALID_VIEWER_PRINCIPAL');
    if(binding)requireValue(fields.every(k=>binding[k]===principal[k]),'VIEWER_SCOPE_MISMATCH');
    return principal;
  }
  function enqueue(action) {
    if(closed)return Promise.reject(new WireError('VIEWER_SESSION_CLOSED'));
    if(pending>=maxPending)return Promise.reject(new WireError('QUEUE_LIMIT'));
    pending++;const result=tail.then(()=>{live();return action();});
    tail=result.then(()=>{},()=>{}).finally(()=>{pending--;});return result;
  }
  function armExpiry() {
    const remaining=binding.exp*1000-Date.now();
    if(remaining<=0){closed=true;cleanup();return;}
    expiryTimer=setTimeout(armExpiry,Math.min(remaining,2147483647));expiryTimer.unref();
  }
  return {
    open({token,streamId,approvalData={}}) {
      const data=structuredClone(approvalData);
      return enqueue(async()=>{
        requireValue(!binding,'VIEWER_ALREADY_JOINED');
        const principal=await check(token,streamId,'join-request');
        binding=Object.freeze(Object.fromEntries(fields.map(k=>[k,principal[k]])));armExpiry();
        let timer;
        try {
          const approved=await Promise.race([
            Promise.resolve().then(()=>approveJoin({principal:binding,approvalData:data})),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new WireError('VIEWER_APPROVAL_TIMEOUT')),approvalTimeoutMs);}),
          ]);
          clearTimeout(timer);
          requireValue(approved===true,'VIEWER_NOT_APPROVED');
          await check(token,streamId,'join-request');
          peer=await core.join(binding,onEvent);live();
          const transport=await core.request(peer,'createTransport',{direction:'recv'});live();
          transportId=transport.id;
          const routerCapabilities=await core.request(peer,'getRouterRtpCapabilities');
          await check(token,streamId,'join-request');
          // The native receiver requires videoCodec in an accepted join before
          // creating its receive transport (beta4.1 RVA 0x1a9063a). Derive codec
          // names from the actual publisher, never from its supplied ICE data.
          const codecs={};
          const owner=peer.room.peers.get(binding.publisherPeer);
          for(const source of owner?.producers.values() ?? []) {
            if(source.closed)continue;
            const mime=source.rtpParameters.codecs.find(c=>c.mimeType.toLowerCase()!== 'video/rtx')?.mimeType;
            const names={'video/av1':'AV1','video/vp8':'VP8','video/vp9':'VP9','video/h264':'H264','audio/opus':'opus'};
            const name=names[mime?.toLowerCase()];
            if(name)codecs[source.kind+'Codec']=name;
          }
          return JSON.parse(JSON.stringify({transportInfo:{...transport,routerCapabilities},...codecs}));
        } catch(error){clearTimeout(timer);closed=true;cleanup();throw error;}
      });
    },
    connect({token,streamId,dtlsParameters}) {
      const parameters=structuredClone(dtlsParameters);
      return enqueue(async()=>{
        await check(token,streamId,'transport-connect');
        requireValue(peer && transportId && !connected,'VIEWER_TRANSPORT_STATE');
        await core.request(peer,'connectTransport',{transportId,dtlsParameters:parameters});
        await check(token,streamId,'transport-connect');connected=true;
      });
    },
    consume({token,streamId,kind,rtpCapabilities}) {
      const capabilities=structuredClone(rtpCapabilities);
      return enqueue(async()=>{
        await check(token,streamId,'consume-stream');
        // The receiver installs consumer options before mediasoup-client emits
        // transport-connect. Keep this consumer paused until explicit readiness.
        requireValue(peer && transportId,'VIEWER_TRANSPORT_STATE');
        requireValue(['audio','video'].includes(kind),'INVALID_MEDIA_KIND');
        const owner=peer.room.peers.get(binding.publisherPeer);
        const source=owner && [...owner.producers.values()].find(p=>p.kind===kind && !p.closed);
        requireValue(source,'PUBLISHER_MEDIA_UNAVAILABLE');
        const consumer=await core.request(peer,'consume',{transportId,producerId:source.id,rtpCapabilities:capabilities});
        try {
          await check(token,streamId,'consume-stream');
          consumers.set(consumer.id,source.id);
          return {...consumer,sourcePaused:source.paused};
        } catch(error){if(!peer.closed)await core.request(peer,'closeConsumer',{consumerId:consumer.id});throw error;}
      });
    },
    sourcePauseState({token,streamId}) {
      return enqueue(async()=>{
        await check(token,streamId,'set-paused');
        requireValue(peer && connected,'VIEWER_TRANSPORT_STATE');
        const owner=peer.room.peers.get(binding.publisherPeer);
        requireValue(owner && !owner.closed,'PUBLISHER_MEDIA_UNAVAILABLE');
        const state={audio:true,video:true};
        for(const source of owner.producers.values())if(!source.closed)state[source.kind]=source.paused;
        return state;
      });
    },
    setPaused({token,streamId,consumerId,paused}) {
      return enqueue(async()=>{
        await check(token,streamId,'set-paused');
        requireValue(typeof paused==='boolean','INVALID_PAUSE_STATE');
        requireValue(connected || paused,'VIEWER_TRANSPORT_NOT_CONNECTED');
        requireValue(consumers.has(consumerId),'CONSUMER_SCOPE_MISMATCH');
        await core.request(peer,paused?'pauseConsumer':'resumeConsumer',{consumerId});
        await check(token,streamId,'set-paused');
      });
    },
    // Called only after the viewer has installed the consumer. This never
    // resumes a publisher that explicitly declared its source paused.
    resume({token,streamId,consumerId}) {
      return enqueue(async()=>{
        await check(token,streamId,'consume-stream');
        requireValue(connected,'VIEWER_TRANSPORT_NOT_CONNECTED');
        requireValue(consumers.has(consumerId),'CONSUMER_SCOPE_MISMATCH');
        await core.request(peer,'resumeConsumer',{consumerId});
        await check(token,streamId,'consume-stream');
      });
    },
    invalidate,
    async close(){closed=true;cleanup();unsubscribe?.();await tail;cleanup();},
  };
}
