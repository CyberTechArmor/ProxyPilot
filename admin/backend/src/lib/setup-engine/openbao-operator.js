import { randomBytes } from 'node:crypto';
import { readOpenBao,assertReview,idle } from './openbao-store.js';
import { createJob,startJob,acquireLock,releaseLock,renewLock,heartbeat,fenceJob,finishJob,checkpoint,jobView } from './store.js';
import { OPENBAO_APP,fail } from './openbao-logic.js';
import { createClient,requireReady,status,ok } from './openbao-api.js';
import { bootstrap } from './openbao-access.js';
import { verifyDatabase } from './openbao-postgres.js';
import { verifyClient } from './openbao-identity.js';
import { verifyKeycloak } from './keycloak-discovery.js';
import { verifiedProvider } from './pomerium-store.js';
// An operator's share/bootstrap token is never queued or persisted. This
// short-lived backend operation uses existing durable jobs/leases. If it dies,
// the saved checkpoint asks for a deliberate resubmission, not secret replay.
export async function operatorAction(db,action,input,by,{send,clientProbe=verifyClient,providerProbe=verifyKeycloak,databaseProbe=verifyDatabase}={}){let r=assertReview(db,input);idle(db,r);
  if(action==='bootstrap'&&r.config.mode==='install'&&!r.handoff_ack)throw fail('Acknowledge the separately held recovery handoff before bootstrap.');
  const owner=`backend@openbao#${process.pid}:${randomBytes(5).toString('hex')}`;let job,lease;
  db.exec('BEGIN IMMEDIATE');try{
    job=createJob(db,{app:OPENBAO_APP,kind:'openbao_operator',plan:{params:{revision:r.revision,action}},configRefs:{credentials:r.credential_ref},requestedBy:by,via:'ui',retryOf:r.last_job_id});
    lease=acquireLock(db,{app:OPENBAO_APP,owner,operation:'openbao_operator',jobId:job.id,leaseMs:30000});if(!lease.ok)throw fail('OpenBao has a held or unresolved lease. Reopen its existing job before retrying.');
    job=startJob(db,{id:job.id,owner,leaseMs:30000});db.prepare('UPDATE setup_openbao SET last_job_id=?,verified_json=NULL WHERE id=1').run(job.id);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  let lost=false;const renew=()=>{if(!heartbeat(db,{id:job.id,owner,epoch:job.epoch,leaseMs:30000})||!renewLock(db,{app:OPENBAO_APP,owner,epoch:lease.lock.epoch,leaseMs:30000}))lost=true;};
  const fence=()=>{renew();if(lost)throw fail('OpenBao operator lease was lost. Resubmit only after reviewing the recorded state.');fenceJob(db,{id:job.id,owner,epoch:job.epoch,safe:true});assertReview(db,input);};
  const timer=setInterval(()=>{try{renew();}catch{lost=true;}},10000);timer.unref();
  try{fence();checkpoint(db,{id:job.id,owner,epoch:job.epoch,phase:action,checkpoint:{resumable:false,openbao:true},message:action==='unseal'?'Submitting one transient unseal share.':'Configuring the reviewed owned resources with a transient bootstrap token.'});
    const api=createClient(r.config.origin,{send,job:{fence}});let result;
    if(action==='unseal'){const s=await status(api);if(s.state==='unsealed')result={state:'unsealed',label:'OpenBao is already unsealed. No share submitted.'};else {if(s.state!=='sealed'||s.seal!=='shamir')throw fail('Manual share submission requires an initialized Shamir-sealed instance. External seal configuration is preserved.');ok(await api('/v1/sys/unseal',{method:'POST',body:{key:input.share}}),'Manual unseal');const after=await status(api);if(!['sealed','unsealed'].includes(after.state))throw fail('Unseal result is unavailable; inspect the service before resubmitting.');result={state:after.state,progress:after.progress,threshold:after.threshold,label:after.state==='sealed'?'Share accepted; more shares are required.':'OpenBao unsealed. Reapply the saved plan to verify it.'};}}
    else if(action==='bootstrap'){await requireReady(api,r);let k;try{k=verifiedProvider(db,r.config.connectionId);await providerProbe({mode:'connect',url:k.origin,realm:k.realm});}catch{throw fail('The saved Keycloak provider could not be verified.');}await clientProbe(db,r);result=await bootstrap(db,r,input,api,{job:{fence},verifyDatabase:databaseProbe});}
    else throw fail('Unsupported OpenBao operator action.');
    fence();finishJob(db,{id:job.id,owner,epoch:job.epoch,status:'succeeded',outcome:result.state,reason:result.label,verification:{state:'not_verified',operator:result.state}});return {job:jobView(readJob()),result};
  }catch(e){const message=e.openbaoSafe?e.message:'OpenBao operator request failed; upstream details and submitted material were withheld. Review state and deliberately resubmit if needed.';
    finishJob(db,{id:job.id,owner,epoch:job.epoch,status:'recovery_required',outcome:'operator_retry_required',reason:message,verification:{state:'not_verified'}});throw fail(message);
  }finally{clearInterval(timer);releaseLock(db,{app:OPENBAO_APP,owner,epoch:lease.lock.epoch});input.share=undefined;input.bootstrapToken=undefined;input.databasePassword=undefined;r=null;}
  function readJob(){return db.prepare('SELECT * FROM setup_jobs WHERE id=?').get(job.id);}
}
