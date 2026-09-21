// Closeout of the runner-owned deployment slice. What this file proves:
//   A. containment is by CGROUP, with real processes: a deployment child
//      that calls setsid() (a new session, so session-based cleanup cannot
//      see it), outlives its parent and keeps writing is stopped by the
//      takeover's reap; the application's own service (a process outside
//      any job cgroup) and the current job's legitimate holder are left
//      untouched. Exercised on every raw mechanism this host offers
//      (cgroup v2 cgroup.kill; cgroup v1 pids). The systemd scope form
//      cannot run here (no running systemd): it is host acceptance.
//   B. no silent fallback: a guest with no mechanism makes the wrapper
//      refuse (exit 97, CONTAINMENT:none) before the body runs, and the
//      deploy job records containment_unavailable with nothing executed.
//   C. verification cannot certify a different revision: a follow-up that
//      finds another commit/build running records `superseded`; an older
//      follow-up behind a newer deploy is kept as an obligation and decides
//      at run time; a recovery queues the check the deploy never reached.
//   D. a follow-up that meets a held lease is REQUEUED with a not-before
//      (an obligation is never finished as deferred), and the claim skips
//      it until due.
//   E. a deploy that fails after the disruptive step queues a post-failure
//      verification, so the record ends with a checked state.
//   F. ratchets on the wiring: runner-required never executes in the
//      backend; install.sh / update.sh promote the policy only on runner
//      evidence and say so loudly otherwise; the backend warns when the
//      policy names a runner nobody hears from.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync, rmdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureSetupEngineSchema, getJob, listEvents, readLock, acquireLock, releaseLock, claimNextJob, createJob } from '../lib/setup-engine/store.js';
import { ownerIdentity, parseJson, CREDENTIAL_USE_OUTCOMES } from '../lib/setup-engine/logic.js';
import { submitDeployJob } from '../lib/setup-engine/backend.js';
import { runOnce } from '../lib/setup-engine/executor.js';
import { containedScript, reapStaleWritersScript, parseStaleWriters, parseContainment, CONTAINMENT_UNAVAILABLE_RC } from '../lib/setup-engine/guest-probes.js';
import { scriptedGuest, noSecretIn, PARAMS, LOGIN } from './helpers/scripted-guest.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const T0 = Date.parse('2026-09-21T18:00:00.000Z');
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });

function db() { const d = new DatabaseSync(':memory:'); ensureSetupEngineSchema(d); return d; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procState = (pid) => { try { return (readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^[^)]*\) /, '').split(' ')[0]); } catch { return null; } };
const alive = (pid) => { const st = procState(pid); return st != null && st !== 'Z' && st !== 'X'; };
const sessionOf = (pid) => { try { return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^[^)]*\) /, '').split(' ')[3]); } catch { return null; } };

// The raw mechanisms this host offers, probed by doing exactly what the
// wrapper does (mkdir under the root). Each is exercised in turn.
function availableMechanisms() {
  const out = [];
  const tryRoot = (kind, root, marker) => {
    if (!existsSync(join(root, marker))) return;
    const probe = join(root, 'mock2-deploy', `probe-${process.pid}`);
    try { mkdirSync(probe, { recursive: true }); rmdirSync(probe); out.push({ kind, root }); } catch { /* not writable here */ }
  };
  tryRoot('cgroup2', '/sys/fs/cgroup', 'cgroup.controllers');
  tryRoot('cgroup2', '/sys/fs/cgroup/unified', 'cgroup.controllers');
  tryRoot('cgroup1', '/sys/fs/cgroup/pids', 'cgroup.procs');
  return out;
}
const MECHANISMS = availableMechanisms();
const HAS_TOOLS = spawnSync('sh', ['-c', 'command -v setsid && command -v pgrep'], { encoding: 'utf8' }).status === 0;
const NONE = '/nonexistent/cgroup-root-for-tests';

