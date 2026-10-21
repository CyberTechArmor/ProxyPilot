import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { APPLICATION_JOB_KINDS, applicationGuestScript, runApplicationReleaseOperation, validateApplicationJob } from '../lib/setup-engine/application-deploy-op.js';
import { ensureSetupEngineSchema, getJob, claimNextJob, readLock, createJob, checkpoint, acquireLock, recordJobOutcome, markLockStale } from '../lib/setup-engine/store.js';
import { submitApplicationReleaseJob, listApplicationReleaseJobs } from '../lib/setup-engine/backend.js';
import { reapAttemptScriptsScript } from '../lib/setup-engine/guest-probes.js';
import { executeJob, reconcile } from '../lib/setup-engine/executor.js';
import { ownerIdentity, redact, validateRunnerJob } from '../lib/setup-engine/logic.js';

const sha = 'a'.repeat(40), treeSha = 'b'.repeat(40), profileDigest = 'c'.repeat(64);
const params = { applicationId: 3, profileRevision: 1, profileDigest, sha, treeSha };
const runner = ownerIdentity({ kind: 'runner', host: 'test', pid: 1, instance: 'one' });

function fixture() {
  const calls = [], records = [];
  const profile = { targetId: 'nodus', sourceDir: '/opt/nodus', releaseRoot: '/opt/nodus-releases', serviceName: 'nodus.service', healthUrl: 'http://127.0.0.1:3000/ready', installScript: 'deps', buildScript: 'build', validationScripts: ['test'], preservePaths: ['/opt/nodus/data'], envFiles: ['/etc/nodus.env'], revision: 1, digest: profileDigest };
  const candidate = { sha, treeSha, validation: { passed: true, profileDigest, treeSha, releasePath: `/opt/nodus-releases/${sha}-p1-good`, evidenceDigest: 'd'.repeat(64), artifactDigest: 'f'.repeat(64) } };
  const state = { target: '/opt/nodus-releases/old', failHealth: false, failed: false, previousSha: 'e'.repeat(40) };
  const service = {
    prepareCandidate: async () => ({ profile, candidate, gitDir: '/trusted/repo.git' }),
    prepareDeployment: async () => ({ profile, candidate, gitDir: '/trusted/repo.git' }),
    recordValidation: async (...args) => { records.push(['validation', ...args]); candidate.validation = args[2]; },
    recordLive: async (...args) => { records.push(['live', ...args]); },
  };
  const exec = {
    host: async argv => { calls.push({ host: argv }); if (argv.includes('bundle') && argv.includes('create')) await fs.writeFile(argv[argv.indexOf('create')+1], 'fixture'); return { code: 0, stdout: '' }; },
    guest: async (container, script) => {
      assert.equal(container, 'pp-nodus');
      if (script.includes('STALE_WRITERS:')) return { code: 0, stdout: 'STALE_WRITERS:0\n' };
      const encoded = script.match(/printf '%s' '([^']+)' \| base64/);
      const body = Buffer.from(encoded[1], 'base64').toString();
      if (body.startsWith('mkdir -p')) { calls.push({ action: 'mkdir' }); return { code: 0, stdout: '' }; }
      const data = JSON.parse(Buffer.from(body.match(/ '([A-Za-z0-9+/=]+)'\n$/)[1], 'base64').toString());
      calls.push(data);
      const response = { ok: true };
      if (data.action === 'seal') response.artifactDigest = 'f'.repeat(64);
      if (data.action === 'inspect') Object.assign(response, { user: 'root', group: '', target: state.target, identity: { sha: state.target.endsWith('/old') ? state.previousSha : sha } });
      if (data.action === 'switch') { assert.equal(state.target, data.expected); state.target = data.target; }
      if (data.action === 'verify') {
        if (state.failHealth && state.target !== '/opt/nodus-releases/old') return { code: 1, stdout: JSON.stringify({ ok: false, code: 'HEALTH_FAILED' }), stderr: 'CONTAINMENT:systemd fixture' };
        assert.equal(state.target, data.expected); Object.assign(response, { target: state.target, sha: data.sha, pid: 55 });
      }
      return { code: 0, stdout: JSON.stringify(response), stderr: 'CONTAINMENT:systemd fixture' };
    },
  };
  const job = { id: 'job-1', app: 'pp-nodus', epoch: 1, fence() {}, checkpoint(phase, data) { calls.push({ checkpoint: phase, ...data }); }, event() {} };
  return { profile, candidate, state, service, exec, job, calls, records };
}

