import { makeDb as baseDb, apiFixture } from './pomerium-fixture.js';
import { FULL_PLATFORM_SCHEMA, saveFullPlatform, reviewFullPlatform, applyFullPlatform, readFullPlatform } from '../../lib/setup-engine/full-platform-store.js';
import { keycloakAdmin, reconcileOwnedIdentity, storeProtected } from '../../lib/setup-engine/full-platform-keycloak.js';
import { runFullPlatformOperation } from '../../lib/setup-engine/full-platform-op.js';
import { INFISICAL_SCHEMA } from '../../lib/setup-engine/infisical-store.js';
import { OPENBAO_SCHEMA } from '../../lib/setup-engine/openbao-store.js';
import { VAULTWARDEN_SCHEMA } from '../../lib/setup-engine/vaultwarden-store.js';
import { createJob, startJob } from '../../lib/setup-engine/store.js';
export { apiFixture };
export const config = () => ({ experience: 'full', publicOrigin: 'https://pilot.example.com', recoveryOrigin: 'https://recovery.example.com', realm: 'proxypilot', recoveryNetworks: ['10.20.30.0/24'],
  services: Object.fromEntries(Object.entries({ keycloak:'identity',pomerium:'access',infisical:'secrets',openbao:'bao',vaultwarden:'vault' }).map(([id,host])=>[id,{mode:'install',url:`https://${host}.example.com`}])) });
export function makeDb(path = ':memory:') {
  const db = baseDb(path); db.exec(FULL_PLATFORM_SCHEMA + INFISICAL_SCHEMA + OPENBAO_SCHEMA + VAULTWARDEN_SCHEMA);
  if (!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='auth_source')) db.exec('ALTER TABLE users ADD COLUMN auth_source TEXT');
  if (!db.prepare('SELECT 1 FROM setup_full_platform').get()) {
    db.exec('DELETE FROM sso_config; DELETE FROM sso_links; DELETE FROM setup_platform_plan');
    db.prepare("UPDATE setup_keycloak SET ownership='managed'").run();
    const j = createJob(db,{app:'pp-platform-keycloak',kind:'keycloak_setup',status:'succeeded'});
    db.prepare('UPDATE setup_keycloak SET last_job_id=?').run(j.id);
  }
  return db;
}
export function approved(db, wanted = config()) { saveFullPlatform(db,{expectedRevision:0,config:wanted,reviewed:true},'admin'); return applyFullPlatform(db,{revision:1,reviewToken:reviewFullPlatform(db).reviewToken,reviewed:true},'admin').job; }
export const handle = id => ({ id, fence(){}, checkpoint(){}, generated(){}, onStep(){} });

