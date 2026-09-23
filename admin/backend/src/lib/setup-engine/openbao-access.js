import { fail,digest,namesFor,policyFor,humanRoleFor,machineRoleFor,roleFor,databaseDetails } from './openbao-logic.js';
import { secrets,putSecrets } from './openbao-store.js';
import { ok,requireReady } from './openbao-api.js';
// Compare only documented readback fields; default-valued fields are checked
// explicitly where an alternate value could broaden authentication or policy.
const same=(a,b)=>digest(a)===digest(b);
export function assertFields(actual,wanted,label){if(!actual||Object.entries(wanted).some(([k,v])=>!same(actual[k],v)))throw fail(`${label} differs from the reviewed owned configuration. Nothing was overwritten.`);}
export async function verifyMachine(r,v,api){const n=namesFor(r);if(!v.roleId)throw fail('Complete the reviewed OpenBao bootstrap handoff first.');
  const a=ok(await api(`/v1/auth/${n.approle}/login`,{method:'POST',body:{role_id:v.roleId,secret_id:v.machine}}),'Machine login')?.auth;
  if(!a?.client_token||!same([...(a.policies||[])].sort(),[n.machine])||a.lease_duration>120||a.lease_duration<=0){if(a?.client_token)await api('/v1/auth/token/revoke-self',{method:'POST',token:a.client_token}).catch(()=>{});throw fail('Machine authentication did not return the exact limited policy and TTL.');}
  const token=a.client_token;
  try{const paths=[r.config.basic?`${n.prefix}-kv/data/health`:`${n.database}/creds/reader`,`${n.database}/creds/not-allowed`,'sys/mounts','sys/policies/acl/default','secret/data/unrelated'];
    const caps=ok(await api('/v1/sys/capabilities-self',{method:'POST',token,body:{paths}}))?.data;
    if(!caps||!same(caps[paths[0]],['read'])||paths.slice(1).some(p=>!same(caps[p],['deny'])))throw fail('Machine permissions are broader or narrower than the reviewed scope.');
    for(const path of paths.slice(1))if((await api('/v1/'+path,{token})).status!==403)throw fail('OpenBao did not enforce a selected denied operation.');
    return token;
  }catch(e){await api('/v1/auth/token/revoke-self',{method:'POST',token}).catch(()=>{});throw e;}}