const localSh = (script, timeoutMs = 10_000) => new Promise((resolve) => {
  const p = spawn('sh', [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (x) => { stdout += x; }); p.stderr.on('data', (x) => { stderr += x; });
  const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
  p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
  p.stdin.end(script);
});

// ── A. real processes: the setsid() escape is contained by cgroup ─────────

for (const mech of MECHANISMS) {
  test(`containment (real processes, ${mech.kind} at ${mech.root}): a deployment child that setsid()s away, outlives its parent and keeps writing is stopped by the takeover; the application service and the current job's holder are untouched`, { skip: !HAS_TOOLS && 'setsid/pgrep not installed' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-closeout-'));
    const runDir = join(root, 'run');
    const out = join(root, 'out.txt');
    const opts = { runDir, cgroupV2Root: mech.kind === 'cgroup2' ? mech.root : NONE, cgroupV1Root: mech.kind === 'cgroup1' ? mech.root : NONE, allowSystemd: false };
    const spawned = [];
    let appService = null;
    try {
      // The dead job's script: contained, spawns a child that makes its OWN
      // session (setsid), then exits. The child keeps writing.
      const body = [
        `echo "PARENT_SID:$(sed -E 's/^[^)]*\\) //' /proc/$$/stat | cut -d' ' -f4)"`,
        `setsid sh -c 'echo "CHILD_PID:$$"; while :; do echo x >> "${out}"; sleep 0.05; done' </dev/null >>"${root}/child.log" 2>&1 &`,
        'sleep 0.3; cat "' + root + '/child.log"; exit 0',
      ].join('\n');
      const r0 = await localSh(containedScript('dead-job', body, opts));
      assert.equal(r0.code, 0, r0.stderr);
      const c = parseContainment(r0.stderr);
      assert.equal(c?.kind, mech.kind, `the wrapper reports the mechanism it used: ${r0.stderr}`);
      assert.ok(c.ref.startsWith(join(mech.root, 'mock2-deploy', 'dead-job')), c.ref);
      const recorded = readFileSync(join(runDir, 'dead-job.cgroups'), 'utf8').trim().split('\n');
      assert.deepEqual(recorded, [c.ref], 'the cgroup is recorded under the job');
      const parentSid = Number((r0.stdout.match(/^PARENT_SID:(\d+)/m) || [])[1]);
      const childPid = Number((r0.stdout.match(/^CHILD_PID:(\d+)/m) || [])[1]);
      assert.ok(parentSid > 0 && childPid > 0, r0.stdout);
      spawned.push(childPid);
      assert.ok(alive(childPid), 'the child outlives its parent (the wrapper shell has exited)');
      assert.equal(sessionOf(childPid), childPid, 'the child is its own session leader: setsid() took it out of the parent session');
      assert.notEqual(sessionOf(childPid), parentSid);
      const parentSession = (spawnSync('pgrep', ['-s', String(parentSid)], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).map(Number);
      assert.equal(parentSession.includes(childPid), false, `session-based cleanup of the parent session (${parentSid}) would not find the child ${childPid}: ${parentSession}`);
      const inGroup = readFileSync(join(c.ref, 'cgroup.procs'), 'utf8').trim().split('\n').map(Number);
      assert.ok(inGroup.includes(childPid), `the cgroup still holds the escaped child: ${inGroup}`);
      const size1 = statSync(out).size; await sleep(300);
      assert.ok(statSync(out).size > size1, 'and it keeps writing');

      // The application's own service: a process OUTSIDE any job cgroup
      // (in the real guest it lives in its unit's cgroup under systemd).
      appService = spawn('sleep', ['30'], { stdio: 'ignore' });
      // A legitimate holder: the CURRENT job's own contained process.
      const holder = await localSh(containedScript('current-job', `sleep 30 </dev/null >/dev/null 2>&1 & echo HOLDER:$!; exit 0\n`, opts));
      assert.equal(holder.code, 0, holder.stderr);
      const holderPid = Number((holder.stdout.match(/HOLDER:(\d+)/) || [])[1]);
      assert.ok(holderPid > 0); spawned.push(holderPid);
      assert.ok(alive(holderPid));

      // Takeover: the current job reaps every OTHER job's group.
      const reap = await localSh(reapStaleWritersScript('current-job', { runDir }));
      assert.equal(reap.code, 0, reap.stderr);
      assert.equal(parseStaleWriters(reap.stdout), 0, `no survivors: ${reap.stdout} ${reap.stderr}`);
      assert.equal(alive(childPid), false, 'the escaped child is stopped');
      const sizeAfter = statSync(out).size; await sleep(400);
      assert.equal(statSync(out).size, sizeAfter, 'and it writes no more');
      assert.equal(existsSync(c.ref), false, 'the dead job\'s empty cgroup was removed');
      assert.equal(existsSync(join(runDir, 'dead-job.cgroups')), false, 'and its record');
      assert.ok(existsSync(join(runDir, 'current-job.cgroups')), 'the current job\'s record stays');
      assert.ok(alive(holderPid), 'the current job\'s holder is alive');
      assert.ok(alive(appService.pid), 'the application service is alive');
      assert.equal(appService.exitCode, null);
      // The reap is idempotent and truthful when there is nothing to do.
      assert.equal(parseStaleWriters((await localSh(reapStaleWritersScript('current-job', { runDir }))).stdout), 0);
    } finally {
      for (const pid of spawned) { try { process.kill(pid, 'SIGKILL'); } catch { /* */ } }
      try { appService?.kill('SIGKILL'); } catch { /* */ }
      await sleep(100);
      for (const f of (existsSync(runDir) ? readdirSync(runDir) : [])) if (f.endsWith('.cgroups')) for (const g of readFileSync(join(runDir, f), 'utf8').split('\n').filter(Boolean)) { try { for (const pid of readFileSync(join(g, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean)) process.kill(Number(pid), 'SIGKILL'); } catch { /* */ } await sleep(50); try { rmdirSync(g); } catch { /* */ } }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('containment mechanisms are present on this host (the regression above ran on at least one), or this line says why not', { skip: MECHANISMS.length > 0 && 'ran' }, () => {
  assert.fail('no writable cgroup tree: the real-process containment regression could not run here; see docs/features/setup-engine.md § Containment for the host acceptance step');
});

// ── B. no silent fallback ─────────────────────────────────────────────────

test('refusal (real process): with no mechanism the wrapper prints CONTAINMENT:none, exits 97 and never runs the body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-closeout-none-'));
  try {
    const touched = join(root, 'ran');
    const r = await localSh(containedScript('j1', `touch '${touched}'\n`, { runDir: join(root, 'run'), cgroupV2Root: NONE, cgroupV1Root: NONE, allowSystemd: false }));
    assert.equal(r.code, CONTAINMENT_UNAVAILABLE_RC);
    assert.deepEqual(parseContainment(r.stderr), { kind: 'none', ref: null });
    assert.equal(existsSync(touched), false, 'the body did not run');
    assert.deepEqual(readdirSync(join(root, 'run')), [], 'no record, no leftover script');
    // A body's own exit 97 under a recorded mechanism is not a refusal.
    assert.equal(parseContainment('CONTAINMENT:cgroup2 /sys/fs/cgroup/mock2-deploy/j1\n')?.kind, 'cgroup2');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refusal on the record: a guest without containment ends the deploy as recovery_required/containment_unavailable with nothing executed and the lease released; the app deploys once the guest has a mechanism', async () => {
  const d = db();
  const g = scriptedGuest({ containment: 'none' });
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  const out = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 1 }, { reconcileFirst: false });
  assert.equal(out.ran[0].status, 'recovery_required');
  assert.equal(out.ran[0].outcome, 'containment_unavailable');
  assert.deepEqual(g.calls.map((c) => c.phase), ['reap', 'refused'], 'the reap (uncontained, it only signals) and ONE refused wrapper; no body ran, nothing was stopped');
  const job = getJob(d, sub.job.id);
  assert.match(job.reason, /no process containment is available in pp-x/);
  assert.equal(parseJson(job.verification_json).failedAt, 'containment');
  assert.match(parseJson(job.verification_json).next, /systemd-run|writable cgroup/);
  assert.equal(readLock(d, 'pp-x'), null, 'nothing ran in the guest: the lease is released, not flagged');
  assert.equal(parseJson(job.progress_json)?.checkpoint?.app_stopped, undefined);
  // Body exit 97 under a mechanism is an ordinary failure, never a refusal.
  const g2 = scriptedGuest({});
  const sub2 = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 + 10 });
  const out2 = await runOnce({ db: d, owner: RUNNER, exec: g2, reviewLogin: async () => LOGIN, nowMs: () => T0 + 11 }, { reconcileFirst: false });
  assert.equal(out2.ran[0].status, 'succeeded');
  assert.notEqual(sub2.job.id, sub.job.id);
  noSecretIn(d, [sub.job.id, sub2.job.id]);
});

// ── C. verification cannot certify another revision ───────────────────────

test('superseded by what runs: a follow-up that finds another commit/build records `superseded` (value null) on both records and certifies nothing', async () => {
  const d = db();
  const state = { commit: 'a'.repeat(40), buildId: 'b1' };
  const g = scriptedGuest(state);
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 1 }, { reconcileFirst: false, max: 1 });
  const deploy = getJob(d, sub.job.id);
  assert.equal(deploy.status, 'succeeded');
  const followId = parseJson(deploy.progress_json).verification_job_id;
  const follow = getJob(d, followId);
  assert.equal(follow.status, 'queued');
  const want = parseJson(follow.plan_json).params.origin.revision;
  assert.equal(want.commit, 'a'.repeat(40), 'the follow-up names the revision it may certify');
  assert.equal(want.buildId, state.stampedBuildId, 'and the build id the deploy stamped');
  // Between queue and run, something else changed what runs in the guest.
  state.commit = 'e'.repeat(40);
  const out = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 5 }, { reconcileFirst: false, kinds: ['verify_app'] });
  assert.equal(out.ran.length, 1);
  assert.equal(g.calls.filter((c) => c.phase === 'credential_use').length, 0, 'the credential check did not run against the other revision');
  const after = getJob(d, followId);
  assert.equal(after.outcome, CREDENTIAL_USE_OUTCOMES.superseded);
  assert.equal(after.status, 'succeeded', 'the follow-up finished (its finding is the supersession), the app is not marked broken');
  const v = parseJson(getJob(d, sub.job.id).verification_json);
  assert.equal(v.rungs.credential_use_verified.value, null);
  assert.match(v.rungs.credential_use_verified.detail, /^superseded: the guest runs eeeeeeeeee/);
  assert.notEqual(v.state, 'credential_use_verified', 'never certified');
  noSecretIn(d, [sub.job.id, followId]);
});

