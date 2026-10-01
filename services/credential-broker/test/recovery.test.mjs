import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createCipheriv,createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {canonical} from '../schema.mjs';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,chmodSync,symlinkSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { backupState,restoreState,generateRecoveryKey,configurationDigest,acquireStateLease,recoverStoppedLease } from '../recovery.mjs';
import { createBroker } from '../broker.mjs';

function world(t){const dir=mkdtempSync(join(tmpdir(),'broker-recovery-')),stateRoot=join(dir,'state'),keyPath=join(dir,'key'),archivePath=join(dir,'backup.enc');mkdirSync(stateRoot,{mode:0o700});generateRecoveryKey(keyPath);const expectedPins={build:'reviewed_commit_1',config_digest:configurationDigest({state_dir:stateRoot,adapter:'synthetic-ledger-v1',authority:'independent-public-key-reference'})};for(const name of ['broker.db','intake.json','authority.json','allocator.json'])writeFileSync(join(stateRoot,name),randomBytes(100),{mode:0o600});t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,stateRoot,keyPath,archivePath,expectedPins};}
const deny=(fn,code)=>assert.throws(fn,e=>e.code===code);
test('authenticated encrypted stopped-state backup and new-directory restore preserve state and pins',t=>{
 const w=world(t),canary=randomBytes(32).toString('base64url');writeFileSync(join(w.stateRoot,'intake.json'),JSON.stringify({canary}),{mode:0o600});
 const receipt=backupState(w);assert.equal(receipt.quarantine_required,true);assert(!readFileSync(w.archivePath).includes(canary));assert(!JSON.stringify(receipt).includes(canary));
 const destination=join(w.dir,'restored'),result=restoreState({...w,destination});assert.equal(result.quarantine_required,true);
 for(const name of readdirSync(w.stateRoot))assert.deepEqual(readFileSync(join(destination,name)),readFileSync(join(w.stateRoot,name)));
 assert(!existsSync(join(destination,'.maintenance.lock')));deny(()=>restoreState({...w,destination}),'DESTINATION_EXISTS');
 assert.equal(configurationDigest({state_dir:destination,adapter:'synthetic-ledger-v1',authority:'independent-public-key-reference'}),w.expectedPins.config_digest);
});
test('wrong key, ciphertext modification and mismatched config/build never publish a restore',t=>{
 const w=world(t);backupState(w);const destination=join(w.dir,'restored');
 const wrongKey=join(w.dir,'wrong-key');generateRecoveryKey(wrongKey);deny(()=>restoreState({...w,keyPath:wrongKey,destination}),'ARCHIVE_AUTHENTICATION_FAILED');assert(!existsSync(destination));
 for(const expectedPins of [{...w.expectedPins,build:'other'},{...w.expectedPins,config_digest:'0'.repeat(64)}])deny(()=>restoreState({...w,destination,expectedPins}),'PIN_MISMATCH');
 const envelope=JSON.parse(readFileSync(w.archivePath));const bytes=Buffer.from(envelope.ciphertext,'base64');bytes[bytes.length-1]^=1;envelope.ciphertext=bytes.toString('base64');writeFileSync(w.archivePath,JSON.stringify(envelope));
 deny(()=>restoreState({...w,destination}),'ARCHIVE_AUTHENTICATION_FAILED');assert(!existsSync(destination));
});
test('active lease, component locks, unknown files, symlinks and public permissions fail closed',t=>{
 const w=world(t),lease=acquireStateLease(w.stateRoot);deny(()=>backupState(w),'STATE_BUSY');deny(()=>recoverStoppedLease(w.stateRoot),'STATE_BUSY');lease.close();
 writeFileSync(join(w.stateRoot,'broker.db.lock'),'{}',{mode:0o600});deny(()=>backupState(w),'STATE_INVENTORY_MISMATCH');rmSync(join(w.stateRoot,'broker.db.lock'));
 writeFileSync(join(w.stateRoot,'unlisted-secret'),'secret',{mode:0o600});deny(()=>backupState(w),'STATE_INVENTORY_MISMATCH');rmSync(join(w.stateRoot,'unlisted-secret'));
 rmSync(join(w.stateRoot,'intake.json'));symlinkSync(w.keyPath,join(w.stateRoot,'intake.json'));deny(()=>backupState(w),'UNSAFE_FILE');rmSync(join(w.stateRoot,'intake.json'));writeFileSync(join(w.stateRoot,'intake.json'),'{}',{mode:0o600});
 chmodSync(w.keyPath,0o644);deny(()=>backupState(w),'UNSAFE_FILE');chmodSync(w.keyPath,0o600);
 writeFileSync(join(w.stateRoot,'.restore-incomplete'),'failed publication',{mode:0o600});deny(()=>acquireStateLease(w.stateRoot),'RESTORE_INCOMPLETE');
});
test('CLI prints only metadata and accepts file paths, never inline keys',t=>{
 const w=world(t),configPath=join(w.dir,'config.json');writeFileSync(configPath,JSON.stringify({state_dir:w.stateRoot,adapter:'synthetic-ledger-v1',authority:'independent-public-key-reference'}),{mode:0o600});
 const cli=new URL('../recovery-main.mjs',import.meta.url).pathname;
 const r=spawnSync(process.execPath,[cli,'backup','--key-file',w.keyPath,'--config-file',configPath,'--build',w.expectedPins.build,'--archive-file',w.archivePath],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).quarantine_required,true);assert(!r.stdout.includes(readFileSync(w.keyPath).toString('base64')));
 const bad=spawnSync(process.execPath,[cli,'restore','--key','literal-value'],{encoding:'utf8'});assert.equal(bad.status,1);assert(!bad.stderr.includes('literal-value'));
});
test('restored real broker store quarantines old active grants, rejects old bearers and never replays',async t=>{
 const w=world(t);rmSync(join(w.stateRoot,'broker.db'));const uid=randomUUID(),pid=randomUUID(),aid=randomUUID(),rid=randomUUID(),task=randomUUID(),scope={operations:['item.read'],resources:[rid],limits:{max_actions:2,max_seconds:60}},values=new Map();let sends=0,approvedPolicy=false;
 const authority={authenticate:async()=>({user_id:uid,fresh_until:Date.now()+60000}),canAssign:async()=>true,eligible:async()=>true,revalidatePolicy:async()=>approvedPolicy};
 const vault={write:async(path,value,{intent})=>{values.set(path,{value,intent,version:1});return {version:1};},read:async path=>values.get(path)};
 const upstream={execute:async(_op,input)=>{sends++;return {resource_id:input.resource_id,state:'open'};}};
 let broker=createBroker({dbPath:join(w.stateRoot,'broker.db'),vault,upstream,authority,mode:'synthetic'});t.after(()=>broker?.close());
 let c=await broker.enroll('human',{name:'restore test',project_id:pid,adapter_id:'synthetic-ledger-v1',...scope},randomBytes(32).toString('base64url'));c=await broker.testConnection('human',c.id,c.revision);const g=await broker.assign('human',c.id,c.revision,{user_id:uid,project_id:pid,agent_id:aid,...scope,expires_at:Date.now()+300000});
 const mint=()=>broker.issueSession('human',g.id,{task_id:task,attempt:randomUUID(),fence:randomUUID(),audience:'fractionate-broker',...scope,expires_at:Date.now()+50000});const old=await mint();broker.close();broker=null;backupState(w);
 const destination=join(w.dir,'restored');restoreState({...w,destination});broker=createBroker({dbPath:join(destination,'broker.db'),vault,upstream,authority,mode:'synthetic'});
 const count=sends;await assert.rejects(mint());await assert.rejects(broker.execute(old.bearer,{connection_id:c.id,operation:'item.read',input:{resource_id:rid}},'old'));
 assert.equal((await broker.detail('human',c.id)).readiness.code,'POLICY_REVALIDATION_REQUIRED');await assert.rejects(broker.testConnection('human',c.id,c.revision));await assert.rejects(broker.revalidatePolicy('human',c.id,c.revision));assert.equal(sends,count);
 approvedPolicy=true;c=await broker.revalidatePolicy('human',c.id,c.revision);const fresh=await mint();assert.equal((await broker.execute(fresh.bearer,{connection_id:c.id,operation:'item.read',input:{resource_id:rid}},'fresh')).state,'succeeded');assert.equal(sends,count+1);
 broker.close();broker=null;
});

