// The four corrections that finish the runner-owned deployment slice:
//   1. durable application-owned verification (a follow-up job, distinct
//      outcomes, an API restart that loses nothing, never a password in a row)
//   2. migration-aware checkpoints (the boundary sits before the migration,
//      protected copies are retained versions, a migration in flight is
//      recorded with its retry class)
//   3. containment of every writer of a stale deployment (a real unmarked
//      child that outlives its marked parent is killed by session; a
//      legitimate current holder is left alone; survivors keep the lease)
//   4. the explicit executor policy (runner-required queues and reports;
//      backend-allowed runs the same executor in-process; never a request
//      parameter)

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureSetupEngineSchema, getJob, listEvents, readLock, runnerHeartbeat, acquireLock, claimNextJob, checkpoint } from '../lib/setup-engine/store.js';
import { ownerIdentity, executorPolicy, parseJson, CREDENTIAL_USE_OUTCOMES } from '../lib/setup-engine/logic.js';
import { submitDeployJob, sweepSetupEngineOnBoot, executionMode, drainRunnerJobsInProcess } from '../lib/setup-engine/backend.js';
import { runOnce, reconcile } from '../lib/setup-engine/executor.js';
import { runDeployOperation } from '../lib/setup-engine/deploy-op.js';
import { containedScript, reapStaleWritersScript, parseStaleWriters, classifyMigrateScript, interpretCredentialUse, credentialUseScript, parseProtectedCopies, protectedCopiesScript } from '../lib/setup-engine/guest-probes.js';
import { deployProject, drainInProcessNow } from '../mock2/deploy.js';
import { configureContainerLockStore, withContainerLock, ContainerLockStaleError } from '../mock2/container-lock.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const T0 = Date.parse('2026-09-21T16:00:00.000Z');
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const RUNNER2 = ownerIdentity({ kind: 'runner', host: 'pp', pid: 301, instance: 'ssss' });
const BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
const BACKEND2 = ownerIdentity({ kind: 'backend', host: 'pp', pid: 101, instance: 'bbbb' });
const GUARD = { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce', filter: "provider = 'ldaps'", legacy_default: 'dev-insecure-master-secret-change-me' };
const CONTRACT = { hasContract: true, install: 'npm ci', migrate: 'npm run migrate', build: 'npm run build', start: 'npm run start' };
const PARAMS = (extra = {}) => ({ container: 'pp-x', appDir: '/srv/app', webPort: 3000, environmentFile: '/etc/environment', contract: CONTRACT, secrets: { configs: [] }, guard: GUARD, ...extra });
const LOGIN = { email: 'review@app.test', password: 'pw-secret-value-9f8e7d' };
const HAS_TOOLS = spawnSync('sh', ['-c', 'command -v pkill && command -v pgrep && command -v setsid'], { encoding: 'utf8' }).status === 0;

function db() { const d = new DatabaseSync(':memory:'); ensureSetupEngineSchema(d); return d; }

// A scripted guest that understands the containment wrapper and every deploy
// and verification script. `state.ldaps` selects the app's LDAPS answer.
function guestFor(state) {
  const calls = [];
  const unwrap = (raw) => { const m = String(raw).match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$T"/); return m ? Buffer.from(m[1], 'base64').toString('utf8') : String(raw); };
  const jobIdOf = (raw) => (String(raw).match(/mock2_deploy_marker job=([A-Za-z0-9-]+)/) || [])[1] || 'adhoc';
  return {
    calls,
    guest: async (container, raw) => {
      const s = unwrap(raw);
      const id = jobIdOf(raw);
      const rec = (phase) => calls.push({ container, phase, id, raw, script: s });
      if (/STALE_WRITERS:/.test(s)) { rec('reap'); return { code: 0, stdout: `STALE_WRITERS:${state.survivors ?? 0}\n` }; }
      if (/PP_CRED_EOF/.test(s)) {
        rec('credential_use');
        assert.ok(s.includes(LOGIN.password), 'the login reaches the guest script (in memory, never a row)');
        const bodies = {
          current: 'SIGNIN:200\n{"configured":true,"masterKey":"current","masterKeyInventory":{"total":2,"current":2,"legacy":0,"unreadable":0,"complete":true}}\nLDAPS:200\n',
          legacy: 'SIGNIN:200\n{"configured":true,"masterKey":"legacy","masterKeyInventory":{"total":2,"current":1,"legacy":1,"unreadable":0,"complete":false}}\nLDAPS:200\n',
          unreadable: 'SIGNIN:200\n{"configured":true,"masterKey":"unreadable","masterKeyInventory":{"total":1,"current":0,"legacy":0,"unreadable":1,"complete":false}}\nLDAPS:200\n',
          none: 'SIGNIN:200\n{"configured":false,"masterKey":"none","masterKeyInventory":{"total":0,"current":0,"legacy":0,"unreadable":0,"complete":true}}\nLDAPS:200\n',
          down: 'SIGNIN:000\n',
          nosettings: 'SIGNIN:200\nLDAPS:000\n',
        };
        return { code: 0, stdout: bodies[state.ldaps || 'current'] };
      }
      if (/DBDUMP:/.test(s)) { rec('protect'); state.protects = [...(state.protects || []), id]; return { code: 0, stdout: state.protectOut ?? `DBDUMP:/var/backups/proxypilot-db/app-pre-deploy-${id}.sql:100:${'a'.repeat(64)}\nUNITCOPY:/etc/systemd/system/mock2-dev.service.pre-${id}\nENVCOPY:/etc/environment.pre-${id}\nCOMMIT:${'d'.repeat(40)}\n` }; }
      if (/MIGRATE_SCRIPT:/.test(s)) { rec('migrate_class'); return { code: 0, stdout: state.migrateClassOut ?? 'MIGRATE_SCRIPT:"migrate": "node scripts/migrate.mjs"\nMIGRATIONS_DIR:yes\n' }; }
      if (/mock2\.yaml/.test(s)) { rec('contract'); return { code: 0, stdout: 'run:\n  install: npm ci\n  migrate: npm run migrate\n  build: npm run build\n  start: npm run start\n' }; }
      if (/MOCK2_INSTALL_FRESH/.test(s)) { rec('install_fresh'); return { code: 0, stdout: 'MOCK2_INSTALL_FRESH\n' }; }
      if (/playwright\.config/.test(s)) { rec('e2e'); return { code: 1, stdout: '' }; }
      if (/MOCK2_RETROFIT_DONE/.test(s)) { rec('pwa'); return { code: 0, stdout: 'MOCK2_RETROFIT_DONE\n' }; }
      if (/\/etc\/systemd\/system\/mock2-dev\.service/.test(s)) { rec('unit_swap'); state.active = true; return { code: 0, stdout: '' }; }
      if (/journalctl/.test(s)) { rec('health'); return { code: 0, stdout: state.serves === false ? 'MOCK2_NOT_SERVING (last http_code: 000)\n' : 'MOCK2_SERVING (302)\n' }; }
      if (/MOCK2_SERVING/.test(s) && /systemctl start/.test(s)) { rec('restart'); state.active = true; return { code: 0, stdout: 'MOCK2_SERVING (200)\n' }; }
      if (/systemctl stop mock2-dev\.service/.test(s)) { rec('stop'); state.active = false; if (state.hooks?.stop) await state.hooks.stop(); return { code: 0, stdout: '' }; }
      if (/MARKER (OK|MISSING)/.test(s)) { rec('markers'); return { code: 0, stdout: 'MARKER OK AUTH_MASTER_SECRET\n' }; }
      if (/environment\.mock2-tmp/.test(s)) { rec('env_write'); return { code: 0, stdout: '' }; }
      if (/^cat \/etc\/environment/m.test(s)) { rec('env_read'); return { code: 0, stdout: 'AUTH_JWT_SECRET=x\nAUTH_MASTER_SECRET=k\n' }; }
      if (/PGPASSFILE|psql/.test(s)) { rec('data_probe'); return { code: 0, stdout: 'PROBE:ok\nTARGET:127.0.0.1:5432/app schema=public\nRLS:off\n' }; }
      if (/AUTH_MASTER_SECRET=/.test(s) && /sed -n/.test(s)) { rec('active_key'); return { code: 0, stdout: 'k\n' }; }
      if (/\/api\/health/.test(s)) { rec('health_check'); return { code: 0, stdout: 'ROOT:302\nHEALTH:200\nLOGIN:200\n' }; }
      if (/UNIT_LOADED/.test(s)) { rec('unit_status'); return { code: 0, stdout: `UNIT_LOADED:yes\nUNIT_ENABLED:enabled\nUNIT_ACTIVE:${state.active === false ? 'inactive' : 'active'}\n` }; }
      if (/START_RC/.test(s)) { rec('start_unit'); state.active = true; return { code: 0, stdout: 'START_RC:0\nUNIT_ACTIVE:active\n' }; }
      if (/PORT_SERVING/.test(s)) { rec('port'); return { code: 0, stdout: state.active === false ? 'PORT_NOT_SERVING:000\n' : 'PORT_SERVING:302\n' }; }
      if (/npm run migrate/.test(s)) { rec('migrate'); if (state.hooks?.migrate) await state.hooks.migrate(); return state.fail === 'migrate' ? { code: 1, stdout: 'apply 0002_add_col.sql\n', stderr: 'migration 0002_add_col.sql failed: relation exists' } : { code: 0, stdout: 'skip 0001 (already applied)\napply 0002\n' }; }
      if (/npm run build/.test(s)) { rec('build'); return { code: 0, stdout: '' }; }
      if (/npm ci/.test(s)) { rec('install'); return { code: 0, stdout: '' }; }
      if (/build-id|sw\.js|MOCK2_BUILD_ID/.test(s)) { rec('stamp'); return { code: 0, stdout: 'MOCK2_BUILD_ID:x\n' }; }
      rec('other'); return { code: 1, stdout: '', stderr: `unexpected: ${s.slice(0, 60)}` };
    },
  };
}

function noSecretIn(d, jobIds) {
  for (const id of jobIds) {
    const row = getJob(d, id);
    const dump = JSON.stringify(row) + JSON.stringify(listEvents(d, id));
    assert.equal(dump.includes(LOGIN.password), false, `review password leaked into job ${id}`);
    assert.equal(dump.includes(LOGIN.email), false, `review email leaked into job ${id}`);
  }
}

// ── 1. durable application-owned verification ──────────────────────────

test('the application rung is a persisted follow-up: queued before the deploy reports done, survives an API restart, runs exactly once, lands on both records', async () => {
  const d = db();
  const g = guestFor({ ldaps: 'current' });
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), requestedBy: 'alice', via: 'ui', nowMs: T0 });
  // The runner executes the deploy and ONLY the deploy (max 1).
  const first = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 1 }, { reconcileFirst: false, max: 1 });
  assert.equal(first.ran.length, 1);
  const deploy = getJob(d, sub.job.id);
  assert.equal(deploy.status, 'succeeded');
  assert.equal(deploy.outcome, 'serving', 'execution status');
  const ver = parseJson(deploy.verification_json);
  assert.equal(ver.state, 'credential_decryptable');
  assert.deepEqual(ver.pending, ['credential_use_verified'], 'verification status: not final');
  const followId = parseJson(deploy.progress_json).verification_job_id;
  const follow = getJob(d, followId);
  assert.equal(follow.kind, 'verify_app');
  assert.equal(follow.status, 'queued');
  assert.deepEqual(parseJson(follow.plan_json).steps, ['verify_credential_use']);
  assert.ok(Date.parse(follow.created_at) <= Date.parse(deploy.finished_at), 'the obligation exists before the deploy is finished');
  // The requesting API process exits and a new one boots: nothing is lost or duplicated.
  const swept = sweepSetupEngineOnBoot(d, { owner: BACKEND2, nowMs: T0 + 60_000 });
  assert.deepEqual(swept, { interrupted: [], recoveryQueued: [], skipped: [] });
  assert.equal(getJob(d, followId).status, 'queued');
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM setup_jobs WHERE kind = 'verify_app'`).get().n, 1);
  // The runner (a later tick, or a restarted runner) runs the verification once.
  const second = await runOnce({ db: d, owner: RUNNER2, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 61_000 }, { reconcileFirst: true });
  assert.equal(second.ran.length, 1);
  assert.equal(second.ran[0].id, followId);
  assert.equal(second.ran[0].status, 'succeeded');
  assert.equal(second.ran[0].verification.state, 'credential_use_verified');
  const after = getJob(d, sub.job.id);
  const rungs = parseJson(after.verification_json).rungs;
  assert.equal(rungs.credential_use_verified.value, true);
  assert.equal(rungs.credential_use_verified.by, RUNNER2);
  assert.equal(parseJson(after.verification_json).state, 'credential_use_verified');
  assert.equal(after.status, 'succeeded');
  assert.ok(listEvents(d, sub.job.id).some((e) => e.kind === 'recovery_result' && /verify_app/.test(e.message)));
  // Nothing more to run; the login is nowhere in the records.
  const third = await runOnce({ db: d, owner: RUNNER2, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 62_000 }, { reconcileFirst: false });
  assert.equal(third.ran.length, 0);
  noSecretIn(d, [sub.job.id, followId]);
  assert.equal(g.calls.filter((c) => c.phase === 'credential_use').length, 1);
});

test('the application rung has distinct outcomes: verified, failed (legacy or unreadable rows behind a 200), no protected credentials, no verification credentials, unreachable', async () => {
  const cases = [
    ['current', LOGIN, true, 'verified', 'credential_use_verified'],
    ['legacy', LOGIN, false, 'failed', 'recovery_required'],
    ['unreadable', LOGIN, false, 'failed', 'recovery_required'],
    ['none', LOGIN, null, 'no_protected_credentials', 'credential_decryptable'],
    ['current', null, null, 'no_verification_credentials', 'credential_decryptable'],
    ['down', LOGIN, null, 'unreachable', 'credential_decryptable'],
    ['nosettings', LOGIN, null, 'unreachable', 'credential_decryptable'],
  ];
  for (const [ldaps, login, value, outcome, finalState] of cases) {
    const d = db();
    const g = guestFor({ ldaps });
    const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
    await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => login, nowMs: () => T0 + 1 }, { reconcileFirst: false });
    const deploy = getJob(d, sub.job.id);
    assert.equal(deploy.status, 'succeeded', `${outcome}: execution is a separate fact`);
    const v = parseJson(deploy.verification_json);
    assert.equal(v.rungs.credential_use_verified.value, value, outcome);
    assert.match(v.rungs.credential_use_verified.detail, new RegExp(`^${outcome}:`));
    assert.equal(v.state, finalState, outcome);
    const follow = getJob(d, parseJson(deploy.progress_json).verification_job_id);
    assert.equal(follow.outcome, outcome);
    assert.equal(follow.status, value === false ? 'recovery_required' : 'succeeded');
    if (value === false) assert.match(follow.reason, /cannot use its credential as stored|refused/);
    noSecretIn(d, [sub.job.id, follow.id]);
  }
  assert.deepEqual(Object.keys(CREDENTIAL_USE_OUTCOMES).sort(), ['failed', 'no_protected_credentials', 'no_verification_credentials', 'not_applicable', 'unreachable', 'verified']);
  assert.equal(interpretCredentialUse('SIGNIN:200\n{"configured":true,"masterKey":"current","masterKeyInventory":{"total":2,"current":1,"legacy":0,"unreadable":1,"complete":false}}\nLDAPS:200\n').outcome, 'failed', 'a 200 with an unreadable row is not verified');
  assert.throws(() => credentialUseScript(3000, null), /needs a login/);
});

// ── 2. migration-aware checkpoints ─────────────────────────────────────

test('the maintenance boundary sits before the migration; protected copies are retained versions; a migration in flight or failed is recorded with its retry class and never rolled back on its own', async () => {
  const d = db();
  const g = guestFor({});
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 1 }, { reconcileFirst: false, max: 1 });
  const phases = g.calls.map((c) => c.phase);
  assert.ok(phases.indexOf('stop') < phases.indexOf('migrate'), 'stopped before migrating');
  assert.ok(phases.indexOf('protect') < phases.indexOf('stop'), 'copies before the stop');
  assert.ok(phases.indexOf('build') < phases.indexOf('protect'));
  const cp = parseJson(getJob(d, sub.job.id).checkpoint_json);
  assert.deepEqual(cp.recovery.completed, ['install', 'build', 'migrate']);
  assert.equal(cp.recovery.migration.retry, 'resume');
  assert.equal(cp.recovery.protected.dbDump.path, `/var/backups/proxypilot-db/app-pre-deploy-${sub.job.id}.sql`);
  assert.equal(cp.recovery.protected.unitCopy, `/etc/systemd/system/mock2-dev.service.pre-${sub.job.id}`);
  assert.equal(cp.recovery.protected.envCopy, `/etc/environment.pre-${sub.job.id}`);
  assert.equal(cp.recovery.protected.sourceCommit, 'd'.repeat(40));
  // A later deploy takes its OWN copies; the first record still names its own.
  const sub2 = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 + 100 });
  await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => T0 + 101 }, { reconcileFirst: false });
  assert.deepEqual(g.calls.filter((c) => c.phase === 'protect').map((c) => c.id), [sub.job.id, sub2.job.id]);
  assert.equal(parseJson(getJob(d, sub.job.id).checkpoint_json).recovery.protected.envCopy, `/etc/environment.pre-${sub.job.id}`, 'unchanged by the later deploy');
  assert.notEqual(parseJson(getJob(d, sub2.job.id).checkpoint_json).recovery.protected.envCopy, `/etc/environment.pre-${sub.job.id}`);

  // Interrupted mid-migration: recover, with the migration's retry class on the record and the copies carried to the recovery job.
  const d2 = db();
  const g2 = guestFor({});
  const sub3 = submitDeployJob(d2, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  const c3 = claimNextJob(d2, { owner: RUNNER2, kinds: ['deploy'], leaseMs: 1000, nowMs: T0 });
  acquireLock(d2, { app: 'pp-x', owner: RUNNER2, operation: 'deploy', jobId: c3.id, leaseMs: 1000, nowMs: T0 });
  checkpoint(d2, { id: c3.id, owner: RUNNER2, epoch: c3.epoch, phase: 'migrating', checkpoint: { app_stopped: true, disruptive: true, migration_in_progress: true, container: 'pp-x', webPort: 3000, unit: 'mock2-dev.service', recovery: { migration: { retry: 'unknown', ledger: null }, protected: { dbDump: { path: '/var/backups/proxypilot-db/app-pre-deploy-x.sql' } }, guard: GUARD } }, nowMs: T0 });
  const s = reconcile({ db: d2, owner: RUNNER, nowMs: T0 + 60_000 });
  assert.equal(s.recoveryQueued.length, 1);
  const dead = getJob(d2, c3.id);
  assert.equal(dead.status, 'recovery_required');
  assert.match(dead.reason, /A migration was in flight \(retry class: unknown\)/);
  const rec = getJob(d2, s.recoveryQueued[0].recovery);
  assert.equal(parseJson(rec.config_refs_json).recovery.protected.dbDump.path, '/var/backups/proxypilot-db/app-pre-deploy-x.sql', 'the protected copy travels with the recovery job');
  assert.equal(readLock(d2, 'pp-x').stale_since != null, true);

  // A failed migration: distinct step, the ledger and the dump named, the old process restarted on the new dist — never a rollback.
  const g3 = guestFor({ fail: 'migrate' });
  const r = await runDeployOperation({ params: PARAMS(), exec: g3, job: { id: 'j-fail', fence: () => {}, checkpoint: () => 0, generated: () => 0, event: () => {} } });
  assert.equal(r.ok, false);
  assert.equal(r.step, 'migrate');
  assert.match(r.error, /Database migration failed/);
  assert.match(r.error, /Restart attempted/i);
  assert.match(r.error, /ledger \(_migrations\)/);
  assert.match(r.error, /app-pre-deploy-j-fail\.sql is the protected copy/);
  assert.ok(g3.calls.some((c) => c.phase === 'restart'));
  assert.equal(g3.calls.some((c) => c.phase === 'env_write' || c.phase === 'unit_swap'), false, 'nothing after the failed migration');

  assert.equal(classifyMigrateScript('MIGRATE_SCRIPT:"migrate": "node scripts/migrate.mjs"\nMIGRATIONS_DIR:yes\n').retry, 'resume');
  assert.equal(classifyMigrateScript('MIGRATE_SCRIPT:"migrate": "./my-migrate.sh"\n').retry, 'unknown');
  assert.equal(classifyMigrateScript('', 'npx drizzle-kit migrate').retry, 'resume');
  assert.equal(classifyMigrateScript('', null).retry, 'none');
  const copies = parseProtectedCopies('DBDUMP:none:no pg_dump\nUNITCOPY:none:no unit yet\nENVCOPY:/etc/environment.pre-1\nCOMMIT:abc\n');
  assert.equal(copies.dbDump, null); assert.equal(copies.dbDumpNote, 'none:no pg_dump'); assert.equal(copies.unitCopy, null); assert.equal(copies.envCopy, '/etc/environment.pre-1'); assert.equal(copies.commit, null);
  assert.match(protectedCopiesScript('j1', { withDatabase: false }), /DBDUMP:skipped/);
});

// ── 3. containment of every writer ─────────────────────────────────────

test('containment (real processes): an unmarked child that outlives its marked parent and keeps writing is killed by session; a legitimate current holder is untouched', { skip: !HAS_TOOLS && 'pkill/pgrep/setsid not installed' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-contain-'));
  const runDir = join(root, 'run');
  const out = join(root, 'out.txt');
  const localSh = (script, timeoutMs = 10_000) => new Promise((resolve) => {
    const p = spawn('sh', [], { stdio: ['pipe', 'pipe', 'pipe'], detached: false });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (x) => { stdout += x; }); p.stderr.on('data', (x) => { stderr += x; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    p.stdin.end(script);
  });
  let holderPid = null;
  try {
    // The stale job's script: marked, contained, spawns an UNMARKED child
    // that outlives it and keeps writing.
    const body = `( sh -c 'while :; do echo x >> "${out}"; sleep 0.05; done' >/dev/null 2>&1 & ) ; exit 0\n`;
    const r0 = await localSh(containedScript('dead-job', body, { runDir }));
    assert.equal(r0.code, 0, r0.stderr);
    const sidFile = join(runDir, 'dead-job.sid');
    assert.ok(existsSync(sidFile), 'the session was recorded under the job');
    const sid = readFileSync(sidFile, 'utf8').trim().split('\n')[0];
    await new Promise((r) => setTimeout(r, 300));
    const size1 = statSync(out).size;
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(statSync(out).size > size1, 'the orphaned child keeps writing after its parent exited');
    assert.equal(spawnSync('pgrep', ['-s', sid], { encoding: 'utf8' }).status, 0, 'processes live in the recorded session');
    assert.equal(spawnSync('pgrep', ['-f', 'mock2_deploy_marker job=dead-job'], { encoding: 'utf8' }).status, 1, 'the marked parent itself is already gone: a marker search alone would find nothing');
    // A legitimate current holder: the CURRENT job's own contained session.
    const holder = await localSh(containedScript('current-job', `( sleep 30 >/dev/null 2>&1 & echo $! ) ; exit 0\n`, { runDir }));
    holderPid = Number(holder.stdout.trim().split('\n').pop());
    assert.ok(holderPid > 0);
    // Cleanup under the current job's ownership.
    const reap = await localSh(reapStaleWritersScript('current-job', { runDir }));
    assert.equal(parseStaleWriters(reap.stdout), 0, `no survivors: ${reap.stdout} ${reap.stderr}`);
    await new Promise((r) => setTimeout(r, 300));
    const sizeAfter = statSync(out).size;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(statSync(out).size, sizeAfter, 'the orphan stopped writing');
    const aliveInSession = (spawnSync('pgrep', ['-s', sid], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).filter((pid) => { try { return !/\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } });
    assert.deepEqual(aliveInSession, [], 'the stale session has no live process (zombies awaiting reap do not count)');
    assert.equal(existsSync(sidFile), false, 'the dead job\'s session file was removed');
    assert.ok(existsSync(join(runDir, 'current-job.sid')), 'the current job\'s file stays');
    assert.doesNotThrow(() => process.kill(holderPid, 0), 'the legitimate holder is alive');
  } finally {
    if (holderPid) { try { process.kill(holderPid, 'SIGKILL'); } catch { /* */ } }
    for (const f of (existsSync(runDir) ? readdirSync(runDir) : [])) { for (const s of readFileSync(join(runDir, f), 'utf8').split('\n')) { if (s.trim()) spawnSync('pkill', ['-9', '-s', s.trim()]); } }
    rmSync(root, { recursive: true, force: true });
  }
});

test('containment on the record: a survivor after the reap ends the job as recovery_required with the lease KEPT and flagged, and conflicting operations are refused with that reason', async (t) => {
  const d = db();
  configureContainerLockStore({ getDb: () => d, owner: BACKEND });
  t.after(() => configureContainerLockStore(null));
  const g = guestFor({ survivors: 1 });
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  const out = await runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 1 }, { reconcileFirst: false });
  assert.equal(out.ran[0].status, 'recovery_required');
  assert.equal(out.ran[0].outcome, 'previous_writer_alive');
  assert.deepEqual(g.calls.map((c) => c.phase), ['reap', 'reap'], 'two attempts, nothing else touched the guest');
  const lock = readLock(d, 'pp-x');
  assert.equal(lock.owner, RUNNER, 'the lease is kept');
  assert.ok(lock.stale_since, 'and flagged');
  assert.equal(lock.recovery_job_id, sub.job.id);
  assert.match(getJob(d, sub.job.id).reason, /lease is kept and flagged stale/);
  // A restore through the shared lock is refused with the recorded condition (stale after the lease lapses, busy before).
  let ran = false;
  await assert.rejects(withContainerLock('pp-x', 'restore_snapshot', async () => { ran = true; }, { wait: false, job: { kind: 'restore_snapshot' } }), (e) => e.code === 'CONTAINER_BUSY' || e instanceof ContainerLockStaleError);
  assert.equal(ran, false);
  // The next deploy attempt (a later runner) takes the stale lease over and reaps again; still a survivor → the same recorded state, never a silent clear.
  const sub2 = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 + 120_000 });
  const out2 = await runOnce({ db: d, owner: RUNNER2, exec: g, nowMs: () => T0 + 120_001 }, { reconcileFirst: false });
  assert.equal(out2.ran[0].status, 'recovery_required');
  assert.equal(readLock(d, 'pp-x').owner, RUNNER2);
  assert.ok(readLock(d, 'pp-x').stale_since);
  // Once the survivors are gone, the app deploys again.
  g.calls.length = 0; const g2 = guestFor({ survivors: 0 });
  const sub3 = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 + 240_000 });
  const out3 = await runOnce({ db: d, owner: RUNNER, exec: g2, reviewLogin: async () => LOGIN, nowMs: () => T0 + 240_001 }, { reconcileFirst: false });
  assert.equal(out3.ran[0].status, 'succeeded');
  assert.equal(readLock(d, 'pp-x'), null);
  assert.ok(sub2.job.id !== sub3.job.id);
});

// ── 4. the executor policy ─────────────────────────────────────────────

test('executorPolicy: explicit values, the safe reading of an unknown value, the documented default', () => {
  assert.deepEqual(executorPolicy({ SETUP_EXECUTOR_POLICY: 'runner-required' }), { mode: 'runner-required', source: 'env' });
  assert.deepEqual(executorPolicy({ SETUP_EXECUTOR_POLICY: 'Backend-Allowed ' }), { mode: 'backend-allowed', source: 'env' });
  assert.equal(executorPolicy({ SETUP_EXECUTOR_POLICY: 'yolo' }).mode, 'runner-required');
  assert.deepEqual(executorPolicy({}), { mode: 'backend-allowed', source: 'default' });
  const example = readFileSync(`${REPO}.env.example`, 'utf8');
  assert.match(example, /^SETUP_EXECUTOR_POLICY=runner-required$/m);
  assert.match(readFileSync(`${REPO}install.sh`, 'utf8'), /^SETUP_EXECUTOR_POLICY=runner-required$/m);
  assert.match(readFileSync(`${REPO}update.sh`, 'utf8'), /grep -q '\^SETUP_EXECUTOR_POLICY=' "\$env_file"/);
});

test('runner-required: with no runner or a stale heartbeat the deploy is QUEUED and reported unavailable; no guest command runs in the backend; a fresh heartbeat hands it to the runner', async (t) => {
  const d = db();
  const g = guestFor({});
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'runner-required' }, guestExec: g, reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  let out = await deployProject({ containerName: 'pp-x', webPort: 3000, requestedBy: 'alice', via: 'ui' });
  assert.equal(out.ok, false);
  assert.equal(out.step, 'runner_unavailable');
  assert.equal(out.queued, true);
  assert.match(out.error, /policy runner-required/);
  assert.equal(getJob(d, out.jobId).status, 'queued');
  assert.equal(g.calls.length, 0, 'nothing ran in the backend');
  // A stale heartbeat is no runner either.
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300, nowMs: Date.now() - 120_000 });
  out = await deployProject({ containerName: 'pp-x', webPort: 3000, detach: true });
  assert.equal(out.step, 'runner_unavailable');
  assert.equal(out.created, false, 'the same queued job is observed, not duplicated');
  assert.equal(g.calls.length, 0);
  assert.deepEqual((await drainInProcessNow()).ran, []);
  assert.equal((await drainInProcessNow()).skipped, 'none');
  // The runner comes back: the queued job is its to run.
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300, nowMs: Date.now() });
  assert.equal(executionMode(d, { env: { SETUP_EXECUTOR_POLICY: 'runner-required' } }).executor, 'runner');
  out = await deployProject({ containerName: 'pp-x', webPort: 3000, detach: true });
  assert.equal(out.submitted, true);
  assert.equal(out.executor, 'runner');
  const ran = await runOnce({ db: d, owner: RUNNER, exec: g, reviewLogin: async () => LOGIN, nowMs: () => Date.now() }, { reconcileFirst: false });
  assert.equal(ran.ran[0].status, 'succeeded');
  assert.equal(getJob(d, out.jobId).owner, RUNNER);
  // No request parameter enables the backend: the policy is the store's env.
  out = await deployProject({ containerName: 'pp-y', webPort: 3000, detach: true, policy: 'backend-allowed', SETUP_EXECUTOR_POLICY: 'backend-allowed', allowBackend: true });
  assert.equal(out.submitted, true, 'submitted to the (live) runner regardless of the parameters');
});

test('backend-allowed (legacy / development): with no runner the backend runs the SAME executor in-process — deploy, then the follow-up verification — with its own owner, and defers to a live runner', async (t) => {
  const d = db();
  const g = guestFor({ ldaps: 'current' });
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: g, reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  const steps = [];
  const out = await deployProject({ containerName: 'pp-x', webPort: 3000, requestedBy: 'alice', via: 'ui', guard: GUARD, onStep: (k, l) => steps.push(k) });
  assert.equal(out.ok, true);
  assert.equal(out.step, 'serving');
  const job = getJob(d, out.jobId);
  assert.equal(job.owner, BACKEND);
  assert.equal(job.status, 'succeeded');
  const follow = getJob(d, parseJson(job.progress_json).verification_job_id);
  assert.equal(follow.status, 'succeeded', 'the follow-up verification ran in-process too');
  assert.equal(follow.owner, BACKEND);
  assert.equal(parseJson(getJob(d, out.jobId).verification_json).rungs.credential_use_verified.value, true);
  assert.ok(steps.includes('install') || steps.includes('health'), `step labels replayed: ${steps.join(',')}`);
  assert.equal(readLock(d, 'pp-x'), null);
  noSecretIn(d, [out.jobId, follow.id]);
  // A live runner takes precedence even under backend-allowed.
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300, nowMs: Date.now() });
  assert.equal((await drainInProcessNow()).skipped, 'runner');
  const det = await deployProject({ containerName: 'pp-x', webPort: 3000, detach: true });
  assert.equal(det.executor, 'runner');
  assert.equal(getJob(d, det.jobId).status, 'queued');
  // And under runner-required the drain never runs, whatever is queued.
  assert.equal((await drainRunnerJobsInProcess(d, { exec: g, env: { SETUP_EXECUTOR_POLICY: 'runner-required' }, nowMs: () => Date.now() + 600_000 })).skipped, 'none');
});

test('index.js drains in-process only under backend-allowed, and the runner is the shared executor', () => {
  const index = readFileSync(`${REPO}admin/backend/src/index.js`, 'utf8');
  assert.match(index, /if \(policy\.mode === 'backend-allowed'\) \{\s*setTimeout\(drain, 15_000\)/);
  assert.match(index, /const policy = executorPolicy\(\);/);
  const runner = readFileSync(`${REPO}cli/src/setup-runner/runner.js`, 'utf8');
  assert.doesNotMatch(runner, /acquireLock|runDeployOperation/, 'the CLI carries no executor of its own');
  const cmd = readFileSync(`${REPO}cli/src/commands/setup-runner.js`, 'utf8');
  assert.match(cmd, /hostReviewLogin\(\{ dbPath: o\.install\.dbPath, envPath: o\.install\.envPath/);
  const login = readFileSync(`${REPO}cli/src/setup-runner/review-login.js`, 'utf8');
  assert.match(login, /readonly: true/);
  assert.match(login, /decryptSecret\(row\.review_login_password_enc\)/);
});
