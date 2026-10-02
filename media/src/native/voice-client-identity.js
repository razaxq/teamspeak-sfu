import {parseControlCommand} from './stream-control.js';

// Compatibility guard for @honeybbq/teamspeak-client 0.2.2: its nickname-based
// self detection also matches another client's nickname with a numeric suffix.
// Install after connect() creates the handler, before awaiting waitConnected().
// Use a fresh SDK client for every connection, as the runtime already does.
export function protectVoiceClientIdentity(voice,{onEvent=()=>{}}={}) {
  const handler=voice?.handler,descriptor=Object.getOwnPropertyDescriptor(voice ?? {},'clid');
  if(!handler || typeof handler.onPacket!=='function' || typeof handler.setClientID!=='function'
    || !descriptor?.configurable || !Object.hasOwn(descriptor,'value'))
    throw new TypeError('A fresh voice client connection is required');
  let assigned,provisional=voice.clid,blocked=false;
  const receive=handler.onPacket,setClientID=handler.setClientID.bind(handler);
  Object.defineProperty(voice,'clid',{
    configurable:true,enumerable:descriptor.enumerable,
    get:()=>assigned ?? provisional,
    set:value=>{if(assigned===undefined)provisional=value;else if(value!==assigned)blocked=true;},
  });
  handler.setClientID=value=>{
    if(assigned===undefined || value===assigned)setClientID(value);
    else blocked=true;
  };
  handler.onPacket=packet=>{
    if(assigned===undefined && [2,3].includes(packet.typeFlagged&15)){
      // This is the SDK's decrypted, reassembled server command, not a client
      // notification, nickname, Query client ID or unauthenticated UDP header.
      for(const line of Buffer.from(packet.data).toString('utf8').split(/[\0\r\n]+/)){
        if(!line.startsWith('initserver '))continue;
        try {
          const {args}=parseControlCommand(line,{maxBytes:65536});
          const raw=args.aclid ?? args.clid;
          if(!/^[1-9][0-9]{0,4}$/.test(raw ?? '') || Number(raw)>65535)continue;
          assigned=Number(raw);setClientID(assigned);break;
        }catch { /* Runtime refuses readiness without a valid assignment. */ }
      }
    }
    try{return receive.call(handler,packet);}
    finally {
      if(blocked){blocked=false;onEvent({event:'relay-client-id-change-blocked'});}
    }
  };
  return {get clientId(){return assigned;}};
}
