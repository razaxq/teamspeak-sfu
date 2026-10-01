import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { MediaCore, LabError } from './core.js';
import { validateSecret, verifyToken } from './auth.js';

export async function startServer({ secret, host = '127.0.0.1', port = 18090, tls,
  allowedOrigins = [], coreOptions = {}, maxSockets = 32 } = {}) {
  validateSecret(secret);
  const core = await MediaCore.create(coreOptions);
  let pending = Promise.resolve(), stopping = false;
  // Serial resource mutations keep joins, limits and disconnects race-free.
  function serialize(fn) { const next = pending.then(fn); pending = next.catch(() => {}); return next; }
  const files = new Map([
    ['/lab', ['../web/index.html', 'text/html; charset=utf-8']],
    ['/lab/client.js', ['../web/dist/client.js', 'text/javascript; charset=utf-8']],
  ]);
  function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(core.worker.closed || stopping ? 503 : 200);
      return res.end(JSON.stringify({ media: 'mediasoup', protocol: 'sfu-lab-v1',
        nativeTeamspeak: 'NOT_IMPLEMENTED', ...core.counts() }));
    }
    if (req.method === 'GET' && files.has(req.url)) {
      const [path, type] = files.get(req.url);
      try { const body = readFileSync(new URL(path, import.meta.url)); res.setHeader('Content-Type', type); return res.end(body); }
      catch { res.writeHead(503); return res.end('Run npm run build:web first.'); }
    }
    res.writeHead(501); res.end('Native TeamSpeak adapter not implemented. Use the M0 probe for capture.\n');
  }
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxConnections = 64;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const defaultOrigin = `${tls ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
    const originOk = !req.headers.origin || [defaultOrigin, ...allowedOrigins].includes(req.headers.origin);
    if (stopping || req.url !== '/lab/ws' || !originOk || wss.clients.size >= maxSockets) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    let peer, expireTimer, queued = 0, windowStart = Date.now(), messages = 0, alive = true;
    const send = value => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 262144) return ws.terminate();
      ws.send(JSON.stringify(value));
    };
    const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false; ws.ping();
    }, 15000);
    ws.on('message', (bytes, binary) => {
      if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); messages = 0; }
      if (binary || ++messages > 40 || queued >= 16) return ws.close(1008, 'Message limit');
      let request;
      try {
        request = JSON.parse(bytes.toString());
        if (!request || !Number.isSafeInteger(request.id) || request.id < 0 || typeof request.method !== 'string') throw new Error();
      } catch { return ws.close(1008, 'Invalid request'); }
      queued++;
      serialize(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          let data;
          if (!peer) {
            if (request.method !== 'join') throw new LabError('NOT_JOINED');
            let claims;
            try { claims = verifyToken(request.data?.token, secret); }
            catch { throw new LabError('INVALID_TOKEN'); }
            peer = await core.join(claims, send);
            if (ws.readyState !== WebSocket.OPEN) { core.leave(peer); return; }
            clearTimeout(authTimer);
            expireTimer = setTimeout(() => ws.close(1008, 'Token expired'), Math.max(1, claims.exp * 1000 - Date.now()));
            data = { peer: peer.id, room: peer.room.id, role: peer.role,
              rtpCapabilities: peer.room.router.rtpCapabilities, producers: core.listProducers(peer) };
          } else data = await core.request(peer, request.method, request.data);
          send({ id: request.id, ok: true, data });
        } catch (err) {
          // Library errors may contain attacker input: never reflect them or log tokens.
          send({ id: request.id, ok: false, error: err instanceof LabError ? err.message : 'INVALID_REQUEST' });
        }
      }).finally(() => { queued--; });
    });
    ws.on('close', () => {
      clearTimeout(authTimer); clearTimeout(expireTimer); clearInterval(heartbeat);
      serialize(() => core.leave(peer));
    });
  });
  async function stop() {
    if (stopping) return;
    stopping = true;
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await pending;
    core.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  core.worker.on('died', () => { void stop(); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (err) { await stop(); throw err; }
  return { core, server, stop, port: server.address().port };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tls = process.env.TLS_CERT && process.env.TLS_KEY ? {
    cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) } : undefined;
  const instance = await startServer({ secret: process.env.SFU_SECRET,
    host: process.env.HTTP_HOST || '127.0.0.1', port: Number(process.env.HTTP_PORT || 18090), tls,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean),
    coreOptions: { listenIp: process.env.MEDIA_LISTEN_IP || '127.0.0.1',
      announcedAddress: process.env.MEDIA_ANNOUNCED_ADDRESS || undefined,
      mediaPort: Number(process.env.MEDIA_PORT || 19000) } });
  console.log(JSON.stringify({ event: 'ready', port: instance.port, nativeTeamspeak: 'NOT_IMPLEMENTED' }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void instance.stop(); });
  instance.core.worker.once('died', () => { process.exitCode = 1; });
}