test('an older follow-up queued behind a newer deploy is an obligation kept: it waits out the deploy\'s lease, records superseded when the deploy changed what runs, and still verifies its revision when the deploy failed before changing anything', async () => {
  const d = db();
  const g = scriptedGuest({});
  const a = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 1 }, { reconcileFirst: false, max: 1 });
  const followA = parseJson(getJob(d, a.job.id).progress_json).verification_job_id;
  assert.equal(getJob(d, followA).status, 'queued');
  // A newer deploy is submitted: the older follow-up is NOT cancelled.
  const b = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 + 2 });
  assert.equal(b.created, true);
  assert.equal(getJob(d, followA).status, 'queued', 'still an obligation');
  // In the natural order the older follow-up runs first and verifies A.
  // Force the deploy first: B changes the build id the guest reports.
  const outB = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 5 }, { reconcileFirst: false, kinds: ['deploy'], max: 1 });
  assert.equal(outB.ran[0].status, 'succeeded');
  const outA = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 6 }, { reconcileFirst: false, kinds: ['verify_app'], max: 1 });
  assert.equal(outA.ran.length, 1);
  assert.equal(getJob(d, followA).outcome, 'superseded');
  const va = parseJson(getJob(d, a.job.id).verification_json);
  assert.equal(va.rungs.credential_use_verified.value, null);
  assert.match(va.rungs.credential_use_verified.detail, /^superseded: the guest runs/);
  // B's own follow-up certifies B.
  const followB = parseJson(getJob(d, b.job.id).progress_json).verification_job_id;
  assert.notEqual(followB, followA);
  const outF = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 7 }, { reconcileFirst: false, kinds: ['verify_app'], max: 1 });
  assert.equal(outF.ran[0].status, 'succeeded');
  assert.equal(getJob(d, followB).outcome, 'verified');
  assert.equal(parseJson(getJob(d, b.job.id).verification_json).state, 'credential_use_verified');
  // A third deploy fails at build (before the stamp, the stop, anything) — so B's
  // revision is still what runs; had B's follow-up still been queued it
  // would verify B, not be thrown away. Shown with a fresh pair:
  const d2 = db();
  const g2 = scriptedGuest({});
  const c = submitDeployJob(d2, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  await runOnce({ db: d2, owner: RUNNER, exec: g2, reviewLogin: async () => LOGIN, nowMs: () => T0 + 1 }, { reconcileFirst: false, max: 1 });
  const followC = parseJson(getJob(d2, c.job.id).progress_json).verification_job_id;
  g2.state = null; const gFail = scriptedGuest({ fail: 'build', stampedBuildId: (() => { const m = g2.calls.find((x) => x.phase === 'stamp'); return m && (m.script.match(/'(\d{14}-[a-z0-9]+)'/) || [])[1]; })() });
  const e = submitDeployJob(d2, { app: 'pp-x', params: PARAMS(), nowMs: T0 + 2 });
  const outE = await runOnce({ db: d2, owner: RUNNER, exec: gFail, reviewLogin: async () => LOGIN, nowMs: () => T0 + 3 }, { reconcileFirst: false, kinds: ['deploy'], max: 1 });
  assert.equal(outE.ran[0].status, 'failed');
  assert.equal(parseJson(getJob(d2, e.job.id).progress_json).failed_step, 'build');
  assert.equal(parseJson(getJob(d2, e.job.id).progress_json).verification_job_id, null, 'nothing was stopped or started: no post-failure verification');
  const outC = await runOnce({ db: d2, owner: RUNNER, exec: gFail, reviewLogin: async () => LOGIN, nowMs: () => T0 + 4 }, { reconcileFirst: false, kinds: ['verify_app'], max: 1 });
  assert.equal(outC.ran[0].status, 'succeeded');
  assert.equal(getJob(d2, followC).outcome, 'verified', 'the older revision still runs and is certified');
  assert.equal(parseJson(getJob(d2, c.job.id).verification_json).state, 'credential_use_verified');
  noSecretIn(d, [a.job.id, b.job.id, followA, followB]);
  noSecretIn(d2, [c.job.id, e.job.id, followC]);
});

