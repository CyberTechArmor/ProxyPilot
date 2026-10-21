// Application storage — the fixed REMOVE PROGRAM (DESIGN §3.3).
//
// One Node program, run inside the guest (`incus exec … -- node -e PROGRAM
// <b64>`, wrapped in the job's containment) or on the host for host items
// (the runner's own node). Its input is base64 JSON in argv — never caller
// text to execute — and every path in it comes from the stored cleanup row
// and the check, never from a job plan. It prints one JSON line.
//
// Actions:
//   live               realpath of the profile's sourceDir, the release
//                      root's protected set (describeReleases), statfs('/')
//   remove             entries [{ path, identity }] under approvedRoots:
//                      the parent opened by file descriptor from / with no
//                      link on the way, lstat identity unchanged since the
//                      check, nothing mounted at or below, optionally
//                      nothing open inside; then an atomic rename to
//                      `.pp-cleanup-<cleanupId>-<n>` inside that same open
//                      directory, the renamed inode re-verified, a removal
//                      that descends by file descriptor only (never follows
//                      a link, never enters another filesystem, stops when a
//                      name changes under it), and an fsync of the parent.
//                      All of it is safe-remove.js (the one remover); without
//                      a usable /proc/self/fd nothing is removed (NO_PROCFS).
//                      A renamed entry that is not what the check saw is put
//                      back, or parked as `.pp-cleanup-hold-<id>-<n>` and
//                      reported (`parked`) — never removed.
//   remove-release     one sealed release through removeSelectedRelease (the
//                      release retention predicates), removed as above
//   finish-quarantine  on resume: removes only `.pp-cleanup-<cleanupId>-<n>`
//                      entries directly under approved roots or the recorded
//                      parents
//   vacuum-journal     journalctl --vacuum-size=<targetBytes>, measured
//   measure            statfs('/') and, for memoryPaths, the used bytes of
//                      memory-backed filesystems (tmpfs, ramfs)
//
// Result codes per entry: removed | gone (no longer exists) | refused (nothing
// was changed; code says why) | failed (removal began and did not finish; the
// rest stays in quarantine for finish-quarantine).

import { RELEASE_CLEANUP_SOURCE } from '../setup-engine/application-release-cleanup.js';

export const CLEANUP_ID_RE = /^cln_[a-f0-9-]{36}$/;
export const QUARANTINE_PREFIX = '.pp-cleanup-';
export const MIN_JOURNAL_TARGET_BYTES = 16 * 1024 * 1024;

