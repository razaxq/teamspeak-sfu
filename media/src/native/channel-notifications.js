// Channel discovery delivery adapter. The native sender must resolve the supplied
// live connection generation on its own server thread; client IDs alone are not
// sufficient. No guessed native pointers or public notification endpoint here.
export function createChannelNotifications({control,listClientIds,resolveClient,sendNotification,includeStreamingStatus=false,maxPending=64,onEvent=()=>{}}) {
  if(!control || typeof listClientIds!=='function' || typeof resolveClient!=='function'
    || typeof sendNotification!=='function' || !Number.isInteger(maxPending) || maxPending<1)
    throw new TypeError('Trusted directory and native notification sender required');
  let closed=false,pending=0,tail=Promise.resolve(),allSync,dirty=false;
  const delivered=new Map(),stopReasons=new Map();
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
    const current=async()=>!closed && same(identity,await resolveClient(clientId));
    const send=notification=>sendNotification({recipient:{...identity},notification});
    let previous=delivered.get(clientId);
    if(!previous || !same(previous.identity,identity)){
      previous={identity,streams:new Map()};delivered.set(clientId,previous);
    }
    const visible=new Map((await control.listChannelStreams(clientId)).filter(s=>includeStreamingStatus || s.publisherClientId!==clientId).map(s=>[s.id,s]));
    if(!await current())return;
    for(const [id,state] of previous.streams)if(!visible.has(id)){
      const {stream}=state;
      if(!await current())return;
      if(state.startAttempted && !state.stopSent){
        await send(`notifystreamstopped clid=${stream.publisherClientId} id=${id} reason=${stopReasons.get(id) ?? 1}`);
        state.stopSent=true;
      }
      if(!await current())return;
      if(state.flagAttempted && !state.clearSent){
        await send(`notifyclientupdated clid=${stream.publisherClientId} client_is_streaming=0`);
        state.clearSent=true;
      }
      previous.streams.delete(id);
    }
    for(const [id] of visible){
      // A stream can stop while an earlier delivery is awaiting I/O.
      const stream=(await control.listChannelStreams(clientId)).find(s=>s.id===id);
      if(!stream || !await current())continue;
      let state=previous.streams.get(id);
      if(!state){state={stream};previous.streams.set(id,state);}
      if(includeStreamingStatus && !state.flagSent){
        // A failed acknowledgement does not prove that delivery failed. Keep
        // attempted steps so stop can compensate, and confirmed steps for retry.
        state.flagAttempted=true;
        await send(`notifyclientupdated clid=${stream.publisherClientId} client_is_streaming=1`);
        state.flagSent=true;
      }
      if(stream.publisherClientId!==clientId && !state.startSent){
        if(!await current() || !(await control.listChannelStreams(clientId)).some(s=>s.id===id))continue;
        state.startAttempted=true;
        await send(stream.notification);
        state.startSent=true;
      }
    }
  }
  async function syncEveryone(){
    const ids=await listClientIds();const active=new Set(ids),errors=[];
    for(const id of delivered.keys())if(!active.has(id))delivered.delete(id);
    for(const id of ids){
      if(closed)break;
      // One stale recipient must not starve later recipients on every poll.
      try{await sync(id);}catch(error){errors.push(error);}
    }
    if(errors.length)throw new AggregateError(errors,'Channel notification synchronization failed');
  }
  function syncAll(){
    if(closed)return Promise.reject(new Error('Notification adapter closed'));
    dirty=true;
    if(allSync)return allSync;
    // Bursts collapse into a current-state scan and, when changed during I/O,
    // a follow-up scan instead of filling the queue with identical work.
    allSync=enqueue(async()=>{
      let failure;
      do {
        dirty=false;failure=undefined;
        try{await syncEveryone();}catch(error){failure=error;}
      }while(dirty && !closed);
      if(failure)throw failure;
    }).finally(()=>{allSync=undefined;});
    void allSync.catch(()=>onEvent({event:'channel-notification-sync-failed'}));
    return allSync;
  }
  const unsubscribe=control.subscribeStreams(event=>{
    if(event.type==='stopped'){
      stopReasons.set(event.streamId,event.reason ?? 1);
      if(stopReasons.size>maxPending)stopReasons.delete(stopReasons.keys().next().value);
    }
    if(event.type==='started' || event.type==='stopped')void syncAll().catch(()=>{});
  });
  return {
    // Directory connect/move/reconnect events (or a bounded poll) should call this.
    syncClient(clientId){return enqueue(()=>sync(clientId));},
    syncAll,
    async flush(){await tail;},
    async close(){closed=true;unsubscribe();await tail;delivered.clear();stopReasons.clear();},
  };
}
