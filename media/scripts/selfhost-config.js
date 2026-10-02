import {isIPv4} from 'node:net';
import {isAbsolute, resolve, sep} from 'node:path';

export const SERVER_SHA256='c15d88ba878c64a05c0e2325e2deb37e96864120af6d72091267b97944e2d200';
export const SERVER_IMAGE='docker.io/teamspeaksystems/teamspeak6-server@sha256:a89b53db7b4a213251a47b652b212d1314728ec8c498f5246cf7e7622587ed89';

export function selfhostConfig(env=process.env) {
  const host=env.SFU_PUBLIC_HOST?.toLowerCase();
  if(!host || host==='sfu.example.com' || host.length>253 ||
    !(isIPv4(host) || host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))
    throw new Error('Set SFU_PUBLIC_HOST to your IPv4 address or DNS hostname, without scheme or port');
  if(env.TSSERVER_LICENSE_ACCEPTED!=='accept')throw new Error('Read the TeamSpeak server license and set TSSERVER_LICENSE_ACCEPTED=accept');
  const port=(key,fallback)=>{
    const raw=env[key] ?? String(fallback);
    const value=Number(raw);
    if(!/^\d+$/.test(raw) || !Number.isInteger(value) || value<1024 || value>65535)throw new Error(`Invalid ${key}: use 1024..65535`);
    return value;
  };
  const config={host,voicePort:port('SFU_VOICE_PORT',19987),queryPort:port('SFU_QUERY_PORT',11022),
    wsPort:port('SFU_WS_PORT',18344),mediaPort:port('SFU_MEDIA_PORT',19125),
    name:env.SFU_CONTAINER_NAME ?? 'ts6-sfu-selfhost',volume:env.SFU_DATA_VOLUME ?? 'ts6-sfu-selfhost-data',
    image:env.SFU_SERVER_IMAGE ?? SERVER_IMAGE,dir:env.SFU_STATE_DIR ?? '/var/lib/ts6-sfu-selfhost'};
  if(new Set([config.voicePort,config.queryPort,config.wsPort,config.mediaPort]).size!==4)throw new Error('Use four distinct ports');
  for(const key of ['name','volume'])if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(config[key]))throw new Error(`Invalid ${key}`);
  if(!isAbsolute(config.dir) || /[:\s\x00-\x1f]/.test(config.dir) || resolve(config.dir)==='/')throw new Error('SFU_STATE_DIR must be an absolute non-root path without whitespace or colons');
  config.dir=resolve(config.dir)+sep;
  const slots=env.SFU_TS_MAXCLIENTS ?? '0';
  if(!/^\d+$/.test(slots) || !Number.isSafeInteger(Number(slots)) || Number(slots)>2147483647)
    throw new Error('Invalid SFU_TS_MAXCLIENTS: use 0 to retain the TeamSpeak setting, or a positive slot count');
  config.tsMaxClients=Number(slots);
  const audioRefresh=env.SFU_EXPERIMENTAL_AUDIO_REFRESH ?? '0';
  if(!['0','1'].includes(audioRefresh))throw new Error('Invalid SFU_EXPERIMENTAL_AUDIO_REFRESH: use 0 or 1');
  config.audioRefresh=audioRefresh==='1';
  if(!/^[a-zA-Z0-9][a-zA-Z0-9./:@_-]*$/.test(config.image))throw new Error('Invalid SFU_SERVER_IMAGE');
  return config;
}