export const CLEANUP_PROGRAM = String.raw`
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
${RELEASE_CLEANUP_SOURCE}
const a=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
const R=safeRemover(fs,p);
function emit(x){process.stdout.write(JSON.stringify(x))}
function fail(code){emit({ok:false,code});process.exit(1)}
function refuse(code,extra){const e=new Error(code);e.refusal=code;if(extra)Object.assign(e,extra);throw e}
function normalAbs(x){return typeof x==='string'&&x.length<4096&&x.charAt(0)==='/'&&p.normalize(x)===x&&x!=='/'&&!x.endsWith('/')&&x.indexOf('\0')===-1}
function within(root,x){return x.startsWith(root+'/')}
function cleanupIdOk(){return typeof a.cleanupId==='string'&&/^cln_[a-f0-9-]{36}$/.test(a.cleanupId)}
function approvedRoots(){const r=(Array.isArray(a.approvedRoots)?a.approvedRoots:[]).filter(normalAbs);if(!r.length)fail('NO_APPROVED_ROOTS');return r}
function sameIdentity(st,id){
 if(!id||typeof id!=='object'||id.dev==null||id.ino==null)return false;
 if(Number(id.dev)!==st.dev||Number(id.ino)!==st.ino)return false;
 const type=st.isDirectory()?'dir':st.isSymbolicLink()?'link':st.isFile()?'file':'other';
 if(id.type&&({dir:'dir',directory:'dir',file:'file',link:'link'}[id.type]||id.type)!==type)return false;
 // Raw lstat values survive JSON exactly, so they are compared exactly: a
 // directory whose own entries changed since the check (or one recreated on a
 // reused inode) is newer, and a file must be byte-for-byte the same size and
 // time. birthtime, when both sides know it, must match too.
 if(type==='dir'){if(id.mtimeMs!=null&&st.mtimeMs>Number(id.mtimeMs))return false}
 else{if(id.size!=null&&st.size!==Number(id.size))return false;if(id.mtimeMs!=null&&st.mtimeMs!==Number(id.mtimeMs))return false}
 if(id.birthtimeMs!=null&&st.birthtimeMs>0&&st.birthtimeMs!==Number(id.birthtimeMs))return false;
 return true}
let counter=Number.isInteger(a.startIndex)&&a.startIndex>=0?a.startIndex:0;
// One entry, relative to its parent directory held open (R.openDir walks
// from / and refuses any link on the way): lstat, identity, nothing mounted
// at or below, optionally nothing open inside; the atomic rename to
// .pp-cleanup-<id>-<n> happens INSIDE that same directory, the renamed inode
// is re-verified, and the removal descends by file descriptor only.
// state.touched: set once the entry was renamed (a later error is a failure,
// not a refusal: the remainder sits in quarantine for finish-quarantine).
function removeOne(x,identity,roots,opts,state){
 if(!normalAbs(x))refuse('INVALID_PATH');
 if(!roots.some(r=>within(r,x)))refuse('OUTSIDE_APPROVED_ROOTS');
 const parent=p.dirname(x),name=p.basename(x);
 const pfd=R.openDir(parent);
 try{
  const pst=fs.fstatSync(pfd);
  let st;try{st=R.lstatAt(pfd,name)}catch(e){if(e.code==='ENOENT')return {status:'gone'};throw e}
  if(!st.isDirectory()&&!st.isFile()&&!st.isSymbolicLink())refuse('NOT_REMOVABLE_TYPE');
  if(!sameIdentity(st,identity))refuse('CHANGED_SINCE_CHECK');
  if(R.mountedAt(x))refuse('MOUNT_INSIDE');
  if(opts.checkInUse&&R.inUse(x))refuse('IN_USE');
  let q,n;for(;;){n=counter++;q='.pp-cleanup-'+a.cleanupId+'-'+n;if(!R.existsAt(pfd,q))break}
  R.renameAt(pfd,name,q);
  let qs=null;try{qs=R.lstatAt(pfd,q)}catch(e){qs=null}
  const pnow=fs.fstatSync(pfd);
  if(!qs||!R.same(qs,st)||!R.same(pnow,pst)||pnow.nlink===0){
   // Whatever was renamed is not what the check saw: put it back, or park it
   // under a name finish-quarantine never touches (reported), remove nothing.
   let parked=null;
   try{if(qs){if(!R.existsAt(pfd,name))R.renameAt(pfd,q,name);else{const h='.pp-cleanup-hold-'+a.cleanupId+'-'+n;R.renameAt(pfd,q,h);parked=p.join(parent,h)}}}catch(e){}
   refuse('CHANGED_SINCE_CHECK',parked?{parked}:null);
  }
  state.touched=true;
  const r=R.removeTreeAt(pfd,q,st.dev,st);
  fs.fsyncSync(pfd);
  return {status:'removed',bytes:r.bytes,entries:r.entries};
 }finally{R.close(pfd)}
}
function codeOf(e){if(e&&e.refusal)return e.refusal;const m=String(e&&e.message||'');if(/^[A-Z][A-Z0-9_]{2,60}$/.test(m))return m;return e&&e.code?'FS_'+String(e.code).replace(/[^A-Z0-9_]/g,''):'REMOVE_FAILED'}
function attempt(x,fn){const state={touched:false};try{return {path:x,...fn(state)}}catch(e){return {path:x,status:state.touched?'failed':'refused',code:codeOf(e),...(e&&e.parked?{parked:e.parked}:{})}}}
function statfsRoot(){if(typeof fs.statfsSync!=='function')return null;try{const s=fs.statfsSync('/');return {totalBytes:s.bsize*s.blocks,freeBytes:s.bsize*s.bfree,availBytes:s.bsize*s.bavail,usedBytes:s.bsize*(s.blocks-s.bfree)}}catch(e){return null}}
// Memory-backed filesystems (tmpfs, ramfs) holding the given paths: used
// bytes per mount, each mount once.
function memoryUse(paths){const out=[],seen=new Set();if(typeof fs.statfsSync!=='function'||!Array.isArray(paths))return out;for(const x of paths.filter(normalAbs).slice(0,20)){try{const m=R.mountOf(x);if(!m||seen.has(m.path)||!/^(tmpfs|ramfs)$/.test(m.type))continue;seen.add(m.path);const s=fs.statfsSync(m.path);out.push({mount:m.path,usedBytes:s.bsize*(s.blocks-s.bfree)})}catch(e){}}return out}
function walkBytes(x){let st;try{st=fs.lstatSync(x)}catch(e){return 0}let b=(st.blocks||0)*512;if(st.isDirectory()&&!st.isSymbolicLink()){let names=[];try{names=fs.readdirSync(x)}catch(e){names=[]}for(const n of names)b+=walkBytes(p.join(x,n))}return b}
try{
 if(a.action==='live'){
  const out={ok:true,live:null};
  if(normalAbs(a.sourceDir)){try{out.isLink=fs.lstatSync(a.sourceDir).isSymbolicLink();out.live=fs.realpathSync(a.sourceDir)}catch(e){out.liveError=e.code||'UNREADABLE'}}
  if(a.profile&&a.profile.releaseRoot){try{const d=describeReleases(fs,p,a);out.releases={root:d.root,live:d.live,rollback:d.rollback,rollbackUnknown:d.rollbackUnknown===true,waiting:d.waiting||null,pending:[...(d.pending||[])],candidate:d.candidate,protect:[...d.protect],backing:[...d.backing],sealed:d.sealed.map(r=>({path:r.path,mtimeMs:r.mtimeMs,sha:r.sha}))}}catch(e){out.releasesError=codeOf(e)}}
  if(a.statfs)out.fs=statfsRoot();
  if(a.memoryPaths)out.memory=memoryUse(a.memoryPaths);
  emit(out);
 }
 else if(a.action==='remove'){
  if(!cleanupIdOk())fail('INVALID_CLEANUP_ID');
  const roots=approvedRoots();
  const entries=Array.isArray(a.entries)?a.entries:[];
  if(!entries.length||entries.length>100000)fail('INVALID_ENTRIES');
  // Mounts and open files are re-read when older than 2 s; a small batch
  // re-reads them for every entry.
  const small=entries.length<=20;
  const results=entries.map(e=>attempt(e&&e.path,state=>{if(small)R.refresh();return removeOne(e&&e.path,e&&e.identity,roots,{checkInUse:a.checkInUse===true},state)}));
  emit({ok:true,results,next:counter});
 }
 else if(a.action==='remove-release'){
  if(!cleanupIdOk())fail('INVALID_CLEANUP_ID');
  const roots=approvedRoots();
  const r=attempt(a.path,state=>{if(!normalAbs(a.path))refuse('INVALID_PATH');try{fs.lstatSync(a.path)}catch(e){if(e.code==='ENOENT')return {status:'gone'};throw e}const out=removeSelectedRelease(fs,p,a,x=>removeOne(x,a.identity,roots,{checkInUse:false},state));delete out.removed;return out});
  emit({ok:true,results:[r],next:counter});
 }
 else if(a.action==='finish-quarantine'){
  if(!cleanupIdOk())fail('INVALID_CLEANUP_ID');
  const roots=approvedRoots();
  const dirs=[...new Set([...roots,...(Array.isArray(a.parents)?a.parents:[]).filter(d=>normalAbs(d)&&roots.some(r=>d===r||within(r,d)))])];
  const pattern=new RegExp('^\\.pp-cleanup-'+a.cleanupId.replace(/[^a-z0-9_]/g,c=>'\\'+c)+'-[0-9]+$');
  const removed=[],failed=[],skipped=[];
  for(const dir of dirs){
   let dfd;try{dfd=R.openDir(dir)}catch(e){skipped.push({dir,code:codeOf(e)});continue}
   try{
    let names=[];try{names=R.listAt(dfd)}catch(e){skipped.push({dir,code:codeOf(e)});continue}
    for(const raw of names){
     const name=raw.toString();
     if(!pattern.test(name)||!Buffer.from(name).equals(raw))continue;
     const q=p.join(dir,name);
     try{const st=R.lstatAt(dfd,raw);if(R.mountedAt(q))refuse('MOUNT_INSIDE');const r=R.removeTreeAt(dfd,raw,st.dev,st);fs.fsyncSync(dfd);removed.push({dir,name,bytes:r.bytes,entries:r.entries})}
     catch(e){failed.push({dir,name,code:codeOf(e)})}
    }
   }finally{R.close(dfd)}
  }
  emit({ok:true,removed,failed,skipped});
 }
 else if(a.action==='vacuum-journal'){
  const target=Number(a.targetBytes);
  if(!Number.isInteger(target)||target<16*1024*1024)fail('INVALID_JOURNAL_TARGET');
  const before=walkBytes('/var/log/journal');
  const r=cp.spawnSync('journalctl',['--vacuum-size='+target],{stdio:['ignore','ignore','ignore'],timeout:300000});
  if(r.status!==0)fail('JOURNAL_VACUUM_FAILED');
  emit({ok:true,beforeBytes:before,afterBytes:walkBytes('/var/log/journal')});
 }
 else if(a.action==='measure'){emit({ok:true,fs:statfsRoot(),...(a.memoryPaths?{memory:memoryUse(a.memoryPaths)}:{})})}
 else fail('UNKNOWN_ACTION');
}catch(e){fail(e&&e.refusal==='NO_PROCFS'?'NO_PROCFS':'PROGRAM_FAILED')}
`;

const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const encode = data => Buffer.from(JSON.stringify(data)).toString('base64');

// The guest form: one shell line for containedScript (data as one argv entry).
export function cleanupProgramScript(data) { return `node -e ${quote(CLEANUP_PROGRAM)} ${quote(encode(data))}\n`; }

// The host form: an argv array for exec.host, run by the runner's own node.
export function cleanupProgramArgv(data, { node = process.execPath } = {}) { return [node, '-e', CLEANUP_PROGRAM, encode(data)]; }

// parseProgramOutput(result) → the program's JSON answer, or a typed failure
// when the output is not one bounded JSON object.
export function parseProgramOutput(r) {
  const text = String(r?.stdout || '').trim();
  const invalid = { ok: false, code: r?.code === 127 || /node: (not found|command not found)|No such file or directory.*node/.test(String(r?.stderr || '')) ? 'NODE_MISSING' : 'PROGRAM_RESULT_INVALID' };
  if (!text || text.length > 4 * 1024 * 1024) return invalid;
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : invalid; } catch { return invalid; }
}

export const quarantinePattern = cleanupId => new RegExp(`^\\.pp-cleanup-${String(cleanupId).replace(/[^a-z0-9_]/g, c => `\\${c}`)}-[0-9]+$`);