test('immutable job references survive redaction; executable payloads and abbreviated identities are refused', () => {
  assert.deepEqual(redact(params), params);
  for (const kind of APPLICATION_JOB_KINDS) assert.equal(validateRunnerJob({ kind, app: 'pp-nodus', plan: { params } }).ok, true);
  for (const extra of [{ sha: 'abc' }, { command: 'rm -rf /' }, { profileRevision: 0 }, { treeSha: 'x'.repeat(40) }]) assert.equal(validateApplicationJob({ kind: 'application_deploy' }, { ...params, ...extra }).ok, false);
});

test('submission queues immutable references on the canonical guest lock, with reloadable job listing', async () => {
  const f = fixture(), db = new DatabaseSync(':memory:'); ensureSetupEngineSchema(db);
  const r = await submitApplicationReleaseJob(db, { applicationId: 3, sha, operation: 'validate', service: f.service });
  assert.equal(r.created, true); assert.equal(r.job.app, 'pp-nodus');
  assert.deepEqual(JSON.parse(r.job.plan_json).params, params);
  assert.equal(listApplicationReleaseJobs(db, 3)[0].id, r.job.id);
  assert.equal((await submitApplicationReleaseJob(db, { applicationId: 3, sha, operation: 'validate', service: f.service })).created, false);
  db.close();
});

test('submission refuses a profile or tree changed since confirmation before creating a job', async () => {
  const f=fixture(),db=new DatabaseSync(':memory:');ensureSetupEngineSchema(db);
  for(const pin of [{expectedProfileRevision:2},{expectedProfileDigest:'d'.repeat(64)},{expectedTreeSha:'e'.repeat(40)}]) {
    const result=await submitApplicationReleaseJob(db,{applicationId:3,sha,operation:'deploy',service:f.service,...pin});
    assert.equal(result.code,'STALE_CONFIRMATION');assert.equal(listApplicationReleaseJobs(db,3).length,0);
  }
  const result=await submitApplicationReleaseJob(db,{applicationId:3,sha,operation:'deploy',service:f.service,expectedProfileRevision:1,expectedProfileDigest:profileDigest,expectedTreeSha:treeSha});
  assert.equal(result.created,true);db.close();
});

test('validation stages exact Git bundle, executes named scripts, seals artifact, and never switches live', async t => {
  const f = fixture(), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'app-host-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const r = await runApplicationReleaseOperation({ kind: 'application_validate', params, ...f, hostRoot: temp });
  assert.equal(r.outcome, 'validated'); assert.deepEqual(f.calls.filter(c => c.action === 'script').map(c => c.script), ['deps','build','test']);
  assert.equal(f.calls.some(c => c.action === 'switch'), false);
  assert.equal(f.state.target, '/opt/nodus-releases/old');
  assert.deepEqual(f.records.filter(r => r[0] === 'validation').map(r => r[3].passed), [false,true]);
  assert.ok(f.calls.some(c => c.host?.[0] === 'git' && c.host.includes(candidateRef())));
  assert.equal(f.calls.some(c => c.host?.includes('--all')), false);
  assert.ok(f.calls.some(c => c.host?.[0] === 'incus' && c.host.at(-1).startsWith('pp-nodus/')));
  // The build's leftover processes are stopped after the last script and before the seal.
  const steps = f.calls.map(c => c.checkpoint || c.action);
  assert.ok(steps.lastIndexOf('script') < steps.indexOf('stop_build_processes') && steps.indexOf('stop_build_processes') < steps.indexOf('seal'));
});

test('a build process that cannot be stopped keeps the release from being sealed', async t => {
  const f = fixture(), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'app-host-')); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const guest = f.exec.guest;
  f.exec.guest = async (c, script) => (String(script).includes(': reap_attempt_scripts') ? { code: 0, stdout: 'STALE_WRITERS:1\n' } : guest(c, script));
  await assert.rejects(runApplicationReleaseOperation({ kind: 'application_validate', params, ...f, hostRoot: temp }), { code: 'BUILD_PROCESS_ALIVE' });
  assert.equal(f.calls.some(c => c.action === 'seal'), false);
  const script = reapAttemptScriptsScript('job-1-1');
  assert.match(script, /\$RUN\/\$CUR\.units/); assert.match(script, /cgroup\.kill/); assert.match(script, /STALE_WRITERS:\$n/);
  assert.throws(() => reapAttemptScriptsScript('job; rm -rf /'), /plain identifier/);
});

function candidateRef() { return 'refs/heads/release'; }

test('install/build without a real validation script cannot certify the candidate', async () => {
  const f = fixture(); f.profile.validationScripts = [];
  await assert.rejects(runApplicationReleaseOperation({ kind: 'application_validate', params, ...f }), { code: 'NO_VALIDATION_SCRIPTS' });
  assert.equal(f.records.length, 0); assert.equal(f.calls.some(c => c.action === 'switch'), false);
});

