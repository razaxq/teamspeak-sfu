import { Device } from 'mediasoup-client';

export class LabClient {
  constructor() { this.pending = new Map(); this.consumers = new Map(); this.producers = new Map(); this.nextId = 1; }
  async connect(token) {
    this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/lab/ws`);
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if ('id' in msg) {
        const pending = this.pending.get(msg.id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(msg.id); msg.ok ? pending.resolve(msg.data) : pending.reject(new Error(msg.error)); }
      } else if (msg.event === 'consumerClosed') {
        this.consumers.get(msg.data.consumerId)?.close(); this.consumers.delete(msg.data.consumerId);
      }
      this.onEvent?.(msg);
    };
    this.ws.onclose = () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Disconnected')); }
      this.pending.clear(); this.sendTransport?.close(); this.recvTransport?.close();
      this.producers.clear(); this.consumers.clear();
      this.onClose?.();
    };
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('Connection failed')); });
    this.session = await this.rpc('join', { token });
    this.device = new Device();
    await this.device.load({ routerRtpCapabilities: this.session.rtpCapabilities });
    return this.session;
  }
  rpc(method, data = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('Disconnected'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Request timed out')); }, 10000);
      this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, data }));
    });
  }
  async transport(direction) {
    const key = direction === 'send' ? 'sendTransport' : 'recvTransport';
    if (this[key]) return this[key];
    const options = await this.rpc('createTransport', { direction });
    const transport = direction === 'send' ? this.device.createSendTransport(options) : this.device.createRecvTransport(options);
    transport.on('connect', ({ dtlsParameters }, done, fail) => {
      this.rpc('connectTransport', { transportId: transport.id, dtlsParameters }).then(done, fail);
    });
    transport.on('produce', ({ kind, rtpParameters }, done, fail) => {
      this.rpc('produce', { transportId: transport.id, kind, rtpParameters }).then(done, fail);
    });
    this[key] = transport; return transport;
  }
  async publish(track) {
    const producer = await (await this.transport('send')).produce({ track });
    this.producers.set(producer.id, producer);
    producer.on('trackended', () => { void this.stopProducer(producer.id).catch(() => {}); });
    return producer.id;
  }
  async stopProducer(id) {
    await this.rpc('closeProducer', { producerId: id });
    this.producers.get(id)?.close(); this.producers.delete(id);
  }
  async consume(producerId) {
    const transport = await this.transport('recv');
    const options = await this.rpc('consume', { transportId: transport.id, producerId,
      rtpCapabilities: this.device.rtpCapabilities });
    const consumer = await transport.consume(options);
    this.consumers.set(consumer.id, consumer);
    await this.rpc('resumeConsumer', { consumerId: consumer.id });
    return consumer;
  }
  close() { this.ws?.close(); this.sendTransport?.close(); this.recvTransport?.close(); }
}
window.LabClient = LabClient;
const status = document.querySelector('#status');
const token = document.querySelector('#token');
let client, source;
const show = message => { status.textContent = message; };
const run = fn => async () => { try { await fn(); } catch (err) { show(err.message); } };
document.querySelector('#connect').onclick = run(async () => {
  source?.getTracks().forEach(t => t.stop()); source = null;
  client?.close(); client = new LabClient();
  const session = await client.connect(token.value.trim()); token.value = '';
  show(`已进入 ${session.room}，角色：${session.role}`);
  client.onClose = () => show('连接已关闭');
});
document.querySelector('#publish').onclick = run(async () => {
  if (!client?.session) throw new Error('请先连接');
  if (source) throw new Error('请先停止当前共享');
  source = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  try { for (const track of source.getTracks()) await client.publish(track); show('共享中'); }
  catch (err) { source.getTracks().forEach(t => t.stop()); source = null; throw err; }
});
document.querySelector('#watch').onclick = run(async () => {
  if (!client?.session) throw new Error('请先连接');
  const producers = await client.rpc('listProducers');
  for (const p of producers) {
    if (p.peer === client.session.peer || [...client.consumers.values()].some(c => c.producerId === p.id)) continue;
    const consumer = await client.consume(p.id);
    const element = document.createElement(p.kind === 'video' ? 'video' : 'audio');
    element.autoplay = true; element.controls = true; element.playsInline = true;
    element.srcObject = new MediaStream([consumer.track]); document.querySelector('#media').append(element);
    consumer.observer.on('close', () => { element.srcObject = null; element.remove(); });
    await element.play().catch(() => {});
  }
  show(`已订阅 ${client.consumers.size} 条媒体轨道`);
});
document.querySelector('#stop').onclick = run(async () => {
  if (client) for (const id of [...client.producers.keys()]) await client.stopProducer(id);
  source?.getTracks().forEach(t => t.stop()); source = null; show('共享已停止');
});
window.addEventListener('beforeunload', () => { source?.getTracks().forEach(t => t.stop()); client?.close(); });