test('a recovery that brings an interrupted deploy\'s app up still owes the application-owned check: queued before the recovery reports done, landing on the recovery and on the deploy it recovered', async () => {
  const d = db();
  const g = scriptedGuest({ active: false });
  // An interrupted deploy: stopped the app, then its owner died.
  const dead = ownerIdentity({ kind: 'runner', host: 'pp', pid: 999, instance: 'dead' });
  const deploy = createJob(d, { kind: 'deploy', app: 'pp-x', plan: { steps: ['install'], params: PARAMS() }, configRefs: { guard: PARAMS().guard, webPort: 3000, unit: 'mock2-dev.service', environmentFile: '/etc/environment', appDir: '/srv/app' }, requestedBy: 'alice', via: 'ui', nowMs: T0 });
  const claimed = claimNextJob(d, { owner: dead, kinds: ['deploy'], nowMs: T0 + 1 });
  assert.equal(claimed.id, deploy.id);
  acquireLock(d, { app: 'pp-x', owner: dead, operation: 'deploy', jobId: deploy.id, leaseMs: 1000, nowMs: T0 + 1 });
  const { checkpoint } = await import('../lib/setup-engine/store.js');
  checkpoint(d, { id: deploy.id, owner: dead, epoch: claimed.epoch, phase: 'stopping_app', checkpoint: { app_stopped: true, disruptive: true, container: 'pp-x', webPort: 3000, unit: 'mock2-dev.service', recovery: { guard: PARAMS().guard } }, nowMs: T0 + 2 });
  // The live runner reconciles (recovery job), runs it, then the follow-up.
  const out = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 120_000 }, { reconcileFirst: true });
  const kinds = out.ran.map((r) => r.status);
  assert.ok(kinds.length >= 2, `recovery then follow-up: ${JSON.stringify(out.ran)}`);
  const recovery = d.prepare(`SELECT * FROM setup_jobs WHERE kind = 'recover_app'`).get();
  assert.equal(recovery.status, 'succeeded');
  assert.match(recovery.reason, /application-owned check pending → job /);
  const followId = parseJson(recovery.progress_json).verification_job_id;
  const follow = getJob(d, followId);
  assert.equal(follow.status, 'succeeded');
  assert.equal(follow.outcome, 'verified');
  assert.deepEqual(parseJson(follow.plan_json).params.origin.also, [deploy.id]);
  assert.equal(parseJson(recovery.verification_json).rungs.credential_use_verified.value, true, 'on the recovery');
  const dv = parseJson(getJob(d, deploy.id).verification_json);
  assert.equal(dv.rungs.credential_use_verified.value, true, 'and on the deploy it recovered');
  assert.match(dv.rungs.credential_use_verified.detail, /after recovery job /);
  assert.equal(getJob(d, deploy.id).status, 'recovery_required', 'the deploy\'s own verdict does not change');
  noSecretIn(d, [deploy.id, recovery.id, followId]);
});