test('deployment validates artifact then checkpoints before switching, and verifies running SHA plus health', async () => {
  const f = fixture(); const r = await runApplicationReleaseOperation({ kind: 'application_deploy', params, ...f, sleep: async () => {} });
  assert.equal(r.ok, true); assert.equal(f.state.target, f.candidate.validation.releasePath);
  const order = f.calls.map(c => c.action || c.checkpoint);
  assert.ok(order.indexOf('artifact') < order.indexOf('promoting')); assert.ok(order.indexOf('promoting') < order.indexOf('switch'));
  assert.equal(f.records.at(-1)[0], 'live'); assert.equal(f.records.at(-1)[2].sha, sha);
});

test('verifying the live release keeps its recorded previous release (rollback and retention still see it)', async () => {
  const f = fixture(); f.state.target = f.candidate.validation.releasePath;
  const recordedBefore = 'e'.repeat(40);
  f.service.getApplication = async () => ({ live: { sha, releasePath: f.state.target, previousSha: recordedBefore, verifiedAt: '2026-10-20T10:00:00Z' }, candidates: [] });
  const r = await runApplicationReleaseOperation({ kind: 'application_verify', params, ...f, sleep: async () => {} });
  assert.equal(r.outcome, 'live_verified');
  assert.equal(f.records.at(-1)[0], 'live'); assert.equal(f.records.at(-1)[2].previousSha, recordedBefore, 'carried forward, not dropped');
  const r2 = fixture(); r2.state.target = r2.candidate.validation.releasePath;
  r2.service.getApplication = async () => ({ live: { sha, releasePath: r2.state.target, previousSha: recordedBefore, rollbackOf: recordedBefore, verifiedAt: '2026-10-20T10:00:00Z' }, candidates: [] });
  await runApplicationReleaseOperation({ kind: 'application_verify', params, ...r2, sleep: async () => {} });
  assert.equal(r2.records.at(-1)[2].rollbackOf, recordedBefore, 'a rollback stays a rollback after verifying it');
  // A different release recorded live before (the switch happened outside a deployment): that one is the previous release.
  const g = fixture(); g.state.target = g.candidate.validation.releasePath;
  g.service.getApplication = async () => ({ live: { sha: '9'.repeat(40), releasePath: '/opt/nodus-releases/other', previousSha: null }, candidates: [] });
  await runApplicationReleaseOperation({ kind: 'application_verify', params, ...g, sleep: async () => {} });
  assert.equal(g.records.at(-1)[2].previousSha, '9'.repeat(40));
  // No live record before: nothing to carry.
  const h = fixture(); h.state.target = h.candidate.validation.releasePath; h.service.getApplication = async () => ({ live: null, candidates: [] });
  await runApplicationReleaseOperation({ kind: 'application_verify', params, ...h, sleep: async () => {} });
  assert.equal(Object.hasOwn(h.records.at(-1)[2], 'previousSha'), false);
});

test('a rollback job records the release it rolled back from; a failed deployment restore names the failed one', async () => {
  const f = fixture();
  await runApplicationReleaseOperation({ kind: 'application_rollback', params, ...f, sleep: async () => {} });
  const live = f.records.at(-1);
  assert.equal(live[0], 'live'); assert.equal(live[2].sha, sha);
  assert.equal(live[2].rollbackOf, f.state.previousSha, 'the release replaced by the rollback');
  const g = fixture(); g.state.failHealth = true;
  await runApplicationReleaseOperation({ kind: 'application_deploy', params, ...g, sleep: async () => {} });
  assert.equal(g.records.at(-1)[2].restored, true); assert.equal(g.records.at(-1)[2].rollbackOf, sha, 'the failed release is never the previous one');
  const h = fixture();
  await runApplicationReleaseOperation({ kind: 'application_deploy', params, ...h, sleep: async () => {} });
  assert.equal(Object.hasOwn(h.records.at(-1)[2], 'rollbackOf'), false, 'an ordinary deployment is not a rollback');
});

test('failed new health restores and verifies the recorded old release without touching service definitions', async () => {
  const f = fixture(); f.state.failHealth = true;
  const r = await runApplicationReleaseOperation({ kind: 'application_deploy', params, ...f, sleep: async () => {} });
  assert.equal(r.recovered, true); assert.equal(r.ok, false); assert.equal(f.state.target, '/opt/nodus-releases/old');
  assert.equal(f.records.at(-1)[2].restored, true);
  assert.equal(f.calls.filter(c => c.action === 'switch').length, 2);
});

