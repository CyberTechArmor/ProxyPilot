import { verifyPomeriumClient } from './pomerium-identity.js';
import { readPomerium,pomeriumIntents,verifiedProvider } from './pomerium-store.js';
import { POMERIUM_APP,pomeriumJobSchema,pomeriumError as fail } from './pomerium-logic.js';
import { ensurePomeriumRuntime } from './pomerium-runtime.js';
import { verifyPrivateApplications,verifyPomeriumGateway } from './pomerium-probes.js';
import { verifyKeycloak } from './keycloak-discovery.js';
import { createJob,getJob } from './store.js';

export async function runPomeriumOperation({db,params,exec,job,runtime=ensurePomeriumRuntime,privateProbe=verifyPrivateApplications,gatewayProbe=verifyPomeriumGateway,providerProbe=verifyKeycloak,clientProbe=verifyPomeriumClient}) {
  pomeriumJobSchema.parse(params);
  let r=readPomerium(db);
  if(!r || r.revision!==params.revision || r.last_job_id!==job.id) throw fail('Saved Pomerium operation was superseded.');
  const current=()=>JSON.parse(getJob(db,job.id)?.progress_json||'{}');
  const k=verifiedProvider(db,r.config.connectionId);
  job.checkpoint('provider_verification',{resumable:true,pomerium:true});
  let clientEvidence;
  const intents=pomeriumIntents(db).filter(i=>i.state!=='removed' || i.revision===r.revision);
  const edge=async stage=>{
    r=readPomerium(db);
    let child=r.edge_job_id?getJob(db,r.edge_job_id):null;
    if(!child || JSON.parse(child.plan_json).params.stage!==stage) {
      job.fence();db.exec('BEGIN IMMEDIATE');
      try {child=createJob(db,{app:POMERIUM_APP,kind:'configure_pomerium_routes',plan:{params:{revision:r.revision,stage}},requestedBy:'pomerium_apply',via:'system'});db.prepare('UPDATE setup_pomerium SET edge_job_id=? WHERE id=1').run(child.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    }
    if(['queued','running'].includes(child.status)) return false;
    if(child.status!=='succeeded') throw fail('The recorded Caddy gateway step failed; inspect its saved job and retry.');
    return true;
  };
  // The stage is durable on the parent and the child reference. Browser/API
  // restart cannot skip the denial or duplicate the route work.
  if(current().verificationFailure) {
    if(!await edge('deny')) return {waiting:true,reason:'Gateway verification failed; waiting for durable Caddy denial.'};
    throw fail(current().verificationFailure);
  }
  await providerProbe({mode:'connect',url:k.origin,realm:k.realm});job.fence();
  clientEvidence=await clientProbe(db,r);job.fence();
  if(!current().denialApplied) {
    job.checkpoint('deny_routes',{resumable:true,pomerium:true});
    if(!await edge('deny')) return {waiting:true,reason:'Waiting for the recorded Caddy deny/authentication route step.'};
    job.progress({denialApplied:true});
  }
  const privateEvidence=await privateProbe(intents,{exec,job});job.fence();
  if(!current().runtimeVerified) {
    job.checkpoint('gateway_runtime',{resumable:true,pomerium:true});
    const resources=await runtime(db,r,intents,{exec,job});job.fence();
    db.prepare('UPDATE setup_pomerium SET resources_json=? WHERE id=1').run(JSON.stringify(resources));
    job.progress({runtimeVerified:true});
  }
  if(!current().gatewayApplied) {
    job.checkpoint('gateway_routes',{resumable:true,pomerium:true});
    if(!await edge('gateway')) return {waiting:true,reason:'Waiting for the recorded Caddy gateway route step.'};
    job.progress({gatewayApplied:true});
  }
  job.checkpoint('gateway_verification',{resumable:true,pomerium:true});
  let gateway;
  try {gateway=await gatewayProbe(r.config,intents,{exec,job});job.fence();}
  catch(e) {
    job.fence();
    job.progress({verificationFailure:'Gateway verification failed. The recorded denial step must succeed before retry; no route is certified.'});
    await edge('deny');
    return {waiting:true,reason:'Gateway verification failed; durable Caddy denial queued.'};
  }
  const verification={state:'gateway_verified',label:'Pomerium gateway configuration, private upstreams and unauthenticated/spoof checks verified. Browser authorization acceptance is separate.',revision:r.revision,clientEvidence,privateEvidence,gateway,loginFlow:'operator_browser_check',verifiedAt:new Date().toISOString()};
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const i of intents) db.prepare('UPDATE setup_route_protection SET state=?,verified_json=? WHERE route_id=?').run(i.action==='remove'?'removed':'protected',JSON.stringify({revision:r.revision,verifiedAt:verification.verifiedAt}),i.routeId);
    db.prepare('UPDATE setup_pomerium SET verified_json=?,applied_revision=? WHERE id=1').run(JSON.stringify(verification),r.revision);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {verification};
}
