import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { backupWorkerState,restoreWorkerState,restoreState,generateRecoveryKey,acquireStateLease } from '../recovery.mjs';
import { recoveryCommand } from '../recovery-main.mjs';
import { createRunner } from '../runner.mjs';
import { authorityFixture } from './authority-fixture.mjs';
const pins={build:'worker-rehearsal',config_digest:'b'.repeat(64)};
function paths(t){const dir=mkdtempSync(join(tmpdir(),'worker-recovery-')),stateRoot=join(dir,'state'),keyPath=join(dir,'key'),archivePath=join(dir,'archive');mkdirSync(stateRoot,{mode:0o700});generateRecoveryKey(keyPath);const p={dir,stateRoot,keyPath,archivePath,expectedPins:pins};t.after(()=>{p.close?.();rmSync(dir,{recursive:true,force:true});});return p;}

test('worker archive enforces private stopped inventory, authenticated role/pins and no overwrite; CLI uses worker profile',t=>{
 const p=paths(t);writeFileSync(join(p.stateRoot,'worker.db'),'private task metadata',{mode:0o600});
 const lease=acquireStateLease(p.stateRoot);assert.throws(()=>backupWorkerState(p),/STATE_BUSY/);lease.close();
 writeFileSync(join(p.stateRoot,'worker.db.lock'),'{}',{mode:0o600});assert.throws(()=>backupWorkerState(p),/STATE_INVENTORY_MISMATCH/);unlinkSync(join(p.stateRoot,'worker.db.lock'));
 const config=join(p.dir,'config.json');writeFileSync(config,JSON.stringify({state_dir:p.stateRoot,schema_version:1,broker:{agent_origin:'https://broker.invalid'}}),{mode:0o600});
 const argv=['--key-file',p.keyPath,'--config-file',config,'--build',pins.build,'--archive-file',p.archivePath];const receipt=recoveryCommand(['worker-backup',...argv]);assert.equal(receipt.format,'fractionate-worker-encrypted-state');assert.equal(readFileSync(p.archivePath,'utf8').includes('private task metadata'),false);
 assert.throws(()=>restoreState({...p,destination:join(p.dir,'wrong-role')}),/ARCHIVE_AUTHENTICATION_FAILED/);
 assert.throws(()=>restoreWorkerState({...p,destination:join(p.dir,'wrong-pins')}),/PIN_MISMATCH/);
 const destination=join(p.dir,'restore');recoveryCommand(['worker-restore',...argv,'--destination',destination]);assert.equal(readFileSync(join(destination,'worker.db'),'utf8'),'private task metadata');assert.throws(()=>recoveryCommand(['worker-restore',...argv,'--destination',destination]),/DESTINATION_EXISTS/);
 writeFileSync(join(destination,'.restore-incomplete'),'pending',{mode:0o600});assert.throws(()=>acquireStateLease(destination),/RESTORE_INCOMPLETE/);
});

