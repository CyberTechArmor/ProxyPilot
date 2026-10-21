// The read-only storage facts collector. One fixed Node program (the same
// pattern as GUEST_PROGRAM in setup-engine/application-deploy-op.js): the
// caller's data travels as one base64 JSON argv entry, never as command text.
// It runs in the guest (`incus exec <guest> -- sh` with `node -e PROGRAM b64`
// on stdin) and, for host-side leftovers, on the host (`node -e PROGRAM b64`).
//
// What it does, and nothing else:
//   - lstat / readdir / readlink / statfs (df when this Node has no statfs);
//   - reads /proc/mounts and the /proc/<pid>/fd and /proc/<pid>/cwd link
//     targets (which paths are open);
//   - runs `journalctl --disk-usage`, `systemctl show <unit> -p User`,
//     `getent passwd <user>` and `git ls-files -z -- <paths>`;
//   - reads exactly three kinds of file contents: the release marker
//     `.proxypilot-release.json` and `.git` link files (each at most 4 KiB),
//     and /etc/passwd (the unprivileged account safe git runs as).
// It never follows a symlink while walking (lstat only; a link is reported
// with its target string and whether that target exists), never descends into
// another filesystem, and never writes anything.

// Git is the ONE safe git (lib/setup-engine/safe-git.js SAFE_GIT_SOURCE, the
// same the release and cleanup programs embed): read-only git never runs as
// root (the repository's non-root owner, else nobody), with an exact
// safe.directory, --no-optional-locks, every configuration that can run a
// command switched off on the command line and a clean environment. The scan
// only ever runs `git ls-files -z -- <paths>`: with no -m/-d/-o/--eol it
// reads the index and prints names, so no filter, textconv or diff driver
// runs, and the one command an index read can start (core.fsmonitor) is off.
import { describeReleases } from '../setup-engine/application-release-cleanup.js';
import { SAFE_GIT_SOURCE } from '../setup-engine/safe-git.js';
import { SAFE_REMOVE_SOURCE } from '../setup-engine/safe-remove.js';

/** The only git command the scan runs (the index, nothing else). */
export const SCAN_GIT_ARGS = Object.freeze(['ls-files', '-z', '--']);

/**
 * readOnlyFs(fs) → a view of fs with the read operations only. Every open
 * loses its write, create, truncate and append flags (a request for one is
 * refused) and gains O_NOFOLLOW | O_NONBLOCK; readFileSync reads /proc only;
 * every other operation (write, rename, unlink, chmod, …) is not there and
 * throws. describeReleases and the shared fd walker it reads markers with
 * (safe-remove.js) run over this view in the scan, so even the remover's own
 * code cannot change anything here. Serialized into the program.
 */
export function readOnlyFs(fs) {
  const C = fs.constants;
  const WRITE = C.O_WRONLY | C.O_RDWR | C.O_CREAT | C.O_TRUNC | C.O_APPEND | C.O_EXCL;
  const deny = (op) => function () { const e = new Error(`read-only view: ${op}`); e.code = 'EROFS'; throw e; };
  const view = { constants: C };
  for (const k of ['lstatSync', 'statSync', 'fstatSync', 'readdirSync', 'realpathSync', 'existsSync', 'readlinkSync', 'readSync', 'closeSync', 'statfsSync']) if (typeof fs[k] === 'function') view[k] = fs[k].bind(fs);
  if (view.realpathSync && fs.realpathSync.native) view.realpathSync.native = fs.realpathSync.native.bind(fs.realpathSync);
  view.openSync = function (f, flags) {
    let n = flags === undefined || flags === 'r' ? C.O_RDONLY : flags;
    if (typeof n !== 'number' || (n & WRITE)) return deny('openSync for writing')();
    return fs.openSync(f, n | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0));
  };
  view.readFileSync = function (f, o) {
    if (typeof f !== 'string' || !f.startsWith('/proc/')) return deny('readFileSync outside /proc')();
    return fs.readFileSync(f, o);
  };
  return new Proxy(view, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /Sync$|^(write|append|rm|unlink|rename|mkdir|mkdtemp|chmod|chown|lchown|truncate|copyFile|cp|utimes|symlink|link|open|create)/.test(k) ? deny(k) : undefined)) });
}

