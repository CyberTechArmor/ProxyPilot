// Installation proof is delivered to a new root-only file, never stdout/argv.
import fs from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
export function issueBootstrap(db,username,{directory='/run/proxypilot-bootstrap',now=Date.now()}={}) {
 const parent=resolve(directory);fs.mkdirSync(parent,{recursive:true,mode:0o700});const st=fs.lstatSync(parent);
 if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022)||fs.realpathSync(parent)!==parent)throw new Error('Credential directory must be canonical, root-owned and not writable by other users');
 const installation=db.prepare("SELECT value FROM app_settings WHERE key='installation_bootstrap_id'").get()?.value;
 if(!installation)throw new Error('Start the upgraded backend once to initialize bootstrap schema');
 let file=null;
 db.exec('BEGIN IMMEDIATE');
 try{
  const user=db.prepare("SELECT u.* FROM users u WHERE username=? AND role='admin' AND (auth_source IS NULL OR auth_source='local') AND (password_hash='' OR password_hash IS NULL) AND totp_enabled=0 AND NOT EXISTS(SELECT 1 FROM sso_links WHERE user_id=u.id) AND NOT EXISTS(SELECT 1 FROM webauthn_credentials WHERE user_id=u.id)").get(username);
  if(!user)throw new Error('Only an unclaimed local administrator can receive a bootstrap credential; use recover admin for an initialized account');
  const token='ppboot_'+randomBytes(32).toString('base64url'),expires=now+15*60_000;
  const path=join(parent,'proxypilot-bootstrap-'+randomBytes(12).toString('hex')+'.txt');
  const fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);file=path;
  try{fs.writeFileSync(fd,token+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  db.prepare(`INSERT INTO admin_bootstrap(user_id,installation_id,token_hash,issued_at,expires_at,consumed_at) VALUES(?,?,?,?,?,NULL)
   ON CONFLICT(user_id) DO UPDATE SET installation_id=excluded.installation_id,token_hash=excluded.token_hash,issued_at=excluded.issued_at,expires_at=excluded.expires_at,consumed_at=NULL`).run(user.id,installation,createHash('sha256').update(token).digest('hex'),now,expires);
  db.prepare("INSERT INTO audit_log(id,user_id,action,resource_type,resource_id,details) VALUES(?,?,'ADMIN_BOOTSTRAP_ISSUED','user',?,?)").run(randomUUID(),user.id,user.id,JSON.stringify({expires_at:expires,via:'root-recovery'}));
  db.exec('COMMIT');return {credentialFile:file,expiresAt:new Date(expires).toISOString(),username};
 }catch(e){db.exec('ROLLBACK');if(file)fs.rmSync(file,{force:true});throw e;}
}
