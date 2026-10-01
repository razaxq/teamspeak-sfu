// A dedicated local TS connection drives native sends on the server's command
// thread. No native connection pointers cross the private bridge or survive it.
export function createNotificationRelay({voice,identity,resolveClient,maxPending=64,onEvent=()=>{}}) {
  if(!voice || !identity || typeof resolveClient!=='function' || !Number.isInteger(maxPending) || maxPending<1)
    throw new TypeError('Trusted relay connection required');
  const relay=Object.freeze({...identity});let closed=false,healthy=true,pending=0,current,tail=Promise.resolve();
  const same=(a,b)=>b && ['serverId','channelId','clientId','sessionId','uid'].every(k=>a[k]===b[k]);
  return {
    get healthy(){return !closed && healthy;},
    sendNotification({recipient,notification}) {
      if(closed || pending>=maxPending)return Promise.reject(new Error('Notification relay unavailable'));
      if(typeof notification!=='string' || Buffer.byteLength(notification)>4000 || /[\r\n\0]/.test(notification)
        || !(/^notifystream(?:started|stopped) /.test(notification) || /^notifyclientupdated clid=[1-9][0-9]{0,4} client_is_streaming=[01]$/.test(notification)))return Promise.reject(new Error('Invalid notification'));
      const item={recipient:{...recipient},notification,offered:false};pending++;
      const result=tail.then(async()=>{
        if(closed || !same(relay,await resolveClient(relay.clientId)) || !same(item.recipient,await resolveClient(item.recipient.clientId)))
          throw new Error('Notification connection changed');
        current=item;
        try {
          try {
            await voice.execCommand('sfulabflush',3000);
            if(!item.offered)throw new Error('Notification was not fetched');
          } catch(error) {
            healthy=false;
            onEvent({event:'notification-relay-send-failed',reason:item.offered?'NATIVE_SEND_FAILED':'NOT_FETCHED',errorCode:Number.isInteger(error?.id)?error.id:undefined});
            throw error;
          }
        } finally {if(current===item)current=undefined;}
      });
      tail=result.catch(()=>{}).finally(()=>{pending--;});return result;
    },
    async takeNotification(clientId) {
      const item=current;
      if(closed || clientId!==relay.clientId || !item || item.offered || !same(relay,await resolveClient(clientId))
        || !same(item.recipient,await resolveClient(item.recipient.clientId)) || current!==item || closed)return null;
      item.offered=true;return {clientId:item.recipient.clientId,notification:item.notification};
    },
    async close(){closed=true;current=undefined;await tail;},
  };
}