// The release roles (live, rollback, waiting candidate, backing roots, kept
// releases) are decided by describeReleases from application-release-cleanup.js,
// the one definition the release job's retention and the storage cleanup run
// too. It is embedded as source and runs here over a read-only view of fs
// (readOnlyFs: every open read-only, O_NOFOLLOW|O_NONBLOCK; it only lstats,
// reads link targets and reads each 4 KiB release marker).
export const DESCRIBE_RELEASES_SOURCE = `const describeReleases=${describeReleases.toString()};`;

const SCAN_PROGRAM_SOURCE = String.raw`
'use strict';
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
const a=JSON.parse(Buffer.from(process.argv[1]||'','base64').toString('utf8')||'{}');
const t0=Date.now();
const B=a.budget||{};
const MS=Number.isFinite(B.ms)&&B.ms>0?B.ms:60000,ENTRIES=Number.isFinite(B.entries)&&B.entries>0?B.entries:2000000;
const deadline=t0+MS,MAX_ITEMS=a.maxItems||20000,MAX_CHILDREN=a.maxChildren||5000,MAX_INACC=20,MAX_OPEN=500000,MARKER_MAX=4096;
let entries=0,exceeded=false;
const out={ok:true,node:process.version,pid:process.pid,startedAt:t0,items:[],roots:[],fs:[],mounts:[],resolved:{},tracked:{},service:null,journal:null,openPaths:0,budgetExceeded:false,truncatedItems:0,errors:[]};
function lst(f){try{return fs.lstatSync(f)}catch(e){return null}}
function note(e){if(out.errors.length<20)out.errors.push(String(e&&e.code||e&&e.message||e).slice(0,120))}
function run(cmd,args,opts){try{const r=cp.spawnSync(cmd,args,Object.assign({encoding:'utf8',maxBuffer:8*1024*1024,timeout:20000,stdio:['ignore','pipe','pipe']},opts||{}));return r.status===0?String(r.stdout||''):null}catch(e){return null}}
${SAFE_GIT_SOURCE}
function unescapeMount(s){return s.replace(/\\([0-7]{3})/g,function(m,o){return String.fromCharCode(parseInt(o,8))})}
// /proc/mounts: which filesystem each path is on (fstype only; never mount contents).
const mounts=[];
try{for(const line of fs.readFileSync('/proc/mounts','utf8').split('\n')){const f=line.split(' ');if(f.length<3)continue;mounts.push({mount:unescapeMount(f[1]),fstype:f[2]})}}catch(e){note(e)}
mounts.sort(function(x,y){return y.mount.length-x.mount.length});
function mountOf(f){for(const m of mounts){if(m.mount==='/'||f===m.mount||f.startsWith(m.mount+'/'))return m}return null}
function memoryFs(t){return t==='tmpfs'||t==='ramfs'}
out.mounts=mounts.filter(function(m){return memoryFs(m.fstype)}).map(function(m){return m.mount}).slice(0,50);
const rootSt=lst('/');out.rootDev=rootSt?rootSt.dev:null;
// statfs: what each filesystem says about itself.
for(const f of (Array.isArray(a.statfs)?a.statfs:[])){
  const m=mountOf(f);let row=null;
  try{if(typeof fs.statfsSync==='function'){const s=fs.statfsSync(f);row={path:f,mount:m&&m.mount,fstype:m&&m.fstype,totalBytes:s.blocks*s.bsize,freeBytes:s.bfree*s.bsize,availBytes:s.bavail*s.bsize}}}catch(e){row=null}
  if(!row){const d=run('df',['-kP','--',f]);const l=d&&d.trim().split('\n')[1];const c=l&&l.trim().split(/\s+/);if(c&&c.length>=6)row={path:f,mount:m&&m.mount,fstype:m&&m.fstype,totalBytes:Number(c[1])*1024,freeBytes:(Number(c[1])-Number(c[2]))*1024,availBytes:Number(c[3])*1024}}
  if(row)out.fs.push(row);
}
// The service user (and home), so caches under that home can be found.
if(a.service&&/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,100}\.service$/.test(a.service)){
  let user=run('systemctl',['show',a.service,'--property=User','--value']);user=user==null?null:user.trim()||'root';
  let uid=null,home=null;
  if(user&&/^[A-Za-z_][A-Za-z0-9_.-]{0,31}\$?$/.test(user)){const g=run('getent',['passwd',user]);const f=g&&g.trim().split('\n')[0].split(':');if(f&&f.length>=6){uid=Number(f[2]);home=f[5]||null}}
  out.service={unit:a.service,user:user,uid:Number.isFinite(uid)?uid:null,home:home&&home.startsWith('/')?p.posix.normalize(home):null};
}
function expand(path){if(typeof path!=='string')return null;if(path.startsWith('~service/')||path==='~service'){const h=out.service&&out.service.home;if(!h||h==='/')return null;return p.posix.normalize(h+path.slice('~service'.length))}return path}
function absOk(f){return typeof f==='string'&&f.startsWith('/')&&p.posix.normalize(f)===f&&!f.includes('\0')}
// Resolution of declared paths (preserve paths, env files, the live link).
for(const raw of (Array.isArray(a.resolve)?a.resolve:[])){
  const f=expand(raw);if(!absOk(f))continue;const s=lst(f);let real=null;
  try{real=fs.realpathSync(f)}catch(e){real=null}
  out.resolved[raw]={exists:!!s&&real!==null,isLink:!!s&&s.isSymbolicLink(),realpath:real,linkTarget:s&&s.isSymbolicLink()?safeReadlink(f):null};
}
function safeReadlink(f){try{return fs.readlinkSync(f)}catch(e){return null}}
// Release roles: describeReleases (embedded below), never decided here. It
// reads markers through the shared fd walker (safe-remove.js), and both run
// over readOnlyFs: nothing in either can write here.
const readOnlyFs=${readOnlyFs.toString()};
${SAFE_REMOVE_SOURCE}
${DESCRIBE_RELEASES_SOURCE}
if(a.releases&&typeof a.releases==='object'&&a.releases.profile){
  const roFs=readOnlyFs(fs);
  try{const d=describeReleases(roFs,p,a.releases);out.releases={ok:true,root:d.root,live:d.live,rollback:d.rollback||null,rollbackUnknown:!!d.rollbackUnknown,waiting:d.waiting||null,pending:Array.from(d.pending||[]).sort(),backing:Array.from(d.backing).sort(),protect:Array.from(d.protect).sort(),sealed:d.sealed.map(function(r){return{path:r.path,sha:r.sha||null}})}}
  catch(e){const m=String(e&&e.message||'');out.releases={ok:false,code:/^[A-Z_]{3,64}$/.test(m)?m:(e&&e.code==='ENOENT'?'RELEASE_ROOT_MISSING':'RELEASES_UNREADABLE')}}
}
// Open paths: /proc/<pid>/cwd and /proc/<pid>/fd/* link targets (ours excluded).
const openAnc=new Set();
if(a.procScan){
  let n=0;const skip=new Set([String(process.pid),String(process.ppid)]);
  let pids=[];try{pids=fs.readdirSync('/proc').filter(function(x){return /^[0-9]+$/.test(x)&&!skip.has(x)})}catch(e){note(e)}
  const add=function(t){if(!t||t[0]!=='/')return;t=t.replace(/ \(deleted\)$/,'');n++;let x=t;while(x&&x!=='/'&&!openAnc.has(x)){openAnc.add(x);x=p.posix.dirname(x)}};
  for(const pid of pids){if(n>MAX_OPEN)break;add(safeReadlink('/proc/'+pid+'/cwd'));let fds=[];try{fds=fs.readdirSync('/proc/'+pid+'/fd')}catch(e){continue}for(const fd of fds){add(safeReadlink('/proc/'+pid+'/fd/'+fd));if(n>MAX_OPEN)break}}
  out.openPaths=n;
}
// Journal usage as journalctl reports it.
if(a.journal){const j=run('journalctl',['--disk-usage']);const m=j&&/take up ([0-9.]+)\s*([KMGTPE]?)/i.exec(j);if(m){const u={'':1,K:1024,M:1048576,G:1073741824,T:1099511627776,P:1125899906842624,E:1152921504606846976}[m[2].toUpperCase()]||1;out.journal={bytes:Math.round(Number(m[1])*u)}}else out.journal={bytes:null}}
// Tracked test: which of these paths git tracks (nothing is checked out or written).
for(const t of (Array.isArray(a.tracked)?a.tracked:[])){
  if(!t||!absOk(t.repo)||!Array.isArray(t.paths))continue;const paths=t.paths.filter(function(x){return typeof x==='string'&&x&&!x.startsWith('/')&&!x.split('/').includes('..')}).slice(0,100);
  const g=safeGit(cp,fs,t.repo,${JSON.stringify(SCAN_GIT_ARGS)}.concat(paths));
  out.tracked[t.repo]=g.ok?{ok:true,paths:g.stdout.split('\0').filter(Boolean).slice(0,5000),...(g.asUid!=null?{asUid:g.asUid}:{})}:{ok:false,paths:[],reason:g.reason};
}
// Items: each depth-0 root is one item; each child of a depth-1 root is one item.
const roots=(Array.isArray(a.roots)?a.roots:[]).map(function(r,i){const path=expand(r.path);return Object.assign({},r,{i:i,declared:r.path,path:path})});
const rootPaths=new Set(roots.filter(function(r){return absOk(r.path)}).map(function(r){return r.path}));
const items=[],claimed=new Set();
function addItem(it){if(claimed.has(it.path))return false;if(items.length>=MAX_ITEMS){out.truncatedItems++;return false}claimed.add(it.path);items.push(it);return true}
for(const r of roots){
  const summary={i:r.i,path:r.path,declared:r.declared,depth:r.depth===1?1:0,role:r.role||null,exists:false,isLink:false,children:0,omitted:0};
  out.roots.push(summary);
  if(!absOk(r.path)){summary.skipped=r.path===null?'no service home':'invalid path';continue}
  let path=r.path;
  if(r.resolve){let real=null;try{real=fs.realpathSync(path)}catch(e){real=null}if(real&&absOk(real)){summary.realpath=real;path=real}}
  const s=lst(path);if(!s){continue}summary.exists=true;summary.isLink=s.isSymbolicLink();
  if((r.depth===1)&&s.isDirectory()){
    let names=[];try{names=fs.readdirSync(path).sort()}catch(e){summary.inaccessible=true;continue}
    const re=typeof r.match==='string'?new RegExp(r.match):null;
    for(const n of names){if(re&&!re.test(n))continue;const f=path==='/'?'/'+n:path+'/'+n;if(rootPaths.has(f)&&f!==path)continue;if(summary.children>=MAX_CHILDREN){summary.omitted++;continue}if(addItem({path:f,r:r.i}))summary.children++}
  } else if(r.depth===1){continue}
  else addItem({path:path,r:r.i,declared:path!==r.path?r.path:undefined});
}
const seen=new Set();
// Never blocks on a FIFO swapped in after the lstat (O_NONBLOCK), never follows a link (O_NOFOLLOW),
// and reads only what fstat proves is a regular file of at most 4 KiB.
function readSmall(f){const s=lst(f);if(!s||!s.isFile()||s.size>MARKER_MAX)return null;let fd;try{fd=fs.openSync(f,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));const st=fs.fstatSync(fd);if(!st.isFile()||st.size>MARKER_MAX||st.ino!==s.ino||st.dev!==s.dev)return null;const b=Buffer.alloc(st.size);const n=st.size?fs.readSync(fd,b,0,st.size,0):0;return b.subarray(0,n).toString('utf8')}catch(e){return null}finally{if(fd!==undefined)try{fs.closeSync(fd)}catch(e){}}}
const HEX40=/^[a-f0-9]{40}$/,HEX64=/^[a-f0-9]{64}$/;
function measure(it,r){
  const st=lst(it.path);if(!st){it.missing=true;return}
  it.name=p.posix.basename(it.path);it.dev=st.dev;it.ino=st.ino;it.uid=st.uid;it.gid=st.gid;it.mode=st.mode&0o7777;it.nlink=st.nlink;it.size=st.size;it.mtimeMs=st.mtimeMs;it.birthtimeMs=st.birthtimeMs>0?st.birthtimeMs:null;it.newestMtimeMs=st.mtimeMs;
  it.logicalBytes=st.size;it.allocatedBytes=st.blocks*512;it.files=0;it.dirs=0;it.links=0;it.others=0;it.sharedBytes=0;it.inaccessible=0;
  const m=mountOf(it.path);if(m&&memoryFs(m.fstype))it.memoryBacked=true;
  const parent=lst(p.posix.dirname(it.path));if(parent&&parent.dev!==st.dev)it.mountPoint=true;
  if(openAnc.has(it.path))it.inUse=true;
  if(st.isSymbolicLink()){it.type='link';it.linkTarget=safeReadlink(it.path);try{it.linkTargetExists=it.linkTarget!==null&&fs.existsSync(p.posix.resolve(p.posix.dirname(it.path),it.linkTarget))}catch(e){it.linkTargetExists=false}return}
  if(st.isFile()){it.type='file';it.files=1;if(st.nlink>1){const k=st.dev+':'+st.ino;if(seen.has(k)){it.sharedBytes=it.allocatedBytes;it.logicalBytes=0;it.allocatedBytes=0}else{seen.add(k);it.hardLinkedBytes=it.allocatedBytes}}return}
  if(!st.isDirectory()){it.type='other';it.special=st.isSocket()?'socket':st.isFIFO()?'fifo':st.isCharacterDevice()||st.isBlockDevice()?'device':'other';return}
  it.type='dir';
  if(r.marker){const mk=p.posix.join(it.path,'.proxypilot-release.json');const ms=lst(mk);if(ms){if(ms.isFile()&&!ms.isSymbolicLink()){const txt=readSmall(mk);let j=null;try{j=txt?JSON.parse(txt):null}catch(e){j=null}it.marker=j&&typeof j==='object'?{present:true,sha:HEX40.test(j.sha||'')?j.sha:null,treeSha:HEX40.test(j.treeSha||'')?j.treeSha:null,artifactDigest:HEX64.test(j.artifactDigest||'')?j.artifactDigest:null}:{present:true,unreadable:true}}else it.marker={present:false,unsafe:true}}}
  if(r.gitLinks){const g=p.posix.join(it.path,'.git');const gs=lst(g);if(gs){if(gs.isFile()){const txt=readSmall(g);const mm=txt&&/^gitdir:\s*(.+)$/m.exec(txt);if(mm){const target=mm[1].trim();let ex=false;try{ex=fs.existsSync(p.posix.resolve(it.path,target))}catch(e){ex=false}it.gitLink={target:target.slice(0,300),exists:ex}}}else if(gs.isDirectory())it.gitDir=true}}
  if(it.mountPoint&&!r.walkMounts){it.crossesDevice=true;return}
  if(exceeded){it.partial=true;return}
  const bd=Array.isArray(r.breakdown)?new Map(r.breakdown.map(function(n){return [n,{name:n,logicalBytes:0,allocatedBytes:0,files:0}]})):null;
  const inacc=[];const stack=[it.path];
  while(stack.length){
    const dir=stack.pop();let names;
    try{names=fs.readdirSync(dir)}catch(e){it.inaccessible++;if(inacc.length<MAX_INACC)inacc.push(dir);continue}
    const rel0=dir===it.path?null:dir.slice(it.path.length+1).split('/')[0];
    for(const n of names){
      entries++;
      if(entries>ENTRIES||((entries&511)===0&&Date.now()>deadline)){exceeded=true;it.partial=true;break}
      const f=dir==='/'?'/'+n:dir+'/'+n;
      if(claimed.has(f)){it.nested=(it.nested||0)+1;continue}
      let s;try{s=fs.lstatSync(f)}catch(e){if(e&&(e.code==='EACCES'||e.code==='EPERM')){it.inaccessible++;if(inacc.length<MAX_INACC)inacc.push(f)}continue}
      if(s.mtimeMs>it.newestMtimeMs)it.newestMtimeMs=s.mtimeMs;
      if(s.isDirectory()&&s.dev!==st.dev){it.crossesDevice=true;continue}
      let lb=s.size,ab=s.blocks*512;
      if(s.isFile()&&s.nlink>1){const k=s.dev+':'+s.ino;if(seen.has(k)){it.sharedBytes+=ab;continue}seen.add(k);it.hardLinkedBytes=(it.hardLinkedBytes||0)+ab}
      if(s.isDirectory()){it.dirs++;stack.push(f)}else if(s.isFile())it.files++;else if(s.isSymbolicLink())it.links++;else it.others++;
      it.logicalBytes+=lb;it.allocatedBytes+=ab;
      if(bd){const b=bd.get(rel0===null?n:rel0);if(b){b.logicalBytes+=lb;b.allocatedBytes+=ab;if(s.isFile())b.files++}}
    }
    if(exceeded)break;
  }
  if(inacc.length)it.inaccessiblePaths=inacc;
  if(bd){const rows=[...bd.values()].filter(function(b){return b.allocatedBytes>0||b.logicalBytes>0});if(rows.length)it.breakdown=rows}
}
for(const it of items){const r=roots[it.r]||{};try{measure(it,r)}catch(e){it.error=String(e&&e.code||'MEASURE_FAILED');note(e)}}
// Compact: drop empty fields so a large /tmp stays small on the wire.
out.items=items.map(function(it){const o={};for(const k of Object.keys(it)){const v=it[k];if(v===undefined||v===null||v===false||(v===0&&k!=='dev'&&k!=='ino'&&k!=='uid'&&k!=='gid'&&k!=='mode'&&k!=='r'))continue;o[k]=v}return o});
out.budgetExceeded=exceeded;out.entries=entries;out.elapsedMs=Date.now()-t0;out.finishedAt=Date.now();
process.stdout.write(JSON.stringify(out));
`;

