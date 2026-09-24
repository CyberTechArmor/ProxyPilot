import {createHash} from 'node:crypto';

export const ADMIN_BOOTSTRAP_SCHEMA=`CREATE TABLE IF NOT EXISTS admin_bootstrap (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 installation_id TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
 issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);`;
export const bootstrapHash=token=>createHash('sha256').update(String(token)).digest('hex');
export function bootstrapUser(db,username,token,now=Date.now()) {
 if(typeof token!=='string'||!/^ppboot_[A-Za-z0-9_-]{43}$/.test(token))return null;
 return db.prepare(`SELECT u.* FROM users u JOIN admin_bootstrap b ON b.user_id=u.id
 WHERE u.username=? AND u.role='admin' AND (u.auth_source IS NULL OR u.auth_source='local')
 AND (u.password_hash IS NULL OR u.password_hash='') AND u.totp_enabled=0
 AND NOT EXISTS(SELECT 1 FROM sso_links WHERE user_id=u.id)
 AND NOT EXISTS(SELECT 1 FROM webauthn_credentials WHERE user_id=u.id)
 AND b.token_hash=? AND b.consumed_at IS NULL AND b.expires_at>?
 AND b.installation_id=(SELECT value FROM app_settings WHERE key='installation_bootstrap_id')`).get(username,bootstrapHash(token),now) || null;
}
export function claimBootstrap(db,{username,token,passwordHash,now=Date.now()}) {
 db.exec('BEGIN IMMEDIATE');
 try {
  const user=bootstrapUser(db,username,token,now);
  if(!user){db.exec('ROLLBACK');return null;}
  const claimed=db.prepare('UPDATE admin_bootstrap SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL AND expires_at>?').run(now,user.id,now);
  const updated=db.prepare("UPDATE users SET password_hash=?,password_change_required=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (password_hash='' OR password_hash IS NULL) AND totp_enabled=0").run(passwordHash,user.id);
  if(claimed.changes!==1||updated.changes!==1)throw new Error('Bootstrap state changed');
  db.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP,sudo_until=NULL WHERE user_id=? AND revoked_at IS NULL').run(user.id);
  db.exec('COMMIT');return {...user,password_hash:passwordHash,password_change_required:0};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