// ── D. an obligation waits; it is never finished as deferred ──────────────

test('a follow-up that meets a held lease is requeued with a not-before, skipped by the claim until due, and runs afterwards; a plain probe is still deferred', async () => {
  const d = db();
  const g = scriptedGuest({});
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 1 }, { reconcileFirst: false, max: 1 });
  const followId = parseJson(getJob(d, sub.job.id).progress_json).verification_job_id;
  // A restore holds the app's lease.
  const held = acquireLock(d, { app: 'pp-x', owner: BACKEND, operation: 'restore_snapshot', jobId: 'restore-1', leaseMs: 60_000, nowMs: T0 + 2 });
  assert.ok(held.ok);
  const out = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 3 }, { reconcileFirst: false, kinds: ['verify_app'] });
  assert.equal(out.ran[0].status, 'requeued');
  assert.equal(out.ran[0].outcome, 'lock_held');
  const follow = getJob(d, followId);
  assert.equal(follow.status, 'queued', 'still an obligation');
  assert.equal(follow.owner, null);
  const prog = parseJson(follow.progress_json);
  assert.equal(prog.requeues, 1);
  assert.equal(Date.parse(prog.not_before), T0 + 3 + 30_000);
  assert.match(listEvents(d, followId).find((e) => e.kind === 'requeued').message, /lease is held by .* \(restore_snapshot\)/);
  assert.equal(claimNextJob(d, { owner: RUNNER, kinds: ['verify_app'], nowMs: T0 + 3 + 29_000 }), null, 'not due: nobody claims it');
  // A later-created job that IS due is claimed ahead of it.
  const probe = createJob(d, { kind: 'probe', app: 'pp-y', plan: { steps: ['unit_status'], params: { container: 'pp-y' } }, requestedBy: 't', via: 'test', nowMs: T0 + 4 });
  const claimed = claimNextJob(d, { owner: RUNNER, kinds: ['verify_app', 'probe'], nowMs: T0 + 3 + 29_000 });
  assert.equal(claimed.id, probe.id);
  releaseLock(d, { app: 'pp-x', owner: BACKEND, epoch: held.lock.epoch });
  const again = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 3 + 30_000 }, { reconcileFirst: false, kinds: ['verify_app'] });
  assert.equal(again.ran[0].status, 'succeeded');
  assert.equal(getJob(d, followId).outcome, 'verified');
  assert.equal(parseJson(getJob(d, followId).progress_json).not_before, undefined, 'the not-before is consumed');
  // A job that is NOT a follow-up keeps the old contract: deferred, terminal.
  const held2 = acquireLock(d, { app: 'pp-y', owner: BACKEND, operation: 'restore_snapshot', jobId: 'restore-2', leaseMs: 60_000, nowMs: T0 + 40_000 });
  assert.ok(held2.ok);
  const p2 = createJob(d, { kind: 'probe', app: 'pp-y', plan: { steps: ['unit_status'], params: { container: 'pp-y' } }, requestedBy: 't', via: 'test', nowMs: T0 + 40_001 });
  const outP = await runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 40_002 }, { reconcileFirst: false, kinds: ['probe'] });
  assert.equal(outP.ran[0].status, 'deferred');
  assert.equal(getJob(d, p2.id).status, 'deferred');
  noSecretIn(d, [sub.job.id, followId]);
});

