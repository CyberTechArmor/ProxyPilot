import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as FS, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { canonical, exact, parseJson } from './schema.mjs';

const FORMAT='fractionate-broker-encrypted-state', VERSION=1, MAX_FILE=32*1024*1024, MAX_TOTAL=64*1024*1024;
const REQUIRED=['broker.db','intake.json','authority.json','allocator.json'];
const OPTIONAL=['broker.db-wal','broker.db-shm','identity.json'];
const BROKER={format:FORMAT,contract:'broker.v1',required:REQUIRED,allowed:new Set([...REQUIRED,...OPTIONAL])};
const WORKER={format:'fractionate-worker-encrypted-state',contract:'runner.v1',required:['worker.db'],allowed:new Set(['worker.db','worker.db-wal','worker.db-shm'])};
const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=b=>createHash('sha256').update(b).digest('hex');
function privateDirectory(path) {
 const st=lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||realpathSync(path)!==resolve(path))fail('UNSAFE_DIRECTORY');
}
function privateFile(path,max=MAX_FILE) {
 const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o077)||st.size>max)fail('UNSAFE_FILE');return st;
}
function syncDirectory(path){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function writeExclusive(path,bytes){const fd=openSync(path,FS.O_WRONLY|FS.O_CREAT|FS.O_EXCL|FS.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}}
function readPrivate(path,max=MAX_FILE){privateDirectory(dirname(path));privateFile(path,max);const fd=openSync(path,FS.O_RDONLY|FS.O_NOFOLLOW);try{return readFileSync(fd);}finally{closeSync(fd);}}
function pins(value){exact(value,['build','config_digest']);if(typeof value.build!=='string'||! /^[A-Za-z0-9._-]{1,128}$/.test(value.build)||! /^[a-f0-9]{64}$/.test(value.config_digest))fail('INVALID_PINS');return value;}
function key(path){const bytes=readPrivate(resolve(path),32);if(bytes.length!==32)fail('INVALID_KEY');return bytes;}
export function configurationDigest(config){if(!config||typeof config!=='object'||Array.isArray(config))fail('INVALID_CONFIG');const {state_dir,...metadata}=config;return hash(canonical(metadata));}

/** Required configured-service lifetime lease. Never steal automatically. */
export function acquireStateLease(stateRoot) {
 stateRoot=resolve(stateRoot);privateDirectory(stateRoot);
 if(existsSync(join(stateRoot,'.restore-incomplete')))fail('RESTORE_INCOMPLETE');
 const path=join(stateRoot,'.maintenance.lock'),nonce=randomUUID();
 try{writeExclusive(path,JSON.stringify({pid:process.pid,nonce}));syncDirectory(stateRoot);}catch{fail('STATE_BUSY');}
 let closed=false;return {close(){if(closed)return;const saved=JSON.parse(readPrivate(path,4096));if(saved.nonce!==nonce)fail('LEASE_CHANGED');unlinkSync(path);syncDirectory(stateRoot);closed=true;}};
}
/** Only an explicit stopped-process operator action clears an abandoned lease. */
export function recoverStoppedLease(stateRoot) {
 stateRoot=resolve(stateRoot);privateDirectory(stateRoot);const path=join(stateRoot,'.maintenance.lock');
 const saved=parseJson(readPrivate(path,4096));exact(saved,['pid','nonce']);
 if(!Number.isSafeInteger(saved.pid)||saved.pid<1||typeof saved.nonce!=='string')fail('INVALID_LEASE');
 try{process.kill(saved.pid,0);fail('STATE_BUSY');}catch(e){if(e.code!=='ESRCH')throw e;}
 if(existsSync(join(stateRoot,'.restore-incomplete')))fail('RESTORE_INCOMPLETE');
 unlinkSync(path);syncDirectory(stateRoot);return {recovered:true};
}
export function generateRecoveryKey(keyPath){keyPath=resolve(keyPath);privateDirectory(dirname(keyPath));writeExclusive(keyPath,randomBytes(32));syncDirectory(dirname(keyPath));return {created:true};}

/** Stopped-service snapshot; stores only encrypted bytes outside the protected state root. */
function backupProfile({stateRoot,keyPath,archivePath,expectedPins},profile) {
 const {format:FORMAT,contract,required:REQUIRED,allowed:ALLOWED}=profile;
 pins(expectedPins);stateRoot=resolve(stateRoot);archivePath=resolve(archivePath);privateDirectory(dirname(archivePath));
 const secret=key(keyPath);let lease,payload;
 try {
  lease=acquireStateLease(stateRoot);
  const names=readdirSync(stateRoot).filter(n=>n!=='.maintenance.lock');
  // Unknown state, live/stale component locks, sqlite journals and symlinks are not silently ignored.
  if(names.some(n=>!ALLOWED.has(n))||REQUIRED.some(n=>!names.includes(n)))fail('STATE_INVENTORY_MISMATCH');
  let total=0;const files=names.sort().map(name=>{const bytes=readPrivate(join(stateRoot,name));total+=bytes.length;if(total>MAX_TOTAL)fail('STATE_TOO_LARGE');return {name,size:bytes.length,sha256:hash(bytes),data:bytes.toString('base64')};});
  payload=Buffer.from(JSON.stringify({manifest:{version:VERSION,contract_version:contract,build:expectedPins.build,config_digest:expectedPins.config_digest,created_at:new Date().toISOString(),quarantine_required:true},files}));
  const nonce=randomBytes(12),header={format:FORMAT,version:VERSION,algorithm:'aes-256-gcm'};
  const cipher=createCipheriv('aes-256-gcm',secret,nonce);cipher.setAAD(Buffer.from(canonical(header)));
  const ciphertext=Buffer.concat([cipher.update(payload),cipher.final()]);
  const envelope=Buffer.from(JSON.stringify({...header,nonce:nonce.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
  writeExclusive(archivePath,envelope);syncDirectory(dirname(archivePath));
  return {format:FORMAT,version:VERSION,files:files.map(({name,size})=>({name,size})),archive_digest:hash(envelope),quarantine_required:true};
 }finally{payload?.fill(0);secret.fill(0);lease?.close();}
}
function decode64(s,max){if(typeof s!=='string'||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail('INVALID_ARCHIVE');const b=Buffer.from(s,'base64');if(b.length>max)fail('INVALID_ARCHIVE');return b;}
function decrypt(archivePath,keyBytes,expectedPins,profile) {
 const {format:FORMAT,contract,required:REQUIRED,allowed:ALLOWED}=profile;
 let clear;
 try {
  const outer=parseJson(readPrivate(archivePath,MAX_TOTAL*2));exact(outer,['format','version','algorithm','nonce','tag','ciphertext']);
  const {format,version,algorithm}=outer;if(format!==FORMAT||version!==VERSION||algorithm!=='aes-256-gcm')fail('INVALID_ARCHIVE');
  const nonce=decode64(outer.nonce,12),tag=decode64(outer.tag,16);if(nonce.length!==12||tag.length!==16)fail('INVALID_ARCHIVE');
  const decipher=createDecipheriv(algorithm,keyBytes,nonce);decipher.setAAD(Buffer.from(canonical({format,version,algorithm})));decipher.setAuthTag(tag);
  clear=Buffer.concat([decipher.update(decode64(outer.ciphertext,MAX_TOTAL*1.5)),decipher.final()]);
  const payload=parseJson(clear);exact(payload,['manifest','files']);const m=payload.manifest;
  exact(m,['version','contract_version','build','config_digest','created_at','quarantine_required']);
  if(m.version!==VERSION||m.contract_version!==contract||m.quarantine_required!==true||m.build!==expectedPins.build||m.config_digest!==expectedPins.config_digest||typeof m.created_at!=='string'||!Number.isFinite(Date.parse(m.created_at)))fail('PIN_MISMATCH');
  if(!Array.isArray(payload.files)||payload.files.length<REQUIRED.length||payload.files.length>ALLOWED.size)fail('INVALID_ARCHIVE');
  const seen=new Set();let total=0;const files=payload.files.map(f=>{exact(f,['name','size','sha256','data']);if(!ALLOWED.has(f.name)||seen.has(f.name))fail('INVALID_ARCHIVE');seen.add(f.name);const bytes=decode64(f.data,MAX_FILE);total+=bytes.length;if(total>MAX_TOTAL||bytes.length!==f.size||hash(bytes)!==f.sha256)fail('INVALID_ARCHIVE');return {name:f.name,bytes};});
  if(REQUIRED.some(n=>!seen.has(n)))fail('INVALID_ARCHIVE');return files;
 }catch(e){if(e.code==='PIN_MISMATCH')throw e;fail('ARCHIVE_AUTHENTICATION_FAILED');}finally{clear?.fill(0);}
}
/** Restores exclusively to a NEW directory. Authenticate completely before publication.
 * Stage all bytes, then publish under a lease and crash marker; incomplete publication
 * remains unstartable. No existing destination, live store or external key is overwritten. */
function restoreProfile({archivePath,keyPath,destination,expectedPins},profile) {
 pins(expectedPins);destination=resolve(destination);privateDirectory(dirname(destination));if(existsSync(destination))fail('DESTINATION_EXISTS');
 const secret=key(keyPath);let files;try{files=decrypt(resolve(archivePath),secret,expectedPins,profile);}finally{secret.fill(0);}
 const staging=join(dirname(destination),`.${basename(destination)}.restore-${randomUUID()}`);mkdirSync(staging,{mode:0o700});let created=false,lease;
 try {
  for(const f of files)writeExclusive(join(staging,f.name),f.bytes);syncDirectory(staging);
  // mkdir is exclusive even if another process creates destination after initial check.
  mkdirSync(destination,{mode:0o700});created=true;lease=acquireStateLease(destination);
  writeExclusive(join(destination,'.restore-incomplete'),Buffer.from('quarantined restore publication'));syncDirectory(destination);
  for(const f of files)renameSync(join(staging,f.name),join(destination,f.name));syncDirectory(destination);
  unlinkSync(join(destination,'.restore-incomplete'));syncDirectory(destination);lease.close();lease=null;syncDirectory(dirname(destination));
  return {restored:true,quarantine_required:true,files:files.map(f=>f.name),build:expectedPins.build,config_digest:expectedPins.config_digest};
 }catch(e){if(created){/* Preserve incomplete target/lease for explicit operator inspection. */}throw e;}
 finally{for(const f of files)f.bytes.fill(0);rmSync(staging,{recursive:true,force:true});}
}

export const backupState=options=>backupProfile(options,BROKER);
export const restoreState=options=>restoreProfile(options,BROKER);
export const backupWorkerState=options=>backupProfile(options,WORKER);
export const restoreWorkerState=options=>restoreProfile(options,WORKER);