test('restored paused worker never resumes; fresh signed broker authority still denies revoked task and permits only new authorized task',async t=>{
 const p=paths(t),f=authorityFixture(t),i=f.ids,secret=randomBytes(32).toString('base64url');let sends=0,mints=0,currentSession;
 const makeRequest=()=>({id:i.task,user_id:i.user,project_id:i.project,agent_id:i.agent,grant_id:i.grant,connection_id:i.connection,attempt:i.attempt,fence:i.fence,configuration_revision:1,scope:{...structuredClone(f.scope),expires_at:f.now()+30000,audience:'fractionate-broker'},steps:[{operation:'item.set_state',input:{resource_id:i.resource,state:'closed'}}]});
 const broker={checkTask:async r=>f.authority.checkTask(i.workload,r),issueSession:async r=>{f.authority.issueWorkloadProof(i.workload,r);mints++;currentSession={...f.session(),id:randomUUID(),revoked:false};return{session:currentSession,bearer:secret};},execute:async()=>{assert.equal(f.authority.eligible(currentSession),true);sends++;return{id:randomUUID(),state:'succeeded'};},endTask:async r=>{f.authority.endTask(i.workload,r);return{ended:true};}};
 f.publish();let worker=createRunner({statePath:join(p.stateRoot,'worker.db'),broker,clock:f.now});const oldRequest=makeRequest();const paused=await worker.startTask(oldRequest);assert.equal(paused.state,'awaiting_approval');worker.close();
 assert.equal(readFileSync(join(p.stateRoot,'worker.db')).includes(Buffer.from(secret)),false);backupWorkerState(p);const destination=join(p.dir,'restored');restoreWorkerState({...p,destination});
 // Revoke independently after the backup; restoring the worker must not restore source authority.
 f.records.tasks[0].status='cancelled';f.records.tasks[0].revision++;const oldSnapshot=f.snapshot();f.restart();assert.throws(()=>f.authority.ingest(oldSnapshot));
 worker=createRunner({statePath:join(destination,'worker.db'),broker,clock:f.now});p.close=()=>worker.close();assert.equal(worker.status(oldRequest.id).state,'interrupted');await assert.rejects(worker.continueTask(oldRequest.id,{approval_id:randomUUID()}),/TASK_NOT_CONTINUABLE/);await assert.rejects(worker.startTask(oldRequest),/TASK_EXISTS/);
 const next={...oldRequest,id:randomUUID(),attempt:randomUUID(),fence:randomUUID()};await assert.rejects(worker.checkTask(next));f.publish();assert.equal(f.authority.eligible(currentSession),false);await assert.rejects(worker.checkTask(next));assert.equal(sends,0);assert.equal(mints,1);
 // A new independently approved registration is required; restoring the same prior epoch cannot mint.
 f.records.tasks[0]={...f.records.tasks[0],id:next.id,attempt:next.attempt,fence:next.fence,status:'running',revision:1};Object.assign(i,{task:next.id,attempt:next.attempt,fence:next.fence});f.publish();assert.equal((await worker.startTask(next)).state,'awaiting_approval');assert.equal(sends,0);assert.equal(mints,2);await worker.cancelTask(next.id);assert.equal(f.authority.eligible(currentSession),false);
});

test('process-crash possible-send state restores uncertain without transport, replay or revived task',async t=>{
 const p=paths(t),id=randomUUID();
 const row={id,user_id:randomUUID(),project_id:randomUUID(),agent_id:randomUUID(),configuration_revision:1,attempt:randomUUID(),fence:randomUUID(),state:'running',code:null,session_id:randomUUID(),step_index:0,pending_approval:null,receipts:[],end_confirmed:false,sending:true};
 const storeUrl=new URL('../store.mjs',import.meta.url).href;
 assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',`import{openStore}from ${JSON.stringify(storeUrl)};const db=openStore(process.argv[1]);db.put('task',JSON.parse(process.argv[2]));process.exit(17);`,join(p.stateRoot,'worker.db'),JSON.stringify(row)],{stdio:'ignore'}),e=>e.status===17);
 assert.throws(()=>backupWorkerState(p),/STATE_INVENTORY_MISMATCH/);
 // Child has exited; operator removes only its verified abandoned component lock.
 unlinkSync(join(p.stateRoot,'worker.db.lock'));backupWorkerState(p);const destination=join(p.dir,'restored');restoreWorkerState({...p,destination});
 let calls=0;const broker={checkTask:async()=>{calls++;throw Error('revoked');},execute:async()=>{calls++;throw Error('must not send');}};
 const runner=createRunner({statePath:join(destination,'worker.db'),broker});p.close=()=>runner.close();assert.equal(runner.status(id).state,'uncertain');assert.equal(runner.status(id).code,'OPERATION_UNCERTAIN');await assert.rejects(runner.continueTask(id,{approval_id:randomUUID()}),/TASK_NOT_CONTINUABLE/);assert.equal(calls,0);
});