test('interrupted promotion restores old target; never builds or replays the original switch', async () => {
  const f = fixture(); f.state.target = f.candidate.validation.releasePath;
  const r = await runApplicationReleaseOperation({ kind: 'application_rollback', params, ...f, prior: { applicationRelease: true, disruptive: true, previousTarget: '/opt/nodus-releases/old', previousSha: f.state.previousSha, nextTarget: f.state.target }, sleep: async () => {} });
  assert.equal(r.recovered, true); assert.equal(f.state.target, '/opt/nodus-releases/old');
  assert.equal(f.calls.filter(c => c.action === 'switch').length, 1); assert.equal(f.calls.some(c => c.action === 'script'), false);
});

test('a moved live target fails recovery without overwriting it', async () => {
  const f = fixture(); f.state.target = '/opt/nodus-releases/someone-else';
  await assert.rejects(runApplicationReleaseOperation({ kind: 'application_rollback', params, ...f, prior: { applicationRelease: true, disruptive: true, previousTarget: '/opt/nodus-releases/old', previousSha: f.state.previousSha, nextTarget: '/opt/nodus-releases/expected' } }), { code: 'LIVE_TARGET_CHANGED' });
  assert.equal(f.calls.some(c => c.action === 'switch'), false);
});

test('ownership loss at the operation fence prevents subsequent commands and live recording', async () => {
  const f = fixture(); f.job.fence = () => { if (f.calls.some(c => c.action === 'artifact')) throw Object.assign(new Error('fenced'), { code: 'FENCED' }); };
  await assert.rejects(runApplicationReleaseOperation({ kind: 'application_deploy', params, ...f }), { code: 'FENCED' });
  assert.equal(f.calls.some(c => c.action === 'switch'), false); assert.equal(f.records.length, 0);
});

test('runner persists completed deployment and releases the guest lease; backend cannot execute it', async () => {
  const f = fixture(), db = new DatabaseSync(':memory:'); ensureSetupEngineSchema(db);
  await submitApplicationReleaseJob(db, { applicationId: 3, sha, operation: 'deploy', service: f.service });
  const claimed = claimNextJob(db, { owner: runner, kinds: APPLICATION_JOB_KINDS });
  const r = await executeJob(claimed, { db, owner: runner, exec: f.exec, applicationService: f.service, sleep: async () => {} });
  assert.equal(r.status, 'succeeded'); assert.equal(getJob(db, claimed.id).outcome, 'live_verified'); assert.equal(readLock(db, 'pp-nodus'), null);
  await submitApplicationReleaseJob(db, { applicationId: 3, sha, operation: 'verify', service: f.service });
  const backend = ownerIdentity({ kind: 'backend', host: 'test', pid: 2, instance: 'two' }); const second = claimNextJob(db, { owner: backend, kinds: APPLICATION_JOB_KINDS });
  const before = f.calls.length; assert.equal((await executeJob(second, { db, owner: backend, exec: f.exec, applicationService: f.service })).status, 'requeued'); assert.equal(f.calls.length, before);
  db.close();
});

test('dead promotion is requeued for checkpoint recovery, safe interrupted work is not blindly replayed', () => {
  const db = new DatabaseSync(':memory:'); ensureSetupEngineSchema(db);
  const old = ownerIdentity({ kind: 'runner', host: 'test', pid: 3, instance: 'old' });
  const queued = createJob(db, { app: 'pp-nodus', kind: 'application_deploy', plan: { params }, nowMs: 1000 });
  const job = claimNextJob(db, { owner: old, kinds: APPLICATION_JOB_KINDS, nowMs: 1000, leaseMs: 1000 });
  acquireLock(db, { app: 'pp-nodus', owner: old, operation: job.kind, jobId: job.id, nowMs: 1000, leaseMs: 1000 });
  checkpoint(db, { id: job.id, owner: old, epoch: job.epoch, phase: 'promoting', checkpoint: { applicationRelease: true, disruptive: true, previousTarget: '/opt/releases/old', nextTarget: '/opt/releases/new' }, nowMs: 1000 });
  const r = reconcile({ db, owner: runner, nowMs: 100000 }); assert.ok(r.requeued.includes(queued.id)); assert.equal(getJob(db, queued.id).status, 'queued');
  assert.equal(JSON.parse(getJob(db, queued.id).checkpoint_json).previousTarget, '/opt/releases/old'); db.close();
});

