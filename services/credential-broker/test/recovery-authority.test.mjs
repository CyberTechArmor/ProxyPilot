import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,randomUUID,randomBytes,sign } from 'node:crypto';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuthority,AUTHORITY_KINDS } from '../authority.mjs';
import { createBroker } from '../broker.mjs';
import { canonical } from '../schema.mjs';
import { backupState,restoreState,generateRecoveryKey } from '../recovery.mjs';

test('encrypted restored broker needs new signed boot snapshot and independently exact policy reaffirmation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'broker-signed-restore-')),state=join(dir,'state');mkdirSync(state,{mode:0o700});
 const keyPath=join(dir,'recovery.key'),archivePath=join(dir,'state.enc');generateRecoveryKey(keyPath);
 const keys=generateKeyPairSync('ed25519'),uid=randomUUID(),project=randomUUID(),resource=randomUUID();
 const sources=[{id:'independent',public_key:keys.publicKey.export({type:'spki',format:'pem'}),kinds:[...AUTHORITY_KINDS]}];
 const identity={authenticate:async p=>{if(p!=='fresh-independent-person')throw Error();return {user_id:uid,fresh_until:Date.now()+30000,proof_type:'human',actions:[]};}};
 let authority,broker;
 const records={users:[{id:uid,revision:1,disabled:false}],projects:[{id:project,revision:1,archived:false,user_ids:[uid]}],agents:[],tasks:[],ceilings:[],policies:[]};
 const envelope=(sequence)=>{const payload={version:'authority.v1',source_id:'independent',sequence,challenge:authority.challenge(),issued_at:Date.now(),expires_at:Date.now()+25000,records:structuredClone(records)};return {...payload,signature:sign(null,Buffer.from(canonical(payload)),keys.privateKey).toString('base64url')};};
 const values=new Map(),vault={write:async(path,value,{intent})=>{values.set(path,{value,intent,version:1});return {version:1};},read:async path=>values.get(path)},upstream={execute:async(_op,input)=>({resource_id:input.resource_id,state:'open'})};
 const scope={operations:['item.read'],resources:[resource],limits:{max_actions:2,max_seconds:60}};
 try{
  authority=createAuthority({statePath:join(state,'authority.json'),identity,sources});authority.ingest(envelope(1));
  broker=createBroker({dbPath:join(state,'broker.db'),vault,upstream,authority,mode:'synthetic'});
  let c=await broker.enroll('fresh-independent-person',{name:'Signed restore',project_id:project,adapter_id:'synthetic-ledger-v1',...scope},randomBytes(32).toString('base64url'));
  c=await broker.testConnection('fresh-independent-person',c.id,c.revision);
  records.ceilings=[{id:randomUUID(),revision:1,user_id:uid,project_id:project,actions:['revalidatePolicy'],connection_ids:[c.id],adapter_ids:[c.adapter_id],...scope,expires_at:Date.now()+120000,revoked:false,grant_rights:['view','use','assign','manage'],manage_actions:['test','rename','rotate','revoke']}];
  records.policies=[{id:c.id,revision:1,policy_revision:c.policy_revision,credential_version:c.credential_version,owner_id:uid,project_id:project,adapter_id:c.adapter_id,...scope,status:'active'}];
  const oldSigned=envelope(2);authority.ingest(oldSigned);broker.close();broker=null;authority.close();authority=null;
  for(const name of ['intake.json','allocator.json'])writeFileSync(join(state,name),'[]',{mode:0o600});
  const expectedPins={build:'signed_restore_test',config_digest:'a'.repeat(64)};backupState({stateRoot:state,keyPath,archivePath,expectedPins});const restored=join(dir,'restored');restoreState({destination:restored,keyPath,archivePath,expectedPins});
  authority=createAuthority({statePath:join(restored,'authority.json'),identity,sources});broker=createBroker({dbPath:join(restored,'broker.db'),vault,upstream,authority,mode:'synthetic'});
  assert.equal(authority.health().ready,false);assert.throws(()=>authority.ingest(oldSigned));await assert.rejects(broker.revalidatePolicy('fresh-independent-person',c.id,c.revision));
  records.policies[0]={...records.policies[0],revision:2,credential_version:2};authority.ingest(envelope(3));
  await assert.rejects(broker.revalidatePolicy('fresh-independent-person',c.id,c.revision));assert.equal((await broker.detail('fresh-independent-person',c.id)).readiness.code,'POLICY_REVALIDATION_REQUIRED');
  records.policies[0]={...records.policies[0],revision:3,credential_version:1};authority.ingest(envelope(4));
  c=await broker.revalidatePolicy('fresh-independent-person',c.id,c.revision);assert.equal(c.readiness.code,'SYNTHETIC_ONLY');assert.equal(c.revision,2);
 }finally{broker?.close();authority?.close();rmSync(dir,{recursive:true,force:true});}
});
