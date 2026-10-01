// Beta4.1 OnJoinRequestReceived parses userId as JSON (RVA 0x1a10470),
// then resolves the native TS client id (0x1a948c0). This is routing metadata,
// never an authentication credential. All values come from trusted Query state.
export function nativeUserId(identity) {
  if(!identity || !/^[1-9][0-9]{0,4}$/.test(identity.clientId ?? '') || Number(identity.clientId)>65535
    || ![identity.uid,identity.serverUid].every(s=>typeof s==='string' && s.length>0 && s.length<=128 && !/[\x00-\x1f\x7f]/.test(s)))
    throw new Error('Native identity unavailable');
  return JSON.stringify({version:1,type:1,vs_uid:identity.serverUid,uid:identity.uid,id:Number(identity.clientId)});
}
