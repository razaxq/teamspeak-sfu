import {execFileSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {selfhostConfig,SERVER_SHA256} from './selfhost-config.js';

const run=(program,args)=>execFileSync(program,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
  if(process.argv.slice(2).some(arg=>arg!=='--check'))throw new Error('Usage: selfhost.js [--check]');
  const config=selfhostConfig();
  if(process.platform!=='linux' || process.arch!=='arm64')throw new Error('This preview requires Linux ARM64 (aarch64)');
  if(process.getuid()!==0)throw new Error('Root is required for Podman and the firewall rules');
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('Node.js 22 or newer is required');
  for(const [program,args] of [['podman',['--version']],['gcc',['--version']],['iptables',['--version']]])run(program,args);
  // No running server or credentials are inspected. Pull explicitly in the installation steps.
  const image=JSON.parse(run('podman',['image','inspect',config.image]))[0];
  if(image.Architecture!=='arm64')throw new Error('The selected image is not ARM64');
  config.image=image.Id;
  const temporary=mkdtempSync(join(tmpdir(),'ts6-sfu-build-'));
  const container='ts6-sfu-check-'+randomBytes(6).toString('hex');
  let created=false;
  try {
    run('podman',['create','--name',container,config.image]);created=true;
    run('podman',['cp',container+':/opt/tsserver/tsserver',join(temporary,'tsserver')]);
    const hash=createHash('sha256').update(readFileSync(join(temporary,'tsserver'))).digest('hex');
    if(hash!==SERVER_SHA256)throw new Error('Unsupported TeamSpeak server binary; use the pinned image');
  } finally {
    if(created)run('podman',['rm','-v',container]);
    rmSync(temporary,{recursive:true,force:true});
  }
  const build=fileURLToPath(new URL('../.runtime/',import.meta.url));
  mkdirSync(build,{recursive:true,mode:0o700});
  config.extensionPath=join(build,'selfhost-control.so');
  run('gcc',['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror','-o',config.extensionPath,
    fileURLToPath(new URL('../../scripts/instrumentation/extend_control.c',import.meta.url)),'-ldl']);
  console.log(JSON.stringify({preflight:'passed',architecture:process.arch,serverSha256:SERVER_SHA256,
    host:config.host,voicePort:config.voicePort,wsPort:config.wsPort,mediaPort:config.mediaPort}));
  if(!process.argv.includes('--check')) {
    const {runNativeServer}=await import('./native-runtime.js');
    await runNativeServer(config);
  }
} catch(error) {
  // Child process output can contain secrets. Only our own validation messages are printable.
  console.error(error.status!==undefined ? 'Deployment command failed; verify installed tools, image availability and free ports.' : error.message);
  process.exitCode=1;
}
