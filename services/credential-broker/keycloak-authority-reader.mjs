import https from 'node:https';
import {exact,uuid,parseJson,fail} from './schema.mjs';

/** Fixed Keycloak issuer; service account must have only reviewed user-read authority.
 * All response/token material stays in memory. This reader never changes Keycloak. */
export function createKeycloakAuthorityReader({issuer,client_id,client_secret,ca}){
 const url=new URL(issuer),match=/^(.*)\/realms\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!match||typeof client_id!=='string'||!client_id||typeof client_secret!=='string'||!client_secret)fail('INVALID_KEYCLOAK_SOURCE');
 const tokenPath=url.pathname+'/protocol/openid-connect/token',usersPath=match[1]+'/admin/realms/'+match[2]+'/users/';
 const send=(method,path,{form,token,deadline=Date.now()+5000}={})=>new Promise((resolve,reject)=>{
  if(deadline<=Date.now()){reject(Error('KEYCLOAK_SOURCE_UNAVAILABLE'));return;}
  const body=form?Buffer.from(new URLSearchParams(form).toString()):undefined;
  const req=https.request(new URL(path,url.origin),{method,ca,rejectUnauthorized:true,minVersion:'TLSv1.2',agent:false,headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/x-www-form-urlencoded','Content-Length':body.length}:{})}},res=>{
   const chunks=[];let n=0;res.on('data',b=>{n+=b.length;if(n>65536)res.destroy(Error('KEYCLOAK_SOURCE_UNAVAILABLE'));else chunks.push(b);});res.on('error',()=>{clearTimeout(timer);reject(Error('KEYCLOAK_SOURCE_UNAVAILABLE'));});res.on('end',()=>{clearTimeout(timer);if(res.statusCode===404){resolve(null);return;}try{if(res.statusCode!==200||!/^application\/json(?:;|$)/i.test(String(res.headers['content-type']))||res.headers['content-encoding'])throw Error();resolve(parseJson(Buffer.concat(chunks)));}catch{reject(Error('KEYCLOAK_SOURCE_UNAVAILABLE'));}});
  });const timer=setTimeout(()=>req.destroy(Error('KEYCLOAK_SOURCE_UNAVAILABLE')),Math.max(1,deadline-Date.now()));timer.unref();req.setTimeout(5000,()=>req.destroy(Error('KEYCLOAK_SOURCE_UNAVAILABLE')));req.on('error',()=>{clearTimeout(timer);reject(Error('KEYCLOAK_SOURCE_UNAVAILABLE'));});req.end(body);
 });
 return async mappings=>{
  if(!Array.isArray(mappings)||mappings.length>100)fail('INVALID_KEYCLOAK_SOURCE');
  for(const m of mappings){exact(m,['user_id','issuer','subject']);uuid(m.user_id);uuid(m.subject);if(m.issuer!==issuer)fail('INVALID_KEYCLOAK_SOURCE');}
  const deadline=Date.now()+5000;const response=await send('POST',tokenPath,{deadline,form:{grant_type:'client_credentials',client_id,client_secret}});if(!response||typeof response.access_token!=='string'||!response.access_token||response.access_token.length>8192||response.token_type?.toLowerCase()!=='bearer')fail('KEYCLOAK_SOURCE_UNAVAILABLE',503);
  const results=new Map();let next=0;const workers=await Promise.allSettled(Array.from({length:Math.min(4,mappings.length)},async()=>{while(next<mappings.length){const m=mappings[next++],user=await send('GET',usersPath+m.subject,{token:response.access_token,deadline});if(user===null){results.set(m.user_id,false);continue;}if(user.id!==m.subject||typeof user.enabled!=='boolean')fail('KEYCLOAK_SOURCE_UNAVAILABLE',503);results.set(m.user_id,user.enabled);}}));if(workers.some(w=>w.status==='rejected'))fail('KEYCLOAK_SOURCE_UNAVAILABLE',503);return results;
 };
}
