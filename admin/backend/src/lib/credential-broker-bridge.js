// Disposable fixture adapter only. A dashboard JWT/signature is not human proof.
export function createSyntheticBrokerBridge({broker,resolveProof,isolatedFixture=false,intake=null,intakeOrigin=null,fixtureScope=null}) {
 if(isolatedFixture!==true || typeof resolveProof!=='function')throw new Error('Isolated fixture authority required');
 const unavailable=()=>{throw Object.assign(new Error('Broker-owned intake required'),{code:'BROKER_UNAVAILABLE'});};
 const activeIntake=!!(intake&&intakeOrigin&&fixtureScope);
 return {capabilities:()=>({contract_version:'broker.v1',mode:'synthetic',intake_enabled:activeIntake,execution_enabled:false,
   intake_origin:activeIntake?intakeOrigin:null,adapters:[{id:'synthetic-ledger-v1',type:'static_api_token',supported:true}],reason:'SYNTHETIC_ONLY'}),async request({action,actor,id,body,query,expected}) {
  const proof=await resolveProof(actor.id);
  if(!proof)throw Object.assign(new Error('Independent identity required'),{code:'AUTH_REQUIRED'});
  switch(action) {
   case 'list':return {connections:query.assignable_to_agent_id?
      await broker.listAssignableConnections(proof,{project_id:query.project_id,agent_id:query.assignable_to_agent_id}):
      await broker.listConnections(proof,{project_id:query.project_id}),next_cursor:null};
   case 'enroll':if(!activeIntake)unavailable();return {intent:await intake.reserve(proof,{kind:'enroll',connection:{...body,...fixtureScope}})};
   case 'rotate':if(!activeIntake)unavailable();return {intent:await intake.reserve(proof,{kind:'rotate',connection_id:id,revision:expected})};
   case 'intent':if(!activeIntake)unavailable();return {intent:await intake.status(proof,id)};
   case 'get':return {connection:await broker.detail(proof,id)};
   case 'assignments':case 'sessions':{const d=await broker.detail(proof,id);return {[action]:d[action]};}
   case 'activity':return {events:await broker.activity(proof,id)};
   case 'test':return {connection:await broker.testConnection(proof,id,expected)};
   case 'update':return {connection:await broker.rename(proof,id,expected,body.name)};
   case 'revoke':return {connection:await broker.revoke(proof,id,expected)};
   case 'assign':return {assignment:await broker.assign(proof,id,expected,{...body,expires_at:Date.parse(body.expires_at)})};
   case 'unassign':return {assignment:await broker.unassign(proof,id,expected)};
   default:return unavailable();
  }
 }};
}
