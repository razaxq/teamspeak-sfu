import { Device } from 'mediasoup-client';

// Browser media test driver. Control is a Playwright bridge, NOT TeamSpeak wire.
class ViewerMediaTestClient {
  constructor(){this.consumers=new Map();}
  async connect(){
    const {transportInfo}=await window.viewerMediaRpc('open',{});
    this.device=new Device();await this.device.load({routerRtpCapabilities:transportInfo.routerCapabilities});
    this.recvTransport=this.device.createRecvTransport(transportInfo);
    this.recvTransport.on('connect',({dtlsParameters},done,fail)=>{
      window.viewerMediaRpc('connect',{dtlsParameters}).then(done,fail);
    });
  }
  async consume(producerId){
    const options=await window.viewerMediaRpc('consume',{producerId,rtpCapabilities:this.device.rtpCapabilities});
    const consumer=await this.recvTransport.consume(options);this.consumers.set(consumer.id,consumer);
    await window.viewerMediaRpc('resume',{consumerId:consumer.id});return consumer;
  }
  onEvent(message){
    if(message.event==='consumerClosed'){
      this.consumers.get(message.data.consumerId)?.close();this.consumers.delete(message.data.consumerId);
    }
  }
  close(){this.recvTransport?.close();this.consumers.clear();return window.viewerMediaRpc('close',{});}
}
window.ViewerMediaTestClient=ViewerMediaTestClient;