test('explicit recovery takes only the recorded hold, verifies old release and closes the failed origin', async () => {
  const f = fixture(), db = new DatabaseSync(':memory:'); ensureSetupEngineSchema(db);
  const old = ownerIdentity({ kind: 'runner', host: 'test', pid: 3, instance: 'old' });
  const origin = createJob(db, { app: 'pp-nodus', kind: 'application_deploy', plan: { params }, nowMs: 1000 });
  const claimed = claimNextJob(db, { owner: old, kinds: APPLICATION_JOB_KINDS, nowMs: 1000, leaseMs: 1000 });
  acquireLock(db, { app: 'pp-nodus', owner: old, operation: claimed.kind, jobId: claimed.id, nowMs: 1000, leaseMs: 1000 });
  checkpoint(db, { id: claimed.id, owner: old, epoch: claimed.epoch, phase: 'promoting', checkpoint: { applicationRelease: true, disruptive: true, previousTarget: '/opt/nodus-releases/old', previousSha: f.state.previousSha, nextTarget: f.candidate.validation.releasePath }, nowMs: 1000 });
  recordJobOutcome(db, { id: origin.id, status: 'recovery_required', outcome: 'application_recovery_required', by: old, nowMs: 2000 });
  markLockStale(db, { app: 'pp-nodus', recoveryJobId: origin.id, nowMs: 2000 });
  f.state.target = f.candidate.validation.releasePath;
  const requested = await submitApplicationReleaseJob(db, { applicationId: 3, sha, operation: 'rollback', service: f.service, nowMs: 100000 });
  assert.equal(requested.created,true); assert.equal(JSON.parse(requested.job.plan_json).params.recoveryOf, origin.id);
  const recovery = claimNextJob(db, { owner: runner, kinds: APPLICATION_JOB_KINDS, nowMs: 100000 });
  const r = await executeJob(recovery, { db, owner: runner, exec: f.exec, applicationService: f.service, nowMs: () => 100000, sleep: async () => {} });
  assert.equal(r.outcome,'interrupted_release_rolled_back'); assert.equal(getJob(db,origin.id).outcome,'application_recovered'); assert.equal(readLock(db,'pp-nodus'),null); db.close();
});

test('wrong guest identity and foreign recovery reference cannot borrow another guest lock', async () => {
  const f = fixture(); f.job.app = 'pp-other';
  await assert.rejects(runApplicationReleaseOperation({ kind: 'application_deploy', params, ...f }), { code: 'GUEST_IDENTITY_MISMATCH' });
  assert.equal(f.calls.length,0);
  const db = new DatabaseSync(':memory:'); ensureSetupEngineSchema(db);
  createJob(db,{kind:'application_deploy',app:'pp-other',plan:{params},id:'foreign',status:'recovery_required'});
  createJob(db,{kind:'application_rollback',app:'pp-nodus',plan:{params:{...params,recoveryOf:'foreign'}}});
  const job = claimNextJob(db,{owner:runner,kinds:['application_rollback']});
  assert.equal((await executeJob(job,{db,owner:runner,exec:f.exec,applicationService:f.service})).outcome,'invalid_recovery_reference');
  assert.equal(f.calls.length,0); db.close();
});

