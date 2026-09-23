import { provisionManagedInfisical } from './full-platform-infisical.js';
import { verifyBasicFlows } from './infisical-basic-flows.js';
import { readInfisical,infisicalSecrets } from './infisical-store.js';
import { INFISICAL_APP,INFISICAL_ROOT,PROXY_KEY,infisicalJobSchema,infisicalError as fail,digest } from './infisical-logic.js';
import { ensureInfisicalRuntime,ensureAgentProxyRuntime,prepareInfisicalFiles,assertLocalTestHost,assertIsolatedAgentVm } from './infisical-runtime.js';
import { createInfisicalClient,requireOk,verifyInfisicalIdentities,ensureTestSecret,verifyServiceHandoff } from './infisical-api.js';
import { verifyCredentialFlows } from './infisical-flows.js';
import { assertInfisicalRouteAvailable } from './infisical-routes.js';
import { createJob,getJob,acquireLock,renewLock,releaseLock,takeoverLock,readLock } from './store.js';

export async function runInfisicalOperation({db,params,exec,job,root=INFISICAL_ROOT,send,runtime=ensureInfisicalRuntime,proxyRuntime=ensureAgentProxyRuntime,hostProbe=assertLocalTestHost,vmProbe=assertIsolatedAgentVm,flows=verifyCredentialFlows,basicFlows=verifyBasicFlows,provision=provisionManagedInfisical}) {
  infisicalJobSchema.parse(params);let r=readInfisical(db);
  if(!r||r.revision!==params.revision||r.last_job_id!==job.id)throw fail('The saved Infisical job was superseded.');
  const phase=name=>job.checkpoint(name,{resumable:true,infisical:true});
  phase('private_target_checks');hostProbe(r.config);const vm=r.config.basic?{uuid:'owned-local-check'}:await vmProbe(r.config,{exec,job});
  if(r.resources?.vmRef&&r.resources.vmRef!==vm.uuid)throw fail('The test VM identity changed. No credential was delivered.');
  let resources=r.resources||{};
  if(r.config.mode==='install'){
    assertInfisicalRouteAvailable(db,r);phase('infisical_runtime');resources={...resources,...await runtime(r,{exec,job,root}),vmRef:vm.uuid};job.fence();
    db.prepare('UPDATE setup_infisical SET resources_json=? WHERE id=1').run(JSON.stringify(resources));
    let child=r.edge_job_id?getJob(db,r.edge_job_id):null;
    if(!child){job.fence();db.exec('BEGIN IMMEDIATE');try{child=createJob(db,{app:INFISICAL_APP,kind:'configure_infisical_route',plan:{params},requestedBy:'infisical_apply',via:'system'});db.prepare('UPDATE setup_infisical SET edge_job_id=? WHERE id=1').run(child.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
    phase('infisical_caddy_route');if(['queued','running'].includes(child.status))return {waiting:true,reason:'Waiting for the recorded restricted Caddy route step. Progress survives browser/API restart.'};
    if(child.status!=='succeeded')throw fail('The Infisical Caddy step failed. Correct its reported conflict and retry the reviewed plan.');
  }
  phase('infisical_bootstrap');
  const api=createInfisicalClient(r.config.origin,{send,job});
  requireOk(await api('/api/status'),'Infisical status');
  const initialized=requireOk(await api('/api/v1/admin/config'),'Infisical administrator initialization').config?.initialized;
  if(r.config.basic&&r.config.mode==='install') {
    const provisioned=await provision(db,r,api,{job});
    if(!provisioned.ready)return {verification:{state:'awaiting_user_action',label:provisioned.action,complete:false}};
    r=readInfisical(db);
  } else if(initialized!==true)throw fail('Complete first-administrator setup through the restricted Infisical route, then perform the exact identity handoff and retry.');
  const values=infisicalSecrets(db,r),tokens=await verifyInfisicalIdentities(r,values,api);job.fence();
  // Connect also keeps its disposable test value locally; no external boot key
  // is copied, replaced or inferred. Retry compares values instead of updating.
  const files=prepareInfisicalFiles({...r,resources:r.config.mode==='install'?resources:r.resources},{root});
  // Bind the disposable VM before any delivery, including an external server's
  // failed/retried flow. A replacement VM must not inherit this authorization.
  resources={...resources,vmRef:vm.uuid,protectedRef:files.bundle,directory:files.root};
  job.fence();db.prepare('UPDATE setup_infisical SET resources_json=? WHERE id=1').run(JSON.stringify(resources));
  phase('application_test_secret');const value=await ensureTestSecret(r,files.keys.test,api,tokens.workload);job.fence();
  let proxyEvidence={state:'skipped'};
  if(r.config.agentMode!=='skip'){
    await ensureTestSecret(r,files.keys.proxyTest,api,tokens.workload,PROXY_KEY);
    phase('proxied_service_handoff');await verifyServiceHandoff(r,api,tokens.agent);
    phase('agent_proxy_runtime');proxyEvidence=await proxyRuntime(r,values,{exec,job,root});job.fence();
  }
  phase('credential_flow_verification');const evidence=r.config.basic?await basicFlows(r,{application:value,proxy:files.keys.proxyTest},tokens,{api,job}):await withVmLease(db,r,job,async guarded=>flows(r,{application:value,proxy:files.keys.proxyTest},tokens,{exec,job:guarded,api,vmProbe:async(config,args)=>{const check=await vmProbe(config,args);if(check.uuid!==vm.uuid)throw fail('The test VM identity changed during verification.');return check;}}));job.fence();
  // Recheck effective grants after the flows; a saved success never certifies
  // a different plan or relies on a previous browser assertion.
  await verifyInfisicalIdentities(r,values,api);job.fence();r=readInfisical(db);
  if(r.revision!==params.revision||r.last_job_id!==job.id)throw fail('Infisical settings changed during verification.');
  const verification={state:r.config.agentMode==='skip'?'application_secret_verified':'infisical_flows_verified',label:r.config.agentMode==='skip'?'Application secret verified; Agent Proxy deliberately skipped.':'Disposable application and Agent Proxy credential flows verified.',revision:r.revision,fingerprint:digest([r.config,r.identities]),...evidence,proxy:proxyEvidence,verifiedAt:new Date().toISOString(),humanSso:'not_configured_edition_oidcSSO_required',scope:'one_disposable_test_secret'};
  db.prepare('UPDATE setup_infisical SET verified_json=?,resources_json=? WHERE id=1').run(JSON.stringify(verification),JSON.stringify({...resources,vmRef:vm.uuid,protectedRef:files.bundle,directory:files.root,proxy:proxyEvidence}));
  return {verification};
}

async function withVmLease(db,r,job,fn) {
  const owner=getJob(db,job.id).owner,app=r.config.agentVm;
  let lease=acquireLock(db,{app,owner,operation:'infisical_test',jobId:job.id,leaseMs:120000});
  if(!lease.ok && lease.reason==='stale' && readLock(db,app)?.job_id===job.id)lease=takeoverLock(db,{app,by:owner,operation:'infisical_test',jobId:job.id,leaseMs:120000,reason:'Resume this interrupted disposable credential test.'});
  if(!lease.ok)throw fail('The disposable test VM has a held or unresolved setup lock. No credentials were delivered.');
  const epoch=Number(lease.lock.epoch);let lost=false;
  const fence=()=>{job.fence();if(lost||!(renewLock(db,{app,owner,epoch,leaseMs:120000})>0))throw fail('The test VM lease was lost. Verification stopped.');};
  const timer=setInterval(()=>{try{fence();}catch{lost=true;}},10000);timer.unref();
  try{return await fn({...job,fence});}finally{clearInterval(timer);releaseLock(db,{app,owner,epoch});}
}
