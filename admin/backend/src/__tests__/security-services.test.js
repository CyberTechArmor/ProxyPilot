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
const calls=[];
const exec = () => { throw new Error('callback interface not used'); };
exec[promisify.custom] = async (command) => { calls.push({command}); return {stdout:'',stderr:''}; };
const execFile = () => { throw new Error('callback interface not used'); };
execFile[promisify.custom] = async (bin,args,opts) => {
  calls.push({bin,args,opts});
  return {stdout:args.includes('python3')||bin==='python3'?args.at(-1)+'\n':'ok',stderr:''};
};
globalThis.__serviceSecurity={db,calls,exec,execFile,childProcess};
registerHooks({resolve(specifier, context, next) {
  if (specifier.endsWith('/db.js') && context.parentURL?.includes('/src/')) return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`
    export const getDb=()=>globalThis.__serviceSecurity.db;
    export const getSetting=k=>getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(k)?.value;
    export const setSetting=()=>{};export const getAdminDomain=()=> 'pilot.test';export const databasePath=()=>'/tmp/unused';
    export const logAudit=()=>{};export const AUDIT_TERMINAL_SESSION_START='start';export const AUDIT_TERMINAL_SESSION_END='end';`)};
  if (['child_process','node:child_process'].includes(specifier)) return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(`
    const c=globalThis.__serviceSecurity;
    export const exec=c.exec,execFile=c.execFile,spawn=()=>{throw new Error('Unexpected spawn')},spawnSync=()=>{throw new Error('Unexpected spawnSync')},execSync=()=>{throw new Error('Unexpected execSync')},execFileSync=()=>{throw new Error('Unexpected execFileSync')};`) };
  return next(specifier,context);
}});
const { authenticateToken, blockPendingRole, generateToken } = await import('../middleware/auth.js');
const { csrfProtection } = await import('../middleware/csrf.js');
const { servicesRouter } = await import('../routes/services.js');
const { composeOperation } = await import('../lib/docker-compose-operation.js');
const app=express();app.use(express.json(),cookieParser());app.use('/api',csrfProtection);
app.use('/api/services',authenticateToken,blockPendingRole,servicesRouter);
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}/api/services`;
const tokens=new Map();
for (const id of ['admin','user','editor','pending']) tokens.set(id,generateToken({id,username:id,role:db.prepare('SELECT role FROM users WHERE id=?').get(id).role}));
db.prepare("UPDATE sessions SET sudo_until=? WHERE user_id='admin'").run(new Date(Date.now()+60000).toISOString());
async function request(user,path,{method='GET',body,csrf=true}={}) {
  return fetch(base+path,{method,headers:{...(user?{authorization:`Bearer ${tokens.get(user)}`} : {}),...(csrf?{cookie:'pp_csrf=fixture','x-csrf-token':'fixture'}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
}
test.after(()=>{server.close();server.closeAllConnections();db.close();rmSync(dir,{recursive:true,force:true});delete globalThis.__serviceSecurity;});

test('real router denies anonymous/pending and filters delegated service inventory',async()=>{
  assert.equal((await request(null,'/')).status,401);assert.equal((await request('pending','/')).status,403);
  assert.deepEqual((await (await request('user','/')).json()).services,[]);
  assert.deepEqual((await (await request('editor','/')).json()).services.map(s=>s.id),['allowed']);
  assert.equal((await request('editor','/other/files/page.txt')).status,403);
  assert.equal((await request('editor','/allowed/files/page.txt')).status,200);
});
test('host operations and aliases reject non-admins before reaching sinks',async()=>{
  calls.length=0;
  for(const user of ['user','editor']) for(const path of ['/docker/compose','/docker/compose/destroy','/docker/container/stop','/docker/volumes/import','/terminal/execute','/caddy/reload','/import'])
    assert.equal((await request(user,path,{method:'POST',body:{action:'destroy',path:'/root/compose.yml',command:'test'}})).status,403,`${user} ${path}`);
  assert.equal((await request('editor','/allowed/caddy-config',{method:'PUT',body:{config:'x'}})).status,403);
  assert.equal(calls.length,0);
});
test('actual file writes enforce service access, CSRF and symlink refusal',async()=>{
  assert.equal((await request('editor','/other/files/new.txt',{method:'PUT',body:{content:'bad'}})).status,403);
  assert.equal((await request('editor','/allowed/files/new.txt',{method:'PUT',body:{content:'bad'},csrf:false})).status,403);
  assert.equal((await request('editor','/allowed/files/new.txt',{method:'PUT',body:{content:'allowed'}})).status,200);
  assert.equal(readFileSync(join(dir,'new.txt'),'utf8'),'allowed');
  symlinkSync('/etc',join(dir,'escape'));
  assert.equal((await request('editor','/allowed/files/escape/passwd')).status,403);
});
test('administrator Compose operations require sudo and preserve literal argv',async()=>{
  calls.length=0;
  db.prepare("UPDATE sessions SET sudo_until=NULL WHERE user_id='admin'").run();
  assert.equal((await request('admin','/docker/compose',{method:'POST',body:{action:'restart',path:'/root/compose.yml'}})).status,401);
  assert.equal(calls.length,0);
  db.prepare("UPDATE sessions SET sudo_until=? WHERE user_id='admin'").run(new Date(Date.now()+60000).toISOString());
  for(const serviceName of ['app;id','$(id)','a\nb','--help']) assert.equal((await request('admin','/docker/compose',{method:'POST',body:{action:'restart',path:'/root/compose.yml',serviceName}})).status,400);
  assert.equal((await request('admin','/docker/compose',{method:'POST',body:{action:'destroy',path:'/root/compose.yml'}})).status,400);
  assert.equal(calls.length,0);
  assert.equal((await request('admin','/docker/compose',{method:'POST',body:{action:'restart',path:'/root/compose.yml',serviceName:'app'}})).status,200);
  const call=calls.find(c=>c.args?.includes('restart'));assert(call);assert.equal(call.opts.shell,false);
  assert.deepEqual(call.args.slice(-4),['-f','/root/compose.yml','restart','app']);
});
test('Compose validators reject traversal and unreviewed host-wide cleanup',()=>{
  assert.throws(()=>composeOperation({action:'up',path:'/root/../etc/x.yml'}));
  assert.throws(()=>composeOperation({action:'destroy',path:'/root/x.yml',options:{prune:true}},{allowDestroy:true}));
  assert.deepEqual(composeOperation({action:'logs',path:'/root/$(literal).yml',serviceName:'app'}),['-f','/root/$(literal).yml','logs','--tail=100','app']);
});

test('every registered services route carries its declared authorization guard',()=>{
  const source=readFileSync(new URL('../routes/services.js',import.meta.url),'utf8');
  const routes=[...source.matchAll(/servicesRouter\.(get|post|put|delete|patch)\('([^']+)'([^\n]*)/g)];
  assert(routes.length>50);
  for(const [,method,path,rest] of routes) assert(rest.startsWith(`, serviceAccess('${method.toUpperCase()}', '${path}')`),`${method} ${path}`);
});
