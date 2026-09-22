import { randomBytes } from 'node:crypto';
import { encryptSecret,decryptSecret,isEncrypted } from '../secrets.js';
import { createJob,getJob,jobView } from './store.js';
import { INFISICAL_APP,INFISICAL_ROOT,INFISICAL_IMAGE,AGENT_PROXY_IMAGE,TEST_ENV,TEST_PATH,TEST_KEY,PROXY_KEY,digest,privateIp,infisicalError as fail,infisicalConfigSchema,infisicalIdentitiesSchema,expectedPolicies,desiredProxiedService } from './infisical-logic.js';
export const INFISICAL_SCHEMA=`
CREATE TABLE IF NOT EXISTS setup_infisical(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,config_json TEXT NOT NULL,identities_json TEXT,credential_ref TEXT NOT NULL,last_job_id TEXT,edge_job_id TEXT,resources_json TEXT,verified_json TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS setup_infisical_credentials(id TEXT PRIMARY KEY,value TEXT NOT NULL);`;
export function readInfisical(db) {
  if(!db.prepare("SELECT name FROM sqlite_master WHERE name='setup_infisical'").get())return null;
  const r=db.prepare('SELECT * FROM setup_infisical WHERE id=1').get();
  return r?{...r,config:JSON.parse(r.config_json),identities:r.identities_json?JSON.parse(r.identities_json):null,resources:r.resources_json?JSON.parse(r.resources_json):null}:null;
}
export function infisicalState(db) { const r=readInfisical(db);return r?{revision:r.revision,config:r.config,identities:r.identities,credentialRef:r.credential_ref,resources:r.resources,job:r.last_job_id?jobView(getJob(db,r.last_job_id)):null,verification:r.verified_json?JSON.parse(r.verified_json):null}:null; }
export function infisicalSecrets(db,r) { const raw=db.prepare('SELECT value FROM setup_infisical_credentials WHERE id=?').get(r.credential_ref)?.value;
  try {if(!isEncrypted(raw))throw Error();return JSON.parse(decryptSecret(raw));}catch{throw fail('Protected Infisical references cannot be decrypted. Restore the matching backup set; do not regenerate keys.');} }
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const out=fn();db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}
function idle(db,r){if(r?.last_job_id&&['queued','running'].includes(getJob(db,r.last_job_id)?.status))throw fail('An Infisical operation is pending. Wait or cancel it before saving changes.');}
function choice(db){const p=db.prepare('SELECT * FROM setup_platform_plan WHERE id=1').get();return p?{revision:p.revision,...JSON.parse(p.choices_json).infisical}:null;}
export function saveInfisical(db,raw){const input=infisicalConfigSchema.parse(raw);return transaction(db,()=>{
  const old=readInfisical(db);idle(db,old);const plan=choice(db);
  if(!plan||plan.revision!==input.expectedPlanRevision||plan.mode==='skip')throw fail('Save an active Infisical platform plan first; skipped plans install nothing.');
  if((old?.revision||0)!==input.expectedRevision)throw fail('Infisical settings changed. Reopen and review them.');
  if(input.agentMode!==(plan.agentProxyMode||plan.mode))throw fail('Agent Proxy choice changed. Save and reopen the platform plan first.');
  const origin=new URL(plan.url);
  if(origin.protocol!=='https:'||origin.port||origin.pathname!=='/'||!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(origin.hostname))throw fail('Infisical requires a dedicated HTTPS DNS origin on port 443.');
  let proxyOrigin=null;
  if(input.agentMode!=='skip') {const p=new URL(plan.agentProxyUrl);if(p.protocol!=='http:'||!privateIp(p.hostname)||p.port!=='17322')throw fail('Agent Proxy uses its documented private HTTP transport at an RFC1918 address on port 17322.');proxyOrigin=p.origin;
    if(p.hostname!==input.testHost)throw fail('The supported local Agent Proxy must bind the reviewed private address on this host.');
    if(input.agentMode==='connect'&&!input.externalProxyContainer)throw fail('Connect requires an existing Agent Proxy Docker container on this host for read-only isolation/configuration verification.');
  }
  const config={mode:plan.mode,origin:origin.origin,proxyOrigin,agentMode:input.agentMode,testHost:input.testHost,agentVm:input.agentVm,allowedIps:[...new Set(input.allowedIps)].sort(),externalProxyContainer:input.agentMode==='connect'?input.externalProxyContainer:null};
  if(old){if(digest(config)!==digest(old.config))throw fail('Saved installation targets are immutable in G5. Restore the reviewed choices; migration is outside this slice.');return infisicalState(db);}
  const ref=`infisical-${randomBytes(12).toString('hex')}`;
  db.prepare('INSERT INTO setup_infisical_credentials VALUES (?,?)').run(ref,encryptSecret(JSON.stringify({})));
  db.prepare('INSERT INTO setup_infisical(id,revision,config_json,credential_ref,created_at) VALUES(1,1,?,?,?)').run(JSON.stringify(config),ref,new Date().toISOString());return infisicalState(db);
});}
export function saveInfisicalIdentities(db,raw){const input=infisicalIdentitiesSchema.parse(raw);return transaction(db,()=>{
  const r=readInfisical(db);idle(db,r);if(!r||r.revision!==input.expectedRevision)throw fail('Infisical settings changed. Reopen them.');
  const kinds=['workload',...(r.config.agentMode==='skip'?[]:['proxy','agent'])];
  if(kinds.some(k=>!input[k])||(r.config.agentMode==='skip'&&(input.proxy||input.agent)))throw fail('Supply exactly the separate identities needed by the selected flows.');
  if(new Set(kinds.map(k=>input[k].identityId)).size!==kinds.length||new Set(kinds.map(k=>input[k].clientId)).size!==kinds.length)throw fail('Workload, proxy and agent must have different machine identities and credentials.');
  const identities={organizationId:input.organizationId,projectId:input.projectId,...Object.fromEntries(kinds.map(k=>[k,{identityId:input[k].identityId,clientId:input[k].clientId}]))};
  const protectedValues=Object.fromEntries(kinds.map(k=>[k,input[k].clientSecret]));
  if(r.identities){if(digest(r.identities)!==digest(identities)||digest(infisicalSecrets(db,r))!==digest(protectedValues))throw fail('Retries preserve existing identities and credentials; rotation is outside G5.');return infisicalState(db);}
  db.prepare('UPDATE setup_infisical_credentials SET value=? WHERE id=?').run(encryptSecret(JSON.stringify(protectedValues)),r.credential_ref);
  db.prepare('UPDATE setup_infisical SET identities_json=?,revision=revision+1,verified_json=NULL WHERE id=1').run(JSON.stringify(identities));return infisicalState(db);
});}
export function reviewInfisical(db){const r=readInfisical(db);if(!r)return null;
  const handoff={organization:'Create or select one dedicated test organization. Preserve unrelated organizations.',project:'Create or select one dedicated Secret Management project; use the environment and folder below only.',environment:TEST_ENV,path:TEST_PATH,secretName:TEST_KEY,proxySecretName:PROXY_KEY,
    identityInstructions:'Create separate machine identities with organization No Access and project No Access. Enable Universal Auth; use a 300-second access-token TTL/max TTL. Add exactly the scoped policies shown. Do not grant Admin, Member, Viewer, wildcards, dynamic-secret leases or additional memberships.',
    policies:r.identities?expectedPolicies(r.identities,r.config.agentMode):null,proxiedService:r.identities&&r.config.agentMode!=='skip'?desiredProxiedService(r.config,r.identities.projectId):null,
    edition:'Static Agent Proxy is available in the self-hosted default. Scoped permissions depend on edition/entitlements; a denied permission-audit or policy capability blocks verification. Keycloak human SSO is optional and requires oidcSSO; it is never a base-flow prerequisite.',
    proxyRuntime:{network:r.config.agentMode==='connect'?'Existing dedicated bridge, inspected without changes':`pp-if-${r.credential_ref.slice(-12)}-proxy-net`,volume:r.config.agentMode==='connect'?'Existing named volume at /root/.infisical, inspected without changes':`pp-if-${r.credential_ref.slice(-12)}-proxy-state`,container:r.config.externalProxyContainer||`pp-if-${r.credential_ref.slice(-12)}-proxy`,environmentRef:`${INFISICAL_ROOT}/agent-proxy.env`,command:['secrets','agent-proxy','start','--unmatched-host=block','--poll-interval=30','--telemetry=false'],logging:'none'},
    protectedDirectory:INFISICAL_ROOT,backup:'Keep the PostgreSQL-consistent data backup, Redis data, protected directory, ProxyPilot SQLite/encryption key and Caddy references together. The standard configuration pack alone omits service data.'};
  return {revision:r.revision,config:r.config,identities:r.identities,images:{infisical:INFISICAL_IMAGE,agentProxy:AGENT_PROXY_IMAGE},handoff,
    changes:['Install creates only named owned containers/networks/volumes and the reviewed restricted Caddy route. Connect verifies without changing its runtime.','Verify only the reviewed organization, project, environment and identities. Preserve unrelated identity resources.',r.config.agentMode==='skip'?'Create one disposable application secret only if absent; reject any conflicting existing value.':'Create disposable application/proxy test secrets only if absent; reject any conflicting existing value.','Verify a test consumer, explicit denial and the selected Agent Proxy flow from the existing isolated test VM.'],reviewToken:digest([r.revision,r.config,r.identities])};
}
export function applyInfisical(db,input,by){return transaction(db,()=>{const r=readInfisical(db),review=reviewInfisical(db),p=choice(db);
  if(!r||r.revision!==input.revision||review.reviewToken!==input.reviewToken)throw fail('Review the current saved Infisical settings before applying.');
  if(!p||p.mode==='skip'||p.mode!==r.config.mode||(p.agentProxyMode||p.mode)!==r.config.agentMode||p.url!==r.config.origin||(r.config.agentMode!=='skip'&&p.agentProxyUrl!==r.config.proxyOrigin))throw fail('The platform plan changed or is skipped. Restore its reviewed choices before applying.');
  const prior=r.last_job_id?getJob(db,r.last_job_id):null;
  if(prior&&['queued','running'].includes(prior.status))return {job:jobView(prior),created:false};
  const job=createJob(db,{app:INFISICAL_APP,kind:'infisical_apply',plan:{params:{revision:r.revision}},configRefs:{credentials:r.credential_ref},requestedBy:by,via:'ui',retryOf:r.last_job_id,reason:'Reviewed Infisical setup queued for the independent runner. Resources and keys are preserved.'});
  db.prepare('UPDATE setup_infisical SET last_job_id=?,edge_job_id=NULL,verified_json=NULL WHERE id=1').run(job.id);return {job:jobView(job),created:true};
});}