// ── E. a failed deploy still owes a verification ──────────────────────────

test('a deploy that fails after the stop queues a post-failure verification; it runs and lands a checked state on the failed record', async () => {
  const d = db();
  const g = scriptedGuest({ fail: 'migrate' });
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  const out = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 1 }, { reconcileFirst: false, max: 1 });
  assert.equal(out.ran[0].status, 'failed');
  const deploy = getJob(d, sub.job.id);
  assert.match(deploy.reason, /post-failure verification queued: job /);
  assert.ok(g.calls.some((c) => c.phase === 'restart'), 'the old app was restarted');
  const prog = parseJson(deploy.progress_json);
  assert.equal(prog.failed_step, 'migrate');
  const followId = prog.verification_job_id;
  const follow = getJob(d, followId);
  assert.equal(follow.status, 'queued');
  const plan = parseJson(follow.plan_json);
  assert.deepEqual(plan.steps, ['unit_status', 'probe_port', 'health_check', 'verify_credential', 'verify_credential_use']);
  assert.equal(plan.params.origin.rung, 'post_failure');
  assert.equal(plan.params.origin.revision, null, 'no revision claim: whatever runs is what gets checked');
  assert.equal(readLock(d, 'pp-x'), null, 'the failed deploy released the lease so the verification can run');
  const outF = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 5 }, { reconcileFirst: false, kinds: ['verify_app'] });
  assert.equal(outF.ran[0].status, 'succeeded');
  const v = parseJson(getJob(d, sub.job.id).verification_json);
  assert.equal(v.rungs.post_failure_credential_use.value, true);
  assert.match(v.rungs.post_failure_credential_use.detail, /^verified:/);
  assert.equal(getJob(d, sub.job.id).status, 'failed', 'the execution verdict does not change: it failed');
  noSecretIn(d, [sub.job.id, followId]);
});