export const SCAN_PROGRAM = SCAN_PROGRAM_SOURCE;
export const SCAN_DEFAULT_BUDGET = Object.freeze({ ms: 60_000, entries: 2_000_000 });
export const SCAN_MAX_CAPTURE = 8 * 1024 * 1024;

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The base64 JSON argument the program reads. */
export function encodeScanInput(data) {
  return Buffer.from(JSON.stringify(data ?? {}), 'utf8').toString('base64');
}

/** Argv for a direct spawn (host side, tests): node -e PROGRAM b64. */
export function scanArgv(data) {
  return ['node', '-e', SCAN_PROGRAM, encodeScanInput(data)];
}

/**
 * A shell script for `incus exec <guest> -- sh` (script on stdin). It runs
 * from `/` (so its own working directory marks nothing as in use) and says
 * NO_NODE when the guest has no Node.js.
 */
export function scanScript(data) {
  return `cd / || exit 70\ncommand -v node >/dev/null 2>&1 || { echo NO_NODE; exit 127; }\nexec node -e ${quote(SCAN_PROGRAM)} ${quote(encodeScanInput(data))}\n`;
}

/**
 * Read an exec result ({ code|status, stdout, stderr, stdoutTruncated? }) into
 * { ok: true, facts } or { ok: false, reason, code }.
 */
export function parseScanOutput(result) {
  const code = result?.code ?? result?.status;
  const stdout = String(result?.stdout || '');
  if (/^NO_NODE\b/m.test(stdout) || code === 127) return { ok: false, code: 'NO_NODE', reason: 'Node.js is not installed in this container, so its files could not be measured' };
  if (result?.stdoutTruncated) return { ok: false, code: 'OUTPUT_TOO_LARGE', reason: 'The measurement was larger than the reader accepts; its files could not be listed' };
  if (code === 124 || result?.timedOut) return { ok: false, code: 'TIMEOUT', reason: 'Measuring the files took too long and was stopped' };
  let facts = null;
  try { facts = JSON.parse(stdout.trim()); } catch { facts = null; }
  if (!facts || facts.ok !== true || !Array.isArray(facts.items)) return { ok: false, code: 'SCAN_FAILED', reason: 'The files could not be measured (the collector did not return a result)' };
  return { ok: true, facts };
}
