import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRunner} from '../runner.mjs';
const uuid=randomUUID;
function setup(t,overrides={}){
 const dir=mkdtempSync(join(tmpdir(),'runner-'));
 const secret=randomBytes(32).toString('base64url'),resource=uuid(),session=uuid();let sends=0,mints=0,ends=0;
 const broker={checkTask:async r=>({ready:true,task_id:r.id,user_id:r.user_id,project_id:r.project_id,agent_id:r.agent_id,configuration_revision:r.configuration_revision,attempt:r.attempt,fence:r.fence,expires_at:Date.now()+50000}),issueSession:async()=>{mints++;return{session:{id:session,user_id:request.user_id,project_id:request.project_id,agent_id:request.agent_id,grant_id:request.grant_id,connection_id:request.connection_id,task_id:request.id,attempt:request.attempt,fence:request.fence,expires_at:request.scope.expires_at,revoked:false},bearer:secret}},execute:async()=>{sends++;return{id:uuid(),state:'succeeded'}},endTask:async()=>{ends++;return{ended:true}},...overrides};
 const statePath=join(dir,'worker.db');const runner=createRunner({statePath,broker});
 const request={id:uuid(),user_id:uuid(),project_id:uuid(),agent_id:uuid(),grant_id:uuid(),connection_id:uuid(),attempt:uuid(),fence:uuid(),configuration_revision:1,scope:{operations:['item.read','item.set_state'],resources:[resource],limits:{max_actions:3,max_seconds:60},expires_at:Date.now()+59000,audience:'fractionate-broker'},steps:[{operation:'item.read',input:{resource_id:resource}},{operation:'item.set_state',input:{resource_id:resource,state:'closed'}}]};
 return {runner,request,secret,statePath,broker,cleanup:()=>rmSync(dir,{recursive:true,force:true}),counts:()=>({sends,mints,ends})};
}
test('bounded worker persists start, pauses for exact human approval, stores no bearer and never repeats task',async t=>{
 const s=setup(t);t.after(()=>{s.runner.close();s.cleanup();});
 let r=await s.runner.startTask(s.request);assert.equal(r.state,'awaiting_approval');assert.equal(s.counts().sends,1);assert.equal(r.pending_approval.request.operation,'item.set_state');
 await assert.rejects(s.runner.startTask(s.request),/TASK_EXISTS/);
 r=await s.runner.continueTask(r.id,{approval_id:uuid()});assert.equal(r.state,'completed');assert.equal(r.end_confirmed,true);assert.equal(s.counts().sends,2);
 assert.equal(JSON.stringify(r).includes(s.secret),false);assert.equal(readFileSync(s.statePath).includes(Buffer.from(s.secret)),false);
 await assert.rejects(s.runner.continueTask(r.id,{approval_id:uuid()}),/TASK_NOT_CONTINUABLE/);
});
test('scope widening rejected before mint, start registration denial stays blocked',async t=>{
 const s=setup(t,{issueSession:async()=>{throw new Error('UNAUTHORIZED')}});t.after(()=>{s.runner.close();s.cleanup();});
 const bad=structuredClone(s.request);bad.steps[0].input.resource_id=uuid();await assert.rejects(s.runner.startTask(bad),/SCOPE_EXCEEDED/);
 assert.equal((await s.runner.startTask(s.request)).state,'blocked');assert.equal(s.counts().sends,0);
});
test('possible send timeout persists uncertainty and never replays',async t=>{
 let calls=0;const s=setup(t,{execute:async()=>{calls++;throw new Error('secret upstream error')}});t.after(()=>{s.runner.close();s.cleanup();});
 const r=await s.runner.startTask(s.request);assert.equal(r.state,'uncertain');assert.equal(r.code,'OPERATION_UNCERTAIN');assert.equal(calls,1);assert.equal(JSON.stringify(r).includes('secret upstream'),false);
 await assert.rejects(s.runner.continueTask(r.id,{approval_id:uuid()}),/TASK_NOT_CONTINUABLE/);
 assert.equal((await s.runner.cancelTask(r.id)).state,'uncertain');assert.equal(calls,1);
});
test('restart drops paused capabilities and does not replay',async t=>{
 const s=setup(t);const r=await s.runner.startTask(s.request);s.runner.close();
 const restart=createRunner({statePath:s.statePath,broker:s.broker});t.after(()=>{restart.close();s.cleanup();});
 assert.equal(restart.status(r.id).state,'interrupted');await assert.rejects(restart.continueTask(r.id,{approval_id:uuid()}),/TASK_NOT_CONTINUABLE/);assert.equal(s.counts().sends,1);
});
test('cancel while send pending acknowledges cutoff but preserves uncertain upstream effect',async t=>{
 let release,started;const waiting=new Promise(r=>started=r);const s=setup(t,{execute:async()=>{started();return new Promise(r=>release=r)}});t.after(()=>{s.runner.close();s.cleanup();});
 const pending=s.runner.startTask(s.request);await waiting;
 const c=await s.runner.cancelTask(s.request.id);assert.equal(c.end_confirmed,true);
 release({id:uuid(),state:'uncertain'});const result=await pending;assert.equal(result.state,'uncertain');assert.equal(result.receipts.length,1);
});
test('failed terminal acknowledgement is explicit and can only retry narrowing',async t=>{
 let fail=true;const s=setup(t,{endTask:async()=>{if(fail)throw new Error('outage')}});t.after(()=>{s.runner.close();s.cleanup();});
 const r=await s.runner.startTask(s.request);let c=await s.runner.cancelTask(r.id);assert.equal(c.end_confirmed,false);assert.equal(c.state,'cancelled');fail=false;c=await s.runner.cancelTask(r.id);assert.equal(c.end_confirmed,true);assert.equal(s.counts().sends,1);
});

test('authoritative session identity mismatch blocks before any operation',async t=>{
 const s=setup(t);t.after(()=>{s.runner.close();s.cleanup();});const mint=s.broker.issueSession;s.broker.issueSession=async r=>{const issued=await mint(r);issued.session.agent_id=uuid();return issued;};
 const result=await s.runner.startTask(s.request);assert.equal(result.state,'blocked');assert.equal(result.code,'SESSION_NOT_ISSUED');assert.equal(s.counts().sends,0);
});
test('last write receipt uncertainty cannot be overwritten by completion',async t=>{
 const s=setup(t,{execute:async()=>({id:uuid(),state:'uncertain'})});t.after(()=>{s.runner.close();s.cleanup();});s.request.steps=[s.request.steps[1]];
 const pending=await s.runner.startTask(s.request);const result=await s.runner.continueTask(pending.id,{approval_id:uuid()});assert.equal(result.state,'uncertain');assert.equal(result.step_index,1);
});

test('readiness checks mint no session and unapproved signed task cannot start',async t=>{
 const s=setup(t);t.after(()=>{s.runner.close();s.cleanup();});const proof=await s.runner.checkTask(s.request);assert.equal(proof.ready,true);assert.equal(s.counts().mints,0);
 s.broker.checkTask=async()=>{throw new Error('TASK_NOT_READY')};await assert.rejects(s.runner.startTask(s.request),/TASK_NOT_READY/);assert.equal(s.counts().mints,0);
});
