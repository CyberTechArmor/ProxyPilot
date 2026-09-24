import { mkdirSync,lstatSync,existsSync,readdirSync,readFileSync,writeFileSync,chmodSync } from 'node:fs';
import { join } from 'node:path';
import { readPrivate,atomicPrivate } from './pomerium-runtime.js';
import { LOG_ARGS,dockerFailure,startOwnedContainer,sameArgv,sameUser } from './owned-runtime.js';
import { OPENBAO_ROOT,OPENBAO_IMAGE,OPENBAO_PORT,POSTGRES_CA_PATH,fail,namesFor,digest,autoCustody } from './openbao-logic.js';
const OWNER='io.proxypilot.openbao';
export function privateDir(path){mkdirSync(path,{recursive:true,mode:0o700});const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077))throw fail('OpenBao protected directory ownership or permissions are unsafe.');}
// OpenBao 2.6 disables the unauthenticated sys/generate-root endpoints unless the
// listener says otherwise (the path then answers 405). Automatic custody needs
// them: withTransientRoot, and the recovery kit's "bao operator generate-root",
// both of which still require 2 of the 3 unseal shares.
const listenerFor=(r,generateRoot)=>({address:'0.0.0.0:8200',cluster_address:'127.0.0.1:8201',tls_disable:true,...(generateRoot?{disable_unauthed_generate_root_endpoints:false}:{})});
const configWith=(r,generateRoot)=>({ui:true,disable_mlock:true,api_addr:r.config.origin,cluster_addr:'https://127.0.0.1:8201',storage:{raft:{path:'/openbao/file',node_id:namesFor(r).server}},listener:{tcp:listenerFor(r,generateRoot)},log_level:'warn'});
export const serverConfig=r=>configWith(r,autoCustody(r));
// The rendering before the generate-root flag; an exact match is upgraded in place.
export const priorServerConfig=r=>configWith(r,false);
export function prepareFiles(r,{root=OPENBAO_ROOT,resourcesExist=false}={}){privateDir(root);const marker=join(root,'owner.json'),config=join(root,'server.json'),identity=JSON.stringify({ref:r.credential_ref,origin:r.config.origin});
  if(!existsSync(marker)){if(resourcesExist||r.resources||readdirSync(root).length)throw fail('Owned runtime has no matching protected configuration. Restore the configuration set; data will not be reset.');atomicPrivate(marker,identity);}
  if(readPrivate(marker)!==identity)throw fail('OpenBao directory belongs to a different installation.');
  const content=JSON.stringify(serverConfig(r),null,2)+'\n',prior=JSON.stringify(priorServerConfig(r),null,2)+'\n';let changed=false;
  if(existsSync(config)){const s=lstatSync(config),live=readFileSync(config,'utf8');if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o022))throw fail('OpenBao configuration drifted. Restore it without replacing Raft data.');
    // Written in place (same inode): the container bind-mounts this file.
    if(live!==content){if(live!==prior)throw fail('OpenBao configuration drifted. Restore it without replacing Raft data.');writeFileSync(config,content);changed=true;}}
  else {atomicPrivate(config,content);chmodSync(config,0o644);} // non-secret config, readable by the image's unprivileged user
  let ca;
  if(r.config.database?.caPem){ca=join(root,'postgres-ca.pem');if(existsSync(ca)){const s=lstatSync(ca);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o022)||readFileSync(ca,'utf8')!==r.config.database.caPem)throw fail('Reviewed PostgreSQL public CA file drifted. Restore the saved certificate bundle.');}else{atomicPrivate(ca,r.config.database.caPem);chmodSync(ca,0o644);}}
  return {root,config,ca,changed};}
