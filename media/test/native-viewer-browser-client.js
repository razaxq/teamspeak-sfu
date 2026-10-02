import {Device} from 'mediasoup-client';
// Synthetic browser exercising the candidate TeamSpeak wire profile, not an
// official client. Its agreement with the server is not compatibility proof.
class NativeViewer {
  constructor(){this.pending=new Map();this.consumers=new Map();this.nextId=1;this.creationOrder=[];}
  async connect({url,token,streamId,expectAudioRefresh=false}) {
    this.token=token;this.streamId=streamId;this.expectAudioRefresh=expectAudioRefresh;
    const joined=new Promise((resolve,reject)=>{this.joined=resolve;this.joinFailed=reject;});
    this.ws=new WebSocket(url);
    this.ws.onmessage=async({data})=>{
      const message=JSON.parse(data);
      if(message.cmd==='join-response'){
        try {
          if(!message.args.accepted)throw new Error('Publisher denied viewer');
          this.videoExpected=!!message.args.videoCodec;
          const options=message.args.transportInfo;
          this.device=new Device();await this.device.load({routerRtpCapabilities:options.routerCapabilities});
          this.recvTransport=this.device.createRecvTransport(options);
          this.recvTransport.on('connect',({dtlsParameters},done,fail)=>this.rpc('transport-connect',{dtlsParameters}).then(done,fail));
          this.ws.send(JSON.stringify({responseId:message.requestId,err:0}));this.joined();
        } catch(error){this.joinFailed(error);}return;
      }
      if(message.cmd==='main-producer-changed' && message.args.kind==='audio'){
        try {
          const previous=[...this.consumers.values()].find(c=>c.kind==='audio');
          const result=await this.rpc('consume-stream',{filter:'audio',rtpCapabilities:this.device.rtpCapabilities});
          const consumer=await this.recvTransport.consume(result.audio);this.consumers.set(consumer.id,consumer);
          if(previous){previous.close();this.consumers.delete(previous.id);await this.rpc('close-consumer-producer',{kind:'consumer',consumerProducerId:previous.id});}
          await this.rpc('set-paused',{audio:false,video:false});
          this.audioRefreshCount=(this.audioRefreshCount??0)+1;this.audioRefreshed=true;this.audioReady?.();
          this.ws.send(JSON.stringify({responseId:message.requestId,err:0}));
        }catch(error){this.refreshError=error;this.audioReady?.();}
        return;
      }
      if(message.cmd==='main-producer-changed'){
        this.videoAvailable=true;this.videoReady?.();
        this.ws.send(JSON.stringify({responseId:message.requestId,err:0}));return;
      }
      if(message.cmd==='set-paused'){
        // Source state is separate from this viewer's local pause preference.
        this.sourcePaused={audio:message.args.audio,video:message.args.video};
        this.ws.send(JSON.stringify({responseId:message.requestId,err:0}));return;
      }
      const pending=this.pending.get(message.responseId);if(!pending)return;
      this.pending.delete(message.responseId);clearTimeout(pending.timer);
      message.err===0?pending.resolve(message.args):pending.reject(new Error('Request failed'));
    };
    this.ws.onclose=()=>{
      this.joinFailed(new Error('Disconnected'));
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Disconnected'));}
      this.pending.clear();this.recvTransport?.close();this.consumers.clear();
    };
    await new Promise((resolve,reject)=>{this.ws.onopen=resolve;this.ws.onerror=reject;});
    await this.rpc('join-request',{signedIdentityType:0,signedIdentity:'synthetic-browser',isRemove:false,
      codecs:['video/AV1','video/VP8','audio/opus']});await joined;
  }
  rpc(cmd,args){return new Promise((resolve,reject)=>{
    const requestId=String(this.nextId++),timer=setTimeout(()=>{this.pending.delete(requestId);reject(new Error('Timed out'));},10000);
    this.pending.set(requestId,{resolve,reject,timer});
    this.ws.send(JSON.stringify({cmd,requestId,token:this.token,args:{...args,id:this.streamId}}));
  });}
  async consume(producerId){
    this.prepared ??= (async()=>{
      const initial=await this.rpc('consume-stream',{rtpCapabilities:this.device.rtpCapabilities});
      const install=async options=>{for(const option of Object.values(options)){
        const consumer=await this.recvTransport.consume(option);this.consumers.set(consumer.id,consumer);this.creationOrder.push(consumer.kind);
      }};
      await install(initial);await this.rpc('set-paused',{audio:false,video:false});
      if(this.videoExpected && !initial.video){
        if(!this.videoAvailable)await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('Video announcement timeout')),5000);
          this.videoReady=()=>{clearTimeout(timer);resolve();};
        });
        await install(await this.rpc('consume-stream',{filter:'video',rtpCapabilities:this.device.rtpCapabilities}));
        await this.rpc('set-paused',{audio:false,video:false});
      }
    })();
    await this.prepared;
    if(this.expectAudioRefresh && !this.audioRefreshed && !this.refreshError)await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Audio refresh timeout')),7000);
      this.audioReady=()=>{clearTimeout(timer);resolve();};
    });
    if(this.refreshError)throw this.refreshError;
    const consumer=[...this.consumers.values()].find(c=>c.producerId===producerId);
    if(!consumer)throw new Error('Producer absent');return consumer;
  }
  close(){this.ws?.close();this.recvTransport?.close();this.consumers.clear();}
}
window.NativeViewer=NativeViewer;
