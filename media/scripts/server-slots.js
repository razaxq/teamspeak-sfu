// TeamSpeak enforces its own slot/license ceiling. Zero leaves that setting alone.
// Older lab versions forced eight slots on every start; migrate that once.
export async function configureServerSlots({reader,requested=0,migrateLegacy=false}) {
  if(!Number.isSafeInteger(requested) || requested<0 || requested>2147483647)
    throw new TypeError('Invalid TeamSpeak slot setting');
  const read=async()=>{
    const response=await reader.request('serverinfo');
    const match=response.match(/(?:^|\s)virtualserver_maxclients=(\d+)(?=\s|$)/);
    if(!match)throw new Error('TeamSpeak slot setting unavailable');
    return Number(match[1]);
  };
  const current=await read();
  const target=requested || (migrateLegacy && current===8 ? 32 : current);
  if(target!==current)await reader.request(`serveredit virtualserver_maxclients=${target}`);
  const actual=target===current ? current : await read();
  if(actual!==target)throw new Error('TeamSpeak rejected the requested slot setting');
  return actual;
}