export async function ensureRuntime(r,{exec,job,root=OPENBAO_ROOT,sleep,startTimeoutMs}={}){const n=namesFor(r),owner=r.credential_ref;
  const call=async a=>{job.fence();const v=await exec.host(['docker',...a],{timeoutMs:120000});job.fence();if(v.code!==0)throw dockerFailure(fail,`OpenBao docker ${a[0]}`,v);return v.stdout;};
  const inspect=async(kind,name)=>{const names=await call(kind==='container'?['container','ls','-a','--format','{{.Names}}']:[kind,'ls','--format','{{.Name}}']);if(!names.trim().split('\n').includes(name))return null;try{return JSON.parse(await call([kind,'inspect',name]))[0];}catch(e){if(e.openbaoSafe)throw e;throw fail('Docker resource identity could not be read.');}};
  await call(['version','--format','{{.Server.Version}}']);const prior={};
  for(const [k,kind] of [['network','network'],['volume','volume'],['logs','volume'],['server','container']]){const a=prior[k]=await inspect(kind,n[k]);if(a&&(kind==='container'?a.Config?.Labels:a.Labels)?.[OWNER]!==owner)throw fail('OpenBao resource name collision. Unrelated resources were preserved.');}
  const files=prepareFiles(r,{root,resourcesExist:Object.values(prior).some(Boolean)}),labels=['--label',`${OWNER}=${owner}`];
  if(prior.network&&(prior.network.Driver!=='bridge'||prior.network.Internal||Object.keys(prior.network.Options||{}).length||Object.values(prior.network.Containers||{}).some(c=>c.Name!==n.server)))throw fail('OpenBao dedicated network changed or has unrelated members.');
  for(const k of ['volume','logs'])if(prior[k]&&(prior[k].Driver!=='local'||Object.keys(prior[k].Options||{}).length))throw fail('OpenBao volume driver/options changed. Data was preserved.');
  if(!prior.network)await call(['network','create',...labels,n.network]);
  for(const k of ['volume','logs'])if(!prior[k])await call(['volume','create',...labels,n[k]]);
  if(!prior.server)await call(['create','--name',n.server,...labels,'--restart','unless-stopped','--network',n.network,...LOG_ARGS,'--memory','512m','--memory-swap','512m','--publish',`127.0.0.1:${OPENBAO_PORT}:8200`,'--mount',`type=volume,source=${n.volume},target=/openbao/file`,'--mount',`type=volume,source=${n.logs},target=/openbao/logs`,'--mount',`type=bind,source=${files.config},target=/openbao/config/server.json,readonly`,...(files.ca?['--mount',`type=bind,source=${files.ca},target=${POSTGRES_CA_PATH},readonly`]:[]),OPENBAO_IMAGE,'server']);
  const a=await inspect('container',n.server),c=a?.Config||{},h=a?.HostConfig||{},m=a?.Mounts||[];
  const ports={'8200/tcp':[{HostIp:'127.0.0.1',HostPort:String(OPENBAO_PORT)}]};
  const mounts=[['volume',n.volume,'/openbao/file',true],['volume',n.logs,'/openbao/logs',true],['bind',files.config,'/openbao/config/server.json',false],...(files.ca?[['bind',files.ca,POSTGRES_CA_PATH,false]]:[])];
  if(c.Image!==OPENBAO_IMAGE||c.Labels?.[OWNER]!==owner||digest(c.Cmd)!==digest(['server'])||h.NetworkMode!==n.network||h.RestartPolicy?.Name!=='unless-stopped'||h.Memory!==536870912||h.MemorySwap!==536870912||h.Privileged||h.CapAdd?.length||h.Devices?.length||h.PidMode||h.IpcMode==='host'||digest(h.PortBindings||{})!==digest(ports)||m.length!==mounts.length||mounts.some(([type,source,target,rw])=>!m.some(x=>x.Type===type&&(type==='volume'?x.Name:x.Source)===source&&x.Destination===target&&x.RW===rw))||Object.keys(a.NetworkSettings?.Networks||{}).some(x=>x!==n.network))throw fail('OpenBao runtime differs from its reviewed private, persistent single-node profile. No replacement was attempted.');
  const image=JSON.parse(await call(['image','inspect',OPENBAO_IMAGE]))[0];
  if(a.Image!==image.Id||!sameArgv(c.Entrypoint,image.Config?.Entrypoint)||digest(c.Env||[])!==digest(image.Config?.Env||[])||!sameUser(c.User,image.Config?.User))throw fail('OpenBao runtime has an unreviewed image, entrypoint, environment or user override.');
  // An upgraded configuration is read at start: restart the owned server. It
  // comes back sealed and this job's automatic unseal opens it again.
  if(files.changed&&prior.server){job.event?.('runtime_migration','OpenBao: restarting to apply the root-generation listener setting (data kept; it is unsealed automatically).',{container:n.server});await call(['restart','--time','30',n.server]);}
  // OpenBao starts sealed; running is the readiness this step can prove (3b).
  await startOwnedContainer({run:argv=>exec.host(argv,{timeoutMs:120000}),name:n.server,fail,job,label:'OpenBao server',requireHealth:false,sleep,startTimeoutMs});
  job.generated({kind:'openbao_data_configuration',name:owner,where:root});return {...n,directory:root,config:files.config,image:OPENBAO_IMAGE};
}
