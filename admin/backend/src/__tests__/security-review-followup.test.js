import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';

process.env.JWT_SECRET = 'security-service-fixture-only-'.repeat(3);
const dir = mkdtempSync(join(tmpdir(), 'pp-services-security-'));
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT);
 CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at TEXT,last_used_at TEXT DEFAULT CURRENT_TIMESTAMP,revoked_at TEXT,sudo_until TEXT,ip TEXT,user_agent TEXT);
 CREATE TABLE user_service_access(user_id TEXT,service_id TEXT,can_view INTEGER,can_write INTEGER);
 CREATE TABLE user_permissions(user_id TEXT,permission TEXT);
 CREATE TABLE services(id TEXT PRIMARY KEY,name TEXT,type TEXT,kind TEXT,is_admin INTEGER DEFAULT 0,is_favorite INTEGER DEFAULT 0,created_at TEXT,data_dir TEXT);
 CREATE TABLE service_http_routes(id TEXT,service_id TEXT,domain TEXT,path_prefix TEXT,target_port INTEGER,websocket_enabled INTEGER,ssl_enabled INTEGER,force_https INTEGER,max_upload_size TEXT,created_at TEXT);
 CREATE TABLE file_versions(id TEXT PRIMARY KEY,service_id TEXT,file_path TEXT,content TEXT,version INTEGER,notes TEXT,created_by TEXT,created_at TEXT);
 CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);`);
for (const [id, role] of [['admin','admin'],['user','user'],['editor','user'],['pending','pending']]) db.prepare('INSERT INTO users VALUES(?,?)').run(id,role);
for (const id of ['allowed','other']) db.prepare('INSERT INTO services(id,name,type,kind,data_dir) VALUES(?,?,?,?,?)').run(id,id,'static','static',dir);
db.prepare('INSERT INTO user_service_access VALUES(?,?,1,1)').run('editor','allowed');
writeFileSync(join(dir,'page.txt'),'original');
db.exec("ALTER TABLE services ADD COLUMN lxc_container_name TEXT; UPDATE services SET lxc_container_name=name; INSERT INTO user_permissions VALUES('editor','proxy');");
const calls=[];
const exec = () => { throw new Error('callback interface not used'); };
exec[promisify.custom] = async (command) => { calls.push({command}); return {stdout:'',stderr:''}; };
const execFile = () => { throw new Error('callback interface not used'); };
execFile[promisify.custom] = async (bin,args,opts) => {
  calls.push({bin,args,opts});
  return {stdout:args.includes('python3')||bin==='python3'?args.at(-1)+'\n':'ok',stderr:''};
};
const spawn = (bin,args) => {
  calls.push({bin,args});
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('exit',0); }); return child;
};
globalThis.__serviceSecurity={db,calls,exec,execFile,spawn,childProcess};
globalThis.__reviewExports={list:()=>[{id:7,container:'other'}],queueStatus:()=>({}),get:()=>({id:7,container:'other'}),openForDownload:async()=>{calls.push({sink:'open-other-export'});return {error:'isolated host read stopped'};}};
registerHooks({resolve(specifier, context, next) {
  if(specifier.endsWith('/lib/lxc-exports-instance.js')) return {shortCircuit:true,url:'data:text/javascript,export const exportStore=()=>globalThis.__reviewExports;export const resolveExportCompression=()=>{throw new Error("Not used")};'};
  if (specifier.endsWith('/db.js') && new URL(specifier,context.parentURL).pathname.endsWith('/admin/backend/src/db.js')) return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`
    export const getDb=()=>globalThis.__serviceSecurity.db;
    export const getSetting=k=>getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(k)?.value;
    export const runMigration=()=>{throw new Error('No migrations in fixture')};export const setSetting=()=>{};export const getAdminDomain=()=> 'pilot.test';export const databasePath=()=>'/tmp/unused';
    export const logAudit=()=>{};export const AUDIT_TERMINAL_SESSION_START='start';export const AUDIT_TERMINAL_SESSION_END='end';`)};
  if (['child_process','node:child_process'].includes(specifier)) return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`
    const c=globalThis.__serviceSecurity;
    export const exec=c.exec,execFile=c.execFile,spawn=c.spawn,spawnSync=()=>{throw new Error('Unexpected spawnSync')},execSync=()=>{throw new Error('Unexpected execSync')},execFileSync=()=>{throw new Error('Unexpected execFileSync')};`) };
  return next(specifier,context);
}});
const { authenticateToken, blockPendingRole, generateToken } = await import('../middleware/auth.js');
const { csrfProtection } = await import('../middleware/csrf.js');
const {lxcRouter}=await import('../routes/lxc.js');
const {createEditorMcpRouter,createEditorAdminRouter}=await import('../routes/mcp-editor.js');
const {createEditorKey,setActivation}=await import('../lib/editor-keys.js');
const app=express();app.use(express.json(),cookieParser());app.use('/api',csrfProtection);
app.use('/api/services',authenticateToken,blockPendingRole,lxcRouter);
app.use('/api/mcp-editor',createEditorMcpRouter());
app.use('/api/editor-admin',authenticateToken,blockPendingRole,createEditorAdminRouter());
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}/api/services`;
const tokens=new Map();
for (const id of ['admin','user','editor','pending']) tokens.set(id,generateToken({id,username:id,role:db.prepare('SELECT role FROM users WHERE id=?').get(id).role}));
db.prepare("UPDATE sessions SET sudo_until=? WHERE user_id='admin'").run(new Date(Date.now()+60000).toISOString());
async function request(user,path,{method='GET',body,csrf=true}={}) {
  return fetch(base+path,{method,headers:{...(user?{authorization:`Bearer ${tokens.get(user)}`} : {}),...(csrf?{cookie:'pp_csrf=fixture','x-csrf-token':'fixture'}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
}
test.after(()=>{server.close();server.closeAllConnections();db.close();rmSync(dir,{recursive:true,force:true});delete globalThis.__serviceSecurity;});



test('shared network mutations require admin; invalid admin input never executes', async () => {
  calls.length=0;
  assert.equal((await request('editor','/networks/incusbr0',{method:'PUT',body:{config:{'ipv4.address':'auto;printf MARKER'}}})).status,403);
  for (const config of [{'ipv4.address':'auto;printf MARKER'},{'user.exec':'$(id)'},{'ipv4.nat':'true\nfalse'}]) {
    assert.equal((await request('admin','/networks/incusbr0',{method:'PUT',body:{config}})).status,400);
  }
  assert.equal(calls.length,0);
});
test('approved network values reach the host only as fixed argv', async () => {
  calls.length=0;
  const r=await request('admin','/networks/incusbr0',{method:'PUT',body:{config:{'ipv4.nat':'true'}}});
  assert.equal(r.status,200); assert.equal(calls.length,1);
  const {bin,args}=calls[0];
  const argv=bin==='incus' ? args : args.slice(args.indexOf('incus')+1);
  assert.deepEqual(argv,['network','set','incusbr0','ipv4.nat','true']);
  assert.equal(calls[0].command,undefined);
});
test('export list and download honor guest grants before host reads',async()=>{
  assert.equal((await request('editor','/containers/other')).status,403);
  const listed=await request('editor','/exports'); assert.equal(listed.status,200);
  assert.deepEqual((await listed.json()).exports,[]);
  assert.equal((await request('editor','/exports/7')).status,403);
  calls.length=0;
  assert.equal((await request('editor','/exports/7/download')).status,403);
  assert.equal(calls.length,0);
  globalThis.__reviewExports.get=()=>({id:8,container:'allowed'});
  assert.equal((await request('editor','/exports/8')).status,200);
});
test('editor grants and docroot activation require fresh local proof before host access', async () => {
  calls.length=0;
  for (const [path,method,body] of [['keys','POST',{label:'attempt'}],['activation','PUT',{active:true,docroot:'/srv/app'}]]) {
    const r=await fetch(base.replace('/api/services','/api/editor-admin')+'/other/'+path,{method,headers:{authorization:'Bearer '+tokens.get('admin'),cookie:'pp_csrf=fixture','x-csrf-token':'fixture','content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(r.status,403); assert.equal((await r.json()).code,'LOCAL_SESSION_REQUIRED');
  }
  assert.equal(calls.length,0);
});
test('editor authority expires and follows live creator status',async()=>{
  db.exec("CREATE TABLE lxc_editor_activations(container_name TEXT PRIMARY KEY,docroot TEXT,active INTEGER,created_by TEXT,created_at TEXT,updated_at TEXT);CREATE TABLE lxc_editor_keys(id INTEGER PRIMARY KEY,scope_type TEXT,container_name TEXT,label TEXT,token_hash TEXT,token_prefix TEXT,created_by TEXT,created_at TEXT,last_used_at TEXT,revoked_at TEXT,expires_at TEXT);");
  setActivation({containerName:'other',docroot:'/opt/app',active:true,createdBy:'admin'});
  const {token,row}=createEditorKey({containerName:'other',label:'fixture',createdBy:'admin'});
  const rpc=()=>fetch(base.replace('/api/services','/api/mcp-editor'),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
  assert.equal((await rpc()).status,200);
  db.prepare('UPDATE lxc_editor_keys SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z',row.id);
  assert.equal((await rpc()).status,403);
  db.prepare('UPDATE lxc_editor_keys SET expires_at=? WHERE id=?').run('2099-01-01T00:00:00Z',row.id);
  for(const action of ["UPDATE users SET role='user' WHERE id='admin'", "UPDATE users SET role='pending' WHERE id='admin'","DELETE FROM users WHERE id='admin'"]){db.exec(action);assert.equal((await rpc()).status,403);}
});
test('read-only SQL refuses psql commands before dispatch and uses the protocol reader',async()=>{
  const {createProjectConfigHandlers}=await import('../routes/mcp-tools/project-config.js');
  const captures=[];
  const handlers=createProjectConfigHandlers({ctx:{mock2Modules:async()=>({}),requireActiveProject:()=>({project:{id:1}}),projectContainerName:()=> 'pp-review'},policy:{exports_dir:'/tmp'},reader:(_n,fn)=>fn,mutation:(_n,_o,fn)=>fn,ok:x=>x,err:x=>({error:x}),projectSh:async(name,script,args,options)=>{captures.push({name,script,input:options.input});return {status:0,stdout:JSON.stringify({columns:['n'],rows:[['1']],row_count:1,truncated:false})};},tail:x=>x});
  const bad=await handlers.run_project_sql({project_id:1,sql:'SELECT 1\n\\! printf SQL_MARKER'});
  assert(bad.error);assert.equal(captures.length,0);
  const out=await handlers.run_project_sql({project_id:1,sql:'SELECT 1 AS n'});
  assert.equal(out.row_count,1);assert.equal(captures.length,1);
  assert.deepEqual(JSON.parse(captures[0].input),{sql:'SELECT 1 AS n',limit:200});
  assert.match(captures[0].script,/PQsendQueryParams/);
  assert.match(captures[0].script,/runuser -u pp_mcp_reader/);
  assert.doesNotMatch(captures[0].script,/su - postgres|psql .* -f/);
});
