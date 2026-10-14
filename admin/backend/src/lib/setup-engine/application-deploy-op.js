// Existing-application releases. No installer, service rewrite, credential
// minting or arbitrary command parameter. Only a saved profile and exact Git
// candidate are executable. Production switching requires an existing symlink
// layout; importing an ordinary application directory never converts it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { containedScript, parseContainment, reapStaleWritersScript, parseStaleWriters } from './guest-probes.js';

import { APPLICATION_JOB_KINDS, applicationGuestName } from './application-deploy-logic.js';
export { APPLICATION_JOB_KINDS, applicationGuestName, validateApplicationJob } from './application-deploy-logic.js';
const quote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function safeError(code, message) { const e = new Error(message); e.code = code; e.applicationReleaseSafe = true; return e; }

// The guest program receives data as JSON, not executable caller text. It uses
// fixed subprocess argv. Output contains identities and exit status only; npm,
// systemd and HTTP bodies never enter API-visible job logs.
const GUEST_PROGRAM = String.raw`
const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const a=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
function fail(code){process.stdout.write(JSON.stringify({ok:false,code}));process.exit(1)}
function run(cmd,args,opts={}){const r=cp.spawnSync(cmd,args,{encoding:'utf8',maxBuffer:1024*1024,...opts});if(r.status!==0)fail('COMMAND_FAILED');return String(r.stdout||'').trim()}
function inside(root,x){return x===root||x.startsWith(root+'/')}
function protectedPath(target){let at='/';for(const part of p.resolve(target).split('/').filter(Boolean)){at=p.join(at,part);if(!fs.existsSync(at))break;const s=fs.lstatSync(at);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('UNSAFE_RELEASE_DIRECTORY')}}
function inventory(root){const rows=[];const excluded=[...a.profile.preservePaths,...a.profile.envFiles].filter(x=>inside(a.profile.sourceDir,x)).map(x=>p.relative(a.profile.sourceDir,x));function walk(dir,rel=''){for(const n of fs.readdirSync(dir).sort()){const r=rel?rel+'/'+n:n;if(r==='.git'||r==='.proxypilot-release.json'||excluded.some(x=>r===x||r.startsWith(x+'/')))continue;const f=p.join(dir,n),s=fs.lstatSync(f);if(s.isSymbolicLink()){if(!inside(root,fs.realpathSync(f)))fail('ARTIFACT_SYMLINK_ESCAPE');rows.push([r,'link',fs.readlinkSync(f)])}else if(s.isDirectory())walk(f,r);else if(s.isFile())rows.push([r,'file',crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]);else fail('ARTIFACT_TYPE_UNSUPPORTED')}}walk(root);return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')}
function freeze(root){for(const n of fs.readdirSync(root)){const f=p.join(root,n),s=fs.lstatSync(f);fs.lchownSync(f,0,0);if(s.isSymbolicLink())continue;if(s.isDirectory())freeze(f);fs.chmodSync(f,s.isDirectory()?0o755:((s.mode&0o111)?0o555:0o444))}fs.chownSync(root,0,0);fs.chmodSync(root,0o755)}
function identity(root){let m;try{m=JSON.parse(fs.readFileSync(p.join(root,'.proxypilot-release.json'),'utf8'))}catch{m={sha:run('git',['-C',root,'rev-parse','HEAD'])}}if(!/^[a-f0-9]{40}$/.test(m.sha||''))fail('NO_RELEASE_IDENTITY');return m}
function layout(){if(!a.profile.releaseRoot)fail('RELEASE_ROOT_REQUIRED');protectedPath(p.dirname(a.profile.sourceDir));protectedPath(a.profile.releaseRoot);const link=fs.lstatSync(a.profile.sourceDir);if(!link.isSymbolicLink())fail('SYMLINK_LAYOUT_REQUIRED');if(link.uid!==0)fail('UNSAFE_RELEASE_DIRECTORY');const target=fs.realpathSync(a.profile.sourceDir);const root=fs.realpathSync(a.profile.releaseRoot);if(!inside(root,target)||target===root)fail('RELEASE_OUTSIDE_ROOT');return {target,root,identity:identity(target)}}
function service(){const unit=a.profile.serviceName;const loaded=run('systemctl',['show',unit,'--property=LoadState','--value']);if(loaded!=='loaded')fail('SERVICE_NOT_LOADED');const workingDir=run('systemctl',['show',unit,'--property=WorkingDirectory','--value']);const start=run('systemctl',['show',unit,'--property=ExecStart','--value']);if(workingDir!==a.profile.sourceDir&&!start.includes(a.profile.sourceDir+'/'))fail('SERVICE_LAYOUT_UNSUPPORTED');return {user:run('systemctl',['show',unit,'--property=User','--value'])||'root',group:run('systemctl',['show',unit,'--property=Group','--value'])||''}}
let out={ok:true};
try{
if(a.action==='inspect'){const s=service();out={...out,...s};if(a.strict)out={...out,...layout()};}
else if(a.action==='prepare'){protectedPath(a.root);fs.mkdirSync(a.root,{recursive:true,mode:0o755});protectedPath(a.root);const stageRoot=p.join(a.root,'.staging');if(fs.existsSync(stageRoot))protectedPath(stageRoot);else fs.mkdirSync(stageRoot,{mode:0o711});fs.chmodSync(stageRoot,0o711);}
else if(a.action==='stage'){
 if(fs.existsSync(a.stage)||fs.existsSync(a.release))fail('RELEASE_EXISTS');
 fs.chmodSync(a.bundle,0o600);
 fs.mkdirSync(a.stage,{recursive:true,mode:0o755});run('git',['clone','--no-checkout','--',a.bundle,a.stage]);run('git',['-C',a.stage,'checkout','--detach',a.sha]);
 if(run('git',['-C',a.stage,'rev-parse','HEAD'])!==a.sha||run('git',['-C',a.stage,'rev-parse','HEAD^{tree}'])!==a.treeSha)fail('SOURCE_IDENTITY_MISMATCH');
 const pkg=JSON.parse(fs.readFileSync(p.join(a.stage,'package.json'),'utf8'));for(const n of a.scripts)if(typeof pkg.scripts?.[n]!=='string')fail('NAMED_SCRIPT_MISSING');
 // Builds run as the existing service identity; never invent an account.
 if(a.user!=='root')run('chown',['-R',a.user+(a.group?':'+a.group:''),'--',a.stage]);
 if(a.user!=='root'){const access=cp.spawnSync('runuser',['-u',a.user,'--','test','-r',p.join(a.stage,'package.json')],{stdio:'ignore'});if(access.status!==0)fail('SERVICE_USER_CANNOT_READ_RELEASE')}
}
else if(a.action==='script'){
 const args=['run',a.script];const r=cp.spawnSync(a.user==='root'?'npm':'runuser',a.user==='root'?args:['-u',a.user,'--','npm',...args],{cwd:a.stage,stdio:'ignore',timeout:a.timeout});
 out={ok:r.status===0,code:r.status===0?'SCRIPT_PASSED':'SCRIPT_FAILED'};if(!out.ok){process.stdout.write(JSON.stringify(out));process.exit(1)}
}
else if(a.action==='seal'){
 // Builds run as the service user. Reclaim the tree before root-owned Git
 // integrity checks; leave Git's repository ownership protection enabled.
 freeze(a.stage);
 if(run('git',['-C',a.stage,'rev-parse','HEAD'])!==a.sha||run('git',['-C',a.stage,'rev-parse','HEAD^{tree}'])!==a.treeSha)fail('SOURCE_IDENTITY_MISMATCH');
 if(run('git',['-C',a.stage,'status','--porcelain','--untracked-files=no'])!=='')fail('TRACKED_SOURCE_MODIFIED');
 const artifactDigest=inventory(a.stage);const fd=fs.openSync(p.join(a.stage,'.proxypilot-release.json'),'wx',0o444);try{fs.writeFileSync(fd,JSON.stringify({...a.marker,artifactDigest}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}freeze(a.stage);const stageFd=fs.openSync(a.stage,'r');try{fs.fsyncSync(stageFd)}finally{fs.closeSync(stageFd)}fs.renameSync(a.stage,a.release);const parentFd=fs.openSync(p.dirname(a.release),'r');try{fs.fsyncSync(parentFd)}finally{fs.closeSync(parentFd)}out.artifactDigest=artifactDigest;
}
else if(a.action==='artifact'){
 const real=fs.realpathSync(a.release);if(real!==a.release)fail('RELEASE_PATH_CHANGED');const m=identity(real);
 if(m.sha!==a.sha||m.treeSha!==a.treeSha||m.profileDigest!==a.profileDigest||m.evidenceDigest!==a.evidenceDigest)fail('RELEASE_IDENTITY_MISMATCH');
 if(m.artifactDigest!==a.artifactDigest||m.artifactDigest!==inventory(real))fail('RELEASE_ARTIFACTS_CHANGED');
 if(run('git',['-C',real,'rev-parse','HEAD'])!==a.sha||run('git',['-C',real,'status','--porcelain','--untracked-files=no'])!=='')fail('RELEASE_SOURCE_CHANGED');out.marker=m;
}
else if(a.action==='links'){
 const paths=[...new Set([...a.profile.preservePaths,...a.profile.envFiles])].filter(x=>inside(a.profile.sourceDir,x));
 const rels=paths.map(x=>p.relative(a.profile.sourceDir,x));
 const tracked=run('git',['-C',a.release,'ls-files','-z']).split('\0').filter(Boolean);
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

function guestScript(data) { return `node -e ${quote(GUEST_PROGRAM)} ${quote(Buffer.from(JSON.stringify(data)).toString('base64'))}\n`; }
export { guestScript as applicationGuestScript };

export async function runApplicationReleaseOperation({ kind, params, exec, job, prior = null, service, hostFs = fs, hostRoot = '/var/lib/proxypilot/application-release-transfers', sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (typeof service === 'function') service = await service();
  if (!service) { const m = await import('../../mock2/application-releases.js'); service = await m.getApplicationReleaseService(); }
  const reference = { sha: params.sha, profileRevision: params.profileRevision, profileDigest: params.profileDigest };
  const prepared = await (kind === 'application_deploy' ? service.prepareDeployment(params.applicationId, reference) : service.prepareCandidate(params.applicationId, reference));
  const { profile, candidate, gitDir } = prepared;
  const container = applicationGuestName(profile.targetId);
  if (job.app !== container) throw safeError('GUEST_IDENTITY_MISMATCH', 'The saved profile does not match the locked application guest.');
  if (profile.digest !== params.profileDigest || profile.revision !== params.profileRevision || candidate.sha !== params.sha || candidate.treeSha !== params.treeSha) throw safeError('PROFILE_CHANGED', 'Saved application profile or candidate changed; create a new job.');
  const root = profile.releaseRoot || `/var/lib/proxypilot/application-releases/${params.applicationId}`;
  const validation = candidate.validation || prepared.validation;
  const release = kind === 'application_validate' ? `${root}/${candidate.sha}-p${profile.revision}-${job.id}` : validation?.releasePath;
  const attempt = `${job.id}-${job.epoch || 1}`;
  let disruptive = false;
  const guest = async (action, extra = {}, timeoutMs = 90000) => {
    job.fence({ safe: !disruptive });
    const r = await exec.guest(container, containedScript(attempt, guestScript({ action, profile, ...extra })), { timeoutMs });
    job.fence({ safe: !disruptive });
    if (parseContainment(r?.stderr)?.kind === 'none') throw safeError('CONTAINMENT_UNAVAILABLE', 'Application scripts require guest process containment.');
    let answer; try { answer = JSON.parse(String(r?.stdout || '').trim()); } catch { throw safeError('GUEST_RESULT_INVALID', 'The application operation did not return a valid bounded result.'); }
    if (r.code !== 0 || !answer.ok) throw safeError(answer.code || 'GUEST_FAILED', `Application operation ${action} failed (${answer.code || 'unknown'}). Existing logs and data were not returned.`);
    return answer;
  };
  const mark = (phase, data = {}) => { job.fence({ safe: !disruptive }); job.checkpoint(phase, { applicationRelease: true, resumable: false, disruptive, ...data }); job.event?.('step', phase); };
  job.fence({ safe: true });
  const reap = await exec.guest(container, reapStaleWritersScript(attempt), { timeoutMs: 30000 });
  if (parseStaleWriters(reap?.stdout) !== 0) throw safeError('PREVIOUS_WRITER_ALIVE', 'A previous application writer could not be established stopped; no release action was issued.');
  if (prior?.applicationRelease && prior.disruptive) {
    // A dead promotion never runs again. Restore only its recorded old target,
    // and only if the current target is still one of those two exact paths.
    disruptive = true;
    const observed = await guest('inspect', { strict: true });
    if (![prior.previousTarget, prior.nextTarget].includes(observed.target)) throw safeError('LIVE_TARGET_CHANGED', 'Interrupted release has an unexpected live target; operator recovery is required.');
    if (observed.target !== prior.previousTarget) await guest('switch', { expected: prior.nextTarget, target: prior.previousTarget, jobId: attempt });
    else { const restarted = await exec.guest(container, containedScript(attempt, `systemctl restart ${quote(profile.serviceName)}\n`), { timeoutMs: 90000 }); if (restarted.code !== 0) throw safeError('RECOVERY_FAILED', 'The existing application service could not restart.'); }
    const proof = await verify(prior.previousTarget, prior.previousSha, prior.previousArtifactDigest);
    await service.recordLive(params.applicationId, { sha: prior.previousSha, profileDigest: profile.digest, jobId: job.id, releasePath: prior.previousTarget, previousSha: prior.previousSha, evidenceDigest: digest(proof), restored: true });
    mark('interrupted_release_recovered', { disruptive: false });
    return { ok: false, recovered: true, outcome: 'interrupted_release_rolled_back', verification: proof };
  }
  async function verify(target, sha, expectedArtifactDigest = null) {
    let last;
    for (let n = 0; n < 12; n++) { try { return await guest('verify', { expected: target, sha, expectedArtifactDigest }, 20000); } catch (e) { if (['FENCED','CANCELLED'].includes(e.code)) throw e; last = e; if (n < 11) await sleep(1000); } }
    throw last;
  }
  if (kind === 'application_validate') {
    mark('inspect'); const identity = await guest('inspect', { strict: false });
    const stage = `${root}/.staging/${attempt}`;
    const bundle = `${root}/.staging/${attempt}.bundle`;
    const scripts = [profile.installScript, profile.buildScript, ...(profile.validationScripts || [])].filter(Boolean);
    if (!profile.validationScripts?.length) throw safeError('NO_VALIDATION_SCRIPTS', 'At least one saved validation script is required; installation/build alone is not a test.');
    // A requested rerun replaces the current acceptance only when it passes;
    // failure must not leave an earlier pass masquerading as this run's result.
    await service.recordValidation(params.applicationId, candidate.sha, { profileDigest: profile.digest, treeSha: candidate.treeSha, passed: false, evidenceDigest: digest({ jobId: job.id, state: 'running' }), jobId: job.id, releasePath: release });
    let transfer;
    try {
      await hostFs.mkdir(hostRoot, { recursive: true, mode: 0o700 });
      transfer = await hostFs.mkdtemp(path.join(hostRoot, 'bundle-'));
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
      job.fence({ safe: true }); const r = await exec.host(['incus', 'file', 'push', hostBundle, `${container}${bundle}`], { timeoutMs: 120000 }); if (r.code !== 0) throw safeError('TRANSFER_FAILED', 'Git bundle transfer failed.');
      mark('stage'); await guest('stage', { stage, release, bundle, sha: candidate.sha, treeSha: candidate.treeSha, scripts, user: identity.user, group: identity.group }, 120000);
      const evidence = [];
      for (const script of scripts) { mark(`script:${script}`); await guest('script', { stage, script, user: identity.user, timeout: 600000 }, 620000); evidence.push({ script, passed: true }); }
      const evidenceDigest = digest({ sha: candidate.sha, treeSha: candidate.treeSha, profileDigest: profile.digest, evidence });
      const sealed = await guest('seal', { stage, release, sha: candidate.sha, treeSha: candidate.treeSha, marker: { sha: candidate.sha, treeSha: candidate.treeSha, profileDigest: profile.digest, evidenceDigest } });
      job.fence({ safe: true }); await service.recordValidation(params.applicationId, candidate.sha, { profileDigest: profile.digest, treeSha: candidate.treeSha, passed: true, evidenceDigest, artifactDigest: sealed.artifactDigest, jobId: job.id, releasePath: release });
      mark('validated'); return { ok: true, outcome: 'validated', verification: { state: 'tested', sha: candidate.sha, evidenceDigest, releasePath: release } };
    } finally { if (transfer) await hostFs.rm(transfer, { recursive: true, force: true }); }
  }
  mark('inspect'); const previous = await guest('inspect', { strict: true });
  if (!validation?.passed || !/^[a-f0-9]{64}$/.test(validation.artifactDigest || '') || validation.profileDigest !== profile.digest || validation.treeSha !== candidate.treeSha || typeof release !== 'string' || !release.startsWith(`${root}/${candidate.sha}-p${profile.revision}-`) || release.includes('/../')) throw safeError('VALIDATION_REQUIRED', 'This exact candidate, profile and release artifact need successful validation.');
  await guest('artifact', { release, sha: candidate.sha, treeSha: candidate.treeSha, profileDigest: profile.digest, evidenceDigest: validation.evidenceDigest, artifactDigest: validation.artifactDigest });
  if (kind === 'application_verify') { const proof = await verify(release, candidate.sha, validation.artifactDigest); await service.recordLive(params.applicationId, { sha: candidate.sha, profileDigest: profile.digest, jobId: job.id, releasePath: release, evidenceDigest: digest(proof) }); return { ok: true, outcome: 'live_verified', verification: proof }; }
  if (previous.target === release) { const proof = await verify(release, candidate.sha, validation.artifactDigest); return { ok: true, outcome: 'already_live', verification: proof }; }
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
    job.fence(); await service.recordLive(params.applicationId, { sha: candidate.sha, profileDigest: profile.digest, jobId: job.id, releasePath: release, previousSha: previous.identity.sha, evidenceDigest: digest(proof) });
    disruptive = false; mark('live_verified', recovery);
    return { ok: true, outcome: 'live_verified', verification: proof };
  } catch (e) {
    if (['FENCED','CANCELLED'].includes(e.code)) throw e;
    mark('rolling_back', recovery);
    const current = await guest('inspect', { strict: true });
    if (current.target === release) await guest('switch', { expected: release, target: previous.target, jobId: attempt });
    else if (current.target !== previous.target) throw safeError('LIVE_TARGET_CHANGED', 'The live target changed during rollback; manual inspection is required.');
    const proof = await verify(previous.target, previous.identity.sha, previous.identity.artifactDigest);
    await service.recordLive(params.applicationId, { sha: previous.identity.sha, profileDigest: profile.digest, jobId: job.id, releasePath: previous.target, previousSha: previous.identity.sha, evidenceDigest: digest(proof), restored: true });
    disruptive = false; mark('rolled_back', recovery);
    return { ok: false, recovered: true, outcome: 'release_failed_rolled_back', verification: proof };
  }
}
