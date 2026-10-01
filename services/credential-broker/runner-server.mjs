import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { exact, uuid, operation, input, fail, parseJson, safeError } from './schema.mjs';

function origin(value) {
  let u;try{u=new URL(value);}catch{fail('INVALID_CONFIGURATION');}
  if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)fail('INVALID_CONFIGURATION');
  return u.origin;
}
// Fixed service origins only; task bodies never influence destinations or authentication.
function client({origin:base,ca,cert,key,timeoutMs=10000}) {
  const target=origin(base);
  if(!ca||!cert||!key||!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)fail('INVALID_CONFIGURATION');
  return (method,path,body,bearer,idempotencyKey)=>new Promise((resolve,reject)=>{
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    if(bytes?.length>65536)return reject(new Error('REQUEST_TOO_LARGE'));
    const req=https.request(target+path,{method,ca,cert,key,rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:8192,headers:{Accept:'application/json',...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...(bearer?{Authorization:`Bearer ${bearer}`}:{ }),...(idempotencyKey?{'Idempotency-Key':uuid(idempotencyKey)}:{})}},res=>{
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>65536)res.destroy(new Error('RESPONSE_TOO_LARGE'));else chunks.push(chunk);});
      res.on('error',()=>reject(new Error('REMOTE_UNAVAILABLE')));
      res.on('end',()=>{clearTimeout(timer);try{if(res.statusCode!==200||!/^application\/json(?:;|$)/i.test(String(res.headers['content-type']))||res.headers['content-encoding'])fail('REMOTE_UNAVAILABLE',503);resolve(parseJson(Buffer.concat(chunks)));}catch{reject(new Error('REMOTE_UNAVAILABLE'));}});
    });
    const timer=setTimeout(()=>req.destroy(new Error('REMOTE_TIMEOUT')),timeoutMs);timer.unref();
    req.on('error',()=>{clearTimeout(timer);reject(new Error('REMOTE_UNAVAILABLE'));});
    req.end(bytes);
  });
}
function taskDto(t) {
  exact(t,['id','user_id','project_id','agent_id','configuration_revision','attempt','fence','state','code','session_id','step_index','pending_approval','receipts','end_confirmed']);
  for(const k of ['id','user_id','project_id','agent_id','attempt','fence'])uuid(t[k]);
  if(t.session_id!==null)uuid(t.session_id);
  if(!Number.isSafeInteger(t.configuration_revision)||t.configuration_revision<1||!Number.isSafeInteger(t.step_index)||t.step_index<0||t.step_index>20||typeof t.end_confirmed!=='boolean'||!['preparing','running','awaiting_approval','completed','cancelled','blocked','uncertain','interrupted'].includes(t.state)||! [null,'SESSION_EXPIRED','TASK_CANCELLED','SESSION_NOT_ISSUED','OPERATION_UNCERTAIN','OPERATION_FAILED','WORKER_RESTARTED'].includes(t.code))fail('WORKER_INCOMPATIBLE',503);
  if(!Array.isArray(t.receipts)||t.receipts.length>20)fail('WORKER_INCOMPATIBLE',503);
  for(const r of t.receipts){exact(r,['id','state','operation']);uuid(r.id);operation(r.operation);if(!['succeeded','failed','denied','uncertain'].includes(r.state))fail('WORKER_INCOMPATIBLE',503);}
  if(t.pending_approval!==null){exact(t.pending_approval,['session_id','request']);uuid(t.pending_approval.session_id);const r=t.pending_approval.request;exact(r,['connection_id','operation','input']);uuid(r.connection_id);if(r.operation!=='item.set_state')fail('WORKER_INCOMPATIBLE',503);input(r.operation,r.input);}
  return t;
}
function readinessDto(r) {
  exact(r,['ready','task_id','user_id','project_id','agent_id','configuration_revision','attempt','fence','expires_at']);
  for(const k of ['task_id','user_id','project_id','agent_id','attempt','fence'])uuid(r[k]);
  if(r.ready!==true||!Number.isSafeInteger(r.configuration_revision)||r.configuration_revision<1||!Number.isSafeInteger(r.expires_at)||r.expires_at<=Date.now()||r.expires_at>Date.now()+60000)fail('TASK_NOT_READY',403);
  return r;
}
export function createRemoteRunner(config) {
  const send=client(config);
  const task=async(method,path,body)=>{const r=await send(method,path,body);exact(r,['contract_version','task']);if(r.contract_version!=='runner.v1')fail('WORKER_INCOMPATIBLE',503);return taskDto(r.task);};
  return {
    async checkTask(request){const r=await send('POST','/v1/tasks/readiness',request);exact(r,['contract_version','readiness']);if(r.contract_version!=='runner.v1')fail('WORKER_INCOMPATIBLE',503);return readinessDto(r.readiness);},
    startTask:request=>task('POST','/v1/tasks',request),
    status:taskId=>task('GET',`/v1/tasks/${uuid(taskId)}`),
    continueTask:(taskId,request)=>task('POST',`/v1/tasks/${uuid(taskId)}/approval`,request),
    cancelTask:taskId=>task('POST',`/v1/tasks/${uuid(taskId)}/cancel`,{}),
  };
}
export function createWorkloadBrokerClient({agentOrigin,...config}) {
  const agent=client({...config,origin:agentOrigin});
  return {
    async ready(){const r=await agent('GET','/v1/workloads/ready');if(r.contract_version!=='broker.v1'||r.ready!==true)fail('BROKER_INCOMPATIBLE',503);return {contract_version:'broker.v1',ready:true};},
    async checkTask(request){const r=await agent('POST','/v1/workloads/tasks/readiness',request);exact(r,['contract_version','readiness']);if(r.contract_version!=='broker.v1')fail('BROKER_INCOMPATIBLE',503);return readinessDto(r.readiness);},
    async issueSession(request){const r=await agent('POST','/v1/workloads/session',request);if(r.contract_version!=='broker.v1')fail('BROKER_INCOMPATIBLE',503);return r;},
    async endTask({task_id,...body}) {const r=await agent('POST',`/v1/workloads/tasks/${uuid(task_id)}/end`,body);if(r.contract_version!=='broker.v1'||r.ended!==true)fail('BROKER_INCOMPATIBLE',503);return {contract_version:'broker.v1',ended:true};},
    async execute(bearer,connection_id,operation,input,idempotencyKey,approval_id) {
      // Agent protocol carries its stable key in a header; use the dedicated helper below.
      const r=await agent('POST','/v1/operations',{connection_id,operation,input,...(approval_id?{approval_id}:{})},bearer,idempotencyKey);
      if(r.contract_version!=='broker.v1')fail('BROKER_INCOMPATIBLE',503);return r.operation;
    },
  };
}
export function createRunnerServer({runner,tls,dashboardFingerprints}) {
  if(!Array.isArray(dashboardFingerprints)||!dashboardFingerprints.length||dashboardFingerprints.some(x=>typeof x!=='string'||!/^[A-Fa-f0-9]{64}$/.test(x)))fail('INVALID_CONFIGURATION');
  const fingerprints=dashboardFingerprints.map(x=>Buffer.from(x.toLowerCase(),'hex'));
  const server = https.createServer({...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2',maxHeaderSize:8192,headersTimeout:5000,requestTimeout:12000},async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    try{
      const names=req.rawHeaders.filter((_,i)=>i%2===0).map(x=>x.toLowerCase());
      if(new Set(names).size!==names.length)fail('INVALID_REQUEST');
      const raw=req.socket.getPeerCertificate()?.fingerprint256?.replaceAll(':','');
      if(!req.socket.authorized||!raw||!fingerprints.some(x=>timingSafeEqual(x,Buffer.from(raw,'hex'))))fail('NOT_PERMITTED',403);
      const match=/^\/v1\/tasks\/([0-9a-f-]{36})(?:\/(approval|cancel))?$/.exec(req.url);
      const chunks=[];let size=0;
      const deadline=setTimeout(()=>req.destroy(),10000);deadline.unref();
      try{for await(const chunk of req){size+=chunk.length;if(size>65536)fail('INVALID_REQUEST');chunks.push(chunk);}}finally{clearTimeout(deadline);}
      let task;
      if(req.method==='GET'&&match&&!match[2]&&!size)task=runner.status(match[1]);
      else if(req.method==='POST'){
        if(req.headers['content-type']!=='application/json'||req.headers['content-encoding'])fail('INVALID_REQUEST');
        const body=parseJson(Buffer.concat(chunks));
        if(req.url==='/v1/tasks/readiness'){const readiness=await runner.checkTask(body);res.end(JSON.stringify({contract_version:'runner.v1',readiness}));return;}
        if(req.url==='/v1/tasks')task=await runner.startTask(body);
        else if(match?.[2]==='approval')task=await runner.continueTask(match[1],body);
        else if(match?.[2]==='cancel'){exact(body,[]);task=await runner.cancelTask(match[1]);}
        else fail('NOT_FOUND',404);
      }else fail('NOT_FOUND',404);
      res.end(JSON.stringify({contract_version:'runner.v1',task}));
    }catch(e){res.statusCode=e.status||503;res.end(JSON.stringify(safeError(e)));}
  });
  server.maxConnections=64;server.maxRequestsPerSocket=32;return server;
}
