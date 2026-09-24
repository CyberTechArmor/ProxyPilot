import { createHash } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { getDb, logAudit } from '../db.js';
import { encryptSecret, decryptSecret } from './secrets.js';
import { postNotification } from './notifications.js';

export const TOTP_ENROLLMENT_SCHEMA = `CREATE TABLE IF NOT EXISTS totp_enrollments (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN ('enroll','replace')),
 secret_ciphertext TEXT NOT NULL, prior_factor_hash TEXT NOT NULL,
 expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
);`;
const factorHash = user => createHash('sha256').update(`${user.totp_enabled || 0}:${user.totp_secret || ''}`).digest('hex');
const failure = (message, status = 409) => Object.assign(new Error(message), { status });

export function beginTotpEnrollment(user, sessionId, purpose = 'enroll') {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
  if (!session || session.user_id !== user.id || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) throw failure('Session unavailable',401);
  if (purpose === 'enroll' && (user.totp_enabled || session.auth_level !== 'enrollment')) throw failure('Initial enrollment is not available');
  if (!['enroll','replace'].includes(purpose)) throw failure('Invalid enrollment purpose');
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({ issuer:'ProxyPilot', label:user.username, secret });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM totp_enrollments WHERE user_id=?').run(user.id);
    db.prepare(`INSERT INTO totp_enrollments(session_id,user_id,purpose,secret_ciphertext,prior_factor_hash,expires_at)
      VALUES(?,?,?,?,?,?)`).run(sessionId,user.id,purpose,encryptSecret(secret.base32),factorHash(user),Date.now()+5*60_000);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { secret:secret.base32, uri:totp.toString() };
}

export function completeTotpEnrollment({userId,sessionId,purpose,code,submittedSecret,ip}) {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const pending = db.prepare('SELECT * FROM totp_enrollments WHERE session_id=? AND user_id=?').get(sessionId,userId);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    if (!pending || !user || pending.purpose !== purpose || pending.expires_at <= Date.now() || pending.attempts >= 5 ||
        !session || session.user_id !== userId || session.revoked_at || Date.parse(session.expires_at) <= Date.now() ||
        pending.prior_factor_hash !== factorHash(user) ||
        (purpose === 'enroll' && (user.totp_enabled || session.auth_level !== 'enrollment')))
      throw failure('Enrollment expired or unavailable. Start again.');
    const secret = decryptSecret(pending.secret_ciphertext);
    const valid = /^\d{6}$/.test(code || '') && (!submittedSecret || submittedSecret === secret) &&
      new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(secret)}).validate({token:code,window:1}) !== null;
    if (!valid) {
      db.prepare('UPDATE totp_enrollments SET attempts=attempts+1 WHERE session_id=?').run(sessionId);
      db.exec('COMMIT'); committed=true;
      throw failure('Invalid enrollment code',401);
    }
    db.prepare('UPDATE users SET totp_secret=?,totp_enabled=1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(pending.secret_ciphertext,userId);
    db.prepare('DELETE FROM totp_enrollments WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM authenticated_devices WHERE user_id=?').run(userId);
    db.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP,sudo_until=NULL WHERE user_id=? AND revoked_at IS NULL').run(userId);
    logAudit(userId,purpose==='replace'?'TOTP_UPDATED':'TOTP_SETUP','user',userId,{allSessionsRevoked:true},ip);
    if (purpose==='replace') postNotification({level:'warning',title:'Authentication factor changed',body:`TOTP was replaced for ${user.username}. Existing sessions were revoked.`,source:'security',source_id:userId});
    db.exec('COMMIT'); committed=true;
    return db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  } catch (e) { if(!committed) db.exec('ROLLBACK'); throw e; }
}
