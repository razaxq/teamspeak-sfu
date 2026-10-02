import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { decodeFrame, summarizeFrame } from './wire.js';
import { createNativePublisherSession } from './publisher-session.js';
import { createRequestChannel } from './request-channel.js';
import { createNativeViewerSession } from './viewer-session.js';
import { createViewerApprovalBroker } from './viewer-approval.js';

// Explicit opt-in experiment with a caller-owned MediaCore and verifier.
// No CLI, lab-token fallback, native access-info issuer, or implied TS support.
export async function startNativePublisherServer({ core, authorize, host = '127.0.0.1', port = 0,
  allowedOrigins = [], maxSockets = 0, subscribeRevocations, onJoinResponse, enableViewers = false, audioActivation = false, audioFirst = false, reserveViewer, onEvent = () => {} } = {}) {
  if (!core || typeof authorize !== 'function') throw new TypeError('Core and native verifier required');
  const server = http.createServer((_req, res) => { res.writeHead(501); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const sessions = new Map();
  const channels = new Map();
  function requestPublisher({ streamId, publisherUserId, cmd, args }) {
    const targets = [...sessions.keys()].filter(session => {
      const p = session.principal;
      return p?.role === 'publish' && p.streamId === streamId && p.userId === publisherUserId;
    });
    if (targets.length !== 1) return Promise.reject(new Error('Authenticated publisher unavailable or ambiguous'));
    return channels.get(targets[0]).request(cmd, { ...args, id: streamId });
  }
  const broker = enableViewers ? createViewerApprovalBroker({requestPublisher,subscribeRevocations}) : undefined;
  const unsubscribe = subscribeRevocations?.(event => {
    for (const [session, ws] of sessions) if (session.invalidate(event)) ws.close(1008, 'Authorization revoked');
  });
  let stopping = false;
  server.on('upgrade', (req, socket, head) => {
    if (stopping || req.url !== '/' || (maxSockets > 0 && wss.clients.size >= maxSockets)
        || (req.headers.origin && !allowedOrigins.includes(req.headers.origin))) {
      onEvent({event:'upgrade-rejected',hasOrigin:!!req.headers.origin,pathIsRoot:req.url==='/'});
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    onEvent({event:'native-ws-connected'});
    let session = createNativePublisherSession({ core, authorize,
      onJoinResponse: broker ? request => broker.acceptPublisherDecision(request) : onJoinResponse });
    sessions.set(session, ws);
    const channel = createRequestChannel({ send: frame => {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 262144) throw new Error('Publisher unavailable');
      ws.send(frame);
    } });
    channels.set(session, channel);
    let pending = Promise.resolve(), queued = 0, alive = true, windowStart = Date.now(), messages = 0, publisherIdentity;
    const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    const heartbeat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 15000);
    heartbeat.unref();
    ws.on('pong', () => { alive = true; });
    ws.on('error', error => {
      const code = typeof error?.code === 'string' && /^WS_ERR_[A-Z_]+$/.test(error.code)
        ? error.code : 'SOCKET_ERROR';
      onEvent({event:'native-ws-error',code});
      ws.terminate();
    });
    ws.on('message', (data, binary) => {
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); messages = 0; }
      if (binary || ++messages > 40 || queued >= 16) {
        onEvent({event:'native-frame-rejected',binary,bytes:data.length,queued});
        return ws.close(1008, 'Message limit');
      }
      queued++;
      pending = pending.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          const frame = decodeFrame(data);
          if (frame.type === 'response') {
            if (!session.principal || !channel.accept(frame)) throw new Error('Unmatched client response');
            onEvent({event:'native-response-received',...summarizeFrame(frame)});
            return;
          }
          onEvent({event:'native-request',...summarizeFrame(frame)});
          if (enableViewers && !session.principal && frame.cmd === 'join-request') {
            const previous = session;
            await previous.close(); sessions.delete(previous); channels.delete(previous);
            if (ws.readyState !== WebSocket.OPEN) return;
            session = createNativeViewerSession({core,authorize,approveJoin: request => broker.approveJoin(request),
              cancelJoin: request => broker.cancelJoin(request),
              leavePublisher: request => broker.removeViewer(request),reserveViewer,onEvent,audioActivation,audioFirst,
              requestClient: (cmd,args) => channel.request(cmd,args),
              onFailure: code => {onEvent({event:'native-viewer-failed',code});ws.close(1008,'Viewer request rejected');}});
            sessions.set(session,ws);channels.set(session,channel);
          }
          const response = await session.dispatch(data);
          if (session.principal?.role === 'publish') publisherIdentity = session.principal;
          clearTimeout(authTimer);
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 262144) return ws.terminate();
          ws.send(response);
          session.afterResponse?.();
          onEvent({event:'native-response-sent',...summarizeFrame(decodeFrame(response))});
          if (session.closed) ws.close(1000, 'Stream closed');
        } catch(error) {
          onEvent({event:'native-request-rejected',code:error?.code ?? 'REQUEST_FAILED'});
          channel.close();void session.close();
          // Unknown native error mappings: close, never invent a protocol code
          // or expose library/authentication exception text to the client.
          ws.close(1008, 'Request rejected');
        }
      }).finally(() => { queued--; });
    });
    ws.on('close', code => {
      onEvent({event:'native-ws-closed',code});
      clearTimeout(authTimer); clearInterval(heartbeat);
      if (publisherIdentity) for (const [other, socket] of sessions) {
        if (other.principal?.role === 'view' && other.invalidate({userId:publisherIdentity.userId,streamId:publisherIdentity.streamId}))
          socket.close(1008,'Publisher disconnected');
      }
      channel.close(); channels.delete(session);
      void session.close().finally(() => sessions.delete(session));
    });
  });
  async function stop() {
    if (stopping) return;
    stopping = true; unsubscribe?.(); broker?.close();
    for (const channel of channels.values()) channel.close();
    for (const ws of wss.clients) ws.terminate();
    await Promise.all([...sessions.keys()].map(session => session.close()));
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { await stop(); throw error; }
  return { port: server.address().port, stop,
    // In-process only. Never exposed as a public HTTP/WebSocket admission API.
    requestPublisher,
  };
}
