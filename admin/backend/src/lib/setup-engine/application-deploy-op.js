// Existing-application releases. No installer, service rewrite, credential
// minting or arbitrary command parameter. Only a saved profile and exact Git
// candidate are executable. Production switching requires an existing symlink
// layout; importing an ordinary application directory never converts it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RELEASE_CLEANUP_SOURCE, resolveReleaseRetention, releaseContextFromApplication } from './application-release-cleanup.js';
import { SAFE_GIT_SOURCE } from './safe-git.js';
import { containedScript, parseContainment, reapStaleWritersScript, reapAttemptScriptsScript, parseStaleWriters } from './guest-probes.js';

import { APPLICATION_JOB_KINDS, applicationGuestName, LEGACY_STARTUP_UNIT, legacyStartupFinding } from './application-deploy-logic.js';
export { APPLICATION_JOB_KINDS, applicationGuestName, validateApplicationJob } from './application-deploy-logic.js';
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function safeError(code, message) { const e = new Error(message); e.code = code; e.applicationReleaseSafe = true; return e; }

// The guest program receives data as JSON, not executable caller text. It uses
// fixed subprocess argv. Output contains identities and exit status only; npm,
// systemd and HTTP bodies never enter API-visible job logs.
const GUEST_PROGRAM = String.raw`
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
${RELEASE_CLEANUP_SOURCE}
${SAFE_GIT_SOURCE}
const a=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
function fail(code){process.stdout.write(JSON.stringify({ok:false,code}));process.exit(1)}
function run(cmd,args,opts={}){const r=cp.spawnSync(cmd,args,{encoding:'utf8',maxBuffer:1024*1024,...opts});if(r.status!==0)fail('COMMAND_FAILED');return String(r.stdout||'').trim()}
// Read-only git (safe-git.js): never as root — as the tree's non-root owner,
// else nobody — and never with the repository's fsmonitor, hooks, pager,
// attributes file or ssh command. Only the stage's checkout into root's own
// fresh clone runs as root (gitRoot).
function git(dir,args){const r=safeGit(cp,fs,dir,args,{timeout:300000});if(r.status!==0)fail('COMMAND_FAILED');return String(r.stdout||'').trim()}
function gitRoot(dir,args){const r=safeGit(cp,fs,dir,args,{timeout:300000,asRoot:true});if(r.status!==0)fail('COMMAND_FAILED');return String(r.stdout||'').trim()}
// The build runs as the service user with .git kept root-owned: the seal
// checks it is still the directory the stage made, root-owned, with no
// group or other write on it or its control files.
function gitMetadataUnchanged(stage,identity){
 const g=p.join(stage,'.git');let st=null;try{st=fs.lstatSync(g)}catch(e){st=null}
 if(!st&&!identity)return; // no repository and none recorded: the identity checks below refuse later
 if(!st||!st.isDirectory()||st.isSymbolicLink()||st.uid!==0||(st.mode&0o022))fail('GIT_METADATA_CHANGED');
 if(identity&&(st.dev!==Number(identity.dev)||st.ino!==Number(identity.ino)))fail('GIT_METADATA_CHANGED');
 for(const n of ['config','commondir','gitdir','HEAD','info','info/attributes','info/exclude','hooks']){let s=null;try{s=fs.lstatSync(p.join(g,n))}catch(e){continue}if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('GIT_METADATA_CHANGED')}
}
// For the pre-seal trim: whether Git tracks rel — true, false, or null when
// that cannot be told safely (then nothing is removed).
function tracked(dir,rel){const r=safeGit(cp,fs,dir,['ls-files','--',rel],{timeout:300000});if(r.status!==0)return null;return String(r.stdout||'').trim()!==''}
function inside(root,x){return x===root||x.startsWith(root+'/')}
function protectedPath(target){let at='/';for(const part of p.resolve(target).split('/').filter(Boolean)){at=p.join(at,part);if(!fs.existsSync(at))break;const s=fs.lstatSync(at);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('UNSAFE_RELEASE_DIRECTORY')}}
function inventory(root){const rows=[];const excluded=[...a.profile.preservePaths,...a.profile.envFiles].filter(x=>inside(a.profile.sourceDir,x)).map(x=>p.relative(a.profile.sourceDir,x));function walk(dir,rel=''){for(const n of fs.readdirSync(dir).sort()){const r=rel?rel+'/'+n:n;if(r==='.git'||r==='.proxypilot-release.json'||excluded.some(x=>r===x||r.startsWith(x+'/')))continue;const f=p.join(dir,n),s=fs.lstatSync(f);if(s.isSymbolicLink()){if(!inside(root,fs.realpathSync(f)))fail('ARTIFACT_SYMLINK_ESCAPE');rows.push([r,'link',fs.readlinkSync(f)])}else if(s.isDirectory())walk(f,r);else if(s.isFile())rows.push([r,'file',crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]);else fail('ARTIFACT_TYPE_UNSUPPORTED')}}walk(root);return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')}
// The tree the service user built is frozen by the fd-relative walker
// (safe-remove.js): a link swapped in mid-freeze is never followed, a file
// also linked from outside the tree is copied rather than re-owned, and a
// tree too deep to walk is refused with its own code (TOO_DEEP).
function freeze(root){try{safeRemover(fs,p).freezeTree(root)}catch(e){if(e&&typeof e.refusal==='string'&&/^[A-Z_]{3,64}$/.test(e.refusal))fail(e.refusal);throw e}}
function identity(root){let m;try{m=JSON.parse(fs.readFileSync(p.join(root,'.proxypilot-release.json'),'utf8'))}catch{m={sha:git(root,['rev-parse','HEAD'])}}if(!/^[a-f0-9]{40}$/.test(m.sha||''))fail('NO_RELEASE_IDENTITY');return m}
function layout(){if(!a.profile.releaseRoot)fail('RELEASE_ROOT_REQUIRED');protectedPath(p.dirname(a.profile.sourceDir));protectedPath(a.profile.releaseRoot);const link=fs.lstatSync(a.profile.sourceDir);if(!link.isSymbolicLink())fail('SYMLINK_LAYOUT_REQUIRED');if(link.uid!==0)fail('UNSAFE_RELEASE_DIRECTORY');const target=fs.realpathSync(a.profile.sourceDir);const root=fs.realpathSync(a.profile.releaseRoot);if(!inside(root,target)||target===root)fail('RELEASE_OUTSIDE_ROOT');return {target,root,identity:identity(target)}}
function service(){const unit=a.profile.serviceName;const loaded=run('systemctl',['show',unit,'--property=LoadState','--value']);if(loaded!=='loaded')fail('SERVICE_NOT_LOADED');const workingDir=run('systemctl',['show',unit,'--property=WorkingDirectory','--value']);const start=run('systemctl',['show',unit,'--property=ExecStart','--value']);if(workingDir!==a.profile.sourceDir&&!start.includes(a.profile.sourceDir+'/'))fail('SERVICE_LAYOUT_UNSUPPORTED');return {user:run('systemctl',['show',unit,'--property=User','--value'])||'root',group:run('systemctl',['show',unit,'--property=Group','--value'])||''}}
// The legacy boot unit (LEGACY_STARTUP_UNIT, application-deploy-logic.js):
// whether it exists, is enabled, and whether its script or working directory
// resolves inside sourceDir or releaseRoot. Read-only, fixed argv; is-enabled
// exits non-zero for a disabled unit, so neither call goes through run(). It
// never fails inspect, which the recovery paths read too; the job decides.
function legacyStartup(){
 const unit=${JSON.stringify(LEGACY_STARTUP_UNIT)};
 const sys=args=>{const r=cp.spawnSync('systemctl',args,{encoding:'utf8',maxBuffer:65536,timeout:30000});return {status:r.status,out:String(r.stdout||'').trim()}};
 const load=sys(['show',unit,'--property=LoadState','--value']);
 if(load.status!==0)return {state:'unknown'};
 if(load.out!=='loaded')return {state:'absent'};
 const enabled=sys(['is-enabled',unit]).out;
 const exec=/(?:^|[{;]\s*)path=([^\s;]+)/.exec(sys(['show',unit,'--property=ExecStart','--value']).out);
 const script=exec?exec[1]:null,workingDir=sys(['show',unit,'--property=WorkingDirectory','--value']).out.replace(/^[-!+]+/,'')||null;
 const real=x=>{try{return fs.realpathSync(x)}catch(e){return null}};
 const roots=[a.profile.sourceDir,a.profile.releaseRoot].filter(x=>typeof x==='string'&&x.startsWith('/'));
 const within=x=>{if(typeof x!=='string'||!x.startsWith('/'))return false;const n=p.resolve(x),r=real(n);return roots.some(root=>{const rr=real(root);return inside(p.resolve(root),n)||(!!r&&!!rr&&inside(rr,r))})};
 const shown=x=>typeof x==='string'&&/^\/[A-Za-z0-9._\/@+-]{0,255}$/.test(x)?x:null;
 return {state:'present',enabled:/^[a-z-]{1,32}$/.test(enabled)?enabled:'unknown',scriptPath:shown(script),workingDir:shown(workingDir),inside:within(script)||within(workingDir)};
}
let out={ok:true};
try{
if(a.action==='inspect'){const s=service();let startup;try{startup=legacyStartup()}catch(e){startup={state:'unknown'}}out={...out,...s,startup};if(a.strict)out={...out,...layout()};}
else if(a.action==='prepare'){protectedPath(a.root);fs.mkdirSync(a.root,{recursive:true,mode:0o755});protectedPath(a.root);const stageRoot=p.join(a.root,'.staging');if(fs.existsSync(stageRoot))protectedPath(stageRoot);else fs.mkdirSync(stageRoot,{mode:0o711});fs.chmodSync(stageRoot,0o711);}
else if(a.action==='stage'){
 if(fs.existsSync(a.stage)||fs.existsSync(a.release))fail('RELEASE_EXISTS');
 fs.chmodSync(a.bundle,0o600);
 fs.mkdirSync(a.stage,{recursive:true,mode:0o755});run('git',['-c','core.hooksPath=/dev/null','clone','--no-checkout','--',a.bundle,a.stage]);gitRoot(a.stage,['checkout','--detach',a.sha]);
 if(git(a.stage,['rev-parse','HEAD'])!==a.sha||git(a.stage,['rev-parse','HEAD^{tree}'])!==a.treeSha)fail('SOURCE_IDENTITY_MISMATCH');
 const pkg=JSON.parse(fs.readFileSync(p.join(a.stage,'package.json'),'utf8'));for(const n of a.scripts)if(typeof pkg.scripts?.[n]!=='string')fail('NAMED_SCRIPT_MISSING');
 // Builds run as the existing service identity; never invent an account.
 // The work tree is handed over, .git is not: it stays root-owned and not
 // writable by the service user, and the seal checks it is the same one.
 const gitDir=p.join(a.stage,'.git');const gst=fs.lstatSync(gitDir);if(!gst.isDirectory()||gst.isSymbolicLink())fail('SOURCE_IDENTITY_MISMATCH');
 fs.chmodSync(gitDir,0o755);out.gitIdentity={dev:gst.dev,ino:gst.ino};
 if(a.user!=='root'){const owner=a.user+(a.group?':'+a.group:'');for(const n of fs.readdirSync(a.stage)){if(n==='.git')continue;run('chown',['-R',owner,'--',p.join(a.stage,n)])}run('chown',[owner,'--',a.stage])}
 if(a.user!=='root'){const access=cp.spawnSync('runuser',['-u',a.user,'--','test','-r',p.join(a.stage,'package.json')],{stdio:'ignore'});if(access.status!==0)fail('SERVICE_USER_CANNOT_READ_RELEASE')}
}
else if(a.action==='script'){
 // .git is root-owned: the build's own git (git describe, rev-parse) is told
 // this exact work tree is safe (command-line scope, not the repository's).
 const gitEnv={...process.env,GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'safe.directory',GIT_CONFIG_VALUE_0:a.stage,GIT_CONFIG_KEY_1:'safe.directory',GIT_CONFIG_VALUE_1:p.join(a.stage,'.git')};
 const args=['run',a.script];const r=cp.spawnSync(a.user==='root'?'npm':'runuser',a.user==='root'?args:['-u',a.user,'--','npm',...args],{cwd:a.stage,stdio:'ignore',timeout:a.timeout,env:gitEnv});
 out={ok:r.status===0,code:r.status===0?'SCRIPT_PASSED':'SCRIPT_FAILED'};if(!out.ok){process.stdout.write(JSON.stringify(out));process.exit(1)}
}
else if(a.action==='release_cleanup'){out.cleanup=cleanupReleaseArtifacts(fs,p,a);}
else if(a.action==='seal'){
 // Builds run as the service user. The repository metadata must be the
 // root-owned .git the stage made; then reclaim the tree before the Git
 // integrity checks (which run unprivileged, safe-git.js).
 gitMetadataUnchanged(a.stage,a.gitIdentity);
 freeze(a.stage);
 // Generated build output is discarded BEFORE the artifact digest exists; a
 // sealed artifact is never edited. A tracked .cache refuses (as it always
 // has); any other tracked, linked or invalid entry is kept and reported.
 const trim=Array.isArray(a.retention?.trimBeforeSeal)?a.retention.trimBeforeSeal:(a.retention?.trimBuildCache?['.cache']:[]);
 if(trim.length){
  if(fs.lstatSync(a.stage).isSymbolicLink()||fs.realpathSync(a.stage)!==a.stage)fail('UNSAFE_CACHE_TARGET');
  if(fs.existsSync(p.join(a.stage,'.proxypilot-release.json')))fail('ALREADY_SEALED');
  out.trim={removed:[],kept:[]};
  for(const rel of trim){
   if(rel==='.cache'){
    const cache=p.join(a.stage,'.cache');
    const t=tracked(a.stage,'.cache');
    if(t===true)fail('TRACKED_BUILD_CACHE');
    if(t===null){if(fs.existsSync(cache))out.trim.kept.push({path:rel,reason:'unknown'});continue}
    if(fs.existsSync(cache)){safeRemover(fs,p).removePath(cache);out.trim.removed.push(rel)}
    continue;
   }
   if(typeof rel!=='string'||!/^[A-Za-z0-9._\/-]{1,200}$/.test(rel)||rel.startsWith('/')||rel.endsWith('/')||rel.split('/').some(s=>!s||s==='.'||s==='..'||s==='.git')){out.trim.kept.push({path:String(rel).slice(0,200),reason:'invalid'});continue}
   const t=tracked(a.stage,rel);
   if(t===null){out.trim.kept.push({path:rel,reason:'unknown'});continue}
   if(t){out.trim.kept.push({path:rel,reason:'tracked'});continue}
   let at=a.stage,state='ok';
   for(const part of rel.split('/').slice(0,-1)){at=p.join(at,part);let s=null;try{s=fs.lstatSync(at)}catch(e){if(e.code!=='ENOENT')throw e}if(!s){state='absent';break}if(!s.isDirectory()||s.isSymbolicLink()){state='link';break}}
   if(state==='absent')continue;
   if(state==='link'){out.trim.kept.push({path:rel,reason:'link'});continue}
   const target=p.join(a.stage,rel);let st=null;try{st=fs.lstatSync(target)}catch(e){if(e.code!=='ENOENT')throw e}
   if(!st)continue;
   if(st.isSymbolicLink()){out.trim.kept.push({path:rel,reason:'link'});continue}
   safeRemover(fs,p).removePath(target);out.trim.removed.push(rel);
  }
 }
 if(git(a.stage,['rev-parse','HEAD'])!==a.sha||git(a.stage,['rev-parse','HEAD^{tree}'])!==a.treeSha)fail('SOURCE_IDENTITY_MISMATCH');
 if(git(a.stage,['status','--porcelain','--untracked-files=no'])!=='')fail('TRACKED_SOURCE_MODIFIED');
 const artifactDigest=inventory(a.stage);const fd=fs.openSync(p.join(a.stage,'.proxypilot-release.json'),'wx',0o444);try{fs.writeFileSync(fd,JSON.stringify({...a.marker,artifactDigest}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}freeze(a.stage);const stageFd=fs.openSync(a.stage,'r');try{fs.fsyncSync(stageFd)}finally{fs.closeSync(stageFd)}fs.renameSync(a.stage,a.release);const parentFd=fs.openSync(p.dirname(a.release),'r');try{fs.fsyncSync(parentFd)}finally{fs.closeSync(parentFd)}out.artifactDigest=artifactDigest;
}
else if(a.action==='artifact'){
 const real=fs.realpathSync(a.release);if(real!==a.release)fail('RELEASE_PATH_CHANGED');const m=identity(real);
 if(m.sha!==a.sha||m.treeSha!==a.treeSha||m.profileDigest!==a.profileDigest||m.evidenceDigest!==a.evidenceDigest)fail('RELEASE_IDENTITY_MISMATCH');
 if(m.artifactDigest!==a.artifactDigest||m.artifactDigest!==inventory(real))fail('RELEASE_ARTIFACTS_CHANGED');
 if(git(real,['rev-parse','HEAD'])!==a.sha||git(real,['status','--porcelain','--untracked-files=no'])!=='')fail('RELEASE_SOURCE_CHANGED');out.marker=m;
}
else if(a.action==='links'){
 const paths=[...new Set([...a.profile.preservePaths,...a.profile.envFiles])].filter(x=>inside(a.profile.sourceDir,x));
 const rels=paths.map(x=>p.relative(a.profile.sourceDir,x));
 const tracked=git(a.release,['ls-files','-z']).split('\0').filter(Boolean);
 for(const rel of rels){
   if(!rel||rel.startsWith('../')||rels.some(other=>other!==rel&&(rel.startsWith(other+'/')||other.startsWith(rel+'/'))))fail('PRESERVED_PATH_OVERLAP');
   if(tracked.some(t=>t===rel||t.startsWith(rel+'/')||rel.startsWith(t+'/')))fail('PRESERVED_SOURCE_COLLISION');
   const old=p.join(a.previous,rel),dest=p.join(a.release,rel);if(!fs.existsSync(old))fail('PRESERVED_PATH_MISSING');
   let at=a.release;for(const part of rel.split('/').slice(0,-1)){at=p.join(at,part);if(fs.existsSync(at)){if(!fs.lstatSync(at).isDirectory()||fs.lstatSync(at).isSymbolicLink())fail('PRESERVED_PATH_COLLISION')}else fs.mkdirSync(at)}
   try{const st=fs.lstatSync(dest);if(st.isSymbolicLink()&&fs.realpathSync(dest)===fs.realpathSync(old))continue;fail('PRESERVED_PATH_COLLISION')}catch(e){if(e.code!=='ENOENT')throw e}
   fs.symlinkSync(fs.realpathSync(old),dest);
 }
}
else if(a.action==='switch'){
 const current=layout();if(current.target!==a.expected)fail('LIVE_TARGET_CHANGED');if(!inside(current.root,a.target)||fs.realpathSync(a.target)!==a.target)fail('RELEASE_OUTSIDE_ROOT');
 const tmp=a.profile.sourceDir+'.pp-'+a.jobId;if(fs.existsSync(tmp))fail('SWITCH_TEMP_EXISTS');fs.symlinkSync(a.target,tmp);fs.renameSync(tmp,a.profile.sourceDir);run('systemctl',['restart',a.profile.serviceName]);
}
else if(a.action==='verify'){
 const current=layout();if(a.expected&&current.target!==a.expected)fail('LIVE_TARGET_CHANGED');if(current.identity.sha!==a.sha)fail('LIVE_SHA_MISMATCH');
 if(run('systemctl',['is-active',a.profile.serviceName])!=='active')fail('SERVICE_NOT_ACTIVE');
 const pid=run('systemctl',['show',a.profile.serviceName,'--property=MainPID','--value']);if(!/^[1-9][0-9]*$/.test(pid))fail('NO_MAIN_PROCESS');
 // A process launched with another working directory cannot certify this
 // layout. This intentionally rejects unsupported service wrappers.
 if(fs.realpathSync('/proc/'+pid+'/cwd')!==current.target)fail('PROCESS_RELEASE_MISMATCH');
 const r=cp.spawnSync('curl',['--fail','--silent','--output','/dev/null','--max-time','10',a.profile.healthUrl],{stdio:'ignore'});if(r.status!==0)fail('HEALTH_FAILED');
 if(a.expectedArtifactDigest&&current.identity.artifactDigest!==a.expectedArtifactDigest)fail('LIVE_ARTIFACT_IDENTITY_MISMATCH');
 if(current.identity.artifactDigest&&current.identity.artifactDigest!==inventory(current.target))fail('LIVE_ARTIFACTS_CHANGED');
 out={...out,target:current.target,sha:current.identity.sha,artifactDigest:current.identity.artifactDigest||null,pid:Number(pid)};
}
else fail('UNKNOWN_ACTION');
process.stdout.write(JSON.stringify(out));
}catch(e){fail(e.code==='ENOENT'?'REQUIRED_PATH_MISSING':'GUEST_OPERATION_FAILED')}
`;

