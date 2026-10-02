// Shared runtime for the isolated lab and public self-host deployment.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, chownSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { lookup } from 'node:dns/promises';
import { MediaCore } from '../src/core.js';
import { nativeUserId } from '../src/native/user-id.js';
import { createAccessRegistry } from '../src/native/access-registry.js';
import { createStreamControl } from '../src/native/stream-control.js';
import { startAccessBridge } from '../src/native/access-bridge.js';
import { startNativePublisherServer } from '../src/native/server.js';
import { collectMediaDiagnostics } from '../src/native/media-diagnostics.js';
import { createSnapshotReader } from './query-snapshot.js';
import { startQueryDirectory } from './query-directory.js';
import { configureServerSlots } from './server-slots.js';
import { Client as VoiceClient, generateIdentity } from '@honeybbq/teamspeak-client';
import { protectVoiceClientIdentity } from '../src/native/voice-client-identity.js';
import { createNotificationRelay } from '../src/native/notification-relay.js';
import { createChannelNotifications } from '../src/native/channel-notifications.js';

export async function runNativeServer(config) {
const {name,host,voicePort,queryPort,wsPort,mediaPort,dir,image,volume,extensionPath,
  viewerPreview=true,audioFirst=false,audioRefresh=false,tsMaxClients=0,accessUid=process.getuid(),accessGid=process.getgid(),smokeTokenEnabled=false}=config;
const run=(...args)=>execFileSync('podman',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
// Refuse duplicate launches before changing the existing instance's status or files.
if(run('ps','-a','--format','{{.Names}}').split('\n').includes(name))throw new Error('Preview container already exists');
mkdirSync(dir,{recursive:true,mode:0o755});chmodSync(dir,0o755);
const firewall=(...args)=>execFileSync('iptables',args,{stdio:['ignore','pipe','pipe']});
const rules=[];
let relayVoice,relay,discovery,relayClientId,relaySessionId,relayReady=false,serverPassword;
let launched=false, bridge, core, endpoint, directory, reader, stopping=false;
const registry=createAccessRegistry({resolveClient:async id=>directory?.get(id),ttlSeconds:0,maxCredentials:0,onEvent:event,makeUserId:viewerPreview ? nativeUserId : undefined,
  resolveViewerGrant:(viewer,id)=>control.resolveViewerGrant(viewer,id)});
const control=createStreamControl({registry,resolveClient:async id=>directory?.get(id),
  canPublish:async identity=>identity.canPublish===true && identity.clientId!==relayClientId,
  canView:async identity=>viewerPreview && identity.clientId!==relayClientId,
  endpoint:`${host}:${wsPort}`,maxStreams:0,onEvent:event});
async function syncDiscovery() {
  if(!viewerPreview || !directory?.healthy)return;
  if(!relayReady || !relay?.healthy || directory.get(relayClientId)?.sessionId!==relaySessionId){
    await relay?.close();try{await relayVoice?.disconnect();}catch{}
    const relayIdentity=generateIdentity(8);
    relayVoice=new VoiceClient(relayIdentity,`127.0.0.1:${voicePort}`,'SFU 服务',{
      serverPassword,logger:Object.fromEntries(['debug','info','warn','error'].map(k=>[k,()=>{}]))});
    relayVoice.on('disconnected',()=>{relayReady=false;});
    await relayVoice.connect();
    const binding=protectVoiceClientIdentity(relayVoice,{onEvent:event});
    await relayVoice.waitConnected(AbortSignal.timeout(10000));
    if(!binding.clientId)throw new Error('Relay server-assigned identity unavailable');
    relayClientId=String(binding.clientId);
    const identity=await directory.waitFor(relayClientId);
    relaySessionId=identity.sessionId;
    relay=createNotificationRelay({voice:relayVoice,identity,onEvent:event,resolveClient:async id=>directory.get(id)});
    // Keep delivery progress when replacing only the relay connection.
    discovery ??=createChannelNotifications({includeStreamingStatus:true,control,listClientIds:async()=>directory.list().map(i=>i.clientId),
      resolveClient:async id=>directory.get(id),sendNotification:item=>relay.sendNotification(item),onEvent:event});
    relayReady=true;event({event:'viewer-discovery-ready'});
  }
  await discovery.syncAll();
}
function event(data) {
  const path=dir+'events.jsonl';
  try {
    if(statSync(path,{throwIfNoEntry:false})?.size>1048576)renameSync(path,path+'.1');
    appendFileSync(path,JSON.stringify({time:new Date().toISOString(),...data})+'\n',{mode:0o600});
  } catch { console.error('Preview diagnostic log unavailable'); }
}
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
try {
  const oldEnv=existsSync(dir+'server.env')?readFileSync(dir+'server.env','utf8'):'';
  const oldAccess=existsSync(dir+'access.txt')?readFileSync(dir+'access.txt','utf8'):'';
  const queryPassword=oldEnv.match(/^TSSERVER_QUERY_ADMIN_PASSWORD=([a-f0-9]{48})$/m)?.[1] ?? randomBytes(24).toString('hex');
  const secret=randomBytes(32).toString('hex');
  serverPassword=oldAccess.match(/^服务器密码：([A-Za-z0-9_-]{24})$/m)?.[1] ?? randomBytes(18).toString('base64url');
  run('volume','create','--ignore','--label','owner='+name,volume);
  writeFileSync(dir+'server.env',`TSSERVER_LICENSE_ACCEPTED=accept\nTSSERVER_QUERY_SSH_ENABLED=true\nTSSERVER_QUERY_SSH_IP=0.0.0.0\nTSSERVER_QUERY_SSH_PORT=10022\nTSSERVER_QUERY_ADMIN_PASSWORD=${queryPassword}\nSFU_BRIDGE_SECRET=${secret}\nSFU_CONTROL_ENABLED=1\nSFU_PUBLISHER_PREVIEW=1\n`,{mode:0o600});
  if(viewerPreview)appendFileSync(dir+'server.env','SFU_VIEWER_CONTROL_ENABLED=1\nSFU_NOTIFICATION_RELAY=1\n');
  copyFileSync(extensionPath,dir+'extend_control.so');
  // The container runs as a different user, including when systemd uses UMask=0077.
  chmodSync(dir+'extend_control.so',0o755);
  writeFileSync(dir+'extension.jsonl','',{mode:0o666});chmodSync(dir+'extension.jsonl',0o666);
  const address=(await lookup(host,{family:4})).address;
  core=await MediaCore.create({listenIp:'0.0.0.0',announcedAddress:address,mediaPort,maxRooms:0,maxPeers:0});
  endpoint=await startNativePublisherServer({core,host:'0.0.0.0',port:wsPort,maxSockets:0,audioFirst,audioRefresh,
    // Official desktop beta4.1 sends the destination WebSocket URL as Origin.
    allowedOrigins:[`ws://${host}:${wsPort}`],
    authorize:registry.authorize,subscribeRevocations:registry.subscribeRevocations,
    reserveViewer:principal=>control.reserveViewer(principal),enableViewers:viewerPreview,onEvent:event});
  bridge=await startAccessBridge({path:dir+'access.sock',secret,registry,streamControl:control,
    takeNotification:id=>relay?.takeNotification(id)});
  run('run','-d','--name',name,'--env-file',dir+'server.env','-v',dir+':/sfu-trace','-v',volume+':/var/tsserver',
    '-e','LD_PRELOAD=/sfu-trace/extend_control.so','-p',`0.0.0.0:${voicePort}:9987/udp`,
    '-p',`127.0.0.1:${queryPort}:10022`,image);launched=true;
  const pid=Number(run('inspect',name,'--format','{{.State.Pid}}'));
  const hash=createHash('sha256').update(readFileSync(`/proc/${pid}/exe`)).digest('hex');
  if(hash!=='c15d88ba878c64a05c0e2325e2deb37e96864120af6d72091267b97944e2d200')throw new Error('Unsupported server build');
  for(let attempt=0;;attempt++) {
    reader=createSnapshotReader({port:queryPort,password:queryPassword});
    try {await reader.request('version');break;} catch {
      reader.close();if(attempt>=10)throw new Error('Preview Query startup timeout');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  await reader.request('use sid=1');
  await reader.request(`serveredit virtualserver_name=SFU\\sPublisher\\sPreview virtualserver_password=${serverPassword} virtualserver_sfu_endpoint=${host}:${wsPort}`);
  const teamSpeakMaxClients=await configureServerSlots({reader,requested:tsMaxClients,
    migrateLegacy:!!oldAccess && !existsSync(dir+'slots-migrated')});
  writeFileSync(dir+'slots-migrated','1\n',{mode:0o600});
  const previousToken=oldAccess.match(/^一次性管理员权限密钥：([^\s]+)$/m)?.[1];
  const response=previousToken ? '' : await reader.request('tokenadd tokentype=0 tokenid1=6 tokenid2=0');
  const token=previousToken ?? response.match(/(?:^|\s)token=([^\s]+)/)?.[1];
  if(!token)throw new Error('Preview administrator token unavailable');
  writeFileSync(dir+'access.txt',`实验地址：${address}:${voicePort}\n对应域名：${host}（测试先用 IP，避免 SRV 跳转）\n服务器密码：${serverPassword}\n一次性管理员权限密钥：${token}\n\n已连接的普通用户也可以使用 Server 屏幕共享，无需管理员权限。管理员权限密钥仅用于管理服务器。\n实验预览版；共享画面已验证，共享声音暂不可用。权限密钥用过后不会在重启时重新生成。\nSFU Endpoint 已设为 ${host}:${wsPort}，无需手动修改。\n`,{mode:0o600});
  chownSync(dir+'access.txt',accessUid,accessGid);chmodSync(dir+'access.txt',0o600);
  if(smokeTokenEnabled) {
  const smokeResponse=await reader.request('tokenadd tokentype=0 tokenid1=6 tokenid2=0');
  const smokeToken=smokeResponse.match(/(?:^|\s)token=([^\s]+)/)?.[1];
  if(!smokeToken)throw new Error('Probe token unavailable');
  writeFileSync(dir+'smoke-token.txt',smokeToken,{mode:0o600});
  }
  reader.close();reader=undefined;
  directory=await startQueryDirectory({port:queryPort,password:queryPassword,serverId:name,registry,onEvent:event});
  if(viewerPreview)try{await syncDiscovery();}catch{event({event:'viewer-discovery-sync-failed'});}
  for(const [protocol,port] of [['tcp',wsPort],['udp',mediaPort],['tcp',mediaPort]]) {
    const rule=['-p',protocol,'--dport',String(port),'-m','comment','--comment',name,'-j','ACCEPT'];
    firewall('-I','INPUT','1',...rule);rules.push(['INPUT',...rule]);
  }
  // This host's FORWARD policy drops new container ingress unless explicitly
  // accepted. Match only this preview container and its published voice port.
  const containerAddress=run('inspect',name,'--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}');
  if(!isIPv4(containerAddress))throw new Error('Unexpected preview container network');
  const voiceRule=['-d',containerAddress,'-p','udp','--dport','9987','-m','conntrack','--ctstate','DNAT',
    '--ctorigdstport',String(voicePort),'-m','comment','--comment',name,'-j','ACCEPT'];
  firewall('-I','FORWARD','1',...voiceRule);rules.push(['FORWARD',...voiceRule]);
  const status={ready:true,publisherPreview:true,viewerPreview,viewerDiscoveryReady:relayReady,officialDesktopClientTested:false,host,voicePort,wsPort,mediaPort,
    announcedAddress:address,productionModified:false,container:name,teamSpeakMaxClients,
    sfuCapacityLimits:false,credentialLifetime:'connection'};
  const writeStatus=()=>{
    Object.assign(status,{ready:directory.healthy && (!viewerPreview || (relayReady && !!relay?.healthy)),
      directoryHealthy:directory.healthy,viewerDiscoveryReady:directory.healthy && relayReady && !!relay?.healthy,
      experimentalAudioRefresh:audioRefresh,updatedAt:new Date().toISOString()});
    writeFileSync(dir+'status.json.tmp',JSON.stringify(status,null,2)+'\n');
    renameSync(dir+'status.json.tmp',dir+'status.json');
  };
  writeStatus();event({event:'preview-ready',...status});
  console.log(JSON.stringify(status));
  while(!stopping) {
    await new Promise(resolve=>setTimeout(resolve,5000));
    if(stopping)break;
    if(core.worker.closed || run('inspect',name,'--format','{{.State.Running}}')!=='true')throw new Error('Preview dependency unavailable');
    try{await syncDiscovery();}catch{event({event:'viewer-discovery-sync-failed'});}
    writeStatus();
    event({event:'media-counts',directoryHealthy:directory.healthy,...core.counts()});
    const diagnostics=await collectMediaDiagnostics(core);
    if(diagnostics.transports.length || diagnostics.producers.length || diagnostics.consumers.length)
      event({event:'media-statistics',...diagnostics});
  }
} catch(error) { console.error('Preview stopped:',error.name);event({event:'preview-failed',errorType:error.name,directoryHealthy:directory?.healthy,workerClosed:core?.worker.closed});process.exitCode=1; }
finally {
  await discovery?.close();await relay?.close();try{await relayVoice?.disconnect();}catch{}
  directory?.stop();reader?.close();
  await endpoint?.stop();await bridge?.stop();control.close();core?.close();
  if(launched)run('rm','-f',name);
  for(const [chain,...rule] of rules)firewall('-D',chain,...rule);
  writeFileSync(dir+'status.json',JSON.stringify({ready:false,stoppedAt:new Date().toISOString()})+'\n');
}
}
