import { createNativeDispatcher } from './dispatch.js';
import { encodeResponse, WireError } from './wire.js';

const requireValue = (ok, code) => { if (!ok) throw new WireError(code); };
const string = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Experimental, in-process adapter. Success code and verified identity are
// integration inputs. Zero success is supported by the beta4.1 callbacks.
// One session owns one publisher transport. This module opens no network listener.
export function createNativePublisherSession({ core, authorize, onJoinResponse, successCode = 0, maxPending = 32 }) {
  requireValue(Number.isInteger(successCode) && successCode >= -2147483648 && successCode <= 2147483647,
    'SUCCESS_CODE_REQUIRED');
  requireValue(Number.isInteger(maxPending) && maxPending > 0, 'INVALID_QUEUE_LIMIT');
  let peer, binding, transportId, timer, closed = false, connected = false;
  let tail = Promise.resolve(), pending = 0;
  function cleanup() {
    clearTimeout(timer);
    if (peer) core.leave(peer);
  }
  function live() {
    requireValue(!closed, 'SESSION_CLOSED');
    if (binding && binding.exp * 1000 <= Date.now()) {
      closed = true; cleanup(); throw new WireError('TOKEN_EXPIRED');
    }
  }
  function armExpiry() {
    clearTimeout(timer);
    const remaining = binding.exp * 1000 - Date.now();
    if (remaining <= 0) { closed = true; cleanup(); return; }
    timer = setTimeout(armExpiry, Math.min(remaining, 2147483647));
    timer.unref();
  }
  function validate(principal, args) {
    live();
    requireValue(object(principal) && ['room', 'peer', 'streamId', 'userId'].every(k => string(principal[k]))
      && principal.role === 'publish' && Number.isSafeInteger(principal.exp)
      && principal.exp > Date.now() / 1000, 'INVALID_NATIVE_PRINCIPAL');
    requireValue(object(args) && args.id === principal.streamId, 'STREAM_SCOPE_MISMATCH');
    requireValue(!Object.hasOwn(args, 'userId') || args.userId === principal.userId, 'USER_SCOPE_MISMATCH');
    if (binding) requireValue(['room', 'peer', 'streamId', 'userId', 'role', 'exp']
      .every(k => principal[k] === binding[k]), 'SESSION_SCOPE_MISMATCH');
  }
  const producers = new Map();
  const handlers = new Map([
    ['join-response', async ({principal,args}) => {
      // userId targets the viewer for this command, unlike publisher media RPCs.
      requireValue(object(args) && string(args.userId) && typeof args.accepted==='boolean','INVALID_JOIN_RESPONSE');
      validate(principal,{...args,userId:principal.userId});
      requireValue(peer && binding,'STREAM_NOT_CREATED');
      requireValue(typeof onJoinResponse==='function','NATIVE_HANDLER_UNAVAILABLE');
      requireValue(await onJoinResponse({principal:binding,args}),'UNMATCHED_JOIN_RESPONSE');
      return {err:successCode};
    }],
    ['close-stream', async ({ principal, args }) => {
      validate(principal, args);
      requireValue(peer && binding, 'STREAM_NOT_CREATED');
      closed = true; cleanup();
      return { err: successCode };
    }],
    ['create-stream', async ({ principal, args }) => {
      validate(principal, args);
      requireValue(!peer, 'STREAM_ALREADY_CREATED');
      binding = Object.freeze(Object.fromEntries(['room', 'peer', 'streamId', 'userId', 'role', 'exp']
        .map(k => [k, principal[k]])));
      try {
        peer = await core.join(binding);
        live();
        const transport = await core.request(peer, 'createTransport', { direction: 'send' });
        live();
        transportId = transport.id;
        const routerCapabilities = await core.request(peer, 'getRouterRtpCapabilities');
        live(); armExpiry();
        // mediasoup includes undefined optional properties (e.g. codec channels).
        // Normalize its trusted data to the JSON representation sent on wire.
        const args = JSON.parse(JSON.stringify({ ...transport, routerCapabilities }));
        const result = { err: successCode, args };
        // Validate before committing success so encoding failures also clean up.
        encodeResponse({ responseId: 'validation', ...result });
        return result;
      } catch (error) { closed = true; cleanup(); throw error; }
    }],
    ['transport-produce', async ({ principal, args }) => {
      validate(principal, args);
      requireValue(peer && transportId && connected, 'TRANSPORT_NOT_CONNECTED');
      requireValue(['audio', 'video'].includes(args.kind) && typeof args.paused === 'boolean'
        && object(args.rtpParameters), 'INVALID_PRODUCE_ARGS');
      requireValue(!producers.has(args.kind), 'KIND_ALREADY_PRODUCED');
      const result = await core.request(peer, 'produce', { transportId, kind: args.kind,
        paused: args.paused, rtpParameters: args.rtpParameters });
      live(); producers.set(args.kind, result.id);
      return { err: successCode, args: { id: result.id } };
    }],
    ['set-paused', async ({ principal, args }) => {
      validate(principal, args);
      requireValue(peer && connected, 'TRANSPORT_NOT_CONNECTED');
      requireValue(typeof args.audio === 'boolean' && typeof args.video === 'boolean', 'INVALID_PAUSE_ARGS');
      for (const [kind, producerId] of producers) {
        await core.request(peer, 'setProducerPaused', { producerId, paused: args[kind] });
        live();
      }
      return { err: successCode };
    }],
    ['transport-connect', async ({ principal, args }) => {
      validate(principal, args);
      requireValue(peer && transportId, 'STREAM_NOT_CREATED');
      requireValue(!connected, 'TRANSPORT_ALREADY_CONNECTED');
      requireValue(object(args.dtlsParameters), 'INVALID_DTLS_PARAMETERS');
      await core.request(peer, 'connectTransport', { transportId, dtlsParameters: args.dtlsParameters });
      live(); connected = true;
      return { err: successCode };
    }],
  ]);
  const dispatch = createNativeDispatcher({ handlers, authorize: typeof authorize !== 'function' ? undefined : async request => {
    live();
    try {
      const principal = await authorize(request);
      live();
      if (!principal) { closed = true; cleanup(); }
      return principal;
    } catch (error) { closed = true; cleanup(); throw error; }
  } });
  return {
    get closed() { return closed; },
    get principal() { return !closed && binding?.exp * 1000 > Date.now() ? binding : undefined; },
    dispatch(input) {
      if (closed) return Promise.reject(new WireError('SESSION_CLOSED'));
      if ((typeof input === 'string' && Buffer.byteLength(input) > 65536)
        || (input instanceof Uint8Array && input.byteLength > 65536))
        return Promise.reject(new WireError('FRAME_TOO_LARGE'));
      if (pending >= maxPending) return Promise.reject(new WireError('QUEUE_LIMIT'));
      // Snapshot caller-owned buffers before queuing asynchronous authorization.
      const snapshot = input instanceof Uint8Array ? Buffer.from(input) : input;
      pending++;
      const result = tail.then(() => { live(); return dispatch(snapshot); });
      tail = result.then(() => {}, () => { if (closed) cleanup(); }).finally(() => { pending--; });
      return result;
    },
    invalidate({ userId, streamId }) {
      if (!binding || binding.userId !== userId || (streamId && binding.streamId !== streamId)) return false;
      closed = true; cleanup(); return true;
    },
    async close() { closed = true; cleanup(); await tail; cleanup(); },
  };
}