// Guest refusals that have a plain explanation of their own.
const PLAIN_GUEST_FAILURES = Object.freeze({
  GIT_METADATA_CHANGED: "The repository's git metadata changed during the build, so this release was not sealed.",
  TOO_DEEP: 'The build left folders nested too deeply to seal safely, so this release was not sealed.',
  CHANGED_DURING_FREEZE: 'The build output changed while it was being sealed, so this release was not sealed.',
  MOUNT_INSIDE: 'The build output contains a mounted filesystem, so this release was not sealed.',
});

function guestScript(data) { return `node -e ${quote(GUEST_PROGRAM)} ${quote(Buffer.from(JSON.stringify(data)).toString('base64'))}\n`; }
export { guestScript as applicationGuestScript };

export async function runApplicationReleaseOperation({ kind, params, exec, job, prior = null, service, releaseRetention = null, releaseHistory = null, hostFs = fs, hostRoot = '/var/lib/proxypilot/application-release-transfers', sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (typeof service === 'function') service = await service();
  if (!service) { const m = await import('../../mock2/application-releases.js'); service = await m.getApplicationReleaseService(); }
  const reference = { sha: params.sha, profileRevision: params.profileRevision, profileDigest: params.profileDigest };
  const prepared = await (kind === 'application_deploy' ? service.prepareDeployment(params.applicationId, reference) : service.prepareCandidate(params.applicationId, reference));
  const { profile, candidate, gitDir } = prepared;
  // The storage policy's effective release retention when one is enabled,
  // else the static opt-in (Nodus), else none. An unreadable policy applies
  // no retention at all rather than a guessed one.
  let retention = null;
  try { retention = await resolveReleaseRetention(releaseRetention, profile.targetId); }
  catch { retention = null; job.event?.('retention_unavailable', 'The storage policy could not be read; no release retention was applied to this job.'); }
  const container = applicationGuestName(profile.targetId);
  if (job.app !== container) throw safeError('GUEST_IDENTITY_MISMATCH', 'The saved profile does not match the locked application guest.');
  if (profile.digest !== params.profileDigest || profile.revision !== params.profileRevision || candidate.sha !== params.sha || candidate.treeSha !== params.treeSha) throw safeError('PROFILE_CHANGED', 'Saved application profile or candidate changed; create a new job.');
  const root = profile.releaseRoot || `/var/lib/proxypilot/application-releases/${params.applicationId}`;
  // The facts the guest decides the release roles from (describeReleases):
  // the recorded previous release, the deploy history's previous release
  // (releaseHistory → lib/app-storage/release-history.js) and the passed
  // validations. With none of them the guest removes no release at all.
  let releaseContext = { previousSha: null, rollback: null, previousLive: null, liveVerifiedAt: null, validated: [] };
  if (retention && typeof service.getApplication === 'function') {
    // No history source: the live record's own previousSha (undefined). A
    // source that fails: unknown (null), so no release is removed.
    let previousLive;
    if (typeof releaseHistory === 'function') { try { previousLive = (await releaseHistory(params.applicationId)) ?? null; } catch { previousLive = null; } }
    try { releaseContext = releaseContextFromApplication(await service.getApplication(params.applicationId), { root, previousLive }); } catch { /* no context: the guest removes no release */ }
  }
  const validation = candidate.validation || prepared.validation;
  const release = kind === 'application_validate' ? `${root}/${candidate.sha}-p${profile.revision}-${job.id}` : validation?.releasePath;
  const attempt = `${job.id}-${job.epoch || 1}`;
  let disruptive = false;
  const guest = async (action, extra = {}, timeoutMs = 90000) => {
    job.fence({ safe: !disruptive });
    const r = await exec.guest(container, containedScript(attempt, guestScript({ action, profile, retention, ...extra })), { timeoutMs });
    job.fence({ safe: !disruptive });
    if (parseContainment(r?.stderr)?.kind === 'none') throw safeError('CONTAINMENT_UNAVAILABLE', 'Application scripts require guest process containment.');
    let answer; try { answer = JSON.parse(String(r?.stdout || '').trim()); } catch { throw safeError('GUEST_RESULT_INVALID', 'The application operation did not return a valid bounded result.'); }
    if (r.code !== 0 || !answer.ok) throw safeError(answer.code || 'GUEST_FAILED', PLAIN_GUEST_FAILURES[answer.code] || `Application operation ${action} failed (${answer.code || 'unknown'}). Existing logs and data were not returned.`);
    return answer;
  };
  const mark = (phase, data = {}) => { job.fence({ safe: !disruptive }); job.checkpoint(phase, { applicationRelease: true, resumable: false, disruptive, ...data }); job.event?.('step', phase); };
  // A legacy boot unit pointing into the live release (legacyStartupFinding):
  // every job reports it once, from its first inspect. Only a deploy or
  // rollback about to promote refuses it; recovery only reports it.
  let startupReported = false;
  const reportStartup = observed => {
    const finding = legacyStartupFinding(observed?.startup);
    if (finding && !startupReported) { startupReported = true; job.event?.('legacy_startup', finding.message, finding.data); }
    return finding;
  };
  job.fence({ safe: true });
  const reap = await exec.guest(container, reapStaleWritersScript(attempt), { timeoutMs: 30000 });
  if (parseStaleWriters(reap?.stdout) !== 0) throw safeError('PREVIOUS_WRITER_ALIVE', 'A previous application writer could not be established stopped; no release action was issued.');
  if (prior?.applicationRelease && prior.disruptive) {
    // A dead promotion never runs again. Restore only its recorded old target,
    // and only if the current target is still one of those two exact paths.
    disruptive = true;
    const observed = await guest('inspect', { strict: true }); reportStartup(observed);
    if (![prior.previousTarget, prior.nextTarget].includes(observed.target)) throw safeError('LIVE_TARGET_CHANGED', 'Interrupted release has an unexpected live target; operator recovery is required.');
    if (observed.target !== prior.previousTarget) await guest('switch', { expected: prior.nextTarget, target: prior.previousTarget, jobId: attempt });
    else { const restarted = await exec.guest(container, containedScript(attempt, `systemctl restart ${quote(profile.serviceName)}\n`), { timeoutMs: 90000 }); if (restarted.code !== 0) throw safeError('RECOVERY_FAILED', 'The existing application service could not restart.'); }
    const proof = await verify(prior.previousTarget, prior.previousSha, prior.previousArtifactDigest);
    await service.recordLive(params.applicationId, { sha: prior.previousSha, profileDigest: profile.digest, jobId: job.id, releasePath: prior.previousTarget, previousSha: prior.previousSha, evidenceDigest: digest(proof), restored: true, ...(/^[a-f0-9]{40}$/.test(prior.nextSha || '') && prior.nextSha !== prior.previousSha ? { rollbackOf: prior.nextSha } : {}) });
    mark('interrupted_release_recovered', { disruptive: false });
    return { ok: false, recovered: true, outcome: 'interrupted_release_rolled_back', verification: proof };
  }
  async function verify(target, sha, expectedArtifactDigest = null) {
    let last;
    for (let n = 0; n < 12; n++) { try { return await guest('verify', { expected: target, sha, expectedArtifactDigest }, 20000); } catch (e) { if (['FENCED','CANCELLED'].includes(e.code)) throw e; last = e; if (n < 11) await sleep(1000); } }
    throw last;
  }
  if (kind === 'application_validate') {
    mark('inspect'); const identity = await guest('inspect', { strict: false }); reportStartup(identity);
    const stage = `${root}/.staging/${attempt}`;
    const bundle = `${root}/.staging/${attempt}.bundle`;
    const scripts = [profile.installScript, profile.buildScript, ...(profile.validationScripts || [])].filter(Boolean);
    if (!profile.validationScripts?.length) throw safeError('NO_VALIDATION_SCRIPTS', 'At least one saved validation script is required; installation/build alone is not a test.');
    // A requested rerun replaces the current acceptance only when it passes;
    // failure must not leave an earlier pass masquerading as this run's result.
    await service.recordValidation(params.applicationId, candidate.sha, { profileDigest: profile.digest, treeSha: candidate.treeSha, passed: false, evidenceDigest: digest({ jobId: job.id, state: 'running' }), jobId: job.id, releasePath: release });
    let transfer; let guestCleaned = false;
    try {
      await hostFs.mkdir(hostRoot, { recursive: true, mode: 0o700 });
      // The transfer copy names its application (bundle-app<id>-<random>), so
      // the storage check attributes it to this application only.
      const appId = Number(params.applicationId);
      if (!Number.isInteger(appId) || appId < 1) throw safeError('INVALID_REFERENCE', 'The application reference is not valid.');
      transfer = await hostFs.mkdtemp(path.join(hostRoot, `bundle-app${appId}-`));
      const hostBundle = path.join(transfer, 'source.bundle');
      const transferRepo = path.join(transfer, 'source.git');
      mark('bundle');
      // Isolate the exact immutable commit and its ancestry: --all on the
      // mutable canonical repository could include an unrelated, unreviewed
      // branch published while this operation was running.
      for (const argv of [
        ['git', 'init', '--bare', transferRepo],
        ['git', `--git-dir=${transferRepo}`, 'fetch', '--no-tags', '--', gitDir, candidate.sha],
        ['git', `--git-dir=${transferRepo}`, 'update-ref', 'refs/heads/release', candidate.sha],
        ['git', `--git-dir=${transferRepo}`, 'bundle', 'create', hostBundle, 'refs/heads/release'],
        ['git', `--git-dir=${transferRepo}`, 'bundle', 'verify', hostBundle],
      ]) {
        job.fence({ safe: true }); const r = await exec.host(argv, { timeoutMs: 120000 }); if (r.code !== 0) throw safeError('BUNDLE_FAILED', 'Exact candidate Git bundle creation or verification failed.');
      }
      await hostFs.chmod(hostBundle, 0o600);
      // The transfer target and root are fixed by the immutable profile.
      await guest('prepare', { root });
      if (retention) { const swept = await guest('release_cleanup', { stage, bundle, release, sweepStages: retention.workspaces !== false, ...releaseContext }, 120000); if (swept.cleanup?.kept?.length) job.event?.('cleanup_incomplete', 'Some abandoned build workspaces could not be removed and were left in place; the build continues.', { kept: swept.cleanup.kept.slice(0, 20) }); }
      job.fence({ safe: true }); const r = await exec.host(['incus', 'file', 'push', hostBundle, `${container}${bundle}`], { timeoutMs: 120000 }); if (r.code !== 0) throw safeError('TRANSFER_FAILED', 'Git bundle transfer failed.');
      mark('stage'); const staged = await guest('stage', { stage, release, bundle, sha: candidate.sha, treeSha: candidate.treeSha, scripts, user: identity.user, group: identity.group }, 120000);
      const evidence = [];
      for (const script of scripts) { mark(`script:${script}`); await guest('script', { stage, script, user: identity.user, timeout: 600000 }, 620000); evidence.push({ script, passed: true }); }
      const evidenceDigest = digest({ sha: candidate.sha, treeSha: candidate.treeSha, profileDigest: profile.digest, evidence });
      // No process the build started may outlive it into the seal: every
      // scope and cgroup this attempt's scripts ran in is killed and counted
      // (guest-probes.js reapAttemptScriptsScript, the same containment the
      // stale-writer reap uses for earlier attempts).
      mark('stop_build_processes');
      job.fence({ safe: true });
      const leftovers = await exec.guest(container, reapAttemptScriptsScript(attempt), { timeoutMs: 30000 });
      if (parseStaleWriters(leftovers?.stdout) !== 0) throw safeError('BUILD_PROCESS_ALIVE', 'A process the build started could not be stopped, so this release was not sealed.');
      const sealed = await guest('seal', { stage, release, sha: candidate.sha, treeSha: candidate.treeSha, gitIdentity: staged?.gitIdentity || null, marker: { sha: candidate.sha, treeSha: candidate.treeSha, profileDigest: profile.digest, evidenceDigest } });
      if (sealed.trim && (sealed.trim.removed?.length || sealed.trim.kept?.length)) job.event?.('trim', sealed.trim.kept?.length ? 'Generated build output removed before sealing; some entries were kept' : 'Generated build output removed before sealing', sealed.trim);
      if (retention) { const cleaned = await guest('release_cleanup', { stage, bundle, release, ...releaseContext }, 120000); guestCleaned = true; job.event?.('cleanup', 'Release retention applied', cleaned.cleanup); }
      job.fence({ safe: true }); await service.recordValidation(params.applicationId, candidate.sha, { profileDigest: profile.digest, treeSha: candidate.treeSha, passed: true, evidenceDigest, artifactDigest: sealed.artifactDigest, jobId: job.id, releasePath: release });
      mark('validated'); return { ok: true, outcome: 'validated', verification: { state: 'tested', sha: candidate.sha, evidenceDigest, releasePath: release } };
    } finally {
      if (retention && !guestCleaned) {
        try { const cleaned = await guest('release_cleanup', { stage, bundle, release, ...releaseContext }, 120000); job.event?.('cleanup', 'Build workspace and transfer archive removed', cleaned.cleanup); }
        catch (error) { job.event?.('cleanup_failed', 'Guest cleanup was not verified; the next validation will retry after checking prior writers are stopped', { code: error.code || 'CLEANUP_FAILED' }); }
      }
      if (transfer) await hostFs.rm(transfer, { recursive: true, force: true });
    }
  }
  mark('inspect'); const previous = await guest('inspect', { strict: true }); const startup = reportStartup(previous);
  if (!validation?.passed || !/^[a-f0-9]{64}$/.test(validation.artifactDigest || '') || validation.profileDigest !== profile.digest || validation.treeSha !== candidate.treeSha || typeof release !== 'string' || !release.startsWith(`${root}/${candidate.sha}-p${profile.revision}-`) || release.includes('/../')) throw safeError('VALIDATION_REQUIRED', 'This exact candidate, profile and release artifact need successful validation.');
  await guest('artifact', { release, sha: candidate.sha, treeSha: candidate.treeSha, profileDigest: profile.digest, evidenceDigest: validation.evidenceDigest, artifactDigest: validation.artifactDigest });
  if (kind === 'application_verify') {
    const proof = await verify(release, candidate.sha, validation.artifactDigest);
    // Verifying what is live must not forget which release ran before it:
    // the same release keeps its recorded previous release; a different one
    // (live changed outside a deployment) had the recorded one before it.
    const before = typeof service.getApplication === 'function' ? (await service.getApplication(params.applicationId))?.live || null : null;
    const same = before?.sha === candidate.sha;
    const previousSha = same ? (before.previousSha && before.previousSha !== candidate.sha ? before.previousSha : null) : (/^[a-f0-9]{40}$/.test(before?.sha || '') ? before.sha : null);
    const rollbackOf = same && /^[a-f0-9]{40}$/.test(before.rollbackOf || '') ? before.rollbackOf : null;
    await service.recordLive(params.applicationId, { sha: candidate.sha, profileDigest: profile.digest, jobId: job.id, releasePath: release, ...(previousSha ? { previousSha } : {}), ...(rollbackOf ? { rollbackOf } : {}), evidenceDigest: digest(proof) });
    return { ok: true, outcome: 'live_verified', verification: proof };
  }
  if (previous.target === release) { const proof = await verify(release, candidate.sha, validation.artifactDigest); return { ok: true, outcome: 'already_live', verification: proof }; }
  // Promotion refuses an enabled legacy boot unit before anything changes
  // (not disruptive yet: the job fails plainly, no recovery hold). The
  // interrupted-release recovery above and rollback-on-failure below never
  // reach this check.
  if (startup?.blocks) throw safeError(startup.code, startup.message);
  // Shared paths are attached only after validation. Scripts do not receive
  // production env files or shared data during the build/test phase.
  await guest('links', { release, previous: previous.target });
  // A profile edit or a newly failed validation invalidates an old queued
  // approval even if the long-running build/health work started earlier.
  const currentApproval = await service.prepareDeployment(params.applicationId, reference);
  const currentValidation = currentApproval.candidate.validation || currentApproval.validation;
  if (currentApproval.profile.digest !== profile.digest || currentValidation?.evidenceDigest !== validation.evidenceDigest || currentValidation?.releasePath !== release) throw safeError('APPROVAL_CHANGED', 'The release approval changed before promotion; validate the current profile again.');
  disruptive = true;
  const recovery = { previousTarget: previous.target, previousSha: previous.identity.sha, previousArtifactDigest: previous.identity.artifactDigest || null, nextTarget: release, nextSha: candidate.sha };
  mark('promoting', recovery);
  try {
    await guest('switch', { expected: previous.target, target: release, jobId: attempt });
    const proof = await verify(release, candidate.sha, validation.artifactDigest);
    // A rollback job records the release it rolled back FROM, so the deploy
    // history never takes that one for the release live before this one.
    const rolledBack = kind === 'application_rollback' && /^[a-f0-9]{40}$/.test(previous.identity.sha || '') && previous.identity.sha !== candidate.sha ? { rollbackOf: previous.identity.sha } : {};
    job.fence(); await service.recordLive(params.applicationId, { sha: candidate.sha, profileDigest: profile.digest, jobId: job.id, releasePath: release, previousSha: previous.identity.sha, ...rolledBack, evidenceDigest: digest(proof) });
    disruptive = false; mark('live_verified', recovery);
    return { ok: true, outcome: 'live_verified', verification: proof };
  } catch (e) {
    if (['FENCED','CANCELLED'].includes(e.code)) throw e;
    mark('rolling_back', recovery);
    const current = await guest('inspect', { strict: true });
    if (current.target === release) await guest('switch', { expected: release, target: previous.target, jobId: attempt });
    else if (current.target !== previous.target) throw safeError('LIVE_TARGET_CHANGED', 'The live target changed during rollback; manual inspection is required.');
    const proof = await verify(previous.target, previous.identity.sha, previous.identity.artifactDigest);
    await service.recordLive(params.applicationId, { sha: previous.identity.sha, profileDigest: profile.digest, jobId: job.id, releasePath: previous.target, previousSha: previous.identity.sha, evidenceDigest: digest(proof), restored: true, ...(candidate.sha !== previous.identity.sha ? { rollbackOf: candidate.sha } : {}) });
    disruptive = false; mark('rolled_back', recovery);
    return { ok: false, recovered: true, outcome: 'release_failed_rolled_back', verification: proof };
  }
}
