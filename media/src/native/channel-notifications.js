// Channel discovery delivery adapter. The native sender must resolve the supplied
// live connection generation on its own server thread; client IDs alone are not
// sufficient. No guessed native pointers or public notification endpoint here.
export function createChannelNotifications({control,listClientIds,resolveClient,sendNotification,includeStreamingStatus=false,maxPending=64,onEvent=()=>{}}) {
  if(!control || typeof listClientIds!=='function' || typeof resolveClient!=='function'
    || typeof sendNotification!=='function' || !Number.isInteger(maxPending) || maxPending<1)
    throw new TypeError('Trusted directory and native notification sender required');
  let closed=false,pending=0,tail=Promise.resolve();const delivered=new Map(),stopReasons=new Map();
  const same=(a,b)=>b && ['serverId','channelId','clientId','sessionId','uid'].every(k=>a[k]===b[k]);
  function enqueue(action){
    if(closed)return Promise.reject(new Error('Notification adapter closed'));
    if(pending>=maxPending)return Promise.reject(new Error('Notification queue full'));
    pending++;const result=tail.then(()=>closed?undefined:action());
    tail=result.catch(()=>{}).finally(()=>{pending--;});return result;
  }
  async function sync(clientId){
    const live=await resolveClient(clientId);
    if(!live){delivered.delete(clientId);return;}
    const identity={...live};
    let previous=delivered.get(clientId);
    if(!previous || !same(previous.identity,identity)){
      previous={identity,streams:new Map()};delivered.set(clientId,previous);
    }
    const visible=new Map((await control.listChannelStreams(clientId)).filter(s=>includeStreamingStatus || s.publisherClientId!==clientId).map(s=>[s.id,s]));
    if(closed || !same(identity,await resolveClient(clientId)))return;
    for(const [id,stream] of previous.streams)if(!visible.has(id)){
      if(closed || !same(identity,await resolveClient(clientId)))return;
      if(stream.publisherClientId!==clientId)await sendNotification({recipient:{...identity},notification:`notifystreamstopped clid=${stream.publisherClientId} id=${id} reason=${stopReasons.get(id) ?? 1}`});
      if(includeStreamingStatus)await sendNotification({recipient:{...identity},notification:`notifyclientupdated clid=${stream.publisherClientId} client_is_streaming=0`});
      previous.streams.delete(id);
    }
    for(const [id,stream] of visible)if(!previous.streams.has(id)){
      // A stream can stop while an earlier delivery is awaiting I/O.
      const current=(await control.listChannelStreams(clientId)).find(s=>s.id===id);
      if(!current || closed || !same(identity,await resolveClient(clientId)))continue;
      if(includeStreamingStatus)await sendNotification({recipient:{...identity},notification:`notifyclientupdated clid=${current.publisherClientId} client_is_streaming=1`});
      if(current.publisherClientId!==clientId)await sendNotification({recipient:{...identity},notification:current.notification});
      previous.streams.set(id,current);
    }
  }
  async function syncAll(){
    const ids=await listClientIds();const active=new Set(ids);
    for(const id of delivered.keys())if(!active.has(id))delivered.delete(id);
    for(const id of ids)await sync(id);
  }
  const unsubscribe=control.subscribeStreams(event=>{
    if(event.type==='stopped'){
      stopReasons.set(event.streamId,event.reason ?? 1);
      if(stopReasons.size>maxPending)stopReasons.delete(stopReasons.keys().next().value);
    }
    if(event.type==='started' || event.type==='stopped')void enqueue(syncAll)
      .catch(()=>onEvent({event:'channel-notification-sync-failed'}));
  });
  return {
    // Directory connect/move/reconnect events (or a bounded poll) should call this.
    syncClient(clientId){return enqueue(()=>sync(clientId));},
    syncAll(){return enqueue(syncAll);},
    async flush(){await tail;},
    async close(){closed=true;unsubscribe();await tail;delivered.clear();stopReasons.clear();},
  };
}
