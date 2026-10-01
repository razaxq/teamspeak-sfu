import net from 'node:net';
import { chmod } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

// Private Unix socket, shared only with the disposable TS container. The random
// per-instance secret prevents other local users from impersonating the hook.
export async function startAccessBridge({ path, secret, registry, streamControl, takeNotification, maxConnections = 8 }) {
  if (!/^[a-f0-9]{64}$/.test(secret) || !registry) throw new TypeError('Private bridge configuration required');
  const sockets = new Set();
  const server = net.createServer(socket => {
    if (sockets.size >= maxConnections) { socket.destroy(); return; }
    sockets.add(socket); socket.setTimeout(1500, () => socket.destroy());
    socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let input = '', handled = false;
    socket.on('data', async chunk => {
      if (handled) { socket.destroy(); return; }
      input += chunk.toString('ascii');
      if (input.length > 4300) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      const match = /^([a-f0-9]{64}) ([1-9][0-9]{0,4})(?: stream ([a-f0-9]{2,4096}))?\n$/.exec(input);
      if (!match || Number(match[2]) > 65535 || !timingSafeEqual(Buffer.from(match[1]), Buffer.from(secret))) {
        socket.destroy(); return;
      }
      try {
        if (match[3]) {
          if (!streamControl || match[3].length % 2) { socket.destroy(); return; }
          const command = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(match[3], 'hex'));
          if(command==='sfulabflush') {
            const item=await takeNotification?.(match[2]);
            if(!socket.destroyed)socket.end(item ? `D ${item.clientId} ${item.notification}\n` : 'E 2568\n');
            return;
          }
          const result = await streamControl.dispatch(match[2], command);
          if (!socket.destroyed) socket.end(result.pass ? 'P\n' : result.error ? `E ${result.error}\n` : `N ${result.notification}\n`);
          return;
        }
        const credentials = await registry.issue(match[2]);
        if (!socket.destroyed) socket.end(`${credentials.token} ${credentials.userId.replace(/\\/g,'\\\\').replace(/ /g,'\\s').replace(/\|/g,'\\p').replace(/\//g,'\\/')}\n`);
      } catch { socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  try { await chmod(path, 0o666); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  return { async stop() {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    streamControl?.clear();
    registry.clear();
  } };
}
