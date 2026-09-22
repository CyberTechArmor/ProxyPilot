import { makeDb as baseDb, apiFixture } from './pomerium-fixture.js';
import { dockerFixture as baseDocker } from './infisical-fixture.js';
import { VAULTWARDEN_SCHEMA, readVaultwarden, secrets } from '../../lib/setup-engine/vaultwarden-store.js';
import { VAULTWARDEN_IMAGE, expectedSettings, flowAlias, callbackFor } from '../../lib/setup-engine/vaultwarden-logic.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export { apiFixture };
export const inputFor = mode => ({expectedPlanRevision:1,expectedRevision:0,connectionId:'kc-aabbccddeeff',clientId:'proxypilot-vaultwarden',clientSecret:'g7-disposable-client-credential',accessRole:'vault-user',matchExistingEmail:false,allowedIps:['192.0.2.10'],reviewed:true,...(mode==='connect'?{adminToken:'g7-disposable-admin-credential'}:{})});
export function makeDb(path=':memory:',{mode='install'}={}) {
  const db=baseDb(path);db.exec(VAULTWARDEN_SCHEMA);
  if(!readVaultwarden(db)){const p=JSON.parse(db.prepare('SELECT choices_json FROM setup_platform_plan').get().choices_json);p.vaultwarden={mode,url:'https://vault.example.com'};db.prepare('UPDATE setup_platform_plan SET choices_json=?').run(JSON.stringify(p));}return db;
}
export function dockerFixture(){const d=baseDocker();d.images[VAULTWARDEN_IMAGE]={Id:'sha256:g7-fixture-image',Config:{Env:['PATH=/bin'],Entrypoint:['/start.sh'],Cmd:['/vaultwarden']}};const host=d.host;
  d.host=async argv=>{const result=await host(argv);
    if(argv[1]==='create'&&result.code===0)d.objects.container.get(argv[argv.indexOf('--name')+1]).Config.Env.push(...argv.flatMap((x,i)=>x==='--env'?[argv[i+1]]:[]));
    if(argv[1]==='start'&&result.code===0){const data=d.objects.container.get(argv[2]).Mounts.find(m=>m.Destination==='/data').Source;
      // Scripted startup writes markers, NOT evidence of a real vault engine.
      for(const [name,value] of [['rsa_key.pem','G7-FIXTURE-SERVER-KEY'],['db.sqlite3','G7-FIXTURE-VAULT-DATA']])try{writeFileSync(join(data,name),value,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}
    return result;};return d;
}
const escape=x=>String(x).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function adminHtml(r,s,changes={},overrides=[]){return '<form id="config-form">'+Object.entries({...expectedSettings(r),sso_client_secret:s.client,...changes}).map(([k,v])=>`<div class="row is-overridden-${overrides.includes(k)}"><input id="input_${k}" ${typeof v==='boolean'?`type="checkbox" ${v?'checked':''}`:`type="text" value="${escape(v)}"`}></div>`).join('')+'<input id="input_smtp_password" value="UNRELATED-MAIL-SECRET"></form>';}
export function serviceFixture(db){const calls=[],changes={};let state='healthy',version='1.37.3';const send=async(origin,path,options={})=>{
  calls.push({origin,path,method:options.adminToken?'POST-authentication':'GET'});if(state==='unavailable')throw Error('UPSTREAM-SENSITIVE-DETAILS');
  if(path==='/api/version')return {status:200,body:version};if(path==='/alive')return {status:state==='unhealthy'?503:200,body:'fixture-date'};
  if(path==='/admin/'){const r=readVaultwarden(db),s=secrets(db,r);return options.adminToken===s.admin?{status:200,body:adminHtml(r,s,changes,Object.keys(changes))}:{status:401,body:null};}throw Error('Unexpected fixture endpoint');
};return {send,calls,changes,set state(v){state=v;},set version(v){version=v;}};}
export function keycloakFixture(r){const calls=[],c={id:'vw-client-id',clientId:r.config.clientId,protocol:'openid-connect',enabled:true,standardFlowEnabled:true,fullScopeAllowed:false,redirectUris:[callbackFor(r)],webOrigins:[r.config.origin],attributes:{'pkce.code.challenge.method':'S256','access.token.lifespan':'600'},authenticationFlowBindingOverrides:{browser:'vw-flow'}};
  const realm={realm:'proxypilot',enabled:true,webAuthnPolicyPasswordlessRpId:'identity.example.com',webAuthnPolicyPasswordlessUserVerificationRequirement:'required',webAuthnPolicyPasswordlessResidentKey:'required'};
  const executions=[{providerId:'webauthn-authenticator-passwordless',requirement:'REQUIRED',level:0},{authenticationFlow:true,requirement:'CONDITIONAL',level:0},{providerId:'conditional-user-role',requirement:'REQUIRED',level:1,authenticationConfig:'role-condition'},{providerId:'deny-access-authenticator',requirement:'REQUIRED',level:1}];
  const condition={condUserRole:`${r.config.clientId}.${r.config.accessRole}`,negate:'true'},roles=[{name:r.config.accessRole,composite:false}];
  const getReader=async()=>async path=>{calls.push(path);if(path==='')return realm;if(path.includes('/clients?'))return [c];if(path==='/authentication/flows')return [{id:'vw-flow',alias:flowAlias(r),builtIn:false,topLevel:true}];if(path.endsWith('/executions'))return executions;if(path.includes('/authentication/config/'))return {config:condition};if(path.endsWith('/roles'))return roles;if(path==='/authentication/required-actions')return [{alias:'webauthn-register-passwordless',enabled:true}];if(path.endsWith('/optional-client-scopes'))return [{name:'offline_access'}];if(path.endsWith('/default-client-scopes'))return [{name:'profile'},{name:'email'}];throw Error('Unexpected observer path');};return {getReader,calls,c,realm,executions,condition,roles};
}
