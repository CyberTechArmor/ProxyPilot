import http from 'node:http';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,dirname,resolve} from 'node:path';
import {z} from 'zod';
const uuid=z.string().uuid(),entry={id:uuid,name:z.string().min(1).max(200),status:z.enum(['ready','unavailable']),revision:z.number().int().positive()};
const registrations=z.object({environments:z.array(z.object({...entry,workload_id:uuid,workflow_type:z.literal('typed_api_v1')})).max(100),outputs:z.array(z.object({...entry,kind:z.literal('project_activity')})).max(100)});
const unavailable=()=>Object.assign(new Error('Authority source unavailable'),{code:'AUTHORITY_SOURCE_UNAVAILABLE',status:503});
export function createAuthoritySourceClient({socketPath,timeoutMs=5000}) {
 if(!isAbsolute(socketPath)||socketPath.includes('\0'))throw unavailable();
 function call(method,path,body){
  try{const parent=dirname(socketPath),dir=lstatSync(parent);if(!dir.isDirectory()||realpathSync(parent)!==resolve(parent)||(dir.mode&0o022)!==0)throw unavailable();const st=lstatSync(socketPath);if(!st.isSocket()||(st.mode&0o077)!==0||![0,process.getuid?.()].includes(st.uid))throw unavailable();}catch{throw unavailable();}
  return new Promise((resolve,reject)=>{
   const data=body===undefined?null:JSON.stringify(body);if(data&&Buffer.byteLength(data)>16384)return reject(unavailable());
   const req=http.request({socketPath,path,method,headers:{accept:'application/json',...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{})}},res=>{
    let size=0,chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>65536)req.destroy(unavailable());else chunks.push(chunk);});
    res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)throw unavailable();resolve(value);}catch{reject(unavailable());}});res.on('error',()=>reject(unavailable()));
   });req.setTimeout(timeoutMs,()=>req.destroy(unavailable()));req.on('error',()=>reject(unavailable()));req.end(data);
  });
 }
 return {previewTask:r=>call('POST','/v1/task/preview',r),authorizeTask:r=>call('POST','/v1/task/authorize',r),
  async registrations({user_id,project_id}){uuid.parse(user_id);uuid.parse(project_id);return registrations.parse(await call('GET',`/v1/registrations?${new URLSearchParams({user_id,project_id})}`));}};
}
export function configuredAuthoritySource(env=process.env){return env.BROKER_AUTHORITY_SOURCE_SOCKET?createAuthoritySourceClient({socketPath:env.BROKER_AUTHORITY_SOURCE_SOCKET}):null;}
