import https from 'node:https';
import {readFileSync,lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
const failure=code=>Object.assign(new Error(code),{code});
const origin=z.string().url().refine(v=>{const u=new URL(v);return u.protocol==='https:'&&u.origin===v&&!u.username&&!u.password;});
const path=z.string().refine(isAbsolute);
const configSchema=z.object({version:z.literal(1),management_origin:origin,human_origin:origin,ca_file:path,cert_file:path,key_file:path,timeout_ms:z.number().int().min(100).max(10000).default(5000)}).strict();
export const configuredCapabilitiesSchema=z.object({contract_version:z.literal('broker.v1'),mode:z.literal('configured'),build:z.literal('credential-broker-configured.v1'),compatible:z.literal(true),intake_origin:origin,intake_enabled:z.boolean(),execution_enabled:z.boolean(),ready:z.boolean(),execution_ready:z.boolean(),reason:z.enum(['READY','AUTHORITY_UNAVAILABLE','BROKER_UNAVAILABLE','VAULT_UNAVAILABLE','WORKER_UNAVAILABLE']),adapters:z.array(z.object({id:z.literal('synthetic-ledger-v1'),type:z.literal('static_api_token'),supported:z.boolean()}).strict()).max(1)}).strict();
function file(filename,{privateFile=false}={}) {
 const st=lstatSync(filename);if(!st.isFile()||st.isSymbolicLink()||st.size>65536||(st.mode&0o022)||(privateFile&&(st.mode&0o077)))throw failure('BROKER_CONFIG_INVALID');
 if(typeof process.getuid==='function'&&st.uid!==0&&st.uid!==process.getuid())throw failure('BROKER_CONFIG_INVALID');
 return readFileSync(filename);
}
const disabled=reason=>({contract_version:'broker.v1',mode:'disabled',intake_enabled:false,execution_enabled:false,intake_origin:null,reason,adapters:[]});
// Only file paths are read from environment. The client certificate authenticates
// dashboard transport, NEVER a human. Every RPC also needs independent delegation.
export function createRemoteBrokerBridge(input) {
 const config=configSchema.parse(input);
 const tls={ca:file(config.ca_file),cert:file(config.cert_file),key:file(config.key_file,{privateFile:true}),rejectUnauthorized:true,minVersion:'TLSv1.2'};
 const request=(method,path,body,delegation)=>new Promise((resolve,reject)=>{
  const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
  const req=https.request(config.management_origin+path,{...tls,method,agent:false,headers:{Accept:'application/json',...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...(delegation?{Authorization:`Bearer ${delegation}`}:{})}},res=>{
   let size=0;const chunks=[];
   if(res.statusCode>=300&&res.statusCode<400){res.resume();req.destroy();return reject(failure('BROKER_UNAVAILABLE'));}
   if(res.headers['content-encoding']||!/^application\/json(?:;|$)/i.test(res.headers['content-type']??'')){res.resume();return reject(failure('BROKER_UNAVAILABLE'));}
   res.on('data',chunk=>{size+=chunk.length;if(size>262144){req.destroy();reject(failure('BROKER_UNAVAILABLE'));}else chunks.push(chunk);});
   res.on('error',()=>reject(failure('BROKER_UNAVAILABLE')));
   res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode<200||res.statusCode>=300){const code=value?.error?.code;throw failure(['AUTH_REQUIRED','FRESH_PROOF_REQUIRED','NOT_FOUND','NOT_PERMITTED','SCOPE_EXCEEDED','REVISION_MISMATCH','REVISION_REQUIRED','INVALID_REQUEST'].includes(code)?code:'BROKER_UNAVAILABLE');}resolve(value);}catch(e){reject(e?.code?e:failure('BROKER_UNAVAILABLE'));}});
  });
  const timer=setTimeout(()=>req.destroy(failure('BROKER_UNAVAILABLE')),config.timeout_ms);req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(failure('BROKER_UNAVAILABLE')));req.end(bytes);
 });
 let latest=disabled('BROKER_UNAVAILABLE'),checked=0,pending;
 const capabilities=async({force=false}={})=>{
  if(!force&&Date.now()-checked<1000)return latest;
  if(pending)return pending;
  pending=(async()=>{try{const caps=configuredCapabilitiesSchema.parse(await request('GET','/v1/capabilities'));if(caps.intake_origin!==config.human_origin)throw Error();latest={...caps,intake_enabled:caps.ready&&caps.intake_enabled,execution_enabled:caps.ready&&caps.execution_ready&&caps.execution_enabled};}catch{latest=disabled('BROKER_UNAVAILABLE');}checked=Date.now();return latest;})().finally(()=>{pending=null;});return pending;
 };
 return {capabilities,async request({delegation,...rpc}) {
  if(typeof delegation!=='string'||!/^[A-Za-z0-9._~-]{32,4096}$/.test(delegation))throw failure('AUTH_REQUIRED');
  const caps=await capabilities({force:true});if(caps.mode!=='configured'||caps.ready!==true)throw failure('BROKER_UNAVAILABLE');
  const value=await request('POST','/v1/dashboard',rpc,delegation);if(value?.contract_version!=='broker.v1')throw failure('BROKER_UNAVAILABLE');return value;
 }};
}
export function configuredBrokerBridge(env=process.env) {
 if(!env.FRACTIONATE_BROKER_CONFIG_FILE)return null;
 try{return createRemoteBrokerBridge(JSON.parse(file(env.FRACTIONATE_BROKER_CONFIG_FILE,{privateFile:true}).toString('utf8')));}
 catch{return {capabilities:async()=>disabled('BROKER_CONFIG_INVALID'),request:async()=>{throw failure('BROKER_UNAVAILABLE');}};}
}

// Registered worker transport is separate from broker metadata management.
export async function configuredBrokerWorker(env=process.env) {
 if(!env.FRACTIONATE_BROKER_WORKER_CONFIG_FILE)return null;
 try {
  const v=z.object({version:z.literal(1),origin,ca_file:path,cert_file:path,key_file:path,timeout_ms:z.number().int().min(100).max(10000).default(10000)}).strict().parse(JSON.parse(file(env.FRACTIONATE_BROKER_WORKER_CONFIG_FILE,{privateFile:true})));
  const {createRemoteRunner}=await import('./credential-broker-runner-client.js');
  return createRemoteRunner({origin:v.origin,ca:file(v.ca_file),cert:file(v.cert_file),key:file(v.key_file,{privateFile:true}),timeoutMs:v.timeout_ms});
 }catch{return null;}
}

// Operations route project identity is :id. A missing context must never
// become a global catalogue query or expand a project-scoped delegation.
export function configurationConnectionReader(bridge) {
 if(!bridge)return null;
 return (actor,req)=>{
  const project_id=z.string().uuid().parse(req.params?.id);
  return bridge.request({action:'list',actor:{id:actor.id},query:{project_id},delegation:req.get('X-Broker-Delegation')});
 };
}