// Exercise authenticated payload validation, not merely GCM tag rejection.
test('authenticated manifest cannot escape destination or duplicate a state member',t=>{
 const w=world(t);backupState(w);const original=JSON.parse(readFileSync(w.archivePath)),key=readFileSync(w.keyPath);
 const header={format:original.format,version:original.version,algorithm:original.algorithm};
 const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(original.nonce,'base64'));decipher.setAAD(Buffer.from(canonical(header)));decipher.setAuthTag(Buffer.from(original.tag,'base64'));
 const payload=JSON.parse(Buffer.concat([decipher.update(Buffer.from(original.ciphertext,'base64')),decipher.final()]));
 for(const kind of ['escape','duplicate']){
  const changed=structuredClone(payload);changed.files[0].name=kind==='escape'?'../outside':changed.files[1].name;
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(canonical(header)));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(changed)),cipher.final()]);
  writeFileSync(w.archivePath,JSON.stringify({...header,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
  deny(()=>restoreState({...w,destination:join(w.dir,kind)}),'ARCHIVE_AUTHENTICATION_FAILED');assert(!existsSync(join(w.dir,kind)));assert(!existsSync(join(w.dir,'outside')));
 }
});
test('I/O failure during publication leaves a locked incomplete target and never modifies source',t=>{
 const w=world(t);backupState(w);const destination=join(w.dir,'interrupted'),nativeRename=fs.renameSync;let count=0;
 fs.renameSync=(from,to)=>{if(to.startsWith(destination+'/')&&++count===2)throw Object.assign(Error('injected disk failure'),{code:'EIO'});return nativeRename(from,to);};syncBuiltinESMExports();
 try{assert.throws(()=>restoreState({...w,destination}),e=>e.code==='EIO');}finally{fs.renameSync=nativeRename;syncBuiltinESMExports();}
 assert(existsSync(join(destination,'.restore-incomplete')));assert(existsSync(join(destination,'.maintenance.lock')));deny(()=>acquireStateLease(destination),'RESTORE_INCOMPLETE');
 assert.equal(readdirSync(w.stateRoot).length,4);const retry=join(w.dir,'retry');assert.equal(restoreState({...w,destination:retry}).restored,true);
});
