import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { allowedAddress } from './keycloak-discovery.js';
import { infisicalError as fail,expectedPolicies,TEST_ENV,TEST_PATH,TEST_KEY,desiredProxiedService,digest } from './infisical-logic.js';

// Fixed origin, pinned DNS, TLS validation, no redirects, bounded bodies/deadline.
// Never attach raw upstream bodies/errors to jobs, audit records or the UI.
// `edge` ({ address, headers }, lib/setup-engine/local-edge.js) pins the
// connection to this host's Caddy for an OWNED instance's self-checks; the URL
// (TLS SNI, certificate name, Host header) stays the reviewed hostname.
export async function infisicalRequest(origin,path,{method='GET',token,body,resolve=lookup,request=https.request,edge=null}={}) {
  const u=new URL(path,origin);
  if(u.origin!==origin||u.protocol!=='https:'||u.username||u.password||u.hash||!u.pathname.startsWith('/api/'))throw fail('Infisical endpoint is outside the reviewed HTTPS origin.');
  let addresses;
  if(edge)addresses=[{address:edge.address,family:4}];
  else{try{addresses=await Promise.race([resolve(u.hostname,{all:true,family:4}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error()),5000);t.unref();})]);}catch{throw fail('Infisical DNS could not be verified.');}
  if(!addresses.length||addresses.some(a=>!allowedAddress(a.address)))throw fail('Infisical DNS points to a blocked special-use address.');}
  const data=body===undefined?null:JSON.stringify(body);
  return new Promise((done,reject)=>{
    let bytes=0;const chunks=[];
    const req=request(u,{method,agent:false,timeout:7000,lookup:(_h,o,cb)=>o.all?cb(null,[addresses[0]]):cb(null,addresses[0].address,4),headers:{...(edge?.headers||{}),'User-Agent':'ProxyPilot-managed-setup',Accept:'application/json',...(token?{Authorization:`Bearer ${token}`} :{}),...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})}},res=>{
      res.on('data',b=>{bytes+=b.length;if(bytes>1024*1024)req.destroy();else chunks.push(b);});
      res.on('error',()=>reject(fail('Infisical response failed; details withheld.')));
      res.on('end',()=>{let value=null;try{value=JSON.parse(Buffer.concat(chunks));}catch{}
        // Bodies for denial/error never leave the transport layer.
        done({status:res.statusCode,body:res.statusCode>=200&&res.statusCode<300?value:null});});
    });
    const timer=setTimeout(()=>req.destroy(),10000);timer.unref();req.on('close',()=>clearTimeout(timer));req.on('timeout',()=>req.destroy());
    req.on('error',()=>reject(fail('Infisical HTTPS failed (DNS, TLS, timeout or reachability); details withheld.')));req.end(data);
  });
}
export function createInfisicalClient(origin,{send=infisicalRequest,job,edge=null}={}) {
  return async(path,options={})=>{job?.fence();const out=await send(origin,path,edge?{...options,edge}:options);job?.fence();return out;};
}
export function requireOk(result,label){if(result.status!==200||!result.body)throw fail(`${label} unavailable (HTTP ${result.status}). Complete the documented handoff; no capability is assumed.`);return result.body;}
export const scopeQuery=projectId=>new URLSearchParams({projectId,environment:TEST_ENV,secretPath:TEST_PATH}).toString();
export const secretPath=(projectId,key=TEST_KEY)=>`/api/v4/secrets/${key}?${scopeQuery(projectId)}&viewSecretValue=true&expandSecretReferences=false&includeImports=false`;

