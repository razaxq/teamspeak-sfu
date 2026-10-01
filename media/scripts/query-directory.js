import { createSnapshotReader } from './query-snapshot.js';
import { parseControlCommand } from '../src/native/stream-control.js';
import { createClientDirectory } from '../src/native/client-directory.js';

// Query loss revokes media identities, but must not destroy the voice server.
export async function startQueryDirectory({ port, password, serverId, registry, publisherGroup = '6', onEvent = () => {} }) {
  const directory = createClientDirectory({serverId,publisherGroup,revokeClient:id=>registry.revokeClient(id),onEvent});
  let stopped=false, timer, reader, connected=false, serverUid;
  async function connect() {
    reader?.close();
    reader=createSnapshotReader({port,password,onNotification:line=>directory.notification(line),
      onDisconnect:()=>{connected=false;directory.invalidate();}});
    try {
      await reader.request('use sid=1');
      const info=await reader.request('serverinfo');
      serverUid=parseControlCommand('info '+(info.match(/(?:^|\s)(virtualserver_unique_identifier=[^\s]+)/)?.[1] ?? '')).args.virtualserver_unique_identifier;
      if(!serverUid)throw new Error('Server identity unavailable');
      await reader.request('servernotifyregister event=server');
      await reader.request('servernotifyregister event=channel id=0');
      const version=directory.version;
      const response=await reader.request('clientlist -uid -groups -times');
      if(stopped)return;
      if(version===directory.version)directory.snapshot(response);
      connected=true;
      onEvent({event:'directory-query-connected'});
    } catch(error) {reader.close();directory.invalidate();throw error;}
  }
  try {await connect();} catch(error) {reader?.close();throw error;}
  async function poll() {
    try {
      if(!connected)await connect();
      else {
        const version=directory.version;
        const response=await reader.request('clientlist -uid -groups -times');
        if(!stopped && version===directory.version)directory.snapshot(response);
      }
    } catch(error) {
      directory.invalidate(); connected=false;
      onEvent({event:'directory-query-failed',error:/^Snapshot/.test(error.message)?error.message:'QUERY_FAILED'});
    }
    if(!stopped){timer=setTimeout(poll,connected?1000:5000);timer.unref();}
  }
  timer=setTimeout(poll,1000);timer.unref();
  return {
    get:id=>{const i=directory.get(id);return i ? {...i,serverUid} : undefined;},list:()=>directory.list().map(i=>({...i,serverUid})),get healthy(){return directory.healthy;},
    async waitFor(id,predicate=()=>true) {
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){const identity=directory.get(id);if(identity&&predicate(identity))return identity;await new Promise(r=>setTimeout(r,50));}
      throw new Error('Trusted client directory timeout');
    },
    stop(){stopped=true;clearTimeout(timer);directory.invalidate();reader?.close();},
  };
}
