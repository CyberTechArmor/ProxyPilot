import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as OTPAuth from 'otpauth';
import {setup,auth} from './helpers/sso-fixture.js';
import {issueBootstrap} from '../../../../cli/src/recovery/bootstrap.js';
import {recoverBootstrapCommand} from '../../../../cli/src/commands/recover.js';
async function fixture(){const f=await setup();f.directory=mkdtempSync(join(tmpdir(),'pp-bootstrap-'));
 f.db.exec("CREATE TABLE audit_log(id TEXT,user_id TEXT,action TEXT,resource_type TEXT,resource_id TEXT,details TEXT);UPDATE users SET password_hash='',totp_secret='',totp_enabled=0 WHERE id='admin'");
 f.app.post('/ordinary',auth.authenticateToken,auth.requireAdmin,(req,res)=>res.json({ok:true}));
 f.issue=(username='admin',options={})=>{const result=issueBootstrap(f.db,username,{directory:f.directory,...options});return {...result,token:readFileSync(result.credentialFile,'utf8').trim()};};
 f.claim=(token,username='admin')=>f.request('/api/auth/initial-setup',{body:{username,bootstrapCredential:token,newPassword:'new-password-fixture',confirmPassword:'new-password-fixture'},csrf:false});
 const close=f.close;f.close=async()=>{await close();rmSync(f.directory,{recursive:true,force:true});};return f;
}
test('public status is minimal; absent/wrong/expired/cross-account or installation proof cannot claim',async()=>{
 const f=await fixture();try{
 assert.deepEqual((await f.request('/api/auth/setup-status')).data,{needsSetup:true});
 assert.equal((await f.claim(undefined)).status,400);
 const expired=f.issue('admin',{now:Date.now()-16*60_000});assert.equal((await f.claim(expired.token)).status,403);
 const issued=f.issue();assert.equal(statSync(issued.credentialFile).mode&0o777,0o600);
 const row=f.db.prepare('SELECT * FROM admin_bootstrap').get();assert(!JSON.stringify(row).includes(issued.token));assert(!JSON.stringify(f.db.prepare('SELECT * FROM audit_log').all()).includes(issued.token));
 assert.equal((await f.claim('ppboot_'+'a'.repeat(43))).status,403);assert.equal((await f.claim(issued.token,'user')).status,403);
 f.db.exec("UPDATE app_settings SET value='other-installation' WHERE key='installation_bootstrap_id'");assert.equal((await f.claim(issued.token)).status,403);
 assert.equal(f.db.prepare("SELECT password_hash FROM users WHERE id='admin'").get().password_hash,'');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);
 }finally{await f.close();}
});
test('concurrent claim consumes once, remains enrollment-only, completes MFA and cannot be replayed',async()=>{
 const f=await fixture();try{
 const issued=f.issue();const replies=await Promise.all([f.claim(issued.token),f.claim(issued.token)]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,403]);
 const result=replies.find(r=>r.status===200);assert.equal(result.headers.get('cache-control'),'no-store');
 const cookie=result.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
 assert.equal((await f.request('/ordinary',{cookie,body:{}})).status,403);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);
 const secret=result.data.totpSecret.secret,totpCode=new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(secret)}).generate();
 const finished=await f.request('/api/auth/complete-totp-setup',{cookie,body:{totpCode,totpSecret:secret}});assert.equal(finished.status,200,JSON.stringify(finished.data));
 assert.equal((await f.claim(issued.token)).status,403);assert.throws(()=>f.issue(),/unclaimed local administrator/);
 assert.equal(f.db.prepare("SELECT totp_enabled FROM users WHERE id='admin'").get().totp_enabled,1);
 assert.deepEqual((await f.request('/api/auth/setup-status')).data,{needsSetup:false});
 }finally{await f.close();}
});
test('root reissue retires expired/abandoned proof; password login resumes an interrupted enrollment',async()=>{
 const f=await fixture();try{
 const old=f.issue(),fresh=f.issue();assert.equal((await f.claim(old.token)).status,403);assert.equal((await f.claim(fresh.token)).status,200);
 f.db.exec('DELETE FROM sessions');
 const resumed=await f.request('/api/auth/login',{csrf:false,body:{username:'admin',password:'new-password-fixture'}});assert.equal(resumed.status,401);assert.equal(resumed.data.enrollmentOnly,true);assert(resumed.data.totpSecret);
 }finally{await f.close();}
});
test('directory and initialized administrators cannot be bootstrapped; nonroot CLI refuses before opening DB',async()=>{
 const f=await fixture();try{
 f.db.exec("UPDATE users SET auth_source='ldap' WHERE id='admin'");assert.throws(()=>f.issue(),/unclaimed local administrator/);assert.deepEqual((await f.request('/api/auth/setup-status')).data,{needsSetup:false});
 f.db.exec("UPDATE users SET auth_source='local' WHERE id='admin';INSERT INTO sso_links VALUES('https://issuer.example','subject','admin','2026-01-01')");assert.throws(()=>f.issue(),/unclaimed local administrator/);assert.deepEqual((await f.request('/api/auth/setup-status')).data,{needsSetup:false});
 let opened=false;const out=[];const code=await recoverBootstrapCommand('admin',{}, {getuid:()=>1000,stdout:s=>out.push(s),openDb:()=>{opened=true;}});assert.equal(code,3);assert.equal(opened,false);
 }finally{await f.close();}
});
