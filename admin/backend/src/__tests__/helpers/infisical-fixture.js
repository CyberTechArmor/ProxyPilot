import { makeDb as baseDb,apiFixture } from './pomerium-fixture.js';
import { INFISICAL_SCHEMA,readInfisical } from '../../lib/setup-engine/infisical-store.js';
import { expectedPolicies,desiredProxiedService,TEST_KEY,PROXY_KEY,INFISICAL_IMAGE,INFISICAL_DB_IMAGE,INFISICAL_REDIS_IMAGE,AGENT_PROXY_IMAGE } from '../../lib/setup-engine/infisical-logic.js';
import { readFileSync } from 'node:fs';
export {apiFixture};
export const ids={org:'11111111-1111-4111-8111-111111111111',project:'22222222-2222-4222-8222-222222222222',workload:'33333333-3333-4333-8333-333333333333',proxy:'44444444-4444-4444-8444-444444444444',agent:'55555555-5555-4555-8555-555555555555'};
export const configInput={expectedPlanRevision:1,expectedRevision:0,agentMode:'install',testHost:'10.20.30.40',agentVm:'g5-disposable',allowedIps:['10.20.30.40','192.0.2.40'],reviewed:true};
export const identityInput={expectedRevision:1,organizationId:ids.org,projectId:ids.project,...Object.fromEntries(['workload','proxy','agent'].map(k=>[k,{identityId:ids[k],clientId:ids[k],clientSecret:`g5-disposable-${k}-credential-not-live`}])),reviewed:true};
export function makeDb(path=':memory:',{mode='install',agentMode=mode}={}){const db=baseDb(path);db.exec(INFISICAL_SCHEMA);if(!readInfisical(db)){const row=db.prepare('SELECT choices_json FROM setup_platform_plan').get();const choices=JSON.parse(row.choices_json);choices.infisical={mode,url:'https://secrets.example.com',agentProxyMode:agentMode,agentProxyUrl:agentMode==='skip'?'':'http://10.20.30.40:17322'};db.prepare('UPDATE setup_platform_plan SET choices_json=?').run(JSON.stringify(choices));}return db;}
export const vm={name:'g5-disposable',type:'virtual-machine',status:'Running',config:{'volatile.uuid':'vm-fixed-id'},expanded_devices:{root:{type:'disk',path:'/',pool:'test'},eth0:{type:'nic',network:'incusbr0'}}};
export function dockerFixture(){const objects={container:new Map(),network:new Map(),volume:new Map()},calls=[];let failure=null;
  const images=Object.fromEntries([INFISICAL_IMAGE,INFISICAL_DB_IMAGE,INFISICAL_REDIS_IMAGE,AGENT_PROXY_IMAGE].map(image=>[image,{Id:'sha256:'+image,Config:{Env:['PATH=/bin'],Entrypoint:image===AGENT_PROXY_IMAGE?['/sbin/tini','--','/bin/infisical']:['entrypoint'],Cmd:['default']}}]));
  const host=async argv=>{calls.push(argv);if(argv[0]==='incus')return {code:0,stdout:JSON.stringify([vm])};const a=argv.slice(1),ok=s=>({code:0,stdout:s||'',stderr:''});
    if(failure?.(a)){failure=null;return {code:1,stdout:'',stderr:'DO-NOT-LOG-RAW-RUNTIME-CREDENTIAL'};}
    if(a[0]==='version')return ok('28.0');
    if(a[0]==='image'&&a[1]==='inspect')return ok(JSON.stringify([images[a[2]]]));
    if(objects[a[0]]&&a[1]==='ls')return ok([...objects[a[0]].keys()].join('\n'));
    if(objects[a[0]]&&a[1]==='inspect'){const v=objects[a[0]].get(String(a[2]).replace(/^id-/,''));return v?ok(JSON.stringify([v])):{code:1,stdout:'',stderr:'No such object'};}
    const labels=()=>Object.fromEntries(a.flatMap((x,i)=>x==='--label'?[a[i+1].split('=')]:[]));
    if(['network','volume'].includes(a[0])&&a[1]==='create'){objects[a[0]].set(a.at(-1),{Name:a.at(-1),Labels:labels(),Internal:a.includes('--internal'),Driver:a[0]==='network'?'bridge':'local',Options:{}});return ok(a.at(-1));}
    if(a[0]==='create'){
      const imageIndex=a.findIndex(x=>images[x]),image=a[imageIndex],defaults=images[image];if(imageIndex<0)throw Error('unknown fixture image');
      const mounts=a.flatMap((x,i)=>{if(x!=='--mount')return [];const v=Object.fromEntries(a[i+1].split(',').map(p=>p.split('=')));return [{Type:v.type,Name:v.source,Source:v.source,Destination:v.target,RW:!('readonly'in v)}];});
      const ports={};if(a.includes('--publish')){const [ip,port,internal]=a[a.indexOf('--publish')+1].split(':');ports[internal+'/tcp']=[{HostIp:ip,HostPort:port}];}
      const env=a.includes('--env-file')?readFileSync(a[a.indexOf('--env-file')+1],'utf8').trim().split('\n'):[];
      const network=a[a.indexOf('--network')+1],name=a[a.indexOf('--name')+1];
      const logOpts=Object.fromEntries(a.flatMap((x,i)=>x==='--log-opt'?[a[i+1].split('=')]:[]));objects.container.set(name,{Id:'id-'+name,Name:'/'+name,Image:defaults.Id,Config:{Image:image,Labels:labels(),Env:[...defaults.Config.Env,...env],Entrypoint:defaults.Config.Entrypoint,Cmd:a.slice(imageIndex+1).length?a.slice(imageIndex+1):defaults.Config.Cmd},HostConfig:{NetworkMode:network,RestartPolicy:{Name:'unless-stopped'},PortBindings:ports,LogConfig:{Type:a.includes('--log-driver')?a[a.indexOf('--log-driver')+1]:'json-file',Config:logOpts}},Mounts:mounts,NetworkSettings:{Networks:{[network]:{}}},State:{Running:false}});return ok(name);
    }
    // Containers are started by inspected Id (id-<name>); the name still works.
    if(a[0]==='start'){const c=objects.container.get(String(a[1]).replace(/^id-/,''));c.State.Running=true;c.State.Status='running';return ok(a[1]);}
    if(a[0]==='exec')return ok('ready');
    throw Error('Unexpected fixture command: '+JSON.stringify(a));
  };return {host,objects,calls,images,failOnce(fn){failure=fn;}};
}
export function infisicalApiFixture(db){const secrets=new Map(),writes=[],tokens={};let badAgent=false,available=true,serviceReady=true;const calls=[];
  const tokenFor=k=>`header.${Buffer.from(JSON.stringify({identityId:ids[k]})).toString('base64url')}.fixture-signature`;
  for(const k of ['workload','proxy','agent'])tokens[k]=tokenFor(k);
  const send=async(origin,path,{token,method='GET',body}={})=>{
    calls.push({path,method});if(!available)throw Error('DO-NOT-LOG-UPSTREAM-SECRET');const ok=body=>({status:200,body}),deny=()=>({status:403,body:null});
    if(path==='/api/status')return ok({date:new Date().toISOString(),redisConfigured:true});
    if(path==='/api/v1/admin/config')return ok({config:{initialized:true}});
    if(path==='/api/v1/auth/universal-auth/login'){const k=Object.keys(ids).find(k=>ids[k]===body.clientId);return body.clientSecret===identityInput[k]?.clientSecret?ok({accessToken:tokens[k],expiresIn:300,tokenType:'Bearer'}):deny();}
    const kind=Object.keys(tokens).find(k=>tokens[k]===token);if(!kind)return {status:401,body:null};
    const r=readInfisical(db);
    if(path==='/api/v1/identities/details')return ok({identityDetails:{organization:{id:ids.org,name:'G5 test',slug:'g5'}}});
    if(path==='/api/v1/projects')return ok({projects:[{id:ids.project,orgId:ids.org}]});
    if(path===`/api/v1/projects/${ids.project}`)return ok({project:{id:ids.project,orgId:ids.org,environments:[{slug:'g5'}]}});
    if(path.includes('/permissions/audit')){const k=Object.keys(ids).find(k=>path.includes(ids[k])&&['workload','proxy','agent'].includes(k));const rules=expectedPolicies(r.identities,r.config.agentMode)[k];const packed=rules.map(p=>[p.action.join(','),p.subject,p.conditions]);if(k==='agent'&&badAgent)packed.push(['readValue','secrets',{}]);return ok({sources:[{type:'additional_privilege',permissions:packed}]});}
    if(path.startsWith('/api/v4/secrets/')){const key=path.split('/').at(-1).split('?')[0];if(kind==='agent')return deny();if(method==='POST'){if(secrets.has(key))return {status:400,body:null};secrets.set(key,{secretValue:body.secretValue,secretComment:body.secretComment,secretValueHidden:false});writes.push(key);}return secrets.has(key)?ok({secret:secrets.get(key)}):{status:404,body:null};}
    if(path.startsWith('/api/v1/proxied-services'))return ok({services:serviceReady?[{...desiredProxiedService(r.config,ids.project),id:'service-fixture',canProxy:true}]:[]});
    throw Error('Unexpected API path '+path);
  };return {send,secrets,writes,tokens,calls,set badAgent(v){badAgent=v;},set available(v){available=v;},set serviceReady(v){serviceReady=v;}};
}
