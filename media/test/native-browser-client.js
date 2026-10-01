// Browser test driver for the recovered native publisher envelope.
// It is NOT an official TeamSpeak client or a replacement authentication scheme.
import { Device } from 'mediasoup-client';
class NativePublisher {
  constructor() { this.pending = new Map(); this.producers = new Map(); this.nextId = 1; }
  async connect({ url, token, streamId, syntheticApproveJoins = false }) {
    this.token = token; this.streamId = streamId;
    this.ws = new WebSocket(url);
    this.ws.onmessage = ({ data }) => {
      const response = JSON.parse(data);
      if (syntheticApproveJoins && response.cmd === 'join-request') {
        this.ws.send(JSON.stringify({responseId:response.requestId,err:0}));
        if(response.args.isRemove)return;
        void this.rpc('join-response',{id:this.streamId,userId:response.args.userId,accepted:true});return;
      }
      const pending = this.pending.get(response.responseId);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(response.responseId);
      response.err === 0 ? pending.resolve(response.args) : pending.reject(new Error('Native request failed'));
    };
    this.ws.onclose = () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Disconnected')); }
      this.pending.clear(); this.sendTransport?.close(); this.producers.clear();
    };
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('Connection failed')); });
    const options = await this.rpc('create-stream', { id: streamId });
    this.device = new Device();
    await this.device.load({ routerRtpCapabilities: options.routerCapabilities });
    this.sendTransport = this.device.createSendTransport(options);
    this.sendTransport.on('connect', ({ dtlsParameters }, done, fail) => {
      this.rpc('transport-connect', { id: streamId, dtlsParameters }).then(done, fail);
    });
    this.sendTransport.on('produce', ({ kind, rtpParameters }, done, fail) => {
      this.rpc('transport-produce', { id: streamId, kind, rtpParameters, paused: false }).then(done, fail);
    });
  }
  rpc(cmd, args) {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Disconnected'));
      const requestId = String(this.nextId++);
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Timed out')); }, 10000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ cmd, args, token: this.token, requestId }));
    });
  }
  async publish(track, mimeType) {
    const codec = mimeType && this.device.rtpCapabilities.codecs.find(c => c.mimeType.toLowerCase() === mimeType.toLowerCase());
    if (mimeType && !codec) throw new Error('Requested codec unavailable: '+mimeType);
    const producer = await this.sendTransport.produce({ track, ...(codec ? { codec } : {}) });
    this.producers.set(producer.id, producer); return producer.id;
  }
  close() { this.ws?.close(); this.sendTransport?.close(); }
}
window.NativePublisher = NativePublisher;