// Scripted upstream wire responses, including empty 201/204 API responses.
// Production orchestration, validation, stores, locks and HTTP adapters run.
export function keycloakWire(k) {
  const realms = new Map(), calls = [], passwords = new Map(), configs = new Map(); let seq = 0;
  const uid = () => 'wire-' + (++seq);
  for (const name of ['master',k.realm]) realms.set(name,{realm:{realm:name,attributes:{'proxypilot.installation':k.id},unrelated:'preserved'},clients:[],flows:[],users:[],groups:[],actions:[{alias:'webauthn-register-passwordless',enabled:false}],roles:new Map(),scopes:['profile','email','offline_access'].map(name=>({id:uid(),name,protocol:'openid-connect'}))});
  const management={id:uid(),clientId:'realm-management',roles:['view-realm','view-clients','view-users'].map(name=>({id:uid(),name}))};realms.get(k.realm).clients.push(management);
  realms.get('master').users.push({id:'bootstrap-id',username:'bootstrap-admin',enabled:true}); passwords.set('master:bootstrap-admin','b'.repeat(43));
  const yes=(body={},status=200)=>new Response([201,204].includes(status)?null:JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  const flatten = (r,f,level=0) => (f.executions||[]).flatMap(e=>[{...e,level},...(e.child?flatten(r,r.flows.find(f=>f.alias===e.child),level+1):[])]);
  const send=async(url,options={})=>{
    const u=new URL(url),path=u.pathname,method=options.method||'GET'; const body=options.body&&String(options.headers?.['Content-Type']).includes('json')?JSON.parse(options.body):null;
    calls.push({path,method});
    if(path.endsWith('/protocol/openid-connect/logout'))return yes({},204);
    if(path.endsWith('/protocol/openid-connect/token')){const p=new URLSearchParams(options.body),username=p.get('username');if(passwords.get('master:'+username)!==p.get('password'))return yes({},401);return yes({access_token:username,refresh_token:'refresh'});}
    if(path.endsWith('/protocol/openid-connect/userinfo')){const name=options.headers.Authorization.slice(7);return yes({sub:realms.get('master').users.find(u=>u.username===name)?.id});}
    const parts=path.split('/').filter(Boolean);if(parts[0]!=='admin'||parts[1]!=='realms')return yes({},404);
    const r=realms.get(decodeURIComponent(parts[2]));if(!r)return yes({},404);const p=parts.slice(3).map(decodeURIComponent);
    if(!p.length){if(method==='PUT')Object.assign(r.realm,body);return yes(r.realm,method==='PUT'?204:200);}
    if(p[0]==='authentication'){
      if(p[1]==='required-actions'){if(method==='PUT'){r.actions[0]=body;return yes({},204);}return yes(r.actions);}
      if(p[1]==='config')return yes(configs.get(p[2])||{},configs.has(p[2])?200:404);
      if(p[1]==='executions'&&p[3]==='config'){const e=r.flows.flatMap(f=>f.executions||[]).find(e=>e.id===p[2]);e.authenticationConfig=uid();configs.set(e.authenticationConfig,body);return yes({},201);}
      if(p[1]==='flows'){
        if(p.length===2){if(method==='POST'){r.flows.push({...body,id:uid(),executions:[]});return yes({},201);}return yes(r.flows.filter(f=>f.topLevel).map(({executions,...f})=>f));}
        if(p.length===3&&method==='GET'){const flow=r.flows.find(f=>f.id===p[2]);return flow?yes(flow):yes({},404);}
        const f=r.flows.find(f=>f.alias===p[2]);if(!f)return yes({},404);
        if(p[4]==='execution'){f.executions.push({id:uid(),providerId:body.provider,requirement:'DISABLED',authenticationFlow:false});return yes({},201);}
        if(p[4]==='flow'){const id=uid();r.flows.push({...body,id,topLevel:false,builtIn:false,executions:[]});f.executions.push({id:uid(),flowId:id,authenticationFlow:true,displayName:body.alias,child:body.alias,requirement:'DISABLED'});return yes({},201);}
        if(method==='PUT'){Object.assign(r.flows.flatMap(f=>f.executions).find(e=>e.id===body.id),body);return yes({},204);}
        return yes(flatten(r,f));
      }
    }
    if(p[0]==='client-scopes')return yes(r.scopes);
    if(p[0]==='roles'&&p[1]==='admin')return yes({id:'master-admin-role',name:'admin'});
    if(p[0]==='clients'){
      if(p.length===1){if(method==='POST'){r.clients.push({...body,id:uid(),roles:[],mappers:[],scopes:[],scopeRoles:[]});return yes({},201);}return yes(r.clients.filter(c=>!u.searchParams.has('clientId')||c.clientId===u.searchParams.get('clientId')).map(({secret,roles,mappers,scopes,scopeRoles,...c})=>c));}
      const c=r.clients.find(c=>c.id===p[1]);if(!c)return yes({},404);
      if(p[2]==='client-secret')return yes({value:c.secret});
      if(p[2]==='service-account-user')return yes({id:'sa-'+c.id});
      if(p[2]==='roles'){if(method==='POST'){c.roles.push({...body,id:uid()});return yes({},201);}const role=c.roles.find(r=>r.name===p[3]);return role?yes(role):yes({},404);}
      if(p[2]==='protocol-mappers'){if(method==='POST'){c.mappers.push({...body,id:uid()});return yes({},201);}return yes(c.mappers);}
      if(p[2]==='scope-mappings'){if(method==='POST'){c.scopeRoles.push(...body);return yes({},204);}return yes(c.scopeRoles);}
      if(p[2]?.endsWith('client-scopes')){if(method==='PUT'){c.scopes.push(r.scopes.find(s=>s.id===p[3]));return yes({},204);}return yes(c.scopes);}
    }
    if(p[0]==='groups'){
      if(p.length===1){if(method==='POST'){r.groups.push({...body,id:uid(),path:'/'+body.name,roles:[]});return yes({},201);}return yes(r.groups.filter(g=>g.name===u.searchParams.get('search')));}
      const g=r.groups.find(g=>g.id===p[1]);if(!g)return yes({},404);
      if(p[2]==='role-mappings'){if(method==='POST'){g.roles.push(...body);return yes({},204);}return yes(g.roles);}return yes(g);
    }
    if(p[0]==='users'){
      if(p[1]==='profile'){r.profile ||= {attributes:[]};if(method==='PUT'){r.profile=body;return yes(body);}return yes(r.profile);}
      if(p.length===1){if(method==='POST'){const {credentials,...user}=body;r.users.push({...user,id:uid()});passwords.set(parts[2]+':'+user.username,credentials[0].value);return yes({},201);}return yes(r.users.filter(x=>x.username===u.searchParams.get('username')));}
      if(p[2]==='role-mappings'){const key=p.slice(1).filter(x=>x!=='composite').join('/'),roles=r.roles.get(key)||[];if(method==='POST'){r.roles.set(key,[...roles,...body]);return yes({},204);}return yes(roles);}
      if(p[2]==='groups')return yes({},204);
      if(method==='DELETE'){r.users=r.users.filter(u=>u.id!==p[1]);return yes({},204);}
    }
    throw Error('Unscripted Keycloak API: '+method+' '+path);
  };
  return {send,realms,calls,passwords};
}

/* ------------------------------ the stages ------------------------------ */
// The coordinator runs ONE stage per job (A→B on apply, then C, then D on
// each continue) and nothing past B until the person finishes B. These drive
// it the way the runner and a person would, with every child job scripted.

const scripted = (db, id, status, verification) => db.prepare('UPDATE setup_jobs SET status=?,owner=NULL,verification_json=? WHERE id=?').run(status, verification ? JSON.stringify(verification) : null, id);

/** Stage B's human part, as the retire step records it: permanent administration, linked SSO and recovery verified. */
export function completeStageB(db) {
  const full = readFullPlatform(db), sso = db.prepare('SELECT fingerprint FROM sso_config WHERE id=1').get();
  const state = { ...full.state, administrator: { username: 'admin', email: 'admin@example.com', firstName: 'A', lastName: 'D', localUserId: 'admin', masterId: 'master-id', applicationId: 'app-id', ...(full.state.administrator || {}) },
    administratorVerified: true, recoveryVerified: true, handoffFingerprint: sso?.fingerprint || null };
  db.prepare('UPDATE setup_full_platform SET state_json=? WHERE id=1').run(JSON.stringify(state));
}
/** Continue the applied revision (a new coordinator job for the current stage). */
export function continueJob(db, by = 'admin') { const r = readFullPlatform(db); return applyFullPlatform(db, { revision: r.revision, reviewToken: reviewFullPlatform(db).reviewToken, reviewed: true }, by).job; }

/**
 * Drive the coordinator through stage `through` ('B' | 'C' | 'D'). Service
 * children finish "succeeded / awaiting user action" (their human steps are
 * pending); Pomerium is additionally recorded verified when it is its stage,
 * so stage C completes. Returns the LAST coordinator job and its args.
 */
export async function driveStages(db, { through = 'D', owner = 'runner@fixture#1:a', identity = null, dnsCheck = async () => null, interfaces = { test: [{ address: '10.20.30.40', internal: false }] } } = {}) {
  const k = db.prepare('SELECT * FROM setup_keycloak').get(), wire = keycloakWire(k);
  storeProtected(db, `keycloak-bootstrap-${k.id}`, { installationId: k.id, password: 'b'.repeat(43), retired: false });
  const connect = identity || (async (d, kk, full, { job: j }) => { const a = await keycloakAdmin(kk, 'b'.repeat(43), { send: wire.send, job: j }); try { return await reconcileOwnedIdentity(d, kk, full, a.api, j); } finally { await a.close(); } });
  let job = approved(db), args, result;
  const settle = async (stage) => {
    startJob(db, { id: job.id, owner });
    args = { db, params: { revision: readFullPlatform(db).revision }, job: handle(job.id), identity: connect, interfaces, dnsCheck };
    for (let i = 0; i < 8; i++) {
      result = await runFullPlatformOperation(args);
      for (const c of db.prepare("SELECT id,kind FROM setup_jobs WHERE id!=? AND status='queued'").all(job.id)) {
        scripted(db, c.id, 'succeeded', { state: 'awaiting_user_action', label: 'Scripted handoff pending' });
        if (c.kind === 'verify_sso') db.prepare('UPDATE sso_config SET verified_at=?,verified_json=?').run(new Date().toISOString(), JSON.stringify({ valid: true }));
        if (c.kind === 'pomerium_apply' && stage === 'C') { db.prepare('UPDATE setup_pomerium SET verified_json=? WHERE id=1').run(JSON.stringify({ state: 'verified', label: 'Scripted Pomerium verification' })); scripted(db, c.id, 'succeeded', { state: 'verified', label: 'Scripted Pomerium verification' }); }
      }
      if (!result.waiting) { scripted(db, job.id, 'succeeded', result.verification); return; }
    }
    throw Error(`Coordinator did not settle in stage ${stage}`);
  };
  await settle('B');
  if (through !== 'B') {
    completeStageB(db);
    job = continueJob(db); await settle('C');
    if (through !== 'C') { job = continueJob(db); await settle('D'); }
  }
  return { job, args, result, k, wire };
}
