import { Client } from 'ssh2';

// Reuse one SSH Query connection: rapid reconnects can trigger server throttling.
// Raw Query responses and credentials never enter evidence logs.
export function createSnapshotReader({ port, password, onNotification = () => {}, onDisconnect = () => {} }) {
  const client = new Client();
  let stream, opening, pending, buffer = '', lines = '', welcomed = false, closed = false;
  let tail = Promise.resolve();
  function fail() { closed = true; onDisconnect(); if (pending) { const p = pending; pending = undefined; p.reject(new Error('Snapshot connection unavailable')); } }
  async function open() {
    await new Promise((resolve, reject) => client.once('ready', resolve).once('error', reject)
      .connect({ host: '127.0.0.1', port, username: 'serveradmin', password, readyTimeout: 3000 }));
    client.on('error', fail); client.on('close', fail);
    await new Promise((resolve, reject) => client.shell(false, (error, channel) => {
      if (error) return reject(error);
      stream = channel;
      const timer = setTimeout(() => reject(new Error('Snapshot greeting timeout')), 5000);
      channel.on('error', fail); channel.on('close', fail);
      channel.on('data', chunk => {
        lines += chunk;
        if (lines.length + buffer.length > 1048576) { fail(); client.destroy(); return; }
        let newline;
        while ((newline = lines.indexOf('\n')) >= 0) {
          const line = lines.slice(0, newline).trim(); lines = lines.slice(newline + 1);
          if (!line) continue;
          if (!welcomed) {
            if (line.includes('TeamSpeak')) { welcomed = true; clearTimeout(timer); resolve(); }
            continue;
          }
          if (line.startsWith('notify')) { onNotification(line); continue; }
          buffer += line + '\n';
          const status = line.match(/^error id=(\d+) msg=/);
          if (!status || !pending) continue;
          const current = pending; pending = undefined;
          const result = buffer; buffer = '';
          if (status[1] !== '0') current.reject(new Error('Snapshot unavailable (id='+status[1]+')'));
          else current.resolve(result);
        }
      });
    }));
  }
  async function command(text) {
    if (closed) throw new Error('Snapshot reader closed');
    if (!opening) opening = open();
    await opening;
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (closed) throw new Error('Snapshot reader closed');
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = undefined; closed = true; client.destroy(); reject(new Error('Snapshot timeout')); }, 5000);
      pending = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      stream.write(text + '\n');
    });
  }
  return {
    request(text) {
      const result = tail.then(() => command(text));
      tail = result.catch(() => {}); return result;
    },
    read(clientId) {
      if (!/^[1-9][0-9]{0,4}$/.test(clientId)) return Promise.reject(new Error('Invalid client ID'));
      const result = tail.then(async () => {
        await command('use sid=1');
        const response = await command(`clientinfo clid=${clientId}`);
        const values = Object.fromEntries(response.trim().split(/\s+/).map(item => {
          const split = item.indexOf('='); return [item.slice(0, split), item.slice(split + 1)];
        }));
        if (!values.client_unique_identifier || !values.cid || values.client_type !== '0') throw new Error('Snapshot identity missing');
        return { uid: values.client_unique_identifier, channelId: values.cid, serverGroups: (values.client_servergroups ?? '').split(',') };
      });
      tail = result.catch(() => {}); return result;
    },
    close() { closed = true; fail(); client.destroy(); },
  };
}
