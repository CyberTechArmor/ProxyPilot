import { mkdirSync,lstatSync,existsSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { readPrivate,atomicPrivate } from './pomerium-runtime.js';
import { INFISICAL_ROOT,INFISICAL_IMAGE,INFISICAL_DB_IMAGE,INFISICAL_REDIS_IMAGE,AGENT_PROXY_IMAGE,INFISICAL_PORT,infisicalError as fail,digest } from './infisical-logic.js';
const OWNER='io.proxypilot.infisical';
export const namesFor=r=>{const prefix=`pp-if-${r.credential_ref.slice(-12)}`;return {network:`${prefix}-data-net`,proxyNetwork:`${prefix}-proxy-net`,database:`${prefix}-db`,redis:`${prefix}-redis`,server:`${prefix}-server`,proxy:`${prefix}-proxy`,databaseVolume:`${prefix}-pg`,redisVolume:`${prefix}-redis-data`,proxyVolume:`${prefix}-proxy-state`};};
function privateDir(path){mkdirSync(path,{recursive:true,mode:0o700});const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw fail('Infisical protected directory has unsafe ownership or permissions.');}
function immutableFile(path,content){if(existsSync(path)){if(readPrivate(path)!==content)throw fail('Protected Infisical configuration drifted; restore its matching backup set.');}else atomicPrivate(path,content);}
export function prepareInfisicalFiles(r,{root=INFISICAL_ROOT,resourcesExist=false}={}) {
  privateDir(root);const bundle=join(root,'protected.json');
  const identity={ref:r.credential_ref,origin:r.config.origin};
  if(!existsSync(bundle)){
    if(resourcesExist||r.resources||readdirSync(root).length)throw fail('Existing resources or files have no protected Infisical key set. Restore it; no keys were regenerated.');
    atomicPrivate(bundle,JSON.stringify({identity,database:randomBytes(32).toString('base64url'),encryption:randomBytes(16).toString('hex'),auth:randomBytes(32).toString('base64'),test:randomBytes(32).toString('base64url'),proxyTest:randomBytes(32).toString('base64url')}));
  }
  let keys;try{keys=JSON.parse(readPrivate(bundle));}catch{throw fail('Protected Infisical key set is unreadable.');}
  if(digest(keys.identity)!==digest(identity)||!/^[a-f0-9]{32}$/.test(keys.encryption)||!/^[A-Za-z0-9_-]{43}$/.test(keys.database)||!/^[A-Za-z0-9_-]{43}$/.test(keys.test)||!/^[A-Za-z0-9_-]{43}$/.test(keys.proxyTest)||Buffer.from(keys.auth||'','base64').length!==32)throw fail('Protected Infisical key set does not match the saved installation.');
  const names=namesFor(r),dbEnv=join(root,'database.env'),serverEnv=join(root,'server.env');
  immutableFile(dbEnv,`POSTGRES_DB=infisical\nPOSTGRES_USER=infisical\nPOSTGRES_PASSWORD=${keys.database}\n`);
  immutableFile(serverEnv,`NODE_ENV=production\nHOST=0.0.0.0\nPORT=8080\nENCRYPTION_KEY=${keys.encryption}\nAUTH_SECRET=${keys.auth}\nDB_CONNECTION_URI=postgresql://infisical:${keys.database}@${names.database}:5432/infisical\nREDIS_URL=redis://${names.redis}:6379\nSITE_URL=${r.config.origin}\nTELEMETRY_ENABLED=false\nDISABLE_UPDATE_CHECK=true\n`);
  return {root,bundle,dbEnv,serverEnv,keys};
}
export function assertLocalTestHost(config,{interfaces=networkInterfaces()}={}){if(!Object.values(interfaces).flat().some(x=>x.address===config.testHost&&!x.internal))throw fail('The reviewed private test address is not assigned to the runner host. No listener was opened.');}
export async function assertIsolatedAgentVm(config,{exec,job}) {
  job.fence();const response=await exec.host(['incus','list',config.agentVm,'--format=json']);job.fence();
  let list;try{list=JSON.parse(response.stdout);}catch{}
  const vm=list?.find(x=>x.name===config.agentVm);
  if(response.code!==0||!vm||vm.type!=='virtual-machine'||vm.status!=='Running'||!vm.config?.['volatile.uuid'])throw fail('Select an existing running disposable Incus VM for the credential tests. No VM will be provisioned or started.');
  const configKeys=Object.keys(vm.expanded_config||vm.config||{});
  const devices=Object.values(vm.expanded_devices||{});
  if(configKeys.some(k=>k.startsWith('raw.')||k==='security.privileged')||devices.some(d=>!['disk','nic'].includes(d.type)||(d.type==='disk'&&(d.path!=='/'||!d.pool||d.source))||(d.type==='nic'&&['physical','sriov'].includes(d.nictype)))||!devices.some(d=>d.type==='disk'&&d.path==='/'))throw fail('The agent test VM has unverified passthrough/shared devices or raw settings. Use an isolated disposable VM without host mounts.');
  return {vm:vm.name,uuid:vm.config['volatile.uuid']};
}
export function dockerAdapter(exec,job){
  const call=async args=>{job.fence();const r=await exec.host(['docker',...args],{timeoutMs:120000});job.fence();return r;};
  const must=async(args,label)=>{const r=await call(args);if(r.code!==0)throw fail(`Infisical ${label} failed. Inspect the named owned resource locally; raw runtime output is withheld.`);return r;};
  const inspect=async(kind,name)=>{const list=await must(kind==='container'?['container','ls','-a','--format','{{.Names}}']:[kind,'ls','--format','{{.Name}}'],`${kind} inventory`);if(!list.stdout.trim().split('\n').includes(name))return null;
    const r=await must([kind,'inspect',name],`${kind} inspection`);try{const v=JSON.parse(r.stdout);if(!Array.isArray(v)||v.length!==1)throw Error();return v[0];}catch{throw fail('Docker inspection could not establish resource identity.');}};
  return {call,must,inspect};
}
export function assertContainer(actual,spec,{external=false}={}) {
  const c=actual.Config||{},h=actual.HostConfig||{},ports=h.PortBindings||{},mounts=actual.Mounts||[];
  const samePorts=digest(ports)===digest(spec.ports||{});
  if(c.Image!==spec.image||(!external&&c.Labels?.[OWNER]!==spec.owner)||h.NetworkMode!==spec.network||h.RestartPolicy?.Name!=='unless-stopped'||h.Privileged||h.LogConfig?.Type!=='none'||h.PidMode||h.IpcMode==='host'||h.CapAdd?.length||h.Devices?.length||!samePorts||mounts.length!==spec.mounts.length||spec.mounts.some(m=>!mounts.some(a=>a.Type===m.Type&&a.Destination===m.Destination&&(m.Type==='volume'?a.Name===m.Name:a.Source===m.Source)&&a.RW===m.RW))||Object.keys(actual.NetworkSettings?.Networks||{}).some(n=>n!==spec.network))throw fail('Docker container configuration or isolation differs from the reviewed profile. No adoption, replacement or restart was attempted.');
  if(spec.command&&digest(c.Cmd)!==digest(spec.command))throw fail('Agent Proxy command differs from the pinned start/block profile.');
  const env=Object.fromEntries((c.Env||[]).map(x=>{const p=x.indexOf('=');return [x.slice(0,p),x.slice(p+1)];}));
  for(const [k,v] of Object.entries(spec.env||{}))if(env[k]!==v)throw fail('Docker credential/configuration environment differs from the protected reference.');
  if(Object.keys(env).some(k=>(k.startsWith('INFISICAL_')||/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|DB_|REDIS_|ENCRYPTION_|AUTH_SECRET|SITE_URL)/.test(k))&&!Object.hasOwn(spec.env||{},k)))throw fail('Docker has an unreviewed environment override; connection cannot be verified.');
}
const envObject=text=>Object.fromEntries(text.trim().split('\n').filter(Boolean).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
export async function ensureInfisicalRuntime(r,{exec,job,root=INFISICAL_ROOT,attempts=45,sleep=ms=>new Promise(done=>setTimeout(done,ms))}={}) {
  const d=dockerAdapter(exec,job),names=namesFor(r),owner=r.credential_ref;
  await d.must(['version','--format','{{.Server.Version}}'],'Docker availability');
  const inventory={};for(const [key,kind] of [['network','network'],['databaseVolume','volume'],['redisVolume','volume'],['database','container'],['redis','container'],['server','container']]){inventory[key]=await d.inspect(kind,names[key]);const v=inventory[key];if(v&&(kind==='container'?v.Config?.Labels:v.Labels)?.[OWNER]!==owner)throw fail(`Resource collision: ${names[key]}. Unrelated resources were preserved.`);}
  const files=prepareInfisicalFiles(r,{root,resourcesExist:Object.values(inventory).some(Boolean)});
  const labels=['--label',`${OWNER}=${owner}`];
  if(inventory.network&&(!inventory.network.Internal||inventory.network.Driver!=='bridge'))throw fail('Owned Infisical data network is no longer private.');
  for(const key of ['databaseVolume','redisVolume'])if(inventory[key]&&(inventory[key].Driver!=='local'||Object.keys(inventory[key].Options||{}).length))throw fail('Owned Infisical volume driver/options changed. No data was replaced.');
  if(!inventory.network)await d.must(['network','create','--internal',...labels,names.network],'private network create');
  for(const key of ['databaseVolume','redisVolume'])if(!inventory[key])await d.must(['volume','create',...labels,names[key]],'persistent volume create');
  const specs=[
    {key:'database',image:INFISICAL_DB_IMAGE,env:envObject(readPrivate(files.dbEnv)),envFile:files.dbEnv,mounts:[{Type:'volume',Name:names.databaseVolume,Destination:'/var/lib/postgresql/data',RW:true}]},
    {key:'redis',image:INFISICAL_REDIS_IMAGE,command:['redis-server','--appendonly','yes'],mounts:[{Type:'volume',Name:names.redisVolume,Destination:'/data',RW:true}]},
    {key:'server',image:INFISICAL_IMAGE,env:envObject(readPrivate(files.serverEnv)),envFile:files.serverEnv,ports:{'8080/tcp':[{HostIp:'127.0.0.1',HostPort:String(INFISICAL_PORT)}]},mounts:[]}
  ];
  for(const spec of specs){spec.owner=owner;spec.network=names.network;
    if(!inventory[spec.key]){const args=['create','--name',names[spec.key],...labels,'--restart','unless-stopped','--network',names.network,'--log-driver','none'];if(spec.envFile)args.push('--env-file',spec.envFile);for(const m of spec.mounts)args.push('--mount',`type=volume,source=${m.Name},target=${m.Destination}`);if(spec.ports)args.push('--publish',`127.0.0.1:${INFISICAL_PORT}:8080`);args.push(spec.image,...(spec.command||[]));await d.must(args,`${spec.key} create`);}
    const actual=await d.inspect('container',names[spec.key]);await verifyImageDefaults(d,actual,spec);assertContainer(actual,spec);
    if(!actual.State?.Running)await d.must(['start',names[spec.key]],`${spec.key} start`);
    const probe=spec.key==='database'?['exec',names.database,'pg_isready','-U','infisical','-d','infisical']:spec.key==='redis'?['exec',names.redis,'redis-cli','ping']:['exec',names.server,'node','-e',"fetch('http://127.0.0.1:8080/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"];
    let ready=false;for(let i=0;i<attempts;i++){if((await d.call(probe)).code===0){ready=true;break;}await sleep(2000);}if(!ready)throw fail(`Infisical ${spec.key} readiness was not established. Retry preserves data and keys.`);
  }
  job.generated({kind:'infisical_backup_set',where:files.root,name:owner});
  return {...names,directory:files.root,protectedRef:files.bundle,serverImage:INFISICAL_IMAGE,databaseImage:INFISICAL_DB_IMAGE,redisImage:INFISICAL_REDIS_IMAGE};
}
export async function ensureAgentProxyRuntime(r,values,{exec,job,root=INFISICAL_ROOT}={}) {
  if(r.config.agentMode==='skip')return {state:'skipped'};
  const d=dockerAdapter(exec,job),n=namesFor(r),external=r.config.agentMode==='connect';
  const name=external?r.config.externalProxyContainer:n.proxy,actual=await d.inspect('container',name);
  const env={INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:r.identities.proxy.clientId,INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:values.proxy,INFISICAL_DOMAIN:r.config.origin,INFISICAL_DISABLE_UPDATE_CHECK:'true'};
  const command=['secrets','agent-proxy','start','--unmatched-host=block','--poll-interval=30','--telemetry=false'];
  // Connect inspects the selected instance's existing dedicated resources. It
  // never requires renaming/recreating them under a newly generated owner ref.
  const spec={owner:r.credential_ref,image:AGENT_PROXY_IMAGE,network:n.proxyNetwork,command,env,ports:{'17322/tcp':[{HostIp:new URL(r.config.proxyOrigin).hostname,HostPort:'17322'}]},mounts:[{Type:'volume',Name:n.proxyVolume,Destination:'/root/.infisical',RW:true}]};
  if(external&&actual){
    const network=actual.HostConfig?.NetworkMode,volume=actual.Mounts?.find(m=>m.Type==='volume'&&m.Destination==='/root/.infisical')?.Name;
    if(!network||['host','bridge','none','default'].includes(network)||network.startsWith('container:')||!volume)throw fail('Existing Agent Proxy requires a dedicated bridge and named state volume. Nothing was changed.');
    if(r.resources?.proxy?.network&&(r.resources.proxy.network!==network||r.resources.proxy.volume!==volume))throw fail('Existing Agent Proxy resources changed since verification. No adoption was attempted.');
    spec.network=network;spec.mounts[0].Name=volume;
  }
  privateDir(root);const envFile=join(root,'agent-proxy.env');immutableFile(envFile,Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
  if(!actual&&external)throw fail('The selected existing Agent Proxy container was not found. Its protected environment handoff is prepared; complete the exact guide and retry.');
  for(const [kind,resourceName] of [['network',spec.network],['volume',spec.mounts[0].Name]]) {
    const resource=await d.inspect(kind,resourceName);
    if(resource&&((!external&&resource.Labels?.[OWNER]!==r.credential_ref)||(kind==='network'&&(resource.Driver!=='bridge'||resource.Internal||Object.keys(resource.Options||{}).length))||(kind==='volume'&&(resource.Driver!=='local'||Object.keys(resource.Options||{}).length))))throw fail('Agent Proxy network/volume isolation changed or ownership conflicts. Nothing was overwritten.');
    if(!resource){if(external||actual)throw fail('Agent Proxy network/volume identity unavailable.');await d.must([kind,'create','--label',`${OWNER}=${r.credential_ref}`,resourceName],'Agent Proxy resource create');}
    if(kind==='network'&&Object.values(resource?.Containers||{}).some(c=>c.Name!==name))throw fail('Agent Proxy bridge is shared with another container. Nothing was changed.');
  }
  if(!actual){
    await d.must(['create','--name',name,'--label',`${OWNER}=${r.credential_ref}`,'--restart','unless-stopped','--network',spec.network,'--log-driver','none','--env-file',envFile,'--publish',`${new URL(r.config.proxyOrigin).hostname}:17322:17322`,'--mount',`type=volume,source=${n.proxyVolume},target=/root/.infisical`,AGENT_PROXY_IMAGE,...command],'Agent Proxy create');
  }
  const verified=await d.inspect('container',name);await verifyImageDefaults(d,verified,spec);assertContainer(verified,spec,{external});
  if(external&&!verified.State?.Running)throw fail('Existing Agent Proxy is stopped. The operator must start it; Connect does not restart services.');
  if(!external&&!verified.State?.Running)await d.must(['start',name],'Agent Proxy start');
  return {container:name,network:spec.network,volume:spec.mounts[0].Name,image:AGENT_PROXY_IMAGE,ownership:external?'external':'managed',endpoint:r.config.proxyOrigin,credentialRef:r.credential_ref};
}

async function verifyImageDefaults(d,actual,spec) {
  const response=await d.must(['image','inspect',spec.image],'pinned image metadata');let image;
  try{image=JSON.parse(response.stdout)[0];}catch{throw fail('Pinned image metadata unavailable.');}
  if(!image?.Id || actual.Image!==image.Id || digest(actual.Config?.Entrypoint)!==digest(image.Config?.Entrypoint) || (!spec.command && digest(actual.Config?.Cmd)!==digest(image.Config?.Cmd)))throw fail('Container executable/image differs from the pinned image.');
  const defaults=envObject((image.Config?.Env||[]).join('\n'));
  const desired={...defaults,...spec.env};
  if(digest(Object.entries(envObject((actual.Config?.Env||[]).join('\n'))).sort())!==digest(Object.entries(desired).sort()))throw fail('Container has changed or unreviewed environment settings.');
  spec.env=desired;
}
