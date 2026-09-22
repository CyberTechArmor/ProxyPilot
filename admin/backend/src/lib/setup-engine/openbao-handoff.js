import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readPrivate,atomicPrivate } from './pomerium-runtime.js';
import { privateDir } from './openbao-runtime.js';
import { RECOVERY_ROOT,digest,fail } from './openbao-logic.js';
import { ok,status } from './openbao-api.js';
function encryptedPacket(v){try{const b=Buffer.from(v,'base64');return typeof v==='string'&&b.length>100&&(b[0]&0x80)!==0;}catch{return false;}}
export async function initialize(db,r,api,{job,recoveryRoot=RECOVERY_ROOT}={}){const s=await status(api);if(r.config.mode!=='install')throw fail('External instances are never initialized or resealed by this guide.');
  privateDir(recoveryRoot);const path=join(recoveryRoot,r.credential_ref+'.json'),fingerprint=digest(r.config);
  const recover=()=>{let p;try{p=JSON.parse(readPrivate(path));}catch{throw fail('Initialization recovery required: the protected handoff is missing or unreadable. Recover its separately held copy; never reset the data.');}
    if(p.fingerprint!==fingerprint||!p.receipt||p.shares?.length!==3||!p.shares.every(encryptedPacket)||!encryptedPacket(p.root))throw fail('Initialization recovery required: the handoff does not match this configuration.');
    job.fence();db.prepare('UPDATE setup_openbao SET handoff_digest=? WHERE id=1').run(digest(p.receipt));return {path};};
  if(s.state==='unavailable')throw fail('OpenBao is unavailable. Initialization was not attempted.');
  if(s.state!=='uninitialized'){if(existsSync(path))return recover();throw fail('Initialization recovery required: OpenBao is already initialized but its handoff cannot be recovered. No reinitialization or data reset is permitted.');}
  if(r.init_attempted||existsSync(path))throw fail('Initialization recovery required: a previous attempt has an uncertain result. This guide never repeats initialization. Inspect the preserved instance and handoff.');
  if(!r.config.initialize||r.config.pgpKeys?.length!==3||!r.config.rootPgpKey)throw fail('Explicit reviewed initialization recipients are required.');
  job.checkpoint('initialization_requested',{resumable:true,openbao:true});job.fence();db.prepare('UPDATE setup_openbao SET init_attempted=1 WHERE id=1').run();
  const response=ok(await api('/v1/sys/init',{method:'POST',body:{secret_shares:3,secret_threshold:2,pgp_keys:r.config.pgpKeys,root_token_pgp_key:r.config.rootPgpKey}}),'Initialization');
  // Fail closed if the server did not honor encryption. Never persist plaintext.
  if(response?.keys_base64?.length!==3||!response.keys_base64.every(encryptedPacket)||!encryptedPacket(response.root_token))throw fail('Initialization recovery required: encrypted handoff could not be confirmed. Data was not reset.');
  job.fence();atomicPrivate(path,JSON.stringify({fingerprint,receipt:randomBytes(24).toString('base64url'),shares:response.keys_base64,root:response.root_token,threshold:2,format:'openbao-pgp-base64',instructions:'Keep each decrypted share with its separate custodian. Store this package separately from service/application backups. The bootstrap token must be revoked after setup.'},null,2)+'\n');
  return recover();
}
