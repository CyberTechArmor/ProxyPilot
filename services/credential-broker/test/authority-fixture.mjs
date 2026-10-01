import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAuthority,AUTHORITY_KINDS} from '../authority.mjs';
import {signAuthoritySnapshot} from '../authority-publisher.mjs';
export function authorityFixture(t){
 const dir=mkdtempSync(join(tmpdir(),'authority-proof-'));let now=1900000000000,sequence=0;
 const ids=Object.fromEntries(['user','other','project','agent','workload','task','attempt','fence','grant','connection','resource','ceiling'].map(k=>[k,randomUUID()]));
 const pair=generateKeyPairSync('ed25519'),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}),publicKey=pair.publicKey.export({type:'spki',format:'pem'});
 const scope={operations:['item.read','item.set_state'],resources:[ids.resource],limits:{max_actions:5,max_seconds:60}};
 const records={users:[{id:ids.user,revision:1,disabled:false}],projects:[{id:ids.project,revision:1,archived:false,user_ids:[ids.user]}],agents:[{id:ids.agent,revision:1,project_id:ids.project,user_id:ids.user,disabled:false,workload_id:ids.workload}],tasks:[{id:ids.task,revision:1,project_id:ids.project,user_id:ids.user,agent_id:ids.agent,attempt:ids.attempt,fence:ids.fence,status:'running',configuration_revision:1,readiness:{guide_revision:1,checks_revision:1,environment_revision:1,execution_approved:true},expires_at:now+3600000,grant_ids:[ids.grant],connection_ids:[ids.connection],...structuredClone(scope)}],ceilings:[{id:ids.ceiling,revision:1,user_id:ids.user,project_id:ids.project,actions:['list','get','activity','assignments','sessions','enroll','test','update','revoke','rotate','assign','unassign','approve','setPermission','reconcileOperation','revalidatePolicy'],connection_ids:[ids.connection],adapter_ids:['synthetic-ledger-v1'],...structuredClone(scope),expires_at:now+3600000,revoked:false,grant_rights:['view','use','assign','manage'],manage_actions:['test','rename','rotate','revoke']}],policies:[{id:ids.connection,revision:1,policy_revision:1,credential_version:1,owner_id:ids.user,project_id:ids.project,adapter_id:'synthetic-ledger-v1',status:'active',...structuredClone(scope)}]};
 const identity={authenticate:async proof=>{if(!['human','delegation'].includes(proof))throw Error('invalid');return {user_id:ids.user,fresh_until:now+30000,proof_type:proof,actions:['list','get','assign']};}};
 const options={statePath:join(dir,'authority.json'),identity,sources:[{id:'independent',public_key:publicKey,kinds:[...AUTHORITY_KINDS]}],clock:()=>now};let authority=createAuthority(options);
 const f={dir,ids,scope,records,options,privateKey,publicKey,get authority(){return authority;},now:()=>now,tick:n=>now+=n,
  snapshot:(overrides={})=>signAuthoritySnapshot(privateKey,{version:'authority.v1',source_id:'independent',sequence:++sequence,challenge:authority.challenge(),issued_at:now,expires_at:now+60000,records:structuredClone(records),...overrides}),
  publish:()=>authority.ingest(f.snapshot()),reserve:()=>authority.issueWorkloadProof(ids.workload,f.request()),restart:()=>{authority.close();authority=createAuthority(options);},close:()=>{authority.close();rmSync(dir,{recursive:true,force:true});},
  session:()=>({user_id:ids.user,project_id:ids.project,agent_id:ids.agent,task_id:ids.task,attempt:ids.attempt,fence:ids.fence,grant_id:ids.grant,connection_id:ids.connection,policy_revision:1,credential_version:1,audience:'fractionate-broker',expires_at:now+30000,...structuredClone(scope)}),
  request:()=>({configuration_revision:1,grant_id:ids.grant,task_id:ids.task,attempt:ids.attempt,fence:ids.fence,expires_at:now+30000,audience:'fractionate-broker',...structuredClone(scope)})};
 if(t)t.after(f.close);return f;
}