function unpackRules(sources) {
  if(!Array.isArray(sources)||sources.length>30)throw fail('Effective machine permissions could not be audited.');
  const out=[];
  for(const source of sources)for(const rule of source.permissions||[]) {
    // Upstream v0.165.15 uses CASL packRules: action,subject,conditions,inverted,fields.
    if(!Array.isArray(rule)||rule.length>6||rule[3]||rule[4])throw fail('Unsupported effective permission rule. Use exactly the reviewed policies.');
    const actions=String(rule[0]).split(','),subjects=String(rule[1]).split(',');
    for(const subject of subjects)for(const action of actions)out.push({subject,action,conditions:rule[2]||{}});
  }
  return out;
}
function canonical(v){if(Array.isArray(v))return v.map(canonical).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
export function verifyPolicies(sources,wanted) {
  const actual=unpackRules(sources),expected=wanted.flatMap(r=>r.action.map(action=>({...r,action})));
  const normal=rules=>[...new Set(rules.map(r=>JSON.stringify(canonical(r))))].sort();
  if(digest(normal(actual))!==digest(normal(expected)))throw fail('Machine identity permissions differ from the exact reviewed scope. Remove broader roles, memberships, folder grants or privileges before retrying.');
  return true;
}
export async function verifyInfisicalIdentities(r,values,api) {
  const i=r.identities;if(!i)throw fail('Complete the organization/project/environment and machine-identity handoff, save the protected credentials, then retry.');
  const kinds=['workload',...(r.config.agentMode==='skip'?[]:['proxy','agent'])],tokens={};
  for(const k of kinds){const login=requireOk(await api('/api/v1/auth/universal-auth/login',{method:'POST',body:{clientId:i[k].clientId,clientSecret:values[k]}}),`${k} Universal Auth`);
    if(typeof login.accessToken!=='string'||!Number.isInteger(login.expiresIn)||login.expiresIn>300||login.expiresIn<30)throw fail('Universal Auth must issue short-lived tokens (30–300 seconds).');
    let claims;try{claims=JSON.parse(Buffer.from(login.accessToken.split('.')[1],'base64url'));}catch{throw fail('Unexpected machine-token format for the pinned release.');}
    // The token came directly from authenticated TLS Universal Auth, not a caller JWT.
    if(claims.identityId!==i[k].identityId)throw fail('A client credential belongs to a different machine identity.');tokens[k]=login.accessToken;
    const details=requireOk(await api('/api/v1/identities/details',{token:tokens[k]}),`${k} organization`).identityDetails;
    if(details?.organization?.id!==i.organizationId)throw fail('Machine identities must belong to the reviewed organization.');
    const projects=requireOk(await api('/api/v1/projects',{token:tokens[k]}),`${k} project membership`).projects;
    if(!Array.isArray(projects)||projects.length!==1||projects[0].id!==i.projectId)throw fail('Use dedicated identities belonging only to the reviewed test project.');
  }
  const project=requireOk(await api(`/api/v1/projects/${i.projectId}`,{token:tokens.workload}),'Test project').project;
  if(project?.id!==i.projectId||project.orgId!==i.organizationId||!project.environments?.some(e=>e.slug===TEST_ENV))throw fail('The reviewed project/environment handoff is incomplete or belongs to another organization.');
  const policies=expectedPolicies(i,r.config.agentMode);
  for(const k of kinds){const audit=requireOk(await api(`/api/v1/projects/${i.projectId}/memberships/identities/${i[k].identityId}/permissions/audit?includeFolderPermissions=true`,{token:tokens.workload}),`${k} effective permission audit`);verifyPolicies(audit.sources,policies[k]);}
  return tokens;
}
export async function ensureTestSecret(r,value,api,token,key=TEST_KEY) {
  const path=secretPath(r.identities.projectId,key),marker=`ProxyPilot G5 ${r.credential_ref}`;
  let response=await api(path,{token});
  if(response.status===404){await api(`/api/v4/secrets/${key}`,{method:'POST',token,body:{projectId:r.identities.projectId,environment:TEST_ENV,secretPath:TEST_PATH,secretValue:value,secretComment:marker,type:'shared'}});response=await api(path,{token});}
  const s=requireOk(response,'Disposable test secret').secret;
  if(s?.secretValueHidden||s?.secretValue!==value||s?.secretComment!==marker)throw fail('The test secret is absent, hidden, approval-pending or owned by another value. Nothing was overwritten.');
  return s.secretValue;
}
export async function verifyServiceHandoff(r,api,token) {
  const wanted=desiredProxiedService(r.config,r.identities.projectId);
  const list=requireOk(await api(`/api/v1/proxied-services?${scopeQuery(r.identities.projectId)}`,{token}),'Agent Proxy proxied-service capability');
  if(!Array.isArray(list.services)||list.services.length!==1)throw fail('Create exactly the reviewed proxied service in the dedicated test folder; preserve other folders.');
  const s=list.services[0],c=s.credentials;
  if(!s.canProxy||s.name!==wanted.name||s.hostPattern!==wanted.hostPattern||!s.isEnabled||c?.length!==1||Object.entries(wanted.credentials[0]).some(([k,v])=>JSON.stringify(c[0][k])!==JSON.stringify(v))||c[0].dynamicSecretName||c[0].headerName)throw fail('The proxied service differs from the reviewed destination, placeholder or credential scope. Complete the exact handoff and retry.');
  return {serviceRef:s.id};
}
