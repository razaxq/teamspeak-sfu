import { randomBytes, createHash } from 'node:crypto';
import {isLiveExpiry,earliestExpiry} from '../expiry.js';

const digest = token => createHash('sha256').update(token).digest('hex');
const field = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const same = (a, b) => b && ['serverId', 'clientId', 'sessionId', 'uid', 'channelId'].every(k => a[k] === b[k]);
const publishCommands = new Set(['create-stream', 'transport-connect', 'transport-produce', 'set-paused', 'close-stream', 'join-response']);
const viewCommands = new Set(['join-request', 'transport-connect', 'consume-stream', 'set-paused', 'close-stream', 'close-consumer-producer']);

// Custom experimental server credentials, not an implementation of an official
// signing algorithm. resolveClient must return a trusted, live connection snapshot
// with a sessionId that changes on every reconnect, even for the same TS identity.
export function createAccessRegistry({ resolveClient, resolveViewerGrant = async () => null, makeUserId = () => randomBytes(16).toString('hex'), onEvent = () => {}, ttlSeconds = 0, maxCredentials = 0,
  now = () => Date.now() } = {}) {
  if (typeof resolveClient !== 'function' || !Number.isInteger(ttlSeconds) || ttlSeconds < 0
      || ttlSeconds > 3600 || !Number.isInteger(maxCredentials) || maxCredentials < 0)
    throw new TypeError('Invalid access registry configuration');
  const records = new Map(), lastDiagnostic = new Map();
  function reject(reason, extra = {}) {
    if (!lastDiagnostic.has(reason) || now()-lastDiagnostic.get(reason)>=5000) {
      lastDiagnostic.set(reason,now());
      onEvent({event:"native-auth-rejected",reason,...extra});
    }
    return null;
  }
  let epoch = 0;
  const listeners = new Set();
  function revoked(record, streamId) {
    // A publisher grant owns every downstream viewer grant, including grants
    // whose WebSocket has not connected yet. Remove before notifying listeners.
    for (const viewer of records.values()) for (const [id, grant] of viewer.views) {
      if (grant.publisherKey === record.key && (!streamId || id === streamId)) {
        viewer.views.delete(id); revoked(viewer, id);
      }
    }
    const event = { clientId: record.identity.clientId, userId: record.userId, streamId };
    for (const listener of listeners) listener(event);
  }
  function prune() { for (const [key, record] of records) if (!isLiveExpiry(record.exp, now())) { records.delete(key); revoked(record); } }
  async function current(record) {
    if (!record || !isLiveExpiry(record.exp, now())) return false;
    const live = await resolveClient(record.identity.clientId);
    return records.get(record.key) === record && isLiveExpiry(record.exp, now()) && same(record.identity, live);
  }
  const api = {
    async issue(clientId) {
      const version = epoch;
      const identity = await resolveClient(clientId);
      if (version !== epoch) throw new Error('Client connection changed');
      if (!identity || identity.clientId !== clientId
          || !['serverId', 'clientId', 'sessionId', 'uid', 'channelId'].every(k => field(identity[k])))
        throw new Error('Client connection unavailable');
      prune();
      const pending = [...records.values()].find(r => r.pendingToken && same(r.identity, identity));
      if (pending) { const token = pending.pendingToken; delete pending.pendingToken; return { token, userId: pending.userId, exp: pending.exp }; }
      // Reissue rotates credentials; previous stream grants are deliberately lost.
      for (const [key, record] of records) if (record.identity.clientId === clientId) { records.delete(key); revoked(record); }
      if (maxCredentials > 0 && records.size >= maxCredentials) throw new Error('Credential limit');
      const token = randomBytes(32).toString('hex'), userId = makeUserId({...identity});
      if (!field(userId) || /[\x00-\x1f\x7f]/.test(userId)) throw new Error('Invalid native user identifier');
      const key = digest(token), exp = ttlSeconds === 0 ? null : Math.floor(now() / 1000) + ttlSeconds;
      records.set(key, { key, identity: { ...identity }, userId, exp, streams: new Set(), views: new Map() });
      return { token, userId, exp };
    },
    // This method is for the trusted TS control plane ONLY. Never expose it on
    // the media WebSocket. Bootstrap credentials alone cannot create a stream.
    async preparePublisher({ clientId, sessionId, streamId }) {
      const identity = await resolveClient(clientId);
      if (!identity || identity.sessionId !== sessionId) throw new Error('Client connection unavailable');
      let record = [...records.values()].find(r => same(r.identity, identity) && isLiveExpiry(r.exp, now()));
      if (!record) {
        const credential = await this.issue(clientId);
        record = records.get(digest(credential.token));
        if (!record || record.identity.sessionId !== sessionId) throw new Error('Client connection changed');
        // Official callers may request access info after setupstream. Keep this
        // one pending credential until first delivery, preserving the announced user ID.
        record.pendingToken = credential.token;
      }
      return this.grantPublisher({ clientId, sessionId, streamId });
    },
    async grantPublisher({ clientId, sessionId, streamId }) {
      const version = epoch;
      if (!field(streamId)) throw new Error('Invalid stream');
      const record = [...records.values()].find(r => r.identity.clientId === clientId && r.identity.sessionId === sessionId);
      if (!await current(record) || version !== epoch) throw new Error('Client connection unavailable');
      record.streams.add(streamId);
      return { userId: record.userId, exp: record.exp };
    },
    async authorize({ token, cmd, args }) {
      const version = epoch;
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || (!publishCommands.has(cmd) && !viewCommands.has(cmd))) return null;
      const record = records.get(digest(token));
      if (!record) return reject('CREDENTIAL_UNKNOWN');
      if (!await current(record)) return reject('CONNECTION_OR_EXPIRY');
      if (!args) return reject('ARGS_MISSING');
      // Native viewer userId addresses the publisher, not the token owner.
      // Identity always comes from the verified credential.
      const target = record.streams.has(args.id) ? record
        : [...records.values()].find(r=>r.streams.has(args.id));
      if (cmd !== 'join-response' && Object.hasOwn(args, 'userId') && args.userId !== target?.userId)
        return reject('USER_ID_MISMATCH');
      let role, publisherPeer, exp = record.exp;
      if (record.streams.has(args.id) && publishCommands.has(cmd)) role = 'publish';
      else {
        // Official clients can join from a stream-start notification without an
        // info query. Only a verified credential may ask the trusted directory
        // for admission; client fields never select the publisher identity.
        if (!record.views.has(args.id) && cmd === 'join-request' && args.isRemove === false && field(args.id)) {
          try {
            const owner = await resolveViewerGrant({ ...record.identity }, args.id);
            if (!owner) return reject('DIRECTORY_ADMISSION');
            if (version !== epoch || !await current(record)) return reject('ADMISSION_CHANGED');
            await api.grantViewer({clientId:record.identity.clientId,sessionId:record.identity.sessionId,
              publisherClientId:owner.clientId,publisherSessionId:owner.sessionId,streamId:args.id});
          } catch { return reject('ADMISSION_FAILED'); }
        }
        const grant = record.views.get(args.id), publisher = grant && records.get(grant.publisherKey);
        if (!viewCommands.has(cmd) || !await current(publisher) || !publisher.streams.has(args.id)
            || record.views.get(args.id) !== grant || !await current(record)
            || version !== epoch || record.views.get(args.id) !== grant
            || records.get(publisher.key) !== publisher || !publisher.streams.has(args.id)
            || !isLiveExpiry(publisher.exp, now())) return reject('VIEW_GRANT_UNAVAILABLE');
        role = 'view'; publisherPeer = publisher.userId; exp = earliestExpiry(exp, publisher.exp);
      }
      if (cmd !== 'join-response' && Object.hasOwn(args,'userId')
          && args.userId !== (role==='view' ? publisherPeer : record.userId)) return reject('USER_ID_MISMATCH');
      const i = record.identity;
      return { room: digest(JSON.stringify([i.serverId, i.channelId, args.id])),
        peer: record.userId, streamId: args.id, userId: record.userId, role, exp,
        ...(publisherPeer ? { publisherPeer } : {}) };
    },
    // Trusted control-plane admission only; not called from a viewer WebSocket.
    // Publish approval is a separate step before allocating a receive transport.
    async prepareViewer(grant) {
      const { clientId, sessionId } = grant;
      const identity = await resolveClient(clientId);
      if (!identity || identity.sessionId !== sessionId) throw new Error('Client connection unavailable');
      let record = [...records.values()].find(r => same(r.identity, identity) && isLiveExpiry(r.exp, now()));
      if (!record) {
        const credential = await this.issue(clientId);
        record = records.get(digest(credential.token));
        if (!record || record.identity.sessionId !== sessionId) throw new Error('Client connection changed');
        // Stream info can precede requestsfuaccessinfo, just like setupstream.
        record.pendingToken = credential.token;
      }
      return this.grantViewer(grant);
    },
    async grantViewer({ clientId, sessionId, publisherClientId, publisherSessionId, streamId }) {
      const version = epoch;
      if (!field(streamId) || clientId === publisherClientId) throw new Error('Invalid viewer grant');
      const viewer = [...records.values()].find(r => r.identity.clientId === clientId && r.identity.sessionId === sessionId);
      const publisher = [...records.values()].find(r => r.identity.clientId === publisherClientId && r.identity.sessionId === publisherSessionId);
      if (!await current(viewer) || !await current(publisher) || !await current(viewer) || version !== epoch
          || records.get(publisher.key) !== publisher || !isLiveExpiry(publisher.exp, now())
          || !publisher.streams.has(streamId) || viewer.identity.serverId !== publisher.identity.serverId
          || viewer.identity.channelId !== publisher.identity.channelId) throw new Error('Viewer admission unavailable');
      viewer.views.set(streamId, { publisherKey: publisher.key });
      return { userId: viewer.userId, publisherUserId: publisher.userId, exp: earliestExpiry(viewer.exp, publisher.exp) };
    },
    revokeClient(clientId) { epoch++; for (const [key, record] of records) if (record.identity.clientId === clientId) { records.delete(key); revoked(record); } },
    revokeViewer(clientId, streamId) { epoch++; for (const record of records.values()) if (record.identity.clientId === clientId && record.views.delete(streamId)) revoked(record, streamId); },
    revokeStream(streamId) { epoch++; for (const record of records.values()) if (record.streams.delete(streamId)) revoked(record, streamId); },
    clear() { epoch++; const prior = [...records.values()]; records.clear(); for (const record of prior) revoked(record); },
    subscribeRevocations(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get size() { prune(); return records.size; },
  };
  return api;
}