// ── F. ratchets on the wiring ─────────────────────────────────────────────

test('ratchet: install.sh writes backend-allowed on a fresh install, preserves an existing policy on re-run, promotes to runner-required only after the unit is active AND the runner opened the database, never downgrades, and errors loudly otherwise', () => {
  const s = readFileSync(`${REPO}install.sh`, 'utf8');
  const heredoc = s.indexOf('SETUP_EXECUTOR_POLICY=${setup_executor_policy:-backend-allowed}');
  assert.ok(s.indexOf("setup_executor_policy=$(grep -E '^SETUP_EXECUTOR_POLICY=' \"${install_dir}/.env\"") > 0 && s.indexOf("setup_executor_policy=$(grep") < heredoc, 'an existing value is read before the heredoc rewrites .env');
  assert.doesNotMatch(s, /^SETUP_EXECUTOR_POLICY=backend-allowed$/m, 'never written unconditionally');
  const kept = s.indexOf('elif [ "$current_policy" = "runner-required" ]; then');
  assert.ok(kept > 0 && s.slice(kept, kept + 600).includes('REQUIRES the runner'), 'a failed runner start on a runner-required install keeps the policy and says so');
  assert.equal(s.slice(kept, s.indexOf('fi', kept)).includes('sed -i'), false, 'and rewrites nothing');
  const active = s.indexOf('systemctl is-active --quiet proxypilot-setup-runner.service');
  const status = s.indexOf('proxypilot setup-runner status --install-dir "$INSTALL_DIR" --json');
  const promote = s.indexOf("sed -i 's/^SETUP_EXECUTOR_POLICY=.*/SETUP_EXECUTOR_POLICY=runner-required/'");
  const error = s.indexOf('log_error "Setup runner did NOT start or cannot open the database');
  assert.ok(heredoc > 0 && active > heredoc && status > active && promote > status && error > promote, `order: ${[heredoc, active, status, promote, error]}`);
  assert.doesNotMatch(s, /^SETUP_EXECUTOR_POLICY=runner-required$/m, 'never written unconditionally');
  const u = readFileSync(`${REPO}update.sh`, 'utf8').slice(readFileSync(`${REPO}update.sh`, 'utf8').indexOf('install_setup_runner()'));
  const writes = u.match(/printf '[^']*SETUP_EXECUTOR_POLICY=runner-required/g) || [];
  assert.equal(writes.length, 1, 'update.sh writes the line in exactly one place');
  assert.ok(u.lastIndexOf("! grep -q '^SETUP_EXECUTOR_POLICY='", u.indexOf(writes[0])) > 0, 'and only when no line exists');
  assert.equal(/sed[^\n]*SETUP_EXECUTOR_POLICY/.test(u), false, 'update.sh never rewrites an existing value: no downgrade is possible there');
  assert.match(s, /journalctl -u proxypilot-setup-runner/);
});

