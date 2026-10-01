import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdirSync, lstatSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonical, digest, exact, uuid, limits, operation, input, fail } from './schema.mjs';

const branded=new WeakSet();
export const isConfiguredAuthority=value=>branded.has(value);
export const AUTHORITY_KINDS=Object.freeze(['users','projects','agents','tasks','ceilings','policies']);
const ACTIONS=['intent','list','get','activity','assignments','sessions','enroll','test','update','revoke','rotate','assign','unassign','approve','setPermission','reconcileOperation','revalidatePolicy'];
const DIRECT=['approve','setPermission','reconcileOperation','revalidatePolicy'];
const FIELDS={
 users:['id','revision','disabled'], projects:['id','revision','archived','user_ids'],
 agents:['id','revision','project_id','user_id','disabled','workload_id'],
 tasks:['id','revision','project_id','user_id','agent_id','attempt','fence','status','expires_at','grant_ids','connection_ids','operations','resources','limits','configuration_revision','readiness'],
 ceilings:['id','revision','user_id','project_id','actions','connection_ids','adapter_ids','operations','resources','limits','expires_at','revoked','grant_rights','manage_actions'],
 policies:['id','revision','policy_revision','credential_version','owner_id','project_id','adapter_id','operations','resources','limits','status'],
};
const reject=()=>fail('AUTHORITY_DENIED',403);
const int=(v,min=1)=>{if(!Number.isSafeInteger(v)||v<min)reject();};
const bool=v=>{if(typeof v!=='boolean')reject();};
const str=v=>{if(typeof v!=='string'||!v.length||v.length>128||!/^[-a-zA-Z0-9_.]+$/.test(v))reject();};
const arr=(v,fn,{empty=true,max=1024}={})=>{if(!Array.isArray(v)||v.length>max||(!empty&&!v.length)||new Set(v.map(x=>canonical(x))).size!==v.length)reject();v.forEach(fn);};
const one=(v,allowed)=>{if(!allowed.includes(v))reject();};
const scope=r=>{arr(r.operations,operation,{empty:false,max:32});arr(r.resources,uuid,{empty:false,max:32});limits(r.limits);};
const fits=(a,b)=>Array.isArray(a.operations)&&Array.isArray(a.resources)&&a.operations.every(x=>b.operations.includes(x))&&a.resources.every(x=>b.resources.includes(x))&&a.limits&&a.limits.max_actions<=b.limits.max_actions&&a.limits.max_seconds<=b.limits.max_seconds;
function validateRecord(kind,r){
 exact(r,FIELDS[kind]);uuid(r.id);int(r.revision);
 for(const k of ['user_id','owner_id','agent_id','attempt','fence','workload_id'])if(k in r)uuid(r[k]);
 if('project_id'in r){if(r.project_id===null){if(!['ceilings','policies'].includes(kind))reject();}else uuid(r.project_id);}
 for(const k of ['disabled','archived','revoked'])if(k in r)bool(r[k]);
 for(const k of ['user_ids','grant_ids','connection_ids'])if(k in r)arr(r[k],uuid);
 if('expires_at'in r)int(r.expires_at);
 if('operations'in r)scope(r);
 if(kind==='tasks'){one(r.status,['running','ended','cancelled']);int(r.configuration_revision);exact(r.readiness,['guide_revision','checks_revision','environment_revision','execution_approved']);for(const k of ['guide_revision','checks_revision','environment_revision'])int(r.readiness[k]);bool(r.readiness.execution_approved);}
 if(kind==='ceilings'){
  arr(r.actions,x=>one(x,ACTIONS),{empty:false,max:32});arr(r.adapter_ids,str,{empty:false,max:32});
  arr(r.grant_rights,x=>one(x,['view','use','assign','manage']),{max:4});arr(r.manage_actions,x=>one(x,['test','rename','rotate','revoke']),{max:4});
 }
 if(kind==='policies'){int(r.policy_revision);int(r.credential_version,0);str(r.adapter_id);one(r.status,['saved','active','revoked']);}
}

