import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { allowedAddress } from './keycloak-discovery.js';
import { fail,OPENBAO_PORT } from './openbao-logic.js';
import http from 'node:http';

// Fixed origin, pinned DNS, TLS validation, no redirects, bounded bodies/deadline.
// Never attach raw upstream bodies/errors to jobs, audit records or the UI.
export async function openbaoRequest(origin,path,{method='GET',token,body,resolve=lookup,request=https.request,local=false}={}) {
  const u=new URL(path,origin);
  if(u.origin!==origin||(local?u.origin!==`http://127.0.0.1:${OPENBAO_PORT}`:u.protocol!=='https:')||u.username||u.password||u.hash||!u.pathname.startsWith('/v1/'))throw fail('OpenBao endpoint is outside the reviewed HTTPS origin.');
  let addresses;
  try{addresses=local?[{address:'127.0.0.1',family:4}]:await Promise.race([resolve(u.hostname,{all:true,family:4}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error()),5000);t.unref();})]);}catch{throw fail('OpenBao DNS could not be verified.');}
  if(!addresses.length||(!local&&addresses.some(a=>!allowedAddress(a.address))))throw fail('OpenBao DNS points to a blocked special-use address.');
  const data=body===undefined?null:JSON.stringify(body);
  return new Promise((done,reject)=>{
    let bytes=0;const chunks=[];
    const req=(local&&request===https.request?http.request:request)(u,{method,agent:false,timeout:7000,lookup:(_h,o,cb)=>o.all?cb(null,[addresses[0]]):cb(null,addresses[0].address,4),headers:{Accept:'application/json',...(token?{'X-Vault-Token':token} :{}),...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})}},res=>{
      res.on('data',b=>{bytes+=b.length;if(bytes>1024*1024)req.destroy();else chunks.push(b);});
      res.on('error',()=>reject(fail('OpenBao response failed; details withheld.')));
      res.on('end',()=>{let value=null;try{value=JSON.parse(Buffer.concat(chunks));}catch{}
        // Bodies for denial/error never leave the transport layer.
        done({status:res.statusCode,body:res.statusCode>=200&&res.statusCode<300?value:null});});
    });
    const timer=setTimeout(()=>req.destroy(),10000);timer.unref();req.on('close',()=>clearTimeout(timer));req.on('timeout',()=>req.destroy());
    req.on('error',()=>reject(fail('OpenBao HTTPS failed (DNS, TLS, timeout or reachability); details withheld.')));req.end(data);
  });
}
export function createClient(origin,{send=openbaoRequest,job,local=false}={}) {
  return async(path,options={})=>{job?.fence();const out=await send(origin,path,{...options,local});job?.fence();return out;};
}
export function ok(r,label='OpenBao request'){if(![200,204].includes(r.status))throw fail(`${label} was not accepted (HTTP ${r.status}); upstream details withheld.`);return r.body;}
export async function status(api){try{const s=await api('/v1/sys/seal-status');if(s.status!==200||typeof s.body?.initialized!=='boolean'||typeof s.body?.sealed!=='boolean')return {state:'unavailable'};const v=s.body;return {state:!v.initialized?'uninitialized':v.sealed?'sealed':'unsealed',seal:v.type,shares:v.n,threshold:v.t,progress:v.progress,version:v.version,clusterId:v.cluster_id||null};}catch(e){if(['FENCED','CANCELLED'].includes(e.code))throw e;return {state:'unavailable'};}}
export async function requireReady(api,r){const s=await status(api);if(s.state!=='unsealed')throw fail(s.state==='sealed'?'OpenBao is sealed. Submit the required shares manually after restart, then retry.':s.state==='uninitialized'?'OpenBao is uninitialized. External instances must be initialized by their owner.':'OpenBao is unavailable. Restore connectivity and retry; no service is verified.');
  if(s.version!=='2.6.2')throw fail('This adapter was reviewed for OpenBao 2.6.2. The connected version is not verified.');
  if(r.resources?.clusterId&&s.clusterId!==r.resources.clusterId)throw fail('OpenBao cluster identity changed. Restore the recorded data; it will not be adopted.');
  const h=await api('/v1/sys/health');if(h.status!==200||h.body?.sealed!==false||h.body?.initialized!==true||h.body?.standby===true)throw fail('OpenBao is not an active unsealed service. Verification is withheld.');return s;}