test('ratchet: update.sh records runner-required only on the same evidence, and warns in red when the runner is not there (including when the policy already names it)', () => {
  const s = readFileSync(`${REPO}update.sh`, 'utf8');
  const fn = s.slice(s.indexOf('install_setup_runner()'));
  const active = fn.indexOf('systemctl is-active --quiet "$unit"') >= 0 ? fn.indexOf('systemctl is-active --quiet "$unit"') : fn.indexOf('is-active --quiet');
  const status = fn.indexOf('proxypilot setup-runner status --install-dir');
  const record = fn.indexOf('SETUP_EXECUTOR_POLICY=runner-required\\n');
  assert.ok(active > 0 && status > active && record > status, `order: ${[active, status, record]}`);
  assert.match(fn, /if \[ "\$runner_ok" = true \]; then/);
  assert.match(fn, /SETUP_EXECUTOR_POLICY was not set to runner-required/);
  assert.match(fn, /grep -q '\^SETUP_EXECUTOR_POLICY=runner-required'/);
  assert.match(fn, /\$\{RED\}/);
});

test('ratchet: the backend warns when policy runner-required has no live runner heartbeat, and never drains jobs in-process under that policy', () => {
  const s = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const branch = s.indexOf("if (policy.mode === 'backend-allowed') {");
  assert.ok(branch > 0);
  const elseAt = s.indexOf('} else {', branch);
  const allowed = s.slice(branch, elseAt);
  const required = s.slice(elseAt, s.indexOf('setInterval(watch', elseAt));
  assert.match(allowed, /setInterval\(drain, 30_000\)/, 'backend-allowed drains in-process');
  assert.match(required, /runnerAvailable\(getDb\(\)\)/);
  assert.match(required, /no host runner heartbeat/);
  assert.match(required, /systemctl status proxypilot-setup-runner/);
  assert.equal(required.includes('drain('), false, 'runner-required never drains in-process');
  assert.equal(required.includes('drainInProcessNow'), false);
});

test('ratchet: the executor reads the guest revision before the application-owned check and the reaper counts only live processes', () => {
  const ex = readFileSync(new URL('../lib/setup-engine/executor.js', import.meta.url), 'utf8');
  assert.match(ex, /REV_COMMIT:/);
  assert.ok(ex.indexOf('read_revision') < ex.indexOf("guest('verify_credential_use'"));
  assert.match(ex, /CREDENTIAL_USE_OUTCOMES\.superseded/);
  const reap = reapStaleWritersScript('cur');
  assert.match(reap, /cgroup\.kill/);
  assert.match(reap, /systemctl kill --signal=KILL --kill-whom=all/);
  assert.match(reap, /"\$st" != "Z"/);
  assert.match(reap, /STALE_WRITERS:\$n/);
  const wrap = containedScript('j', 'true\n');
  assert.match(wrap, /exit 97/);
  assert.match(wrap, /CONTAINMENT:none/);
  assert.equal(wrap.includes('setsid'), false, 'sessions are not the mechanism');
  assert.throws(() => containedScript('../x', 'true'), /plain identifier/);
});