export function createAuthority({statePath,identity,sources,clock=()=>Date.now()}){
 if(!identity||typeof identity.authenticate!=='function'||!Array.isArray(sources)||!sources.length)fail('AUTHORITY_CONFIGURATION_REQUIRED',503);
 const configured=new Map(),owners=new Map();
 for(const source of sources){exact(source,['id','public_key','kinds']);str(source.id);if(source.id.length>64)reject();if(configured.has(source.id))reject();arr(source.kinds,k=>one(k,AUTHORITY_KINDS),{empty:false,max:6});
  let key;try{key=createPublicKey(source.public_key);}catch{reject();}if(key.asymmetricKeyType!=='ed25519')reject();
  for(const kind of source.kinds){if(owners.has(kind))reject();owners.set(kind,source.id);}configured.set(source.id,{...source,key});
 }
 if(owners.size!==6||typeof statePath!=='string'||!statePath)fail('AUTHORITY_CONFIGURATION_REQUIRED',503);
 statePath=resolve(statePath);const directory=dirname(statePath);mkdirSync(directory,{recursive:true,mode:0o700});
 const parent=lstatSync(directory);if(parent.isSymbolicLink()||(parent.mode&0o077)||parent.uid!==process.getuid())fail('UNSAFE_STORE');
 const lock=statePath+'.lock';let lockFd;try{lockFd=openSync(lock,'wx',0o600);writeFileSync(lockFd,JSON.stringify({pid:process.pid}));}catch{fail('STORE_LOCKED',503);}
 let durable={version:'authority-state.v1',sources:{},ended_tasks:{},issued_tasks:{}},closed=false;
 const release=()=>{if(!closed){closed=true;closeSync(lockFd);unlinkSync(lock);}};
 try{let stat;try{stat=lstatSync(statePath);}catch(e){if(e.code!=='ENOENT')throw e;}if(stat){if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)||stat.uid!==process.getuid())fail('UNSAFE_STORE');const text=readFileSync(statePath,'utf8');if(text.length>8*1024*1024)reject();durable=JSON.parse(text);exact(durable,['version','sources','ended_tasks','issued_tasks']);if(!durable.issued_tasks||typeof durable.issued_tasks!=='object'||Array.isArray(durable.issued_tasks))reject();for(const [k,v]of Object.entries(durable.issued_tasks)){const ids=k.split('/');if(ids.length!==3)reject();ids.forEach(uuid);exact(v,['workload_id','reserved_at','authority_digest']);uuid(v.workload_id);int(v.reserved_at);if(!/^[a-f0-9]{64}$/.test(v.authority_digest))reject();}if(!durable.ended_tasks||typeof durable.ended_tasks!=='object'||Array.isArray(durable.ended_tasks))reject();for(const [k,v] of Object.entries(durable.ended_tasks)){const ids=k.split('/');if(ids.length!==3)reject();ids.forEach(uuid);if(v!==true)reject();}if(durable.version!=='authority-state.v1'||!durable.sources||typeof durable.sources!=='object'||Array.isArray(durable.sources))reject();for(const [name,s]of Object.entries(durable.sources)){if(!configured.has(name))reject();exact(s,['sequence','floors']);int(s.sequence);if(!s.floors||typeof s.floors!=='object'||Array.isArray(s.floors))reject();for(const [key,f]of Object.entries(s.floors)){const [kind,id]=key.split('/');if(!configured.get(name).kinds.includes(kind))reject();uuid(id);exact(f,['revision','digest','present']);int(f.revision);if(!/^[a-f0-9]{64}$/.test(f.digest))reject();bool(f.present);}}}}
 catch(e){release();throw e;}
 const boot=randomBytes(32).toString('base64url'),active=new Map(),proofs=new WeakMap();
 const persist=next=>{if(Buffer.byteLength(JSON.stringify(next))>8*1024*1024){active.clear();fail('AUTHORITY_STATE_LIMIT',503);}const temp=statePath+'.'+randomBytes(12).toString('hex')+'.tmp';let fd;try{fd=openSync(temp,'wx',0o600);writeFileSync(fd,JSON.stringify(next));fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,statePath);const dirFd=openSync(directory,'r');try{fsyncSync(dirFd);}finally{closeSync(dirFd);}durable=next;}catch(e){if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}active.clear();throw e;}};
 const ready=()=>!closed&&[...configured.keys()].every(id=>active.has(id)&&active.get(id).expires_at>clock()&&active.get(id).issued_at<=clock());
 const requireReady=()=>{if(!ready())fail('AUTHORITY_UNAVAILABLE',503);};
 const records=kind=>active.get(owners.get(kind))?.records[kind]||[];
 const get=(kind,id)=>records(kind).find(x=>x.id===id);
 const user=id=>{const u=get('users',id);return u&&!u.disabled?u:null;};
 const member=(u,p)=>{const project=get('projects',p);return user(u)&&project&&!project.archived&&project.user_ids.includes(u);};
 const ended=t=>!!durable.ended_tasks[t.id+'/'+t.attempt+'/'+t.fence];
 const policy=id=>{const p=get('policies',id);return p&&p.status!=='revoked'?p:null;};
 function ingest(envelope){
  if(closed)fail('AUTHORITY_UNAVAILABLE',503);
  let bytes;try{bytes=Buffer.byteLength(JSON.stringify(envelope));}catch{reject();}if(bytes>1024*1024)reject();
  exact(envelope,['version','source_id','sequence','challenge','issued_at','expires_at','records','signature']);
  const {signature,...payload}=envelope,source=configured.get(payload.source_id);if(!source||payload.version!=='authority.v1'||payload.challenge!==boot)reject();
  int(payload.sequence);int(payload.issued_at);int(payload.expires_at);const now=clock();if(payload.issued_at>now||payload.expires_at<=now||payload.expires_at-payload.issued_at>60000||payload.expires_at<=payload.issued_at)reject();
  if(typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature)||!verify(null,Buffer.from(canonical(payload)),source.key,Buffer.from(signature,'base64url')))reject();
  const prior=durable.sources[source.id];if(prior&&payload.sequence<=prior.sequence)reject();
  exact(payload.records,source.kinds);const floors=structuredClone(prior?.floors||{}),seen=new Set();
  for(const kind of source.kinds){arr(payload.records[kind],r=>validateRecord(kind,r));const ids=new Set();for(const r of payload.records[kind]){if(ids.has(r.id))reject();ids.add(r.id);const k=kind+'/'+r.id,f=floors[k],hash=digest(r);if(f&&(r.revision<f.revision||(r.revision===f.revision&&(hash!==f.digest||!f.present))))reject();floors[k]={revision:r.revision,digest:hash,present:true};seen.add(k);}}
  for(const [k,f]of Object.entries(floors))if(!seen.has(k))f.present=false;
  persist({...durable,sources:{...durable.sources,[source.id]:{sequence:payload.sequence,floors}}});
  active.set(source.id,structuredClone(payload));return {source_id:source.id,sequence:payload.sequence,digest:digest(payload)};
 }
 function principal(p){requireReady();if(!p||!user(p.user_id)||!Number.isFinite(p.fresh_until)||p.fresh_until<=clock()||!['human','delegation','workload'].includes(p.proof_type))reject();return p;}
 async function authenticate(proof){
  requireReady();let p;if(proof&&typeof proof==='object'&&proofs.has(proof)){p=proofs.get(proof);proofs.delete(proof);}else{try{p=await identity.authenticate(proof);}catch{fail('AUTH_REQUIRED',401);}if(!p||!['human','delegation'].includes(p.proof_type))reject();}
  principal(p);return structuredClone(p);
 }
 function ceiling(p,action,{connection,project_id,adapter_id,scope:requested}={}){
  const project=connection?connection.project_id:(project_id??null);
  return records('ceilings').find(c=>c.user_id===p.user_id&&!c.revoked&&c.expires_at>clock()&&c.actions.includes(action)&&c.project_id===project&&(!connection||c.connection_ids.includes(connection.id))&&(!adapter_id||c.adapter_ids.includes(adapter_id))&&(!connection||c.adapter_ids.includes(connection.adapter_id))&&(!requested||fits(requested,c)));
 }
 function canViewProject(p,projectId){
  try{uuid(projectId);principal(p);return p.proof_type!=='workload'&&(p.proof_type!=='delegation'||p.actions?.includes('list'))&&!!member(p.user_id,projectId);}catch{return false;}
 }
 function authorize(p,{action,id,body={},query={},connection}={}){
  principal(p);if(!ACTIONS.includes(action)||p.proof_type==='workload'||(DIRECT.includes(action)&&p.proof_type!=='human'))reject();
  if(p.proof_type==='delegation'&&(!Array.isArray(p.actions)||!p.actions.includes(action)))reject();
  if(action==='intent')return true; // Intake independently enforces exact owner; status never reveals secret values.
  let project=connection?connection.project_id:(body.project_id??body.connection?.project_id??query.project_id??null);
  if(project!==null&&!member(p.user_id,project))reject();
  if(connection&&id&&['assign','unassign','approve','reconcileOperation'].every(x=>x!==action)&&id!==connection.id)reject();
  if(!connection&&!['enroll','list'].includes(action))reject();
  let requested=body.connection||body;
  if(action==='test')requested={operations:['item.read'],resources:[connection.resources[0]],limits:connection.limits};
  if(action==='approve'){const r=body.request;if(!r||r.connection_id!==connection.id||!r.input)reject();requested={operations:[r.operation],resources:[r.input.resource_id],limits:body.limits||connection.limits};}
  const needsScope=['enroll','assign','setPermission','test','approve'].includes(action);
  if(needsScope)scope(requested);
  const cap=ceiling(p,action,{connection,project_id:project,adapter_id:requested.adapter_id,scope:needsScope?requested:undefined});if(!cap)reject();
  if(action==='setPermission'){
   arr(body.rights,x=>one(x,['view','use','assign','manage']),{empty:false,max:4});arr(body.manage_actions,x=>one(x,['test','rename','rotate','revoke']),{max:4});
   if(!body.rights.every(x=>cap.grant_rights.includes(x))||!body.manage_actions.every(x=>cap.manage_actions.includes(x))||body.expires_at>cap.expires_at)reject();
  }
  if(action==='assign'&&(!canAssign(p,{...body,connection_id:connection.id})||body.expires_at>cap.expires_at))reject();
  return true;
 }
 function canAssign(p,g){
  try{principal(p);if(p.proof_type==='workload'||(p.proof_type==='delegation'&&!p.actions.includes('assign')))return false;
   const a=get('agents',g.agent_id),pol=policy(g.connection_id);if(!a||a.disabled||a.project_id!==g.project_id||(g.user_id&&a.user_id!==g.user_id)||!member(p.user_id,g.project_id)||!member(g.user_id,g.project_id)||!pol||(pol.project_id!==null&&pol.project_id!==g.project_id))return false;
   const requested=g.operations?g:undefined;return !!ceiling(p,'assign',{connection:pol,scope:requested})&&(!requested||fits(requested,pol));
  }catch{return false;}
 }
 function canUnassign(p,g){
  try{principal(p);if(p.proof_type==='workload'||(p.proof_type==='delegation'&&!p.actions.includes('unassign')))return false;const a=get('agents',g.agent_id),pol=policy(g.connection_id);return !!(a&&a.project_id===g.project_id&&a.user_id===g.user_id&&member(p.user_id,g.project_id)&&pol&&(pol.project_id===null||pol.project_id===g.project_id)&&ceiling(p,'unassign',{connection:pol}));}catch{return false;}
 }
 const taskAuthorityDigest=t=>digest({task:t,agent:get('agents',t.agent_id),project:get('projects',t.project_id),user:get('users',t.user_id),policies:t.connection_ids.map(id=>get('policies',id)||null),ceilings:records('ceilings').filter(c=>c.user_id===t.user_id&&c.connection_ids.some(id=>t.connection_ids.includes(id))).sort((a,b)=>a.id.localeCompare(b.id))});
 function eligible(s){
  try{requireReady();scope(s);const task=get('tasks',s.task_id),agent=get('agents',s.agent_id),pol=policy(s.connection_id);
   if(!task||!agent||agent.disabled||!pol||pol.status!=='active'||task.status!=='running'||!task.readiness.execution_approved||ended(task)||task.expires_at<=clock()||s.expires_at<=clock()||s.audience!=='fractionate-broker')return false;
   const reservation=durable.issued_tasks[task.id+'/'+task.attempt+'/'+task.fence];if(!reservation||reservation.authority_digest!==taskAuthorityDigest(task))return false;
   if(!member(s.user_id,s.project_id)||agent.project_id!==s.project_id||agent.user_id!==s.user_id||task.user_id!==s.user_id||task.project_id!==s.project_id||task.agent_id!==s.agent_id||task.attempt!==s.attempt||task.fence!==s.fence||!task.connection_ids.includes(s.connection_id)||!task.grant_ids.includes(s.grant_id))return false;
   if(pol.project_id!==null&&pol.project_id!==s.project_id)return false;
   if(pol.policy_revision!==s.policy_revision||pol.credential_version!==s.credential_version)return false;
   return fits(s,task)&&fits(s,pol)&&s.expires_at<=task.expires_at;
  }catch{return false;}
 }
 function issueWorkloadProof(workloadId,request){
  requireReady();uuid(workloadId);exact(request,['grant_id','task_id','attempt','fence','configuration_revision','operations','resources','limits','expires_at','audience']);int(request.configuration_revision);for(const k of ['grant_id','task_id','attempt','fence'])uuid(request[k]);scope(request);int(request.expires_at);if(request.audience!=='fractionate-broker'||request.expires_at<=clock()||request.expires_at>clock()+request.limits.max_seconds*1000)reject();
  const task=get('tasks',request.task_id),a=task&&get('agents',task.agent_id);if(!a||a.disabled||a.workload_id!==workloadId||task.status!=='running'||!task.readiness.execution_approved||task.configuration_revision!==request.configuration_revision||ended(task)||task.attempt!==request.attempt||task.fence!==request.fence||!task.grant_ids.includes(request.grant_id)||!member(task.user_id,task.project_id)||a.user_id!==task.user_id||a.project_id!==task.project_id||!fits(request,task)||request.expires_at>task.expires_at)reject();
  const issuanceKey=task.id+'/'+task.attempt+'/'+task.fence;if(durable.issued_tasks[issuanceKey])fail('TASK_SESSION_ALREADY_RESERVED',409);persist({...durable,issued_tasks:{...durable.issued_tasks,[issuanceKey]:{workload_id:workloadId,reserved_at:clock(),authority_digest:taskAuthorityDigest(task)}}});
  const proof=Object.freeze(Object.create(null));proofs.set(proof,{user_id:task.user_id,fresh_until:Math.min(clock()+10000,...[...active.values()].map(s=>s.expires_at)),proof_type:'workload',actions:['issueSession'],workload_scope:structuredClone(Object.fromEntries(Object.entries(request).filter(([k])=>k!=='configuration_revision')))});return proof;
 }
 function checkTask(workloadId,r){
  requireReady();uuid(workloadId);exact(r,['id','user_id','project_id','agent_id','grant_id','connection_id','attempt','fence','scope','steps','configuration_revision']);for(const k of ['id','user_id','project_id','agent_id','grant_id','connection_id','attempt','fence'])uuid(r[k]);int(r.configuration_revision);exact(r.scope,['operations','resources','limits','expires_at','audience']);scope(r.scope);int(r.scope.expires_at);if(r.scope.audience!=='fractionate-broker'||r.scope.expires_at<=clock()||r.scope.expires_at>clock()+r.scope.limits.max_seconds*1000)reject();
  if(!Array.isArray(r.steps)||!r.steps.length||r.steps.length>r.scope.limits.max_actions)reject();for(const step of r.steps){exact(step,['operation','input']);input(step.operation,step.input);if(!r.scope.operations.includes(step.operation)||!r.scope.resources.includes(step.input.resource_id))reject();}
  const task=get('tasks',r.id),a=task&&get('agents',task.agent_id),pol=policy(r.connection_id);if(!task||!a||!pol||pol.status!=='active'||a.disabled||a.workload_id!==workloadId||!member(r.user_id,r.project_id)||task.status!=='running'||!task.readiness.execution_approved||ended(task)||durable.issued_tasks[task.id+'/'+task.attempt+'/'+task.fence]||task.configuration_revision!==r.configuration_revision||task.attempt!==r.attempt||task.fence!==r.fence||task.user_id!==r.user_id||task.project_id!==r.project_id||task.agent_id!==r.agent_id||a.user_id!==r.user_id||a.project_id!==r.project_id||!task.grant_ids.includes(r.grant_id)||!task.connection_ids.includes(r.connection_id)||(pol.project_id!==null&&pol.project_id!==r.project_id)||!fits(r.scope,task)||!fits(r.scope,pol)||r.scope.expires_at>task.expires_at)reject();
  return {ready:true,task_id:task.id,user_id:task.user_id,project_id:task.project_id,agent_id:task.agent_id,configuration_revision:task.configuration_revision,attempt:task.attempt,fence:task.fence,expires_at:Math.min(clock()+60000,task.expires_at,...[...active.values()].map(s=>s.expires_at))};
 }
 function workloadReady(workloadId){
  try{requireReady();uuid(workloadId);return records('agents').some(a=>a.workload_id===workloadId&&!a.disabled&&member(a.user_id,a.project_id));}catch{return false;}
 }
 function endTask(workloadId,request){
  requireReady();uuid(workloadId);exact(request,['task_id','attempt','fence']);Object.values(request).forEach(uuid);const t=get('tasks',request.task_id),a=t&&get('agents',t.agent_id);if(!a||a.workload_id!==workloadId||t.attempt!==request.attempt||t.fence!==request.fence)reject();const key=t.id+'/'+t.attempt+'/'+t.fence;persist({...durable,ended_tasks:{...durable.ended_tasks,[key]:true}});return {task_id:t.id,attempt:t.attempt,fence:t.fence,ended:true};
 }
 function revalidatePolicy(p,{connection:c}={}){
  try{authorize(p,{action:'revalidatePolicy',id:c.id,connection:c});if(p.proof_type!=='human'||p.user_id!==c.owner_id)return false;const expected=policy(c.id);if(!expected)return false;
   return ['owner_id','project_id','adapter_id','policy_revision','credential_version','status','operations','resources','limits'].every(k=>canonical(expected[k])===canonical(c[k]));
  }catch{return false;}
 }
 const result={canViewProject,checkTask,workloadReady,endTask,authenticate,authorize,canAssign,canUnassign,eligible,issueWorkloadProof,ingest,revalidatePolicy,challenge:()=>{if(closed)fail('AUTHORITY_UNAVAILABLE',503);return boot;},health:()=>({ready:ready(),reason:ready()?null:'AUTHORITY_UNAVAILABLE',sources:[...configured.keys()].map(id=>({id,sequence:durable.sources[id]?.sequence||0,expires_at:active.get(id)?.expires_at||null}))}),close:()=>{active.clear();branded.delete(result);release();}};
 branded.add(result);return Object.freeze(result);
}
