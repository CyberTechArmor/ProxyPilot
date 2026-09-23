import { localEdge } from './local-edge.js';
import { assertUpstreamListening } from './owned-runtime.js';
import { readOpenBao,secrets,currentPlan } from './openbao-store.js';
import { OPENBAO_ROOT,OPENBAO_PORT,OPENBAO_APP,jobSchema,digest,fail } from './openbao-logic.js';
import { ensureRuntime } from './openbao-runtime.js';
import { initialize } from './openbao-handoff.js';
import { createClient,status,requireReady } from './openbao-api.js';
import { verifyClient } from './openbao-identity.js';
import { verifyKeycloak } from './keycloak-discovery.js';
import { verifiedProvider } from './pomerium-store.js';
import { verifyMachine,verifyAccess } from './openbao-access.js';
import { credentialFlow } from './openbao-postgres.js';
import { assertOpenBaoRouteAvailable } from './openbao-routes.js';
import { createJob,getJob } from './store.js';
export async function runOpenBaoOperation({db,params,exec,job,root=OPENBAO_ROOT,recoveryRoot,send,runtime=ensureRuntime,clientProbe=verifyClient,providerProbe=verifyKeycloak,flow=credentialFlow,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),attempts=30}){
  jobSchema.parse(params);const originalJob=job;job={...originalJob,fence(){originalJob.fence();const current=readOpenBao(db);if(!current||current.revision!==params.revision||current.last_job_id!==job.id)throw fail('OpenBao operation was superseded.');currentPlan(db,current);}};let r=readOpenBao(db);if(!r||r.revision!==params.revision||r.last_job_id!==job.id)throw fail('The OpenBao operation was superseded.');currentPlan(db,r);
  const phase=name=>job.checkpoint(name,{resumable:true,openbao:true});
  if(r.config.mode==='install'){
    phase('owned_private_runtime');assertOpenBaoRouteAvailable(db,r);const resources=await runtime(r,{exec,job,root});job.fence();db.prepare('UPDATE setup_openbao SET resources_json=? WHERE id=1').run(JSON.stringify({...r.resources,...resources}));r=readOpenBao(db);
    const local=createClient(`http://127.0.0.1:${OPENBAO_PORT}`,{send,job,local:true});let observed;
    for(let i=0;i<attempts;i++){observed=await status(local);if(observed.state!=='unavailable')break;await sleep(1000);}
    if(observed.state==='unavailable')throw fail('OpenBao is unavailable after start. Restore the owned runtime and retry; no initialization or verification was claimed.');
    if(r.config.basic&&!r.config.initialize)return {verification:{state:'awaiting_user_action',label:'OpenBao runtime installed. Confirm separate recovery custodians before initialization.',complete:false}};
    if(!r.handoff_ack){phase('protected_initialization_handoff');await initialize(db,r,local,{job,recoveryRoot});r=readOpenBao(db);}
    let child=r.edge_job_id?getJob(db,r.edge_job_id):null;
    if(!child){job.fence();db.exec('BEGIN IMMEDIATE');try{child=createJob(db,{app:OPENBAO_APP,kind:'configure_openbao_route',plan:{params},requestedBy:'openbao_apply',via:'system'});db.prepare('UPDATE setup_openbao SET edge_job_id=? WHERE id=1').run(child.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
    phase('restricted_caddy_route');if(['queued','running'].includes(child.status))return {waiting:true,reason:'Waiting for the recorded OpenBao Caddy route step.'};if(child.status!=='succeeded')throw fail('OpenBao Caddy configuration failed. Resolve its conflict and retry.');await assertUpstreamListening({run:argv=>exec.host(argv,{timeoutMs:15000}),port:OPENBAO_PORT,fail,label:'OpenBao'});job.fence();
    if(r.config.basic&&!r.handoff_ack)return {verification:{state:'awaiting_user_action',label:'Retrieve the encrypted OpenBao recovery package and acknowledge its receipt before manual unseal.',complete:false}};
    if(!r.handoff_ack)throw fail('Recovery handoff acknowledgement is required. Retrieve and decrypt the protected package, keep shares separately, then acknowledge its receipt.');
  }
  const api=createClient(r.config.origin,{send,job,edge:r.config.mode==='install'?localEdge(db):null});phase('seal_and_cluster_check');if(r.config.basic&&(await status(api)).state==='sealed')return {verification:{state:'awaiting_user_action',label:'OpenBao requires manual unseal with the separately retained recovery shares.',complete:false}};const ready=await requireReady(api,r);job.fence();
  // External seal parameters and cluster identity are observed, never configured.
  if(r.resources?.seal&&r.resources.seal!==ready.seal)throw fail('External seal configuration changed; review with its owner. No seal migration was attempted.');
  db.prepare('UPDATE setup_openbao SET resources_json=? WHERE id=1').run(JSON.stringify({...r.resources,clusterId:ready.clusterId,seal:ready.seal}));r=readOpenBao(db);
  if(r.config.basic&&!r.bootstrap_complete)return {verification:{state:'awaiting_user_action',label:'Submit the transient initial root token to configure owned scoped access; it will be revoked after verification.',complete:false}};
  if(!r.bootstrap_complete)throw fail('Complete the reviewed transient bootstrap handoff, then apply again. No root token is retained as a runtime identity.');
  phase('keycloak_and_access_verification');let provider;try{provider=verifiedProvider(db,r.config.connectionId);await providerProbe({mode:'connect',url:provider.origin,realm:provider.realm});}catch{throw fail('The saved Keycloak provider is unavailable or unverified.');}job.fence();const client=await clientProbe(db,r);job.fence();
  const token=await verifyMachine(r,secrets(db,r),api);let access,proof;
  try{access=await verifyAccess(r,token,api);phase('selected_postgresql_credential');proof=r.config.basic?{state:'scoped_read_and_denial_verified',advancedEngines:'not_configured'}:await flow(r,token,api,{job});}finally{await api('/v1/auth/token/revoke-self',{method:'POST',token}).catch(()=>{});}
  await requireReady(api,r);job.fence();currentPlan(db,r);
  const verification={state:r.config.basic?'scoped_access_verified':'credential_flow_verified',label:r.config.basic?'OpenBao is unsealed; owned scoped machine access and denied operations are verified. Database, SSH and PKI engines are optional and untested.':'OpenBao is unsealed; scoped access configuration and the selected disposable PostgreSQL issue/use/revocation flow are verified.',revision:r.revision,fingerprint:digest(r.config),clusterId:ready.clusterId,client,access,proof,verifiedAt:new Date().toISOString()};
  db.prepare('UPDATE setup_openbao SET verified_json=? WHERE id=1').run(JSON.stringify(verification));return {verification};
}