export async function bootstrap(db,r,input,api,{job,verifyDatabase}){const current=await requireReady(api,r),n=namesFor(r),v=secrets(db,r),token=input.bootstrapToken;
  // Bind the first observed ready cluster before any remote mutation. Even an
  // interrupted bootstrap must never adopt a replacement instance on retry.
  job.fence();db.prepare('UPDATE setup_openbao SET resources_json=? WHERE id=1').run(JSON.stringify({...r.resources,clusterId:current.clusterId,seal:current.seal}));
  // Read-only audit of ALL intended names precedes the first write, even on connect.
  const mounts=ok(await api('/v1/sys/mounts',{token})).data,auth=ok(await api('/v1/sys/auth',{token})).data;
  const owned=[{map:mounts,name:r.config.basic?n.prefix+'-kv':n.database,type:r.config.basic?'kv':'database',path:'sys/mounts'},{map:auth,name:n.oidc,type:'oidc',path:'sys/auth'},{map:auth,name:n.approle,type:'approle',path:'sys/auth'}];
  for(const x of owned){const a=x.map?.[x.name+'/'];if(a&&(a.type!==x.type||a.description!==r.credential_ref))throw fail('An intended mount belongs to another configuration. External resources were preserved.');}
  for(const p of [n.human,n.machine]){const res=await api(`/v1/sys/policies/acl/${p}`,{token});if(res.status!==404&&(res.status!==200||res.body?.data?.policy!==policyFor(r)))throw fail('A policy name collides with different existing rules. Nothing was overwritten.');}
  if(!r.config.basic){if(!input.databasePassword)throw fail('The advanced database flow requires its transient database credential.');await verifyDatabase(r,input.databasePassword);}job.fence();
  for(const x of owned)if(!x.map?.[x.name+'/'])ok(await api(`/v1/${x.path}/${x.name}`,{method:'POST',token,body:{type:x.type,description:r.credential_ref,...(x.type==='kv'?{options:{version:'2'}}:{})}}),'Owned mount creation');
  for(const p of [n.human,n.machine]){const path=`/v1/sys/policies/acl/${p}`,res=await api(path,{token});if(res.status===404)ok(await api(path,{method:'PUT',token,body:{policy:policyFor(r)}}));else if(res.body?.data?.policy!==policyFor(r))throw fail('Owned policy drifted.');}
  const ensure=async(path,wanted,label,write=wanted)=>{const res=await api('/v1/'+path,{token});if(res.status===404||res.status===200&&!res.body?.data)ok(await api('/v1/'+path,{method:'POST',token,body:write}),label);else if(res.status!==200)throw fail(`${label} readback failed.`);const after=ok(await api('/v1/'+path,{token}),label)?.data;assertFields(after,wanted,label);return after;};
  const oidc={oidc_discovery_url:r.config.issuer,oidc_client_id:r.config.clientId,default_role:'mapped',bound_issuer:r.config.issuer};
  await ensure(`auth/${n.oidc}/config`,oidc,'Human OIDC configuration',{...oidc,oidc_client_secret:v.client});
  const human=await ensure(`auth/${n.oidc}/role/mapped`,humanRoleFor(r),'Human policy mapping');
  if(human.token_policies_template_claims||human.bound_subject||human.groups_claim||human.claim_mappings&&Object.keys(human.claim_mappings).length)throw fail('Human role has unreviewed identity/template mappings.');
  const machine=await ensure(`auth/${n.approle}/role/workload`,machineRoleFor(r),'Machine AppRole');
  if(machine.token_period||machine.token_num_uses||machine.local_secret_ids)throw fail('Machine AppRole has unreviewed token restrictions.');
  if(r.config.basic){
    const path=`/v1/${n.prefix}-kv/data/health`, before=await api(path,{token});
    if(before.status===404)ok(await api(path,{method:'POST',token,body:{data:{owner:r.credential_ref}}}),'Owned scope marker');
    const marker=ok(await api(path,{token}))?.data?.data;
    if(marker?.owner!==r.credential_ref)throw fail('The owned scope marker differs; unrelated values were preserved.');
  } else {
  const dbSpec={plugin_name:'postgresql-database-plugin',allowed_roles:['reader'],connection_details:databaseDetails(r)};
  // API readbacks intentionally omit password; never rewrite an existing connection.
  const configPath=`/v1/${n.database}/config/selected`,before=await api(configPath,{token});
  if(before.status===404)ok(await api(configPath,{method:'POST',token,body:{plugin_name:dbSpec.plugin_name,allowed_roles:['reader'],...dbSpec.connection_details,password:input.databasePassword,verify_connection:true}}),'Selected disposable database');
  else if(before.status!==200)throw fail('Database connection readback failed.');
  const config=ok(await api(configPath,{token}))?.data;assertFields(config,{plugin_name:dbSpec.plugin_name,allowed_roles:['reader']},'Database connection');assertFields(config.connection_details,dbSpec.connection_details,'Database target');
  await ensure(`${n.database}/roles/reader`,roleFor(r),'Limited database role');
  }
  const id=ok(await api(`/v1/auth/${n.approle}/role/workload/role-id`,{token}))?.data?.role_id;if(!id||v.roleId&&v.roleId!==id)throw fail('Machine role identity changed; no replacement is accepted.');
  const lookup=await api(`/v1/auth/${n.approle}/role/workload/secret-id/lookup`,{method:'POST',token,body:{secret_id:v.machine}});
  if([204,404].includes(lookup.status)){if(v.registrationAttempted)throw fail('Machine credential registration is missing or uncertain. Recover the existing credential; automatic reissue is refused.');job.fence();putSecrets(db,r,{...v,roleId:id,registrationAttempted:true});ok(await api(`/v1/auth/${n.approle}/role/workload/custom-secret-id`,{method:'POST',token,body:{secret_id:v.machine,metadata:JSON.stringify({owner:r.credential_ref})}}),'Preserved machine credential');}
  else {const d=ok(lookup)?.data;if(d?.metadata?.owner!==r.credential_ref)throw fail('Machine credential ownership could not be verified.');}
  const registered=ok(await api(`/v1/auth/${n.approle}/role/workload/secret-id/lookup`,{method:'POST',token,body:{secret_id:v.machine}}))?.data;if(registered?.metadata?.owner!==r.credential_ref)throw fail('Registered machine credential ownership was not verified.');
  job.fence();putSecrets(db,r,{...v,roleId:id,registrationAttempted:true});
  const machineToken=await verifyMachine(r,{...v,roleId:id},api);ok(await api('/v1/auth/token/revoke-self',{method:'POST',token:machineToken}));
  // Bootstrap token (including a managed initial root token) is transient and
  // explicitly revoked after the separately protected machine identity works.
  ok(await api('/v1/auth/token/revoke-self',{method:'POST',token}),'Bootstrap token revocation');
  if((await api('/v1/auth/token/lookup-self',{token})).status!==403)throw fail('Bootstrap token revocation could not be verified.');
  job.fence();db.prepare('UPDATE setup_openbao SET bootstrap_complete=1,resources_json=?,verified_json=NULL WHERE id=1').run(JSON.stringify({...r.resources,clusterId:current.clusterId,seal:current.seal}));
  return {state:'bootstrap_complete',label:'Owned human/machine access configured. Bootstrap token revoked; apply verifies the disposable credential flow.'};
}
export async function verifyAccess(r,token,api){const n=namesFor(r);const get=async path=>ok(await api('/v1/'+path,{token}),'Owned access readback')?.data;
  for(const p of [n.human,n.machine])if((await get(`sys/policies/acl/${p}`))?.policy!==policyFor(r))throw fail('Owned OpenBao policies drifted; verification is withheld.');
  assertFields(await get(`auth/${n.oidc}/config`),{oidc_discovery_url:r.config.issuer,oidc_client_id:r.config.clientId,default_role:'mapped',bound_issuer:r.config.issuer},'Human OIDC connection');
  assertFields(await get(`auth/${n.oidc}/role/mapped`),humanRoleFor(r),'Human group mapping');
  assertFields(await get(`auth/${n.approle}/role/workload`),machineRoleFor(r),'Machine AppRole');
  if(r.config.basic){if((await get(`${n.prefix}-kv/data/health`))?.data?.owner!==r.credential_ref)throw fail('Owned scoped read failed.');}
  else {
  assertFields(await get(`${n.database}/roles/reader`),roleFor(r),'Selected database role');
  const config=await get(`${n.database}/config/selected`);assertFields(config,{plugin_name:'postgresql-database-plugin',allowed_roles:['reader']},'Selected database connection');assertFields(config.connection_details,databaseDetails(r),'Selected database target');
  }
  return {humanConfiguration:true,machinePolicy:true,unmappedRule:'bound_claims_requires_exact_group',humanBrowserAcceptance:'pending_real_host'};
}
