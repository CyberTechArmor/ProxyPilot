import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'pp-mcp-resume-'));
process.env.DATABASE_PATH=join(dir,'test.db');process.env.TOTP_ENCRYPTION_KEY='a'.repeat(64);process.env.NODE_ENV='test';
const {initDatabase,getDb}=await import('../db.js');
const {mcpKeyRefusal}=await import('../lib/mcp-key-authority.js');
test('upgrade resumes only proven dashboard roots, retaining secrets, scope and lifetime exactly once',()=>{
 try{
 initDatabase();const db=getDb();
 for(const [id,role] of [['admin','admin'],['demoted','user']])db.prepare('INSERT INTO users(id,username,password_hash,totp_secret,totp_enabled,role) VALUES(?,?,?,?,?,?)').run(id,id,'hash','secret',1,role);
 const created=new Date().toISOString();const expiry=new Date(Date.now()+86400000).toISOString();
 function key(name,changes={}){
  const row={name,created_by:'admin',created_at:created,scope_json:null,expires_at:expiry,parent_id:null,revoked_at:null,review_required:1,...changes};
  const result=db.prepare(`INSERT INTO mcp_tokens(name,token_hash,created_by,created_at,scope_json,expires_at,parent_id,revoked_at,review_required) VALUES(?,?,?,?,?,?,?,?,?)`).run(row.name,'preserved-'+randomUUID(),row.created_by,row.created_at,row.scope_json,row.expires_at,row.parent_id,row.revoked_at,row.review_required);
  return db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(Number(result.lastInsertRowid));
 }
 function audit(row,changes={}){
  const value={id:randomUUID(),user_id:row.created_by,resource_id:row.name,details:JSON.stringify({expires_at:row.expires_at,never_expires:row.expires_at===null}),created_at:created.slice(0,19).replace('T',' '),...changes};
  db.prepare("INSERT INTO audit_log(id,user_id,action,resource_type,resource_id,details,created_at) VALUES(?,?,'MCP_TOKEN_CREATED','mcp_token',?,?,?)").run(value.id,value.user_id,value.resource_id,value.details,value.created_at);
 }
 const old=key('legacy');audit(old);
 const never=key('non-expiring',{expires_at:null});audit(never);
 const modern=key('scoped dashboard',{scope_json:'{"tools":["get_settings"],"project_ids":[1]}'});
 audit(modern,{resource_id:String(modern.id),details:JSON.stringify({scope:JSON.parse(modern.scope_json),expires_at:modern.expires_at})});
 const rejected=[];
 const reject=(name,changes={},auditChanges={})=>{const row=key(name,changes);audit(row,auditChanges);rejected.push(row);return row;};
 rejected.push(key('no audit'));
 reject('wrong owner',{}, {user_id:'demoted'});
 reject('old audit',{}, {created_at:'2025-01-01 00:00:00'});
 reject('wrong expiry',{}, {details:JSON.stringify({expires_at:null,never_expires:true})});
 reject('inconsistent lifetime',{}, {details:JSON.stringify({expires_at:expiry,never_expires:true})});
 const duplicate=reject('duplicate audit');audit(duplicate);
 reject('duplicate name');rejected.push(key('duplicate name'));
 reject('malformed scope',{scope_json:'{'});
 reject('legacy scoped child',{scope_json:'{"tools":["get_settings"]}'});
 reject('expired',{expires_at:'2025-01-01T00:00:00Z'});
 reject('revoked',{revoked_at:created});
 reject('demoted',{created_by:'demoted'});
 reject('missing owner',{created_by:null});
 reject('known child',{parent_id:old.id});
 reject('modern scope mismatch',{scope_json:'{"tools":[]}'},{resource_id:'99999',details:JSON.stringify({scope:{tools:['get_settings']},expires_at:expiry})});
 const delegated=reject('lost lineage');
 db.prepare("INSERT INTO mcp_ledger(ts,tool,subject_type,subject_id,outcome) VALUES(?,'create_scoped_key','mcp_token',?,'ok')").run(created,String(delegated.id));
 db.prepare('DELETE FROM schema_migrations WHERE version=1016').run();initDatabase();
 for(const original of [old,never,modern]){
  const row=db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(original.id);
  assert.deepEqual(row,{...original,review_required:0},original.name);
  assert.equal(mcpKeyRefusal(db,row),null,original.name);
 }
 for(const original of rejected)assert.deepEqual(db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(original.id),original,original.name);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='MCP_TOKEN_RESUMED'").get().n,3);
 db.prepare('UPDATE mcp_tokens SET revoked_at=? WHERE id=?').run(created,old.id);
 initDatabase();assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='MCP_TOKEN_RESUMED'").get().n,3);
 assert.match(mcpKeyRefusal(db,db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(old.id)),/revoked/i);
 db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
