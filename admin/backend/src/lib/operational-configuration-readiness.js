import {projectBrokerResponse} from './credential-broker-projection.js';
// Optional disposable integration only. Caller supplies permission-filtered
// broker metadata; unknown fields are stripped before constructing readiness.
export async function assessConfigurationConnections({readConnections,actor,agent,readiness,clock=Date.now}) {
 if(!readConnections)return readiness;
 const base={...readiness,state:'blocked',can_start:false,execution_enabled:false};
 try {
  const {connections}=projectBrokerResponse('list',await readConnections(actor));
  const records=[];
  for(const c of connections) {
   if(c.project_id!==null&&c.project_id!==agent.project_id)continue;
   for(const g of c.assignments) {
    if(g.agent_id!==agent.id||g.project_id!==agent.project_id||g.user_id!==actor.id)continue;
    // Public shared-connection metadata does not carry the user's permission
    // ceilings. Only an owner can be assessed here without inventing those.
    const scopeVerified=c.owner_id===actor.id;
    const effective_operations=scopeVerified?(g.operations??[]).filter(x=>agent.controls.operations.includes(x)&&c.operations.includes(x)):[];
    const effective_resources=scopeVerified?(g.resources??[]).filter(x=>agent.controls.resources.includes(x)&&c.resources.includes(x)):[];
    const effective_limits=scopeVerified?{max_actions:Math.min(g.limits?.max_actions??0,c.limits.max_actions,agent.controls.max_actions),max_seconds:Math.min(g.limits?.max_seconds??0,c.limits.max_seconds,agent.controls.max_seconds)}:{max_actions:0,max_seconds:0};
    const revoked=g.revoked||c.status==='revoked';
    const valid=scopeVerified&&!revoked&&g.expires_at>clock()&&c.rights.includes('use')&&c.status==='active'&&c.readiness.state==='ready'&&effective_operations.length>0&&effective_resources.length>0&&effective_limits.max_actions>0&&effective_limits.max_seconds>0;
    records.push({connection_id:c.id,connection_revision:c.revision,policy_revision:c.policy_revision,credential_version:c.credential_version,credential_status:c.status,
      test_state:c.status==='active'?'ready':'unverified',assignment_id:g.id,assignment_revision:g.revision,expires_at:g.expires_at,
      state:valid?'ready':revoked?'revoked':'unverified',code:valid?'ASSIGNMENT_CURRENT':revoked?'ASSIGNMENT_REVOKED':scopeVerified?'ASSIGNMENT_UNVERIFIED':'PERMISSION_SCOPE_UNVERIFIED',effective_operations,effective_resources,effective_limits});
   }
  }
  const ready=records.some(r=>r.state==='ready'),revoked=records.length>0&&records.every(r=>r.state==='revoked');
  const credentialTested=records.some(r=>r.credential_status==='active'),credentialRevoked=records.length>0&&records.every(r=>r.credential_status==='revoked');
  return {...base,connections:records,checks:[...base.checks.filter(c=>!['broker','assignment','vault','adapter','credential'].includes(c.kind)),
   {kind:'broker',state:'ready',code:'BROKER_REACHABLE',next_action:null},
   {kind:'vault',state:'unverified',code:'VAULT_LIVENESS_UNVERIFIED',next_action:'test_connection'},
   {kind:'adapter',state:'ready',code:'ADAPTER_SUPPORTED',next_action:null},
   {kind:'credential',state:credentialTested?'ready':credentialRevoked?'revoked':'unverified',code:credentialTested?'CREDENTIAL_TESTED':credentialRevoked?'CREDENTIAL_REVOKED':'CREDENTIAL_UNVERIFIED',next_action:credentialTested?null:'test_connection'},
   {kind:'assignment',state:ready?'ready':revoked?'revoked':'unverified',code:ready?'ASSIGNMENT_CURRENT':revoked?'ASSIGNMENT_REVOKED':'ASSIGNMENT_UNVERIFIED',next_action:ready?null:'select_connection'}]};
 }catch{return {...base,connections:[],checks:[...base.checks.filter(c=>!['broker','assignment'].includes(c.kind)),
  {kind:'broker',state:'unavailable',code:'BROKER_UNAVAILABLE',next_action:'review_deployment'},
  {kind:'assignment',state:'unverified',code:'ASSIGNMENT_UNVERIFIED',next_action:'select_connection'}]};}
}
