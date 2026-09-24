import test from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import jwt from 'jsonwebtoken';
import { setup, auth } from './helpers/sso-fixture.js';
const {userRouter}=await import('../routes/user.js');
const {verifyWsUpgrade}=await import('../middleware/wsAuth.js');
const code=secret=>new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(secret)}).generate();
const cookieOf=r=>r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
async function fixture() {
  const f=await setup();
  f.db.exec('CREATE TABLE notifications(id TEXT,level TEXT,title TEXT,body TEXT,source TEXT,source_id TEXT,dedupe_key TEXT)');
  f.app.use('/api/user',auth.authenticateToken,userRouter);
  for(const path of ['/api/services','/api/mcp-tokens','/api/setup/platform','/protected-basic'])
    f.app.post(path,auth.authenticateToken,auth.requireAdmin,(req,res)=>res.json({ok:true}));
  return f;
}
test('stolen ordinary session cannot replace an existing factor through either API',async()=>{
  const f=await fixture();try{
    const session=f.local(), secret=new OTPAuth.Secret({size:20}).base32;
    const before=f.db.prepare("SELECT totp_secret FROM users WHERE id='admin'").get().totp_secret;
    const body={totpSecret:secret,secret,totpCode:code(secret)};
    assert.equal((await f.request('/api/auth/complete-totp-setup',{cookie:session.cookie,body,csrf:false})).status,403);
    assert.equal((await f.request('/api/auth/complete-totp-setup',{cookie:session.cookie,body})).status,409);
    assert.equal((await f.request('/api/user/totp/verify',{cookie:session.cookie,body})).status,409);
    assert.equal((await f.request('/api/user/totp/generate',{cookie:session.cookie,body:{currentPassword:'local-password-fixture'}})).status,401);
    assert.equal(f.db.prepare("SELECT totp_secret FROM users WHERE id='admin'").get().totp_secret,before);
  }finally{await f.close();}
});
test('replacement requires existing factor, binds new secret, revokes sessions and emits notification',async()=>{
  const f=await fixture();try{
    const session=f.local(), other=f.local();
    const pending=await f.request('/api/user/totp/generate',{cookie:session.cookie,body:{currentPassword:'local-password-fixture',totpCode:f.totp()}});
    assert.equal(pending.status,200);assert.equal(pending.headers.get('cache-control'),'no-store');
    const secret=pending.data.secret;
    const stored=f.db.prepare('SELECT * FROM totp_enrollments').get();assert(!stored.secret_ciphertext.includes(secret));
    assert.equal((await f.request('/api/user/totp/verify',{cookie:other.cookie,body:{secret,totpCode:code(secret)}})).status,409);
    const result=await f.request('/api/user/totp/verify',{cookie:session.cookie,body:{secret,totpCode:code(secret)}});
    assert.equal(result.status,200);assert.equal(result.data.reauthenticationRequired,true);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions WHERE revoked_at IS NULL').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notifications').get().n,1);
    const login=await f.request('/api/auth/login',{body:{username:'admin',password:'local-password-fixture',totpCode:code(secret)},csrf:false});
    assert.equal(login.status,200);
    assert.equal((await f.request('/api/user/totp/verify',{cookie:session.cookie,body:{secret,totpCode:code(secret)}})).status,401);
  }finally{await f.close();}
});
async function begin(f) {
  f.db.exec("UPDATE users SET totp_enabled=0,totp_secret='' WHERE id='admin'");
  const reply=await f.request('/api/auth/login',{body:{username:'admin',password:'local-password-fixture'},csrf:false});
  assert.equal(reply.status,401);assert.equal(reply.data.enrollmentOnly,true);
  return {reply,cookie:cookieOf(reply),secret:reply.data.totpSecret,id:jwt.decode(reply.data.token).jti};
}
test('limited enrollment cannot access ordinary APIs, privileged setup, key minting or WS',async()=>{
  const f=await fixture();try{
    const e=await begin(f);
    for(const path of ['/api/services','/api/mcp-tokens','/api/setup/platform','/protected-basic'])
      assert.equal((await f.request(path,{cookie:e.cookie,body:{}})).status,403,path);
    assert.throws(()=>verifyWsUpgrade({headers:{host:'pilot.example.com',origin:'https://pilot.example.com',cookie:e.cookie}}),/denied/);
    const body={totpSecret:e.secret,totpCode:code(e.secret)};
    assert.equal((await f.request('/api/auth/complete-totp-setup',{cookie:e.cookie,body,csrf:false})).status,403);
    const wrong=new OTPAuth.Secret({size:20}).base32;
    assert.equal((await f.request('/api/auth/complete-totp-setup',{cookie:e.cookie,body:{totpSecret:wrong,totpCode:code(wrong)}})).status,401);
    const results=await Promise.all([1,2].map(()=>f.request('/api/auth/complete-totp-setup',{cookie:e.cookie,body})));
    assert.equal(results.filter(r=>r.status===200).length,1);
    assert(results.some(r=>[401,409].includes(r.status)));
    const success=results.find(r=>r.status===200);
    assert.equal((await f.request('/protected-basic',{cookie:cookieOf(success),body:{}})).status,200);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM totp_enrollments').get().n,0);
    assert.equal((await f.request('/api/auth/complete-totp-setup',{cookie:e.cookie,body})).status,401);
  }finally{await f.close();}
});
test('expired state and repeated incorrect enrollment proofs fail closed',async()=>{
  const f=await fixture();try{
    let e=await begin(f);
    f.db.prepare('UPDATE totp_enrollments SET expires_at=0 WHERE session_id=?').run(e.id);
    assert.equal((await f.request('/api/auth/complete-totp-setup',{cookie:e.cookie,body:{totpSecret:e.secret,totpCode:code(e.secret)}})).status,409);
    e=await begin(f);
    const wrong=new OTPAuth.Secret({size:20}).base32;
    for(let i=0;i<5;i++) assert.equal((await f.request('/api/auth/complete-totp-setup',{cookie:e.cookie,body:{totpSecret:wrong,totpCode:code(wrong)}})).status,401);
    assert.equal((await f.request('/api/auth/complete-totp-setup',{cookie:e.cookie,body:{totpSecret:e.secret,totpCode:code(e.secret)}})).status,409);
    assert.equal(f.db.prepare("SELECT totp_enabled FROM users WHERE id='admin'").get().totp_enabled,0);
  }finally{await f.close();}
});
