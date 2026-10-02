import {isLiveExpiry} from '../expiry.js';
import { decodeFrame, encodeResponse, WireError } from './wire.js';
import { createViewerMediaSession } from './viewer-media.js';

const requireValue = (ok, code) => { if (!ok) throw new WireError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scope = ['room','peer','streamId','userId','publisherPeer','role','exp'];

// Candidate beta4.1 wire adapter. Kept behind enableViewers until desktop tests.
// Join RPC acknowledgment precedes the separately correlated join-response.
export function createNativeViewerSession({core,authorize,approveJoin,cancelJoin=()=>{},leavePublisher=async()=>{},
  reserveViewer=()=>({activate(){},release(){}}),requestClient,onEvent=()=>{},onFailure=()=>{},audioActivation=false,audioFirst=false,audioRefresh=false}) {
  let binding, closed=false, ready=false, connected=false, deferred, background=Promise.resolve();
  let reservation,expiryTimer,approvalData,joinForwarded=false,departureSent=false,initialStateSent=false,videoCodec,audioCodec,awaitingVideo=false,videoAnnounced=false,audioRefreshRequested=false,audioRefreshPending=false;
  const consumers=new Map(),paused={audio:false,video:false};
  const media=createViewerMediaSession({core,authorize,approveJoin:async request=>{
    joinForwarded=true;
    let accepted;
    try { accepted=await approveJoin(request); }
    catch(error){
      if(['VIEWER_LEAVE_PENDING','APPROVAL_LIMIT','INVALID_VIEWER_PRINCIPAL','APPROVAL_BROKER_CLOSED'].includes(error.code))joinForwarded=false;
      throw error;
    }
    if(!accepted)joinForwarded=false;
    return accepted;
  }});
  const cleanup=()=>{
    closed=true;deferred=undefined;clearTimeout(expiryTimer);reservation?.release();
    cancelJoin({principal:binding});
    if(joinForwarded && !departureSent){
      departureSent=true;
      // Do not hold local cleanup or the viewer's close ACK on publisher I/O.
      setImmediate(()=>{void Promise.resolve().then(()=>leavePublisher({principal:binding,approvalData}))
        .catch(()=>onEvent({event:'native-viewer-leave-failed'}));});
    }
    return media.close();
  };
  function armExpiry(){
    if(binding.exp===null)return;
    const remaining=binding.exp*1000-Date.now();
    if(remaining<=0){void cleanup();onFailure('TOKEN_EXPIRED');return;}
    expiryTimer=setTimeout(armExpiry,Math.min(remaining,2147483647));expiryTimer.unref();
  }
  async function check(frame) {
    requireValue(!closed && frame.type==='request' && object(frame.args),'INVALID_VIEWER_REQUEST');
    const p=await authorize(frame);
    requireValue(!closed && p?.role==='view' && p.streamId===frame.args.id
      && scope.slice(0,5).every(k=>typeof p[k]==='string' && p[k].length>0)
      && isLiveExpiry(p.exp),'VIEWER_AUTH_REJECTED');
    requireValue(frame.args.userId===undefined || frame.args.userId===p.publisherPeer,'USER_SCOPE_MISMATCH');
    if(binding)requireValue(scope.every(k=>binding[k]===p[k]),'VIEWER_SCOPE_MISMATCH');
    return p;
  }
  async function resumeAll(token) {
    for(const [kind,consumer] of consumers) await media.setPaused({token,streamId:binding.streamId,consumerId:consumer.id,paused:paused[kind]});
  }
  return {
    get closed(){return closed;},
    get principal(){return !closed && binding && isLiveExpiry(binding.exp) ? binding : undefined;},
    async dispatch(input) {
      const frame=decodeFrame(input),p=await check(frame),args=frame.args;
      let result;
      if(frame.cmd==='join-request') {
        if(args.isRemove===true){
          requireValue(binding,'VIEWER_NOT_JOINED');await cleanup();
          return encodeResponse({responseId:frame.requestId,err:0});
        }
        requireValue(!binding && args.isRemove===false && Number.isInteger(args.signedIdentityType)
          && typeof args.signedIdentity==='string' && Array.isArray(args.codecs),'INVALID_VIEWER_JOIN');
        binding=Object.freeze(Object.fromEntries(scope.map(k=>[k,p[k]])));
        reservation=reserveViewer(binding);armExpiry();
        const token=frame.token;approvalData=structuredClone(args);
        deferred=async()=>{
          const transport=await media.open({token,streamId:binding.streamId,approvalData});
          requireValue(!closed,'VIEWER_SESSION_CLOSED');
          ready=true;
          onEvent({event:'native-viewer-approved',videoCodec:transport.videoCodec ?? null,audioCodec:transport.audioCodec ?? null});
          const response=await requestClient('join-response',{id:binding.streamId,userId:binding.publisherPeer,
            accepted:true,...transport});
          requireValue(response.err===0,'VIEWER_JOIN_RESPONSE_REJECTED');
          videoCodec=transport.videoCodec;audioCodec=transport.audioCodec;
          requireValue(!closed,'VIEWER_SESSION_CLOSED');reservation.activate();
          onEvent({event:'native-viewer-join-acknowledged'});
        };
      } else if(frame.cmd==='close-consumer-producer') {
        requireValue(ready && args.kind==='consumer' && typeof args.consumerProducerId==='string' && args.consumerProducerId.length>0,'INVALID_CONSUMER_CLOSE');
        await media.closeConsumer({token:frame.token,streamId:binding.streamId,consumerId:args.consumerProducerId});
        for(const [kind,consumer] of consumers)if(consumer.id===args.consumerProducerId)consumers.delete(kind);
      } else if(frame.cmd==='close-stream') {
        requireValue(binding,'VIEWER_NOT_JOINED');await cleanup();
      } else if(frame.cmd==='transport-connect') {
        requireValue(ready && !connected && object(args.dtlsParameters),'VIEWER_TRANSPORT_STATE');
        await media.connect({token:frame.token,streamId:binding.streamId,dtlsParameters:args.dtlsParameters});
        connected=true;await resumeAll(frame.token);
      } else if(frame.cmd==='set-paused') {
        requireValue(ready && ['audio','video'].some(k=>Object.hasOwn(args,k))
          && ['audio','video'].every(k=>!Object.hasOwn(args,k) || typeof args[k]==='boolean'),'INVALID_VIEWER_PAUSE');
        for(const kind of ['audio','video'])if(Object.hasOwn(args,kind))paused[kind]=args[kind];
        if(connected)await resumeAll(frame.token);
        onEvent({event:'native-viewer-pause-state',audio:paused.audio,video:paused.video});
        // The desktop installs track callbacks after consuming. Synchronize the
        // publisher state once readiness has arrived, after ACKing that request.
        // Do not echo every set-paused: the desktop responds with set-paused too.
        if(connected && awaitingVideo && !videoAnnounced){
          videoAnnounced=true;
          deferred=async()=>{
            const response=await requestClient('main-producer-changed',{id:binding.streamId,userId:binding.publisherPeer,kind:'video',codec:videoCodec});
            requireValue(response.err===0,'VIEWER_VIDEO_ANNOUNCEMENT_REJECTED');
            onEvent({event:'native-viewer-staged-video-announced'});
          };
        } else if(connected && !awaitingVideo && consumers.size && !initialStateSent && !paused.audio && !paused.video){
          initialStateSent=true;
          const token=frame.token;
          deferred=async()=>{
            let state=await media.sourcePauseState({token,streamId:binding.streamId});
            requireValue(!closed,'VIEWER_SESSION_CLOSED');
            // Opt-in beta4.1 initialization experiment. A real per-viewer audio
            // pause/resume transition occurs only once; publisher/video stay live.
            const audio=consumers.get('audio');
            if(audioActivation && audio && !state.audio){
              await media.setPaused({token,streamId:binding.streamId,consumerId:audio.id,paused:true});
              const held=await requestClient('set-paused',{id:binding.streamId,userId:binding.publisherPeer,...state,audio:true});
              requireValue(held.err===0 && !closed,'VIEWER_AUDIO_ACTIVATION_REJECTED');
              state=await media.sourcePauseState({token,streamId:binding.streamId});
              await media.setPaused({token,streamId:binding.streamId,consumerId:audio.id,paused:false});
              onEvent({event:'native-viewer-audio-activation'});
            }
            const response=await requestClient('set-paused',{id:binding.streamId,userId:binding.publisherPeer,...state});
            requireValue(response.err===0,'VIEWER_SOURCE_STATE_REJECTED');
            onEvent({event:'native-viewer-source-state-synced',...state});
            // Opt-in beta4.1 experiment: a fresh audio track repeats the native
            // track callback after the previous track pointer has been stored.
            if(audioRefresh && audio && audioCodec && !audioRefreshRequested){
              audioRefreshRequested=true;audioRefreshPending=true;
              const refreshed=await requestClient('main-producer-changed',{id:binding.streamId,userId:binding.publisherPeer,kind:'audio',codec:audioCodec});
              requireValue(refreshed.err===0,'VIEWER_AUDIO_REFRESH_REJECTED');
              onEvent({event:'native-viewer-audio-refresh-announced'});
            }
          };
        }
      } else if(frame.cmd==='consume-stream') {
        requireValue(ready && object(args.rtpCapabilities)
          && (args.filter===undefined || ['audio','video'].includes(args.filter)),'INVALID_VIEWER_CONSUME');
        result={};
        const stageAudio=audioFirst && args.filter===undefined && !consumers.size && !!videoCodec;
        const kinds=args.filter ? [args.filter] : stageAudio ? ['audio'] : awaitingVideo ? ['video'] : ['audio','video'];
        for(const kind of kinds) {
          let consumer=consumers.get(kind);
          const refresh=kind==='audio' && args.filter==='audio' && audioRefreshPending;
          const replace=refresh && consumer;
          if(!consumer || replace) {
            try { consumer=await media.consume({token:frame.token,streamId:binding.streamId,kind,rtpCapabilities:args.rtpCapabilities,...(replace?{replaceConsumerId:consumer.id}:{})}); }
            catch(error){if(error.code==='PUBLISHER_MEDIA_UNAVAILABLE'){if(stageAudio && kind==='audio')kinds.push('video');continue;}throw error;}
            consumers.set(kind,consumer);
            if(refresh){audioRefreshPending=false;onEvent({event:'native-viewer-audio-refreshed'});}
          }
          if(connected)await media.setPaused({token:frame.token,streamId:binding.streamId,consumerId:consumer.id,paused:paused[kind]});
          // The native parser expects optional audio/video objects, not an array.
          result[kind]=JSON.parse(JSON.stringify({...consumer,paused:paused[kind]}));
          if(stageAudio && kind==='audio')awaitingVideo=true;
          if(kind==='video')awaitingVideo=false;
        }
      } else throw new WireError('NATIVE_HANDLER_UNAVAILABLE');
      return encodeResponse({responseId:frame.requestId,err:0,...(result===undefined?{}:{args:result})});
    },
    afterResponse() {
      if(!deferred || closed)return;
      const action=deferred;deferred=undefined;
      background=background.then(action).catch(async error=>{
        const report=!closed;await cleanup();if(report)onFailure(error?.code ?? 'VIEWER_JOIN_FAILED');
      });
    },
    invalidate({userId,streamId}) {
      if(!binding || ![binding.userId,binding.publisherPeer].includes(userId)
        || (streamId && streamId!==binding.streamId))return false;
      void cleanup();return true;
    },
    async close(){await cleanup();await background;},
  };
}
