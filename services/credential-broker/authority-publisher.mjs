/** Independent publisher API. Private key remains in the independently administered publisher. */
import { sign, createPrivateKey } from 'node:crypto';
import https from 'node:https';
import { canonical, digest, exact, fail, parseJson } from './schema.mjs';
export function signAuthoritySnapshot(privateKey,payload){
 exact(payload,['version','source_id','sequence','challenge','issued_at','expires_at','records']);
 const key=createPrivateKey(privateKey);if(key.asymmetricKeyType!=='ed25519')fail('INVALID_PUBLISHER_KEY');
 return {...payload,signature:sign(null,Buffer.from(canonical(payload)),key).toString('base64url')};
}
/** No redirects/proxy/env CA inheritance; exact preconfigured TLS origin + mTLS. */
export function createAuthorityPublisher({origin,ca,cert,key,source_id,private_key,clock=()=>Date.now()}){
 const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!ca||!cert||!key)fail('INVALID_PUBLISHER_CONFIG');
 async function request(path,body){return new Promise((resolve,reject)=>{
  const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));if(bytes&&bytes.length>1024*1024){reject(new Error('PUBLISH_FAILED'));return;}
  const req=https.request(new URL(path,url),{method:body?'POST':'GET',ca,cert,key,rejectUnauthorized:true,agent:false,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},res=>{
   let count=0;const chunks=[];res.on('data',chunk=>{count+=chunk.length;if(count>65536)res.destroy(new Error('PUBLISH_FAILED'));else chunks.push(chunk);});res.on('error',()=>reject(new Error('PUBLISH_FAILED')));res.on('end',()=>{if(res.statusCode!==200&&res.statusCode!==201){reject(new Error('PUBLISH_FAILED'));return;}try{resolve(parseJson(Buffer.concat(chunks)));}catch{reject(new Error('PUBLISH_FAILED'));}});
  });req.setTimeout(10000,()=>req.destroy(new Error('PUBLISH_FAILED')));req.on('error',()=>reject(new Error('PUBLISH_FAILED')));req.end(bytes);
 });}
 return Object.freeze({async publish({sequence,records,lease_ms=60000}){
  if(!Number.isSafeInteger(lease_ms)||lease_ms<1||lease_ms>60000)fail('INVALID_PUBLISHER_CONFIG');
  const response=await request('/v1/authority/challenge');const challenge=typeof response==='string'?response:response.challenge;
  const issued_at=clock();const snapshot=signAuthoritySnapshot(private_key,{version:'authority.v1',source_id,sequence,challenge,issued_at,expires_at:issued_at+lease_ms,records});
  const ack=await request('/v1/authority/snapshot',snapshot);const {signature,...payload}=snapshot;if(ack.source_id!==source_id||ack.sequence!==sequence||ack.digest!==digest(payload))fail('PUBLISH_FAILED');return ack;
 }});
}
