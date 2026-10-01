import https from 'node:https';
// Dashboard-only transport. Keep this inside the packaged backend: importing
// the standalone worker/server would fail in /app/backend and widen its surface.
const refuse=()=>Object.assign(new Error('Worker unavailable'),{code:'BROKER_UNAVAILABLE'});
const uuid=value=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw refuse();return value;};
export function createRemoteRunner({origin,ca,cert,key,timeoutMs=10000}) {
 const u=new URL(origin);if(u.origin!==origin||u.protocol!=='https:'||!ca||!cert||!key||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>10000)throw refuse();
 const send=(method,path,body)=>new Promise((resolve,reject)=>{
  const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));if(bytes?.length>65536)return reject(refuse());
  const req=https.request(origin+path,{method,ca,cert,key,rejectUnauthorized:true,minVersion:'TLSv1.2',agent:false,headers:{Accept:'application/json',...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},res=>{
   if(res.statusCode!==200||res.headers['content-encoding']||!/^application\/json(?:;|$)/i.test(res.headers['content-type']??'')){res.resume();return reject(refuse());}
   let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>65536){res.destroy();reject(refuse());}else chunks.push(chunk);});res.on('error',()=>reject(refuse()));
   res.on('end',()=>{try{const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(v.contract_version!=='runner.v1'||Object.keys(v).some(k=>!['contract_version','task','readiness'].includes(k)))throw Error();resolve(v);}catch{reject(refuse());}});
  });
  const timer=setTimeout(()=>req.destroy(),timeoutMs);req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(refuse()));req.end(bytes);
 });
 const task=async(method,path,body)=>{const r=await send(method,path,body);if(!r.task||r.readiness)throw refuse();return r.task;};
 return {startTask:r=>task('POST','/v1/tasks',r),status:id=>task('GET',`/v1/tasks/${uuid(id)}`),continueTask:(id,r)=>task('POST',`/v1/tasks/${uuid(id)}/approval`,r),cancelTask:id=>task('POST',`/v1/tasks/${uuid(id)}/cancel`,{}),
  async checkTask(request){const r=await send('POST','/v1/tasks/readiness',request);if(!r.readiness||r.task)throw refuse();return r.readiness;}};
}