test('real guest sealing detects changed generated artifact bytes, not merely a matching Git SHA', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'app-seal-')); t.after(() => fs.rm(root,{recursive:true,force:true})); await fs.chmod(root,0o755); // read-only git runs unprivileged
  const stage = path.join(root,'stage'), release = path.join(root,'release'); await fs.mkdir(stage);
  execFileSync('git',['init','-q',stage]); await fs.writeFile(path.join(stage,'app.js'),'source'); execFileSync('git',['-C',stage,'add','app.js']); execFileSync('git',['-C',stage,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const exactSha=execFileSync('git',['-C',stage,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),exactTree=execFileSync('git',['-C',stage,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  await fs.mkdir(path.join(stage,'dist')); await fs.writeFile(path.join(stage,'dist','index.js'),'generated v1');
  const marker={sha:exactSha,treeSha:exactTree,profileDigest,evidenceDigest:'d'.repeat(64)};
  const profile={sourceDir:'/opt/fixture',preservePaths:[],envFiles:[]};
  const run=data=>spawnSync('sh',['-c',applicationGuestScript(data)],{encoding:'utf8'});
  const seal=run({action:'seal',profile,stage,release,sha:exactSha,treeSha:exactTree,marker}); assert.equal(seal.status,0,seal.stdout); marker.artifactDigest=JSON.parse(seal.stdout).artifactDigest;
  const okay=run({action:'artifact',profile,release,...marker}); assert.equal(okay.status,0,okay.stdout);
  await fs.chmod(path.join(release,'dist','index.js'),0o644); await fs.writeFile(path.join(release,'dist','index.js'),'tampered');
  const changed=run({action:'artifact',profile,release,...marker}); assert.equal(JSON.parse(changed.stdout).code,'RELEASE_ARTIFACTS_CHANGED');
});

test('non-root service can build, then transfer the validated tree to root for sealing', async t => {
  assert.equal(process.getuid(),0,'this containment fixture requires the root test environment');
  execFileSync('id',['nobody']);
  const privilegeProbe=spawnSync('runuser',['-u','nobody','--','true'],{encoding:'utf8'});
  if(privilegeProbe.status!==0){t.skip(`test container cannot switch OS user: ${privilegeProbe.stderr.trim()}`);return;}
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'app-nonroot-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.chmod(root,0o755);
  const repo=path.join(root,'repo'),stageRoot=path.join(root,'.staging'),stage=path.join(stageRoot,'job'),release=path.join(root,'release'),bundle=path.join(stageRoot,'source.bundle');
  await fs.mkdir(repo);await fs.mkdir(stageRoot,{mode:0o711});
  // A normal build: it reads git (git describe) although .git stays root-owned.
  await fs.writeFile(path.join(repo,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',scripts:{check:'git describe --always > described.txt && node -e "require(\'fs\').writeFileSync(\'built.txt\',\'nonroot passed\')"'}}));
  execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'add','package.json']);execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const exactSha=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),exactTree=execFileSync('git',['-C',repo,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  execFileSync('git',['-C',repo,'bundle','create',bundle,'HEAD']);await fs.chmod(bundle,0o600);
  const profile={sourceDir:'/opt/fixture',preservePaths:[],envFiles:[]};
  const run=data=>spawnSync('sh',['-c',applicationGuestScript(data)],{encoding:'utf8'});
  const staged=run({action:'stage',profile,stage,release,bundle,sha:exactSha,treeSha:exactTree,scripts:['check'],user:'nobody',group:''});assert.equal(staged.status,0,staged.stdout);
  const checked=run({action:'script',profile,stage,script:'check',user:'nobody',timeout:10000});assert.equal(checked.status,0,checked.stdout);
  assert.equal(await fs.readFile(path.join(stage,'built.txt'),'utf8'),'nonroot passed');assert.equal((await fs.stat(bundle)).mode&0o777,0o600);
  assert.equal((await fs.readFile(path.join(stage,'described.txt'),'utf8')).trim(),exactSha.slice(0,7),'git works for the build with .git read-only to it');
  assert.notEqual((await fs.stat(stage)).uid,0);
  const gitStat=await fs.stat(path.join(stage,'.git'));assert.equal(gitStat.uid,0,'.git is not handed to the service user');assert.equal(gitStat.mode&0o022,0);
  const gitIdentity=JSON.parse(staged.stdout).gitIdentity;assert.deepEqual(gitIdentity,{dev:gitStat.dev,ino:gitStat.ino});
  const marker={sha:exactSha,treeSha:exactTree,profileDigest,evidenceDigest:'d'.repeat(64)};
  const sealed=run({action:'seal',profile,stage,release,sha:exactSha,treeSha:exactTree,gitIdentity,marker});assert.equal(sealed.status,0,sealed.stdout);
  assert.equal((await fs.stat(release)).uid,0);assert.equal((await fs.stat(path.join(release,'built.txt'))).mode&0o222,0);
  const verified=run({action:'artifact',profile,release,...marker,artifactDigest:JSON.parse(sealed.stdout).artifactDigest});assert.equal(verified.status,0,verified.stdout);
});

test('a .git swapped during the build is refused at the seal with a plain reason', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'app-gitswap-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.chmod(root,0o755);
  const repo=path.join(root,'repo'),stageRoot=path.join(root,'.staging'),stage=path.join(stageRoot,'job'),release=path.join(root,'release'),bundle=path.join(stageRoot,'source.bundle');
  await fs.mkdir(repo);await fs.mkdir(stageRoot,{mode:0o711});
  await fs.writeFile(path.join(repo,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',scripts:{check:'true'}}));
  execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'add','package.json']);execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const exactSha=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),exactTree=execFileSync('git',['-C',repo,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  execFileSync('git',['-C',repo,'bundle','create',bundle,'HEAD']);await fs.chmod(bundle,0o600);
  const profile={sourceDir:'/opt/fixture',preservePaths:[],envFiles:[]};
  const run=data=>spawnSync('sh',['-c',applicationGuestScript(data)],{encoding:'utf8'});
  const staged=run({action:'stage',profile,stage,release,bundle,sha:exactSha,treeSha:exactTree,scripts:['check'],user:'root',group:''});assert.equal(staged.status,0,staged.stdout);
  const {gitIdentity}=JSON.parse(staged.stdout);
  // The build replaces .git with its own copy (a new inode, with a planted filter).
  await fs.rename(path.join(stage,'.git'),path.join(stage,'.git.orig'));execFileSync('cp',['-a',path.join(stage,'.git.orig'),path.join(stage,'.git')]);
  execFileSync('git',['-C',stage,'config','filter.x.clean',`sh -c 'id -u > ${root}/RAN; cat'`]);
  const marker={sha:exactSha,treeSha:exactTree,profileDigest,evidenceDigest:'d'.repeat(64)};
  const sealed=run({action:'seal',profile,stage,release,sha:exactSha,treeSha:exactTree,gitIdentity,marker});
  assert.equal(JSON.parse(sealed.stdout).code,'GIT_METADATA_CHANGED');
  await assert.rejects(fs.stat(release),'nothing was sealed');
  await assert.rejects(fs.stat(path.join(root,'RAN')),'the planted filter never ran');
  // The job turns the code into the plain reason.
  const f=fixture();const exec={...f.exec,guest:async(c,script)=>{const r=await f.exec.guest(c,script);if(script.includes('printf')){const body=Buffer.from(script.match(/printf '%s' '([^']+)' \| base64/)[1],'base64').toString();const data=JSON.parse(Buffer.from(body.match(/ '([A-Za-z0-9+/=]+)'\n$/)[1],'base64').toString());if(data.action==='seal')return{code:1,stdout:JSON.stringify({ok:false,code:'GIT_METADATA_CHANGED'}),stderr:'CONTAINMENT:systemd fixture'};}return r;}};
  const hostRoot=path.join(root,'transfers');
  await assert.rejects(runApplicationReleaseOperation({kind:'application_validate',params,...f,exec,hostRoot,sleep:async()=>{}}),e=>e.message==="The repository's git metadata changed during the build, so this release was not sealed.");
});

test('a file hard-linked from outside the stage is copied at the seal, never re-owned: the outside file keeps its owner, mode and bytes', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'app-hardlink-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.chmod(root,0o755);
  const repo=path.join(root,'repo'),stageRoot=path.join(root,'.staging'),stage=path.join(stageRoot,'job'),release=path.join(root,'release'),bundle=path.join(stageRoot,'source.bundle');
  await fs.mkdir(repo);await fs.mkdir(stageRoot,{mode:0o711});
  await fs.writeFile(path.join(repo,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',scripts:{check:'true'}}));
  execFileSync('git',['init','-q',repo]);execFileSync('git',['-C',repo,'add','package.json']);execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const exactSha=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),exactTree=execFileSync('git',['-C',repo,'rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  execFileSync('git',['-C',repo,'bundle','create',bundle,'HEAD']);await fs.chmod(bundle,0o600);
  const profile={sourceDir:'/opt/fixture',preservePaths:[],envFiles:[]};
  const run=data=>spawnSync('sh',['-c',applicationGuestScript(data)],{encoding:'utf8'});
  const staged=run({action:'stage',profile,stage,release,bundle,sha:exactSha,treeSha:exactTree,scripts:['check'],user:'root',group:''});assert.equal(staged.status,0,staged.stdout);
  // What a package manager leaves: files hard-linked from a store in the
  // service user's home (here uid 65534), a pair linked to each other inside
  // the stage, and a link (symlink) that is itself hard-linked from outside.
  const store=path.join(root,'home','store');await fs.mkdir(store,{recursive:true});await fs.chown(path.join(root,'home'),65534,65534);await fs.chown(store,65534,65534);
  const outside=path.join(store,'index.js'),outsideBin=path.join(store,'cli'),outsideLink=path.join(store,'entry');
  await fs.writeFile(outside,'module.exports = 1;\n');await fs.chown(outside,65534,65534);await fs.chmod(outside,0o600);
  await fs.writeFile(outsideBin,'#!/bin/sh\necho cli\n');await fs.chown(outsideBin,65534,65534);await fs.chmod(outsideBin,0o700);
  await fs.symlink('index.js',outsideLink);await fs.lchown(outsideLink,65534,65534);
  await fs.mkdir(path.join(stage,'node_modules','pkg'),{recursive:true});
  await fs.link(outside,path.join(stage,'node_modules','pkg','index.js'));await fs.link(outsideBin,path.join(stage,'node_modules','pkg','cli'));await fs.link(outsideLink,path.join(stage,'node_modules','pkg','entry'));
  await fs.writeFile(path.join(stage,'a.txt'),'pair');await fs.link(path.join(stage,'a.txt'),path.join(stage,'b.txt'));
  const marker={sha:exactSha,treeSha:exactTree,profileDigest,evidenceDigest:'d'.repeat(64)};
  const sealed=run({action:'seal',profile,stage,release,sha:exactSha,treeSha:exactTree,gitIdentity:JSON.parse(staged.stdout).gitIdentity,marker});assert.equal(sealed.status,0,sealed.stdout);
  // Outside the stage nothing changed.
  for(const [f,mode,bytes] of [[outside,0o600,'module.exports = 1;\n'],[outsideBin,0o700,'#!/bin/sh\necho cli\n']]){
    const st=await fs.stat(f);assert.deepEqual([st.uid,st.gid,st.mode&0o7777,st.nlink],[65534,65534,mode,1],f);assert.equal(await fs.readFile(f,'utf8'),bytes);
  }
  assert.equal((await fs.lstat(outsideLink)).uid,65534,'the outside link keeps its owner');assert.equal((await fs.lstat(outsideLink)).nlink,1);
  // The release holds root-owned, read-only copies with the same bytes.
  const pkg=path.join(release,'node_modules','pkg');
  for(const [f,mode,bytes] of [[path.join(pkg,'index.js'),0o444,'module.exports = 1;\n'],[path.join(pkg,'cli'),0o555,'#!/bin/sh\necho cli\n'],[path.join(release,'a.txt'),0o444,'pair'],[path.join(release,'b.txt'),0o444,'pair']]){
    const st=await fs.lstat(f);assert.deepEqual([st.isFile(),st.uid,st.gid,st.mode&0o7777,st.nlink],[true,0,0,mode,1],f);assert.equal(await fs.readFile(f,'utf8'),bytes);
  }
  const entry=await fs.lstat(path.join(pkg,'entry'));assert.deepEqual([entry.isSymbolicLink(),entry.uid,entry.nlink],[true,0,1]);assert.equal(await fs.readlink(path.join(pkg,'entry')),'index.js');
  const left=execFileSync('find',[release,'-name','.pp-freeze-*'],{encoding:'utf8'});assert.equal(left,'','no temporary copy is left behind');
  // The artifact digest is the content's: the sealed release verifies.
  const verified=run({action:'artifact',profile,release,...marker,artifactDigest:JSON.parse(sealed.stdout).artifactDigest});assert.equal(verified.status,0,verified.stdout);
});

test('a freeze refusal reaches the job as a plain reason (too deep, changed, a mount)', async () => {
  const reasons={TOO_DEEP:'The build left folders nested too deeply to seal safely, so this release was not sealed.',CHANGED_DURING_FREEZE:'The build output changed while it was being sealed, so this release was not sealed.',MOUNT_INSIDE:'The build output contains a mounted filesystem, so this release was not sealed.'};
  for(const [code,message] of Object.entries(reasons)){
    const f=fixture();const exec={...f.exec,guest:async(c,script)=>{const r=await f.exec.guest(c,script);if(script.includes('printf')){const body=Buffer.from(script.match(/printf '%s' '([^']+)' \| base64/)[1],'base64').toString();const data=JSON.parse(Buffer.from(body.match(/ '([A-Za-z0-9+/=]+)'\n$/)[1],'base64').toString());if(data.action==='seal')return{code:1,stdout:JSON.stringify({ok:false,code}),stderr:'CONTAINMENT:systemd fixture'};}return r;}};
    const hostRoot=await fs.mkdtemp(path.join(os.tmpdir(),'app-plain-'));
    try{await assert.rejects(runApplicationReleaseOperation({kind:'application_validate',params,...f,exec,hostRoot,sleep:async()=>{}}),e=>e.code===code&&e.message===message);}
    finally{await fs.rm(hostRoot,{recursive:true,force:true});}
  }
});

test('real guest link program preserves absolute data paths, rejects tracked collision and nested symlink escape', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'app-guest-')); t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.chmod(root, 0o755); // read-only git runs unprivileged
  const old = path.join(root, 'old'), release = path.join(root, 'new'), source = path.join(root, 'current');
  await fs.mkdir(old); await fs.mkdir(release); await fs.symlink(old, source); await fs.mkdir(path.join(old,'data')); await fs.writeFile(path.join(old,'data','record'), 'preserve');
  execFileSync('git',['init','-q',release]); await fs.writeFile(path.join(release,'app.js'),'source'); execFileSync('git',['-C',release,'add','app.js']);
  const profile = { sourceDir: source, preservePaths: [path.join(source,'data')], envFiles: [] };
  const run = data => spawnSync('sh',['-c',applicationGuestScript(data)],{ encoding:'utf8' });
  const r = run({ action:'links', profile, previous:old, release }); assert.equal(r.status,0,r.stdout); assert.equal(await fs.readFile(path.join(release,'data','record'),'utf8'),'preserve');
  const collision = run({ action:'links', profile:{...profile,preservePaths:[path.join(source,'app.js')]},previous:old,release}); assert.equal(JSON.parse(collision.stdout).code,'PRESERVED_SOURCE_COLLISION');
  await fs.mkdir(path.join(old,'nested')); await fs.mkdir(path.join(old,'nested','item')); await fs.symlink(old,path.join(release,'nested'));
  const escape = run({ action:'links', profile:{...profile,preservePaths:[path.join(source,'nested','item')]},previous:old,release}); assert.equal(JSON.parse(escape.stdout).code,'PRESERVED_PATH_COLLISION');
});
