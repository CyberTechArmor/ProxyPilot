import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'pp-device-upgrade-'));
process.env.DATABASE_PATH=join(dir,'test.db');
process.env.TOTP_ENCRYPTION_KEY='a'.repeat(64);
process.env.NODE_ENV='test';
const {initDatabase,getDb}=await import('../db.js');
const {encryptSecret}=await import('../lib/secrets.js');
test('upgrade retires fingerprint trust and old sessions exactly once, preserving credentials',()=>{
  initDatabase(); const db=getDb();
  const secret=encryptSecret('JBSWY3DPEHPK3PXP');
  db.prepare("INSERT INTO users(id,username,password_hash,totp_secret,totp_enabled,role) VALUES('fixture','fixture','existing-hash',?,1,'admin')").run(secret);
  db.exec("INSERT INTO authenticated_devices(id,user_id,device_name,device_fingerprint) VALUES('legacy','fixture','legacy','copied-headers')");
  const addSession=id=>db.prepare("INSERT INTO sessions(id,user_id,expires_at,sudo_until) VALUES(?,'fixture','2099-01-01','2099-01-01')").run(id);
  addSession('before');
  db.exec('DELETE FROM schema_migrations WHERE version=1012');
  initDatabase();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM authenticated_devices').get().n,0);
  const old=db.prepare("SELECT * FROM sessions WHERE id='before'").get();assert(old.revoked_at);assert.equal(old.sudo_until,null);
  const user=db.prepare("SELECT * FROM users WHERE id='fixture'").get();assert.equal(user.password_hash,'existing-hash');assert.equal(user.totp_secret,secret);assert.equal(user.totp_enabled,1);
  addSession('after');initDatabase();
  assert.equal(db.prepare("SELECT revoked_at FROM sessions WHERE id='after'").get().revoked_at,null);
  db.close();rmSync(dir,{recursive:true,force:true});
});
