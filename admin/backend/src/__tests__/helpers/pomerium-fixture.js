import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { ensureSetupEngineSchema,PLATFORM_PLAN_SCHEMA } from '../../lib/setup-engine/store.js';
import { KEYCLOAK_SCHEMA } from '../../lib/setup-engine/keycloak-store.js';
import { SSO_SCHEMA } from '../../lib/sso/store.js';
import { POMERIUM_SCHEMA } from '../../lib/setup-engine/pomerium-store.js';
import express from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
process.env.TOTP_ENCRYPTION_KEY='b'.repeat(64);
process.env.JWT_SECRET='g4-isolated-fixture-not-a-live-secret'.repeat(2);
let currentDb;
globalThis.__g4Db=()=>currentDb;
registerHooks({resolve(specifier,context,next){
  if(specifier.endsWith('/db.js') && context.parentURL?.includes('/admin/backend/src/')) return {url:'data:text/javascript,'+encodeURIComponent(`export const getDb=()=>globalThis.__g4Db();export const getAdminDomain=()=>getSetting('admin_domain');export const getSetting=k=>getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(k)?.value;export function logAudit(u,a,t,i,d){getDb().prepare('INSERT INTO audit VALUES (?,?)').run(a,JSON.stringify(d));}`),shortCircuit:true};
  return next(specifier,context);
}});
export function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS services(id TEXT PRIMARY KEY,name TEXT,kind TEXT,runtime TEXT CHECK(runtime IN ('lxc','docker') OR runtime IS NULL),target_ip TEXT,type TEXT,status TEXT,is_admin INTEGER DEFAULT 0,root_dir TEXT,container_name TEXT,data_dir TEXT);
CREATE TABLE IF NOT EXISTS service_http_routes(id TEXT PRIMARY KEY,service_id TEXT,domain TEXT,path_prefix TEXT,target_port INTEGER,websocket_enabled INTEGER DEFAULT 0,ssl_enabled INTEGER DEFAULT 1,force_https INTEGER DEFAULT 1,max_upload_size TEXT DEFAULT '1G',strip_prefix INTEGER DEFAULT 0,read_timeout_seconds INTEGER,write_timeout_seconds INTEGER,max_body_bytes INTEGER,host_header_override TEXT,allow_framing INTEGER,frame_ancestors TEXT,health_path TEXT,extra_headers_json TEXT,csp TEXT,basic_auth_json TEXT,ip_allowlist_json TEXT,rate_limit_json TEXT,UNIQUE(domain,path_prefix));
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT,role TEXT,password_hash TEXT);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at TEXT,last_used_at TEXT DEFAULT CURRENT_TIMESTAMP,revoked_at TEXT,sudo_until TEXT,ip TEXT,user_agent TEXT);
CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS audit(action TEXT,data TEXT);`);
  ensureSetupEngineSchema(db);db.exec(PLATFORM_PLAN_SCHEMA);db.exec(KEYCLOAK_SCHEMA);db.exec(SSO_SCHEMA);db.exec(POMERIUM_SCHEMA);
}
export function makeDb(path=':memory:') {
  const db=new DatabaseSync(path);schema(db);currentDb=db;
  if(db.prepare("SELECT id FROM users WHERE id='admin'").get()) return db;
  db.exec(`INSERT OR IGNORE INTO users VALUES ('admin','Alice','admin','unchanged'),('user','Bob','user','unchanged');
INSERT OR IGNORE INTO app_settings VALUES ('admin_domain','pilot.example.com');
INSERT OR IGNORE INTO services(id,name,kind,runtime,target_ip,type,status) VALUES ('app','G4 test application','container_service',NULL,'127.0.0.1','proxy','active');
INSERT OR IGNORE INTO service_http_routes(id,service_id,domain,path_prefix,target_port) VALUES ('test-route','app','app.example.com','/',18443);`);
  const issuer='https://identity.example.com/realms/proxypilot';
  db.prepare("INSERT OR IGNORE INTO setup_keycloak(id,ownership,origin,realm,created_revision,created_at,verified_json,verified_at) VALUES ('kc-aabbccddeeff','external','https://identity.example.com','proxypilot',1,?,?,?)").run(new Date().toISOString(),JSON.stringify({issuer,issuerExact:true,signingKeys:true}),new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO sso_config(id,revision,config_json,fingerprint,created_by,created_at) VALUES (1,1,?,'g3-fingerprint','admin',?)").run(JSON.stringify({connectionId:'kc-aabbccddeeff',issuer,publicOrigin:'https://pilot.example.com',recoveryOrigin:'https://recovery.example.com',clientId:'proxypilot',readerClientId:'observer'}),new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO sso_links VALUES (?,'subject-alice','admin',?)").run(issuer,new Date().toISOString());
  const choices=Object.fromEntries(['keycloak','pomerium','infisical','openbao','vaultwarden'].map(id=>[id,id==='pomerium'?{mode:'install',url:'https://access.example.com'}:id==='keycloak'?{mode:'connect',url:'https://identity.example.com',realm:'proxypilot'}:{mode:'skip',url:'',...(id==='infisical'?{agentProxyUrl:''}:{})}]));
  db.prepare("INSERT OR IGNORE INTO setup_platform_plan(id,revision,schema_version,choices_json,checks_json,reviewed_at,reviewed_by) VALUES (1,1,1,?,'{\"checks\":[],\"dependencies\":[]}',?,'admin')").run(JSON.stringify(choices),new Date().toISOString());
  return db;
}
export const configInput={expectedPlanRevision:1,expectedRevision:0,connectionId:'kc-aabbccddeeff',clientId:'proxypilot-pomerium',clientSecret:'g4-fixture-client-secret-preserved',reviewed:true};
export async function apiFixture(db) {
  currentDb=db;
  const auth=await import('../../middleware/auth.js');
  const {csrfProtection}=await import('../../middleware/csrf.js');
  const {platformSetupRouter}=await import('../../routes/platform-setup.js');
  const app=express();app.use(express.json());app.use(cookieParser());app.use('/api/',csrfProtection);app.use('/api/setup/platform',auth.authenticateToken,platformSetupRouter);
  app.use((e,_req,res,_next)=>res.status(500).json({error:e.message}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  const tokens={};for(const name of ['admin','user','cold']) {tokens[name]=auth.generateToken(db.prepare('SELECT * FROM users WHERE id=?').get(name==='cold'?'admin':name));if(name==='admin')db.prepare("UPDATE sessions SET sudo_until=? WHERE user_id='admin'").run(new Date(Date.now()+3600000).toISOString());}
  const request=async(path,{who='admin',method='GET',body,csrf=true}={})=>{
    const response=await fetch(url+'/api/setup/platform'+path,{method,headers:{...(who?{Cookie:`pp_token=${tokens[who]}; pp_csrf=fixture-csrf`}:{}),...(csrf?{'X-CSRF-Token':'fixture-csrf'}:{}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'manual'});
    return {status:response.status,body:await response.json(),headers:response.headers};
  };
  return {url,tokens,request,server,app,close:()=>new Promise(r=>server.close(r))};
}
