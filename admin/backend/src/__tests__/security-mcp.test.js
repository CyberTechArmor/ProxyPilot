import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {setup,auth} from './helpers/sso-fixture.js';
import {mintMcpToken,hashMcpToken} from '../lib/mcp-logic.js';
const effects=[];globalThis.__mcpHost=(bin,args)=>{effects.push({bin,args});if(bin==='incus'&&args[0]==='list')return Promise.resolve({status:0,stdout:JSON.stringify([{name:'pp-allowed'},{name:'pp-other'}]),stderr:''});throw new Error('Unexpected host effect');};
registerHooks({load(url,ctx,next){if(url.endsWith('/lib/lxc-zip.js'))return {format:'module',shortCircuit:true,source:readFileSync(new URL(url),'utf8').replace(/export function runHostCapture\([\s\S]*?\} = \{\}\) \{/, '$& return globalThis.__mcpHost(bin,args);')};return next(url,ctx);}});
const {createMcpRouter,createMcpAdminRouter}=await import('../routes/mcp.js');
async function fixture(){
 const f=await setup();f.db.exec(`DROP TABLE mcp_tokens;
 CREATE TABLE mcp_tokens(id INTEGER PRIMARY KEY,name TEXT,token_hash TEXT,created_by TEXT,created_at TEXT,last_used_at TEXT,revoked_at TEXT,scope_json TEXT,token_prefix TEXT,expires_at TEXT,parent_id INTEGER,review_required INTEGER DEFAULT 0);
 CREATE TABLE mcp_ledger(id INTEGER PRIMARY KEY,ts TEXT,token_id INTEGER,actor TEXT,tool TEXT,subject_type TEXT,subject_id TEXT,project_id INTEGER,args_json TEXT,outcome TEXT,dry_run INTEGER,confirmation_used INTEGER,snapshot TEXT,summary TEXT,detail_json TEXT,duration_ms INTEGER);`);
 f.app.use('/api/mcp',createMcpRouter());f.app.use('/api/mcp-tokens',auth.authenticateToken,createMcpAdminRouter());
 f.key=(scope,extra={})=>{const token=mintMcpToken();const r=f.db.prepare('INSERT INTO mcp_tokens(name,token_hash,created_by,created_at,scope_json,expires_at,parent_id,review_required) VALUES(?,?,?,?,?,?,?,?)').run('fixture',hashMcpToken(token),'admin',new Date().toISOString(),scope===null?null:JSON.stringify(scope),extra.expiry??new Date(Date.now()+86400_000).toISOString(),extra.parent??null,extra.review??0);return {token,id:Number(r.lastInsertRowid)};};
 f.rpc=(key,name,args={})=>f.request('/api/mcp',{headers:{authorization:`Bearer ${key.token}`},body:{jsonrpc:'2.0',id:1,method:name==='tools/list'?name:'tools/call',params:{name,arguments:args}}});
 f.result=r=>JSON.parse(r.data.result.content[0].text);
 return f;
}
test('actual MCP delegation cannot widen scope or expiry; inherited children follow parent authority',async()=>{
 const f=await fixture();try{
 const parent=f.key({tools:['create_scoped_key','get_settings']});
 for(const scope of [null,{}, {tools:['create_scoped_key','get_settings'],self_edit:true},{tools:['get_settings','reboot_host']},{tools:null},{tools:[],bogus:true}]){
  const r=await f.rpc(parent,'create_scoped_key',{name:'forbidden',scope,confirm:true});assert.equal(r.data.result.isError,true,JSON.stringify(r.data));
 }
 for(const days of [0,2])assert.equal((await f.rpc(parent,'create_scoped_key',{name:'long',expires_in_days:days,confirm:true})).data.result.isError,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM mcp_tokens').get().n,1);
 const pending=await f.rpc(parent,'create_scoped_key',{name:'child'});assert.match(JSON.stringify(pending.data),/confirm/i);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM mcp_tokens').get().n,1);
 const created=f.result(await f.rpc(parent,'create_scoped_key',{name:'child',confirm:true}));assert(created.token,JSON.stringify(created));
 const child={id:created.id,token:created.token};const row=f.db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(child.id);
 assert.equal(row.parent_id,parent.id);assert.equal(row.expires_at,f.db.prepare('SELECT expires_at FROM mcp_tokens WHERE id=?').get(parent.id).expires_at);
 assert.equal((await f.rpc(child,'get_settings',{keys:['admin_domain']})).data.result.isError,false);
 f.db.prepare('UPDATE mcp_tokens SET scope_json=? WHERE id=?').run(JSON.stringify({tools:['create_scoped_key']}),parent.id);
 assert.equal((await f.rpc(child,'get_settings')).status,401);
 f.db.prepare('UPDATE mcp_tokens SET scope_json=?,revoked_at=? WHERE id=?').run(JSON.stringify({tools:['create_scoped_key','get_settings']}),new Date().toISOString(),parent.id);
 assert.equal((await f.rpc(child,'get_settings')).status,401);
 }finally{await f.close();}
});
test('catalog and execution fail closed for empty/malformed scopes, cross-resource aliases and inactive owners',async()=>{
 const f=await fixture();try{
 const empty=f.key({tools:[]});assert.deepEqual((await f.rpc(empty,'tools/list')).data.result.tools,[]);assert.equal((await f.rpc(empty,'get_settings')).data.result.isError,true);
 const malformed=f.key(null);f.db.prepare('UPDATE mcp_tokens SET scope_json=? WHERE id=?').run('{',malformed.id);assert.equal((await f.rpc(malformed,'get_settings')).status,401);
 const legacy=f.key(null,{review:1});assert.equal((await f.rpc(legacy,'tools/list')).status,401);
 const scoped=f.key({lxc_containers:['allowed']});effects.length=0;
 for(const [name,args] of [['get_settings',{}],['run_lxc_command',{container:'other',command:'id'}],['clone_lxc_container',{container:'allowed',new_name:'other'}],['list_projects',{}],['push_git_remote',{kind:'project',target:1}],['push_git_remote',{kind:'lxc',target:'other'}],['restore_guest_from_snapshot',{guest:'other',new_name:'allowed'}]]){
 const r=await f.rpc(scoped,name,args);assert.equal(r.data.result.isError,true,JSON.stringify(r.data));
 }
 assert.equal(effects.length,0);
 const inventory=f.result(await f.rpc(scoped,'list_lxc_containers'));assert.deepEqual(inventory.containers.map(c=>c.name),['allowed']);assert.equal(effects.length,1);
 const catalog=(await f.rpc(scoped,'tools/list')).data.result.tools;assert(!catalog.some(t=>t.name==='get_settings'||t.name==='list_projects'));
 const active=f.key({tools:['get_settings']});
 for(const role of ['pending','user']){f.db.prepare("UPDATE users SET role=? WHERE id='admin'").run(role);assert.equal((await f.rpc(active,'get_settings')).status,401);}
 f.db.prepare("UPDATE users SET role='admin' WHERE id='admin'").run();
 f.db.prepare('UPDATE mcp_tokens SET expires_at=? WHERE id=?').run('invalid',active.id);assert.equal((await f.rpc(active,'get_settings')).status,401);
 f.db.prepare('UPDATE mcp_tokens SET expires_at=?,parent_id=? WHERE id=?').run('2099-01-01',active.id,active.id);assert.equal((await f.rpc(active,'get_settings')).status,401);
 }finally{await f.close();}
});
test('dashboard grants require CSRF, fresh local proof and explicit policy; review preserves hash',async()=>{
 const f=await fixture();try{
 const stale=f.local('admin','pilot.example.com',false);const session=f.local();const body={name:'reviewed',scope:{tools:['get_settings']},expires_in_days:1};
 assert.equal((await f.request('/api/mcp-tokens',{cookie:stale.cookie,body})).status,403);
 assert.equal((await f.request('/api/mcp-tokens',{cookie:session.cookie,csrf:false,body})).status,403);
 for(const bad of [{name:'bad'},{...body,scope:{}},{...body,scope:{tools:[] ,unknown:1}},{...body,scope:{tools:null}}])assert.equal((await f.request('/api/mcp-tokens',{cookie:session.cookie,body:bad})).status,400);
 const minted=await f.request('/api/mcp-tokens',{cookie:session.cookie,body});assert.equal(minted.status,201,JSON.stringify(minted.data));assert.equal(minted.headers.get('cache-control'),'no-store');
 const stored=f.db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(minted.data.id);assert.equal(stored.token_hash,hashMcpToken(minted.data.token));assert(!JSON.stringify(stored).includes(minted.data.token));
 const legacy=f.key(null,{review:1});const before=f.db.prepare('SELECT token_hash FROM mcp_tokens WHERE id=?').get(legacy.id).token_hash;
 const reviewed=await f.request(`/api/mcp-tokens/${legacy.id}/review`,{cookie:session.cookie,body:{...body,review:true}});assert.equal(reviewed.status,200);
 assert.equal(f.db.prepare('SELECT token_hash FROM mcp_tokens WHERE id=?').get(legacy.id).token_hash,before);assert.equal((await f.rpc(legacy,'get_settings')).status,200);
 const inventory=await f.request('/api/mcp-tokens',{cookie:session.cookie});assert(!JSON.stringify(inventory.data).includes(before));assert(!JSON.stringify(inventory.data).includes(minted.data.token));
 }finally{await f.close();}
});
