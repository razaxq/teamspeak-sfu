import { randomUUID } from 'node:crypto';
import { parseControlCommand } from './stream-control.js';

// Trusted Query event/snapshot directory. A numeric client ID is never itself a
// connection identity. Disconnect/move/permission-change events revoke grants.
export function createClientDirectory({ serverId, publisherGroup, revokeClient, onEvent = () => {} }) {
  const clients = new Map(); let active = false, version = 0;
  function remove(id) { if (clients.delete(id)) revokeClient(id); }
  function upsert(args) {
    const id = args.clid, uid = args.client_unique_identifier;
    const channelId = args.cid ?? args.ctid;
    if (args.client_type !== '0') return;
    if (!/^[1-9][0-9]*$/.test(id ?? '') || !uid || !/^[1-9][0-9]*$/.test(channelId ?? '')) throw new Error('Invalid client directory row');
    const groups = (args.client_servergroups ?? '').split(',');
    const old = clients.get(id), canPublish = groups.includes(publisherGroup);
    if (old && (old.uid !== uid || old.channelId !== channelId || old.canPublish !== canPublish
        || (args.client_lastconnected && old.connectedAt && old.connectedAt !== args.client_lastconnected))) remove(id);
    const retained = clients.get(id);
    clients.set(id, { clientId:id, serverId, uid, channelId, canPublish,
      sessionId:retained?.sessionId ?? randomUUID(), connectedAt:args.client_lastconnected ?? retained?.connectedAt });
  }
  return {
    snapshot(response) {
      const seen = new Set();
      try {
        const rows = response.split(/[\r\n]+/).filter(line => line.includes('clid=') && !line.startsWith('error ')).join('|').split('|').filter(Boolean);
        for (const row of rows) { const {args}=parseControlCommand('client '+row, {maxBytes:65536}); upsert(args); if(args.client_type==='0')seen.add(args.clid); }
        for (const id of clients.keys()) if (!seen.has(id)) remove(id);
        active = true;
      } catch(error) { this.invalidate(); throw error; }
    },
    notification(line) {
      const commandName=line.split(' ',1)[0];
      if(!['notifyclientleftview','notifyclientmoved','notifycliententerview','notifyclientupdated'].includes(commandName))return;
      version++;
      try {
        // Multi-client events repeat arguments after '|'.
        const [first,...rest]=line.split('|');
        const command=first.split(' ',1)[0];
        for(const row of [first,...rest.map(args=>command+' '+args)]) {
          const {args}=parseControlCommand(row, {maxBytes:65536});
          if(command==='notifyclientleftview' || command==='notifyclientmoved') remove(args.clid);
          if(command==='notifycliententerview') {
            remove(args.clid);
            if(args.client_unique_identifier && (args.cid ?? args.ctid))upsert(args);
          }
          if(command==='notifyclientupdated' && Object.hasOwn(args,'client_servergroups')) remove(args.clid);
        }
      } catch { this.invalidate(); onEvent({event:'directory-notification-rejected',command:commandName,bytes:Buffer.byteLength(line)}); }
    },
    get(id) { return active ? clients.get(id) : undefined; },
    list() { return active ? [...clients.values()].map(identity=>({...identity})) : []; },
    invalidate() { version++; active = false; for(const id of [...clients.keys()])remove(id); },
    get healthy() { return active; },
    get version() { return version; },
    get size() { return active ? clients.size : 0; },
  };
}
