import {isLiveExpiry} from '../expiry.js';
import { randomUUID } from 'node:crypto';
import { WireError } from './wire.js';

export function parseControlCommand(input, { maxBytes = 2048 } = {}) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > maxBytes || /[\r\n\0|]/.test(input)) throw new Error('Invalid control command');
  const [command, ...parts] = input.split(' ');
  const args = Object.create(null);
  for (const part of parts) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:=([^ ]*))?$/.exec(part);
    if (!match || Object.hasOwn(args, match[1])) throw new Error('Invalid control argument');
    args[match[1]] = (match[2] ?? '').replace(/\\(.)/g, (_, c) => {
      const escapes = { s: ' ', p: '|', '/': '/', '\\': '\\', n: '\n', r: '\r', t: '\t', v: '\v', f: '\f', a: '\x07', b: '\b' };
      if (!Object.hasOwn(escapes, c)) throw new Error('Invalid escape');
      return escapes[c];
    });
  }
  return { command, args };
}
// Only requeststreaminfo has a bounded multi-row grammar. Other commands keep
// rejecting raw pipes so a batch cannot smuggle a second control command.
export function parseStreamInfoRequest(input) {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 2048) throw new Error('Invalid info request');
  const parts = input.split('|');
  if (parts.length > 16) throw new Error('Too many info rows');
  const rows = parts.map((part, index) => parseControlCommand(index ? 'requeststreaminfo ' + part : part));
  if (rows.some(row => row.command !== 'requeststreaminfo')) throw new Error('Invalid info command');
  const ids = new Set(); let returnCode;
  for (const {args} of rows) {
    if (Object.keys(args).some(k => !['clid', 'return_code'].includes(k))
        || !/^[1-9][0-9]{0,4}$/.test(args.clid ?? '') || Number(args.clid) > 65535
        || ids.has(args.clid)) throw new Error('Invalid info row');
    ids.add(args.clid);
    if (args.return_code !== undefined) {
      if (returnCode !== undefined || args.return_code.length > 256 || /[\x00-\x1f\x7f]/.test(args.return_code))
        throw new Error('Invalid info return code');
      returnCode = args.return_code;
    }
  }
  return {command:'requeststreaminfo', args:{}, clientIds:[...ids], returnCode};
}
const escape = value => String(value).replace(/\\/g, '\\\\').replace(/\//g, '\\/').replace(/ /g, '\\s').replace(/\|/g, '\\p');
const number = (value, min, max) => /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
const same = (a, b) => b && ['clientId', 'serverId', 'channelId', 'sessionId', 'uid'].every(k => a[k] === b[k]);

// Server-owned stream state. All operations originate in authenticated TS command
// handlers through the private bridge, never in client WebSocket messages.
export function createStreamControl({ registry, resolveClient, canPublish, canView = async () => false,
  endpoint, maxStreams = 0, onEvent = () => {} }) {
  if (!registry || typeof resolveClient !== 'function' || typeof canPublish !== 'function'
      || typeof canView !== 'function'
      || !/^[a-zA-Z0-9.-]+:[0-9]{1,5}$/.test(endpoint) || Number(endpoint.split(':')[1]) > 65535)
    throw new TypeError('Explicit stream policy and endpoint required');
  const streams = new Map(), listeners = new Set(); let tail = Promise.resolve(), epoch = 0;
  const viewerCount = stream => [...stream.viewers.values()].filter(v => v.active).length;
  function changed(stream, type, extra = {}) {
    const event = {type,streamId:stream.id,serverId:stream.owner.serverId,channelId:stream.owner.channelId,
      publisherClientId:stream.owner.clientId,viewers:viewerCount(stream),...extra};
    // Delivery is a separate adapter. Listener failures cannot undo admission.
    for (const listener of listeners) { try { listener(Object.freeze(event)); } catch { onEvent({event:'stream-listener-failed'}); } }
  }
  function remove(stream, reason) {
    if (!streams.delete(stream.id)) return;
    stream.viewers.clear();changed(stream,'stopped',reason === undefined ? {} : {reason});
    registry.revokeStream(stream.id);
  }
  const unsubscribe = registry.subscribeRevocations(event => {
    epoch++;
    for (const stream of streams.values()) if (stream.sfuUserId === event.userId
        && (!event.streamId || stream.id === event.streamId)) remove(stream);
    for (const stream of streams.values()) if ((!event.streamId || stream.id === event.streamId)
        && stream.viewers.delete(event.userId)) changed(stream,'viewers');
  });
  async function dispatch(clientId, input) {
    const reject = (reason, error = 256) => {
      onEvent({event:'stream-control-rejected',reason}); return {error};
    };
    let parsed;
    try { parsed = typeof input === 'string' && input.startsWith('requeststreaminfo ')
      ? parseStreamInfoRequest(input) : parseControlCommand(input); } catch { onEvent({event:'stream-control-invalid-frame'}); return { error: 256 }; }
    const { command, args } = parsed;
    onEvent({event:'stream-control-request',command:['setupstream','stopstream','requeststreaminfo'].includes(command)?command:'OTHER',...Object.fromEntries(['mode','type','bitrate','accessibility','viewer_limit','audio'].filter(k=>Object.hasOwn(args,k)).map(k=>[k,/^[0-9]{1,12}$/.test(args[k])?args[k]:'NON_NUMERIC'])),namePresent:Object.hasOwn(args,'name'),nameEmpty:args.name==='',returnCodePresent:Object.hasOwn(args,'return_code')});
    const live = await resolveClient(clientId);
    if (!live || live.clientId !== clientId) return { error: 2568 };
    // Every command rechecks all records against the trusted connection view.
    for (const stream of streams.values()) if (!same(stream.owner, await resolveClient(stream.owner.clientId))) remove(stream);
    if (command === 'setupstream') {
      if (args.mode !== '2') return { pass: true };
      if (!await canPublish(live)) return { error: 2568 };
      const keys = new Set(['name', 'type', 'bitrate', 'accessibility', 'mode', 'viewer_limit', 'audio', 'return_code']);
      if (Object.keys(args).some(key => !keys.has(key))) return reject('UNKNOWN_ARGUMENT');
      if (typeof args.name !== 'string') return reject('MISSING_NAME');
      if (args.name.length > 128) return reject('NAME_TOO_LONG');
      if (/[\x00-\x1f\x7f]/.test(args.name)) return reject('NAME_CONTROL_CHARACTER');
      if (!['2', '3'].includes(args.type)) return reject('UNSUPPORTED_TYPE');
      if (args.accessibility !== '1') return reject('UNSUPPORTED_ACCESSIBILITY');
      if (!number(args.bitrate, 64, 50000)) return reject('BITRATE_RANGE');
      if (!number(args.viewer_limit, 0, 2147483647)) return reject('VIEWER_LIMIT_RANGE');
      if (!['0', '1'].includes(args.audio)) return reject('INVALID_AUDIO');
      if (args.return_code !== undefined && (args.return_code.length > 256 || /[\x00-\x1f\x7f]/.test(args.return_code))) return reject('INVALID_RETURN_CODE');
      if (maxStreams > 0 && streams.size >= maxStreams) return reject('SERVER_STREAM_LIMIT');
      if ([...streams.values()].some(s => s.owner.clientId === clientId)) return reject('CLIENT_ALREADY_STREAMING');
      const owner = { ...live }, id = randomUUID(), version = epoch;
      let grant;
      try { grant = await registry.preparePublisher({ clientId, sessionId: live.sessionId, streamId: id }); }
      catch { return { error: 2568 }; }
      if (!same(owner, await resolveClient(clientId)) || version !== epoch) { registry.revokeStream(id); return { error: 2568 }; }
      const effectiveViewerLimit = args.viewer_limit;
      const stream = { id, owner, ...args, viewer_limit: effectiveViewerLimit, sfuUserId: grant.userId, exp:grant.exp, endpoint, viewers:new Map() };
      streams.set(id, stream);
      const fields = { clid: clientId, id, name: args.name, type: args.type, access: args.accessibility, mode: 2,
        bitrate: args.bitrate, viewer_limit: effectiveViewerLimit, audio: args.audio, sfu_endpoint: endpoint, sfu_user_id: grant.userId };
      stream.announcement='notifystreamstarted ' + Object.entries(fields).map(([k,v]) => `${k}=${escape(v)}`).join(' ');
      changed(stream,'started',{notification:stream.announcement});
      if (args.return_code !== undefined) fields.return_code = args.return_code;
      return { notification: 'notifystreamstarted ' + Object.entries(fields).map(([k,v]) => `${k}=${escape(v)}`).join(' ') };
    }
    if (command === 'requeststreaminfo') {
      if (!parsed.clientIds) return reject('INVALID_INFO_REQUEST');
      const requested = parsed.clientIds.map(id => [...streams.values()].find(s => s.owner.clientId === id));
      if (requested.every(s => !s)) return { pass: true };
      // Mixing original-server P2P state with our SFU directory needs a merge
      // bridge. Reject explicitly until it exists rather than silently lose rows.
      if (requested.some(s => !s)) return reject('MIXED_INFO_DIRECTORY');
      const viewer = { ...live }, version = epoch;
      for (const stream of requested) {
        if (viewer.serverId !== stream.owner.serverId || viewer.channelId !== stream.owner.channelId
            || !await canView({ ...viewer }, { ...stream.owner })) return { error: 2568 };
      }
      const rows = requested.map(stream => {
        const fields = { clid: stream.owner.clientId, id: stream.id, name: stream.name, type: stream.type,
          accessibility: stream.accessibility, mode: 2, viewer: viewerCount(stream), bitrate: stream.bitrate,
          viewer_limit: stream.viewer_limit, audio: stream.audio, sfu_endpoint: stream.endpoint, sfu_user_id: stream.sfuUserId };
        return Object.entries(fields).map(([k,v]) => `${k}=${escape(v)}`).join(' ');
      });
      const notification = 'notifystreaminfo ' + rows.join('|')
        + (parsed.returnCode === undefined ? '' : ` return_code=${escape(parsed.returnCode)}`);
      // C bridge has a 4096-byte response buffer including prefix/newline/NUL.
      if (Buffer.byteLength(notification) > 4092) return reject('INFO_RESPONSE_LIMIT');
      const admitted = [];
      try {
        for (const stream of requested) if (!same(stream.owner, viewer)) {
          await registry.prepareViewer({ clientId, sessionId: viewer.sessionId,
            publisherClientId: stream.owner.clientId, publisherSessionId: stream.owner.sessionId, streamId: stream.id });
          admitted.push(stream.id);
        }
        if (!same(viewer, await resolveClient(clientId))) throw new Error('Viewer changed');
        for (const stream of requested) if (!same(stream.owner, await resolveClient(stream.owner.clientId))
            || streams.get(stream.id) !== stream) throw new Error('Publisher changed');
        if (version !== epoch) throw new Error('Authorization changed');
      } catch {
        // Fail closed for this viewer's queried streams if admission races or
        // exceeds the per-viewer limit; never return a partial success batch.
        for (const id of admitted) registry.revokeViewer(clientId, id);
        return { error: 2568 };
      }
      return { notification };
    }
    if (command === 'stopstream') {
      const stream = streams.get(args.id);
      if (!stream) return { pass: true };
      if (!same(stream.owner, live)) return { error: 2568 };
      if (!number(args.reason, 0, 16)) return { error: 256 };
      remove(stream,Number(args.reason));
      return { notification: `notifystreamstopped clid=${clientId} id=${stream.id} reason=${args.reason}` };
    }
    return { pass: true };
  }
  return {
    // Called by the registry only after credential verification. Admission is
    // based on current TS identities and server-owned stream policy, regardless
    // of whether this client previously requested stream info.
    async resolveViewerGrant(viewer, streamId) {
      const stream=streams.get(streamId),version=epoch;
      if(!stream || !isLiveExpiry(stream.exp) || same(viewer,stream.owner)
        || viewer.serverId!==stream.owner.serverId || viewer.channelId!==stream.owner.channelId
        || !same(viewer,await resolveClient(viewer.clientId))
        || !await canView({...viewer},{...stream.owner})
        || !same(stream.owner,await resolveClient(stream.owner.clientId))
        || !same(viewer,await resolveClient(viewer.clientId))
        || epoch!==version || streams.get(streamId)!==stream)return null;
      return {...stream.owner};
    },
    // Trusted notification adapter only. Discovery does not grant media access.
    async listChannelStreams(clientId) {
      const live=await resolveClient(clientId);if(!live)return [];
      const viewer={...live},result=[];
      for(const stream of streams.values()) {
        if(!isLiveExpiry(stream.exp) || !same(stream.owner,await resolveClient(stream.owner.clientId))){remove(stream);continue;}
        if(viewer.serverId!==stream.owner.serverId || viewer.channelId!==stream.owner.channelId
          || !await canView({...viewer},{...stream.owner}))continue;
        if(streams.get(stream.id)===stream)result.push({id:stream.id,publisherClientId:stream.owner.clientId,notification:stream.announcement});
      }
      return same(viewer,await resolveClient(clientId)) ? result : [];
    },
    // Called only after WebSocket authorization, before asking the publisher.
    // Pending joins reserve capacity; only acknowledged joins count as viewers.
    reserveViewer(principal) {
      const stream=streams.get(principal?.streamId);
      if (principal?.role !== 'view' || !stream || principal.publisherPeer !== stream.sfuUserId
          || typeof principal.userId !== 'string' || !principal.userId
          || !isLiveExpiry(principal.exp))
        throw new WireError('VIEWER_ADMISSION_UNAVAILABLE');
      if (stream.viewers.has(principal.userId)) throw new WireError('VIEWER_ALREADY_RESERVED');
      if (Number(stream.viewer_limit)>0 && stream.viewers.size>=Number(stream.viewer_limit)) throw new WireError('VIEWER_LIMIT');
      const record={active:false};stream.viewers.set(principal.userId,record);
      return {
        activate() {
          if (streams.get(stream.id)!==stream || stream.viewers.get(principal.userId)!==record)
            throw new WireError('VIEWER_RESERVATION_REVOKED');
          if (!record.active) {record.active=true;changed(stream,'viewers');}
        },
        release() {
          if (stream.viewers.get(principal.userId)!==record) return;
          stream.viewers.delete(principal.userId);if(record.active)changed(stream,'viewers');
        },
      };
    },
    subscribeStreams(listener) {listeners.add(listener);return ()=>listeners.delete(listener);},
    dispatch(clientId, input) {
      const result = tail.then(() => dispatch(clientId, input)).then(result => { onEvent({event:'stream-control-result',result:result.pass?'PASSTHROUGH':result.error?'REJECTED':'ACCEPTED',error:result.error}); return result; });
      tail = result.catch(() => {}); return result;
    },
    revokeClient(clientId) { epoch++; for (const stream of streams.values()) if (stream.owner.clientId === clientId) remove(stream); },
    clear() { epoch++; for (const stream of streams.values()) remove(stream); },
    close() { unsubscribe(); this.clear(); listeners.clear(); },
    get size() { return streams.size; },
  };
}
