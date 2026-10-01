// Metadata only: no credentials, stream identifiers, ICE secrets or media data.
export async function collectMediaDiagnostics(core) {
  const transports = [], producers = [], consumers = [];
  for (const room of core.rooms.values()) for (const peer of room.peers.values()) {
    for (const transport of peer.transports.values()) for (const stats of await transport.getStats())
      transports.push(Object.fromEntries(['iceState', 'dtlsState', 'bytesReceived', 'rtpBytesReceived', 'bytesSent', 'rtpBytesSent']
        .filter(k => stats[k] !== undefined).map(k => [k, stats[k]])));
    for (const producer of peer.producers.values()) {
      const stats = await producer.getStats();
      const metadata = { kind: producer.kind, paused: producer.paused,
        mimeType: producer.rtpParameters.codecs[0]?.mimeType,
        rtpObserved: stats.some(s => s.packetCount > 0) };
      // A producer without RTP has an empty stats array. Keep it visible so
      // "allocated but paused/no RTP" cannot be confused with "not created".
      if (!stats.length) producers.push(metadata);
      for (const row of stats) producers.push({ ...metadata,
        ...Object.fromEntries(['packetCount', 'byteCount', 'bitrate', 'mimeType']
          .filter(k => row[k] !== undefined).map(k => [k, row[k]])) });
    }
    for (const consumer of peer.consumers.values()) {
      const stats=await consumer.getStats();
      // Only outbound rows describe this viewer; omit inbound producer rows.
      const outbound=stats.filter(row=>row.type==='outbound-rtp');
      const metadata={kind:consumer.kind,paused:consumer.paused,sourcePaused:consumer.producerPaused,
        mimeType:consumer.rtpParameters.codecs[0]?.mimeType,rtpSent:outbound.some(row=>row.packetCount>0)};
      if(!outbound.length)consumers.push(metadata);
      for(const row of outbound)consumers.push({...metadata,...Object.fromEntries(
        ['packetCount','byteCount','bitrate','packetsLost','fractionLost','roundTripTime','score']
          .filter(k=>row[k]!==undefined).map(k=>[k,row[k]]))});
    }
  }
  return { transports, producers, consumers };
}
