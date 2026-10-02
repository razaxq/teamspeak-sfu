import { createWorker } from 'mediasoup';
import {isLiveExpiry} from './expiry.js';

export class LabError extends Error {}
function requireValue(condition, code) { if (!condition) throw new LabError(code); }
const codecs = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
  { kind: 'video', mimeType: 'video/AV1', clockRate: 90000 },
];

// No TeamSpeak signaling assumptions live here. The lab adapter owns serialization.
export class MediaCore {
  static async create({ listenIp = '127.0.0.1', announcedAddress, mediaPort = 19000,
    maxRooms = 8, maxPeers = 32 } = {}) {
    const core = new MediaCore();
    core.joinQueue = Promise.resolve();
    core.rooms = new Map(); core.maxRooms = maxRooms; core.maxPeers = maxPeers;
    core.worker = await createWorker({ logLevel: 'error' });
    try {
      core.webRtcServer = await core.worker.createWebRtcServer({ listenInfos:
        ['udp', 'tcp'].map(protocol => ({ protocol, ip: listenIp, port: mediaPort,
          ...(announcedAddress ? { announcedAddress } : {}) })) });
      return core;
    } catch (err) { core.worker.close(); throw err; }
  }
  counts() {
    const result = { rooms: this.rooms.size, peers: 0, transports: 0, producers: 0, consumers: 0 };
    for (const room of this.rooms.values()) for (const peer of room.peers.values()) {
      result.peers++;
      for (const key of ['transports', 'producers', 'consumers']) result[key] += peer[key].size;
    }
    return result;
  }
  join(claims, notify = () => {}) {
    // Router creation yields: serialize admission so concurrent sockets cannot
    // replace the same room or bypass peer/room limits.
    const result = this.joinQueue.then(() => this.admit(claims, notify));
    this.joinQueue = result.then(() => {}, () => {});
    return result;
  }
  async admit(claims, notify) {
    requireValue(this.maxPeers === 0 || this.counts().peers < this.maxPeers, 'PEER_LIMIT');
    let room = this.rooms.get(claims.room);
    if (!room) {
      requireValue(this.maxRooms === 0 || this.rooms.size < this.maxRooms, 'ROOM_LIMIT');
      room = { id: claims.room, peers: new Map(), router: await this.worker.createRouter({ mediaCodecs: codecs }) };
      this.rooms.set(room.id, room);
    }
    requireValue(!room.peers.has(claims.peer), 'PEER_EXISTS');
    const peer = { id: claims.peer, role: claims.role, exp: claims.exp, room, notify,
      transports: new Map(), producers: new Map(), consumers: new Map(), closed: false };
    room.peers.set(peer.id, peer);
    return peer;
  }
  listProducers(peer) {
    return [...peer.room.peers.values()].flatMap(p => [...p.producers.values()]
      .map(producer => ({ id: producer.id, peer: p.id, kind: producer.kind })));
  }
  broadcast(room, event, data) {
    for (const peer of room.peers.values()) if (!peer.closed) peer.notify({ event, data });
  }
  owned(map, id) { const value = map.get(id); requireValue(value && !value.closed, 'NOT_FOUND'); return value; }
  async request(peer, method, data = {}) {
    requireValue(peer && !peer.closed, 'NOT_JOINED');
    requireValue(isLiveExpiry(peer.exp), 'TOKEN_EXPIRED');
    requireValue(data && typeof data === 'object' && !Array.isArray(data), 'INVALID_DATA');
    switch (method) {
      case 'getRouterRtpCapabilities': return peer.room.router.rtpCapabilities;
      case 'listProducers': return this.listProducers(peer);
      case 'createTransport': {
        requireValue(['send', 'recv'].includes(data.direction), 'INVALID_DIRECTION');
        requireValue(data.direction !== 'send' || peer.role === 'publish', 'FORBIDDEN');
        requireValue(![...peer.transports.values()].some(t => t.appData.direction === data.direction), 'TRANSPORT_LIMIT');
        const transport = await peer.room.router.createWebRtcTransport({ webRtcServer: this.webRtcServer,
          enableUdp: true, enableTcp: true, preferUdp: true, initialAvailableOutgoingBitrate: 1000000,
          appData: { direction: data.direction } });
        try { await transport.setMaxIncomingBitrate(8000000); }
        catch (err) { transport.close(); throw err; }
        peer.transports.set(transport.id, transport);
        transport.observer.on('close', () => peer.transports.delete(transport.id));
        transport.on('dtlsstatechange', state => { if (state === 'closed' || state === 'failed') transport.close(); });
        return { id: transport.id, iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters };
      }
      case 'connectTransport': {
        const transport = this.owned(peer.transports, data.transportId);
        await transport.connect({ dtlsParameters: data.dtlsParameters }); return {};
      }
      case 'restartIce': return this.owned(peer.transports, data.transportId).restartIce();
      case 'produce': {
        requireValue(peer.role === 'publish', 'FORBIDDEN');
        requireValue(peer.producers.size < 4, 'PRODUCER_LIMIT');
        const transport = this.owned(peer.transports, data.transportId);
        requireValue(transport.appData.direction === 'send', 'INVALID_DIRECTION');
        requireValue(['audio', 'video'].includes(data.kind), 'INVALID_KIND');
        requireValue(data.paused === undefined || typeof data.paused === 'boolean', 'INVALID_PAUSED');
        const producer = await transport.produce({ kind: data.kind, rtpParameters: data.rtpParameters, paused: data.paused ?? false });
        peer.producers.set(producer.id, producer);
        producer.on('transportclose', () => producer.close());
        producer.observer.on('close', () => {
          peer.producers.delete(producer.id);
          this.broadcast(peer.room, 'producerClosed', { producerId: producer.id });
        });
        this.broadcast(peer.room, 'newProducer', { id: producer.id, peer: peer.id, kind: producer.kind });
        return { id: producer.id };
      }
      case 'consume': {
        requireValue(peer.consumers.size < 32, 'CONSUMER_LIMIT');
        requireValue(![...peer.consumers.values()].some(c => c.producerId === data.producerId), 'ALREADY_CONSUMING');
        // Existence in this room is checked BEFORE querying mediasoup; IDs grant no authority.
        requireValue(this.listProducers(peer).some(p => p.id === data.producerId && p.peer !== peer.id), 'NOT_FOUND');
        const transport = this.owned(peer.transports, data.transportId);
        requireValue(transport.appData.direction === 'recv', 'INVALID_DIRECTION');
        requireValue(peer.room.router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities }), 'CANNOT_CONSUME');
        const consumer = await transport.consume({ producerId: data.producerId,
          rtpCapabilities: data.rtpCapabilities, paused: true });
        peer.consumers.set(consumer.id, consumer);
        consumer.on('transportclose', () => consumer.close());
        consumer.on('producerclose', () => consumer.close());
        consumer.observer.on('close', () => {
          peer.consumers.delete(consumer.id);
          peer.notify({ event: 'consumerClosed', data: { consumerId: consumer.id } });
        });
        return { id: consumer.id, producerId: consumer.producerId, kind: consumer.kind,
          rtpParameters: consumer.rtpParameters };
      }
      case 'pauseConsumer': await this.owned(peer.consumers, data.consumerId).pause(); return {};
      case 'resumeConsumer': await this.owned(peer.consumers, data.consumerId).resume(); return {};
      case 'setProducerPaused': {
        requireValue(typeof data.paused === 'boolean', 'INVALID_PAUSED');
        const producer = this.owned(peer.producers, data.producerId);
        if (data.paused) await producer.pause(); else await producer.resume();
        return {};
      }
      case 'closeProducer': this.owned(peer.producers, data.producerId).close(); return {};
      case 'closeConsumer': this.owned(peer.consumers, data.consumerId).close(); return {};
      case 'stats': return {
        transports: await Promise.all([...peer.transports.values()].map(t => t.getStats())),
        producers: await Promise.all([...peer.producers.values()].map(p => p.getStats())),
        consumers: await Promise.all([...peer.consumers.values()].map(c => c.getStats())),
      };
      default: throw new LabError('UNKNOWN_METHOD');
    }
  }
  leave(peer) {
    if (!peer || peer.closed) return;
    peer.closed = true;
    for (const transport of [...peer.transports.values()]) transport.close();
    peer.room.peers.delete(peer.id);
    if (!peer.room.peers.size) { peer.room.router.close(); this.rooms.delete(peer.room.id); }
  }
  close() {
    for (const room of [...this.rooms.values()]) for (const peer of [...room.peers.values()]) this.leave(peer);
    this.worker.close();
  }
}
