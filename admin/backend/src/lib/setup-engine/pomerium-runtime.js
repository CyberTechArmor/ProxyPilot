import { mkdirSync, lstatSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { POMERIUM_ROOT, POMERIUM_IMAGE, POMERIUM_APP, POMERIUM_PORT, renderPomeriumConfig, digest, pomeriumError as fail } from './pomerium-logic.js';
import { pomeriumSecrets, preserveExternalSecrets } from './pomerium-store.js';

function privateDir(path) {
  mkdirSync(path,{recursive:true,mode:0o700}); const s=lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid!==process.getuid() || (s.mode&0o077)) throw fail('Pomerium directory ownership or permissions are unsafe.');
}
export function readPrivate(path) {
  const s=lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.uid!==process.getuid() || (s.mode&0o077) || s.size>2*1024*1024) throw fail('Pomerium configuration file ownership, size or permissions are unsafe.');
  return readFileSync(path,'utf8');
}
export function atomicPrivate(path, content) {
  if (existsSync(path)) readPrivate(path);
  const temp=`${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp,content,{mode:0o600,flag:'wx'});
  const fd=openSync(temp,'r'); try { fsyncSync(fd); } finally {closeSync(fd);}
  renameSync(temp,path);
  const dir=openSync(join(path,'..'),'r'); try {fsyncSync(dir);}finally{closeSync(dir);}
}
export function preparePomeriumFiles(db,r,intents,{root=POMERIUM_ROOT}={}) {
  privateDir(root);
  const marker=join(root,'owner.json'), identity=JSON.stringify({app:POMERIUM_APP,origin:r.config.origin,ref:r.credential_ref});
  if (existsSync(marker) && readPrivate(marker)!==identity) throw fail('Pomerium directory belongs to a different installation.');
  if (!existsSync(marker) && (readdirSync(root).length || r.resources)) throw fail('Pomerium protected files are missing or unowned; restore the recorded backup set.');
  const config=renderPomeriumConfig(r.config,intents,pomeriumSecrets(db,r));
  // Only this renderer's closed schema reaches the runtime. JSON is an official
  // Core config format; arbitrary operator YAML is never parsed or rendered.
  if (!config.authenticate_service_url || config.idp_provider!=='oidc' || config.routes.some(route=>!route.policy[0].allow.or.length)) throw fail('Invalid generated gateway configuration.');
  if (!existsSync(marker)) atomicPrivate(marker,identity);
  const candidate=join(root,`revision-${r.revision}.json`), content=JSON.stringify(config,null,2)+'\n';
  if (existsSync(candidate) && readPrivate(candidate)!==content) throw fail('Saved revision file differs from the reviewed intent; restore it, do not overwrite it.');
  if (!existsSync(candidate)) atomicPrivate(candidate,content);
  return {root,candidate,content,config,fingerprint:digest(config),active:join(root,'config.json')};
}
export function assertExternalConfig(actual, desired) {
  // No adoption or write. Existing global settings and unrelated routes survive.
  // Unknown global settings are refused because env overrides / global policy can
  // defeat the proof. Unrelated ROUTES may remain if they cannot reach our app.
  for (const [key,value] of Object.entries(desired)) {
    if (key==='routes') continue;
    if (JSON.stringify(actual[key])!==JSON.stringify(value)) throw fail(`Existing Core differs at ${key}; this global profile cannot be connected as-is. Use a separate conforming instance; no external configuration was changed.`);
  }
  if (Object.keys(actual).some(k=>!Object.hasOwn(desired,k))) throw fail('Existing Core has unsupported global settings; it cannot be verified without weakening this contract.');
  if (!Array.isArray(actual.routes)) throw fail('Existing route configuration is unavailable.');
  for (const route of desired.routes) {
    const matches=actual.routes.filter(x=>x.from===route.from || x.name===route.name);
    if (matches.length!==1 || JSON.stringify(matches[0])!==JSON.stringify(route)) throw fail(`Owned route ${route.from} does not exactly match the reviewed policy/upstream. Merge that route from the handoff and retry.`);
  }
  for (const route of actual.routes) {
    if (desired.routes.some(x=>x.name===route.name)) continue;
    if (JSON.stringify(route).includes('127.0.0.1') || desired.routes.some(x=>route.from===x.from || String(route.from).includes('*'))) throw fail('An unrelated Pomerium route could bypass the selected application; activation is blocked.');
  }
}
const inspectFormat = '{"image":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"env":{{json .Config.Env}},"network":{{json .HostConfig.NetworkMode}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}}}';
export async function ensurePomeriumRuntime(db,r,intents,{exec,job,root=POMERIUM_ROOT,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),attempts=30}) {
  const call=async args=>{job.fence();const res=await exec.host(['docker',...args],{timeoutMs:120000});job.fence();return res;};
  const must=async(args,step)=>{const res=await call(args);if(res.code!==0)throw fail(`Pomerium ${step} failed; inspect the named resource locally. Runtime output is withheld.`);return res;};
  job.fence();
  let files;
  job.checkpoint('runtime_validation',{resumable:true,pomerium:true});
  const name=r.config.mode==='install'?POMERIUM_APP:r.config.externalContainer;
  const list=await must(['container','ls','-a','--format','{{.Names}}'],'inventory');
  const exists=list.stdout.trim().split('\n').includes(name);
  let actual=null;
  if(exists) {try{actual=JSON.parse((await must(['container','inspect',name,'--format',inspectFormat],'read-only configuration inspection')).stdout);}catch(e){if(e.pomeriumSafe)throw e;throw fail('Cannot read existing Pomerium container configuration.');}}
  if(actual) {
    // v0.33.3 inherits this exact CA bundle path; custom trust overrides remain unsupported.
    if(actual.image!==POMERIUM_IMAGE || actual.network!=='host' || Object.keys(actual.ports||{}).length || JSON.stringify(actual.command)!==JSON.stringify(['--config','/pomerium/config.json']) || JSON.stringify(actual.entrypoint)!==JSON.stringify(['/bin/pomerium']) || (actual.env||[]).some(e=>!e.startsWith('PATH=') && e!=='AUTOCERT_DIR=/data/autocert' && e!=='SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt')) throw fail('Existing Core image, private network configuration, command or environment overrides are unsupported. No resource was taken over.');
    if(r.config.mode==='install' && actual.labels?.['io.proxypilot.pomerium']!==r.credential_ref) throw fail('Pomerium container name is owned by another installation.');
  }
  if(r.config.mode==='connect') {
    if(!actual) throw fail('Existing Core container is not present on this runner host. Remote management is unavailable; configure a local private Core using the handoff.');
    const mount=actual.mounts?.find(m=>m.Destination==='/pomerium' || m.Destination==='/pomerium/config.json');
    if(!mount || mount.Type!=='bind' || mount.RW) throw fail('Existing Core needs a read-only bind for /pomerium/config.json so the runner can verify the configuration handoff.');
    const path=mount.Destination==='/pomerium'?join(mount.Source,'config.json'):mount.Source;
    let external;try{external=JSON.parse(readPrivate(path));}catch(e){if(e.pomeriumSafe)throw e;throw fail('Existing Core configuration is not bounded JSON. Convert it locally using the handoff.');}
    // Capture only existing keys after the client/authentication identity is
    // confirmed; produce a protected handoff for owned route differences.
    if(external.idp_client_secret!==pomeriumSecrets(db,r).client || external.idp_client_id!==r.config.clientId || external.idp_provider_url!==r.config.issuer || external.authenticate_service_url!==r.config.origin) throw fail('Existing Core identity settings do not match the reviewed dedicated client. Configure them locally first; ProxyPilot made no external changes.');
    job.fence();preserveExternalSecrets(db,r,external);
    files=preparePomeriumFiles(db,r,intents,{root});
    job.generated({kind:'pomerium_configuration',name:`revision-${r.revision}`,where:files.candidate});
    assertExternalConfig(external,files.config);
    if(!actual.running || Date.parse(actual.startedAt)<lstatSync(path).mtimeMs) throw fail('Existing Core must be started by its operator after the configuration handoff; no restart is performed by ProxyPilot.');
  } else {
    job.fence();files=preparePomeriumFiles(db,r,intents,{root});
    job.generated({kind:'pomerium_configuration',name:`revision-${r.revision}`,where:files.candidate});
    if(actual && !actual.mounts?.some(m=>m.Type==='bind' && m.Source===root && m.Destination==='/pomerium' && m.RW===false)) throw fail('Owned Core configuration mount drifted; restore it before retrying.');
    const changed=!existsSync(files.active) || readPrivate(files.active)!==files.content;
    // Every selected route is already denied by the Caddy stage. No direct
    // upstream is restored on parser/start/reload failure.
    if(changed) {job.fence();atomicPrivate(files.active,files.content);}
    if(!actual) await must(['create','--name',name,'--label',`io.proxypilot.pomerium=${r.credential_ref}`,'--restart','unless-stopped','--network','host','--user','0:0','--cap-drop','ALL','--security-opt','no-new-privileges','--mount',`type=bind,source=${root},target=/pomerium,readonly`,POMERIUM_IMAGE,'--config','/pomerium/config.json'],'owned service creation');
    // A restart after changed config is intentional, narrowly owned and only
    // occurs through the runner. On retry an already-consumed config is reused.
    const needsRestart=actual?.running && (changed || Date.parse(actual.startedAt)<lstatSync(files.active).mtimeMs);
    if(!actual?.running || needsRestart) await must([needsRestart?'restart':'start',name],'owned service startup');
  }
  for(let i=0;i<attempts;i++) {
    const health=await call(['exec',name,'/bin/pomerium','health','--health-addr','127.0.0.1:18084']);
    if(health.code===0) return {container:name,image:POMERIUM_IMAGE,configRef:files.candidate,credentialsRef:r.credential_ref,root,fingerprint:files.fingerprint,health:true,ownership:r.config.mode==='install'?'managed':'external',upstream:`127.0.0.1:${POMERIUM_PORT}`};
    await sleep(1000);
  }
  throw fail('Pomerium parser/startup/configuration health did not pass. Selected routes remain denied; repair the handoff or runtime and retry.');
}
