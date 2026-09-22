// The runner-owned deployment (lib/setup-engine/deploy-op.js, mock2/deploy.js,
// cli/src/setup-runner/runner.js): one operation over an injected guest,
// driven against a real SQLite database (node:sqlite) and a scripted guest,
// plus two real child-process checks — a marker-carrying guest script is
// reaped and stays dead, and a job submitted by a process that then exits is
// executed by the runner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, randomBytes } from 'node:crypto';

import { runDeployOperation, reapOrphansScript, parseOrphans, DEPLOY_MARKER, PreviousWriterAliveError, resolveDeployPlan } from '../lib/setup-engine/deploy-op.js';
import { interpretCredentialUse, deployProject } from '../mock2/deploy.js';
import {
  ensureSetupEngineSchema, createJob, claimNextJob, getJob, listEvents, acquireLock, readLock, requestCancel, runnerHeartbeat, liveRunners, checkpoint, startJob,
} from '../lib/setup-engine/store.js';
import { ownerIdentity, reconcileDecision, verifyJobFrom, recoveryJobFrom, FencedError, CancelledError, parseJson, RUNNER_JOB_KINDS } from '../lib/setup-engine/logic.js';
import { submitDeployJob, waitForJob, deployResultFromJob, runnerAvailable, sweepSetupEngineOnBoot } from '../lib/setup-engine/backend.js';
import { executeJob, reconcile, runOnce } from '../../../../cli/src/setup-runner/runner.js';
import { withContainerLock, configureContainerLockStore, ContainerBusyError } from '../mock2/container-lock.js';
import { masterKeyFor } from '../mock2/auth-data-logic.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const T0 = Date.parse('2026-09-21T14:00:00.000Z');
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const RUNNER2 = ownerIdentity({ kind: 'runner', host: 'pp', pid: 301, instance: 'ssss' });
const BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
const GUARD = { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce', filter: "provider = 'ldaps'", legacy_default: 'dev-insecure-master-secret-change-me' };
const CONTRACT = { hasContract: true, runtime: 'node-express', install: 'npm ci', migrate: 'npm run migrate', build: 'npm run build', start: 'npm run start' };
const SECRET_CONFIGS = [
  { key: 'AUTH_JWT_SECRET', secret: true, generate: true },
  { key: 'AUTH_MASTER_SECRET', secret: true, generate: true, requires_marker: { path: 'src/auth/crypto.ts', contains: 'decryptSecretAny', built: 'dist/auth/crypto.js' }, protects: GUARD },
];
const HAS_PKILL = spawnSync('sh', ['-c', 'command -v pkill && command -v pgrep'], { encoding: 'utf8' }).status === 0;

function db() { const d = new DatabaseSync(':memory:'); ensureSetupEngineSchema(d); return d; }

function encryptUnder(master, plaintext = 'bind-password') {
  const key = masterKeyFor(master);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { ciphertext: Buffer.concat([ct, c.getAuthTag()]).toString('base64'), nonce: nonce.toString('base64') };
}
const probeRows = (rows) => `PROBE:ok\nTARGET:127.0.0.1:5432/app schema=public\nRLS:off\n${rows.map((r) => `ROW:${r.ciphertext}|${r.nonce}`).join('\n')}\n`;

// A scripted guest for the whole deploy. `state` is mutable: the mint's env
// write lands in state.env, the unit swap in state.unit, and every call is
// recorded with the phase it belongs to (derived from the script).
function deployGuest(state) {
  const calls = [];
  const hooks = state.hooks || {};
  const g = {
    calls, state,
    guest: async (container, raw) => {
      const script = unwrapContained(raw);
      const phase = classify(script);
      calls.push({ container, phase, script, raw });
      if (hooks[phase]) await hooks[phase](g);
      switch (phase) {
        case 'reap': return { code: 0, stdout: `STALE_WRITERS:${state.orphans ?? 0}\n` };
        case 'protect': state.protected = (state.protected || 0) + 1; return { code: 0, stdout: state.protectOut ?? `DBDUMP:/var/backups/proxypilot-db/app-pre-deploy-${jobIdOf(raw)}.sql:12345:${'ab'.repeat(32)}\nUNITCOPY:/etc/systemd/system/mock2-dev.service.pre-${jobIdOf(raw)}\nENVCOPY:/etc/environment.pre-${jobIdOf(raw)}\nCOMMIT:${'c'.repeat(40)}\nMIGRATE_SCRIPT:"migrate": "node scripts/migrate.mjs"\nMIGRATIONS_DIR:yes\n` };
        case 'migrate_class': return { code: 0, stdout: state.migrateClassOut ?? 'MIGRATE_SCRIPT:"migrate": "node scripts/migrate.mjs"\nMIGRATIONS_DIR:yes\n' };
        case 'credential_use': return { code: 0, stdout: state.credentialUseOut ?? 'SIGNIN:200\n{"configured":true,"masterKey":"current","masterKeyInventory":{"total":1,"current":1,"legacy":0,"unreadable":0,"complete":true}}\nLDAPS:200\n' };
        case 'contract': return { code: 0, stdout: state.yaml ?? 'run:\n  install: npm ci\n  migrate: npm run migrate\n  build: npm run build\n  start: npm run start\n' };
        case 'install_fresh': return { code: 0, stdout: state.installFresh ? 'MOCK2_INSTALL_FRESH\n' : '' };
        case 'install': case 'migrate': case 'build': return state.fail === phase ? { code: 1, stdout: '', stderr: `${phase} exploded` } : { code: 0, stdout: 'ok\n' };
        case 'stamp_write': return { code: 0, stdout: '' };
        case 'e2e_probe': return { code: 1, stdout: '' };
        case 'pwa': return { code: 0, stdout: 'MOCK2_RETROFIT_DONE\n' };
        case 'build_id': return { code: 0, stdout: 'MOCK2_BUILD_ID:x\n' };
        case 'stop': state.active = false; return state.fail === 'stop' ? { code: 1, stdout: '', stderr: 'cannot stop' } : { code: 0, stdout: '' };
        case 'markers': return { code: 0, stdout: state.markers ?? 'MARKER OK AUTH_MASTER_SECRET\n' };
        case 'env_read': return { code: 0, stdout: state.env ?? '' };
        case 'data_probe': return { code: 0, stdout: state.probe ?? 'PROBE:ok\nTARGET:127.0.0.1:5432/app schema=public\nRLS:off\n' };
        case 'env_write': { const m = script.match(/printf '%s' '([^']+)' \| base64 -d > \/etc\/environment\.mock2-tmp/); state.env = Buffer.from(m[1], 'base64').toString('utf8'); state.envWrites = (state.envWrites || 0) + 1; return { code: 0, stdout: '' }; }
        case 'unit_swap': { const m = script.match(/printf '%s' '([^']+)' \| base64 -d > \/etc\/systemd\/system\/mock2-dev\.service/); state.unit = Buffer.from(m[1], 'base64').toString('utf8'); if (state.fail === 'start') return { code: 1, stdout: '', stderr: 'Job for mock2-dev.service failed' }; state.active = true; return { code: 0, stdout: '' }; }
        case 'restart': state.active = state.restartWorks !== false; return { code: 0, stdout: state.active ? 'MOCK2_SERVING (200)\n' : 'MOCK2_NOT_SERVING (last http_code: 000)\n' };
        case 'health': return { code: 0, stdout: state.active && state.serves !== false ? 'MOCK2_SERVING (302)\n' : 'MOCK2_NOT_SERVING (last http_code: 000)\n# service state:\nfailed\n' };
        case 'stamp_report': return { code: 0, stdout: '' };
        case 'health_check': return { code: 0, stdout: `ROOT:${state.rootCode ?? 302}\nHEALTH:${state.healthCode ?? 200}\nLOGIN:200\n` };
        case 'active_key': { const m = String(state.env || '').match(/^AUTH_MASTER_SECRET=(.*)$/m); return { code: 0, stdout: `${m ? m[1].replace(/^"|"$/g, '') : ''}\n` }; }
        case 'unit_status': return { code: 0, stdout: `UNIT_LOADED:yes\nUNIT_ENABLED:enabled\nUNIT_ACTIVE:${state.active ? 'active' : 'inactive'}\n` };
        case 'start_unit': state.active = true; return { code: 0, stdout: 'START_RC:0\nUNIT_ACTIVE:active\n' };
        case 'port': return { code: 0, stdout: state.active ? 'PORT_SERVING:302\n' : 'PORT_NOT_SERVING:000\n' };
        default: return { code: 1, stdout: '', stderr: `unexpected script: ${script.slice(0, 80)}` };
      }
    },
  };
  return g;
}

// containedScript() base64-wraps every body under the job's session; the
// scripted guest reads the body back (a real guest would run it under setsid).
function unwrapContained(raw) {
  const m = String(raw).match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > "\$T"/);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : String(raw);
}
function jobIdOf(raw) {
  const m = String(raw).match(/mock2_deploy_marker job=([A-Za-z0-9-]+)/);
  return m ? m[1] : 'adhoc';
}

function classify(script) {
  if (/STALE_WRITERS:/.test(script)) return 'reap';
  if (/ORPHANS:/.test(script)) return 'reap';
  if (/DBDUMP:/.test(script)) return 'protect';
  if (/MIGRATE_SCRIPT:/.test(script)) return 'migrate_class';
  if (/PP_CRED_EOF/.test(script)) return 'credential_use';
  if (/mock2\.yaml/.test(script)) return 'contract';
  if (/MOCK2_INSTALL_FRESH/.test(script)) return 'install_fresh';
  if (/\.mock2-install-stamp'\s*$/m.test(script) && /printf '%s' "\$hash"/.test(script)) return 'stamp_write';
  if (/playwright\.config/.test(script)) return 'e2e_probe';
  if (/MOCK2_RETROFIT_DONE/.test(script)) return 'pwa';
  if (/MOCK2_BUILD_ID/.test(script) && /build-id/.test(script) && !/MOCK2_BUILD_ID_REPORT|stamp report/.test(script)) return /report|REPORT/.test(script) ? 'stamp_report' : 'build_id';
  if (/\/etc\/systemd\/system\/mock2-dev\.service/.test(script)) return 'unit_swap';
  if (/journalctl/.test(script)) return 'health';
  if (/MOCK2_SERVING/.test(script) && /systemctl start/.test(script)) return 'restart';
  if (/systemctl stop mock2-dev\.service/.test(script)) return 'stop';
  if (/MARKER (OK|MISSING)/.test(script)) return 'markers';
  if (/environment\.mock2-tmp/.test(script)) return 'env_write';
  if (/^cat \/etc\/environment/m.test(script)) return 'env_read';
  if (/PGPASSFILE|psql/.test(script)) return 'data_probe';
  if (/AUTH_MASTER_SECRET=/.test(script) && /sed -n/.test(script)) return 'active_key';
  if (/^ROOT|"ROOT:/m.test(script) || /\/api\/health/.test(script)) return 'health_check';
  if (/UNIT_LOADED/.test(script)) return 'unit_status';
  if (/START_RC/.test(script)) return 'start_unit';
  if (/PORT_SERVING/.test(script)) return 'port';
  if (/npm run migrate/.test(script)) return 'migrate';
  if (/npm run build/.test(script)) return 'build';
  if (/npm ci/.test(script)) return 'install';
  if (/build-id|sw\.js/.test(script)) return 'stamp_report';
  return 'other';
}

// The job handle over a real store, as the runner builds it.
function storeHandle(d, job, owner = RUNNER, { nowMs = () => T0 } = {}) {
  const epoch = Number(job.epoch);
  return {
    fence: (o = {}) => {
      const { fenceJob } = storeApi();
      fenceJob(d, { id: job.id, owner, epoch, safe: !!o.safe, nowMs: nowMs() });
    },
    checkpoint: (phase, data, message) => checkpoint(d, { id: job.id, owner, epoch, phase, checkpoint: data, message, nowMs: nowMs() }),
    generated: (resource) => storeApi().recordGenerated(d, { id: job.id, owner, epoch, resource, nowMs: nowMs() }),
    event: (kind, message, data) => storeApi().appendEvent(d, { jobId: job.id, kind, message, data, nowMs: nowMs() }),
    onStep: null,
  };
}
let _store = null;
function storeApi() { return _store; }
test.before(async () => { _store = await import('../lib/setup-engine/store.js'); });

const PARAMS = (extra = {}) => ({ container: 'pp-x', appDir: '/srv/app', webPort: 3000, environmentFile: '/etc/environment', contract: CONTRACT, secrets: { configs: SECRET_CONFIGS, newlyProvisioned: false }, guard: GUARD, ...extra });

// ── the operation ───────────────────────────────────────────────────────

test('deploy-op: the full path — reap, install/migrate/build, checkpoint BEFORE the stop, mint, unit, start, health, verify; recovery references outlive the stopped-app marker', async () => {
  const d = db();
  const job = createJob(d, { kind: 'deploy', app: 'pp-x', plan: { params: PARAMS() }, nowMs: T0 });
  const claimed = claimNextJob(d, { owner: RUNNER, kinds: ['deploy'], nowMs: T0 });
  const g = deployGuest({ env: 'PORT=3000\n', active: true });
  const r = await runDeployOperation({ params: PARAMS(), exec: g, job: storeHandle(d, claimed) });
  assert.equal(r.ok, true);
  assert.equal(r.step, 'serving');
  assert.deepEqual(r.minted, ['AUTH_JWT_SECRET', 'AUTH_MASTER_SECRET']);
  assert.equal(r.verification.state, 'credential_decryptable', 'nothing stored → decryptable vacuously; the application rung is a pending follow-up');
  assert.deepEqual(r.verification.pending, ['credential_use_verified']);
  assert.deepEqual({ ...r.followUp, revision: null }, { kind: 'verify_app', steps: ['verify_credential_use'], rung: 'credential_use_verified', revision: null });
  assert.equal(r.followUp.revision.commit, 'c'.repeat(40), 'the follow-up names the revision it certifies');
  assert.match(String(r.followUp.revision.buildId), /^\d{14}-[a-z0-9]+$/, 'and the build id it stamped');
  const phases = g.calls.map((c) => c.phase);
  assert.deepEqual(phases.slice(0, 5), ['reap', 'install_fresh', 'install', 'stamp_write', 'build'], 'install and build run under the old app; the migration does not');
  const stopAt = phases.indexOf('stop');
  assert.ok(stopAt > phases.indexOf('build'));
  assert.ok(phases.indexOf('protect') < stopAt && phases.indexOf('protect') > phases.indexOf('build'), 'protected copies are taken after the build, before the stop');
  assert.ok(phases.indexOf('migrate') > stopAt, 'the migration runs with the old app stopped');
  assert.ok(phases.indexOf('markers') > phases.indexOf('migrate') && phases.indexOf('env_write') > stopAt, 'the mint happens after the migration');
  assert.equal(r.recovery.migration.retry, 'resume');
  assert.equal(r.recovery.migration.ledger, '_migrations');
  assert.match(r.recovery.protected.dbDump.path, /app-pre-deploy-/);
  assert.match(r.recovery.protected.unitCopy, /\.pre-/);
  assert.match(r.recovery.protected.envCopy, /environment\.pre-/);
  assert.equal(r.recovery.protected.sourceCommit, 'c'.repeat(40));
  assert.deepEqual(r.recovery.completed, ['install', 'build', 'migrate']);
  assert.ok(phases.indexOf('unit_swap') > phases.indexOf('env_write'));
  assert.ok(phases.indexOf('health') > phases.indexOf('unit_swap'));
  assert.ok(g.calls.every((c) => c.container === 'pp-x'));
  // The environment now carries both keys, 43-character base64url values.
  assert.match(g.state.env, /^AUTH_JWT_SECRET="?[A-Za-z0-9_-]{43}"?$/m);
  assert.match(g.state.env, /^AUTH_MASTER_SECRET="?[A-Za-z0-9_-]{43}"?$/m);
  assert.match(g.state.unit, /Environment=NODE_ENV=production/);
  assert.match(g.state.unit, /ExecStart=\/bin\/sh -lc 'cd \/srv\/app && exec npm run start'/);
  // The record: checkpoint order, the stopped marker cleared, the recovery references kept.
  const cps = listEvents(d, claimed.id).filter((e) => e.kind === 'checkpoint').map((e) => e.phase);
  assert.deepEqual(cps, ['starting', 'install', 'build', 'build_done', 'stopping_app', 'migrating', 'migrated', 'secrets_minted', 'unit_written', 'app_started', 'verified']);
  const stopCallIdx = g.calls.findIndex((c) => c.phase === 'stop');
  const cpBeforeStop = listEvents(d, claimed.id).find((e) => e.phase === 'stopping_app');
  assert.ok(cpBeforeStop, 'the stopping_app checkpoint exists');
  assert.ok(stopCallIdx > 0);
  const row = getJob(d, claimed.id);
  const cp = parseJson(row.checkpoint_json);
  assert.equal(cp.app_stopped, false);
  assert.equal(cp.phase, 'verified');
  assert.deepEqual(cp.recovery.generatedKeys, ['AUTH_JWT_SECRET', 'AUTH_MASTER_SECRET']);
  assert.equal(cp.recovery.unitPath, '/etc/systemd/system/mock2-dev.service');
  assert.equal(cp.recovery.contract.start, 'npm run start');
  assert.deepEqual(cp.recovery.guard, GUARD);
  assert.ok(cp.recovery.protected.dbDump && cp.recovery.protected.unitCopy && cp.recovery.protected.envCopy, 'retained copies, not live paths, on the record');
  assert.notEqual(cp.recovery.protected.unitCopy, cp.recovery.unitPath);
  assert.notEqual(cp.recovery.protected.envCopy, cp.recovery.environmentFile);
  const prog = parseJson(row.progress_json);
  assert.deepEqual(prog.generated.map((x) => x.name), ['AUTH_JWT_SECRET', 'AUTH_MASTER_SECRET']);
  // No secret value anywhere in the record.
  const values = [...g.state.env.matchAll(/=("?)(.+?)\1$/gm)].map((m) => m[2]).filter((v) => v.length > 10);
  const dump = JSON.stringify(row) + JSON.stringify(listEvents(d, claimed.id));
  for (const v of values) assert.equal(dump.includes(v), false, 'a minted value leaked into the record');
});

test('deploy-op: a repeat or retry mints nothing new and reuses what exists; an unchanged manifest skips the install', async () => {
  const g = deployGuest({ env: 'AUTH_JWT_SECRET=already-there-value-1\nAUTH_MASTER_SECRET=already-there-value-2\n', active: true, installFresh: true, probe: probeRows([encryptUnder('already-there-value-2')]) });
  const r = await runDeployOperation({ params: PARAMS(), exec: g });
  assert.equal(r.ok, true);
  assert.deepEqual(r.minted, []);
  assert.equal(g.state.envWrites || 0, 0, 'no environment write at all');
  assert.match(g.state.env, /AUTH_MASTER_SECRET=already-there-value-2/);
  assert.equal(g.calls.some((c) => c.phase === 'install'), false, 'install skipped on an unchanged manifest');
  assert.equal(r.verification.state, 'credential_decryptable');
  assert.equal(r.verification.observations.credential.code, 200);
});

test('deploy-op: a stored row under the development key with the marker present mints through the bridge; a marker missing defers the key and says why', async () => {
  const dev = 'dev-insecure-master-secret-change-me';
  const g = deployGuest({ env: '', active: true, probe: probeRows([encryptUnder(dev)]) });
  const r = await runDeployOperation({ params: PARAMS(), exec: g });
  assert.deepEqual(r.minted, ['AUTH_JWT_SECRET', 'AUTH_MASTER_SECRET']);
  assert.equal(r.verification.state, 'recovery_required', 'the row is still under the dev key: decryptable under the NEW key is false — that is the truth until the app rekeys it');
  assert.equal(r.verification.failedAt, 'credential_decryptable');
  const g2 = deployGuest({ env: '', active: true, markers: 'MARKER MISSING AUTH_MASTER_SECRET\n' });
  const r2 = await runDeployOperation({ params: PARAMS(), exec: g2 });
  assert.deepEqual(r2.minted, ['AUTH_JWT_SECRET']);
  assert.equal(r2.deferred.length, 1);
  assert.match(r2.deferred[0].reason, /predates the code that migrates/);
  assert.doesNotMatch(g2.state.env, /AUTH_MASTER_SECRET/);
});

test('deploy-op: failures are distinct and never leave the app down silently — install (before the stop), stop, unit start (restart attempted), health', async () => {
  let g = deployGuest({ env: '', active: true, fail: 'install' });
  let r = await runDeployOperation({ params: PARAMS(), exec: g });
  assert.equal(r.ok, false); assert.equal(r.step, 'install');
  assert.equal(g.calls.some((c) => c.phase === 'stop'), false, 'the app was never stopped');
  g = deployGuest({ env: '', active: true, fail: 'stop' });
  r = await runDeployOperation({ params: PARAMS(), exec: g });
  assert.equal(r.step, 'start'); assert.match(r.error, /could not stop the running app before the migration/); assert.match(r.error, /Restart attempted/i);
  assert.equal(g.calls.some((c) => c.phase === 'restart'), true);
  g = deployGuest({ env: '', active: true, fail: 'start' });
  r = await runDeployOperation({ params: PARAMS(), exec: g });
  assert.equal(r.step, 'start'); assert.match(r.error, /mock2-dev\.service failed/); assert.match(r.error, /Restart attempted/i);
  assert.equal(g.calls.filter((c) => c.phase === 'restart').length, 1);
  g = deployGuest({ env: '', active: true, serves: false });
  r = await runDeployOperation({ params: PARAMS(), exec: g });
  assert.equal(r.step, 'health');
  assert.equal(r.verification.state, 'recovery_required');
  assert.equal(r.verification.failedAt, 'port_responding');
  assert.match(r.verification.next, /journalctl/);
  // A failed restart after a failure is reported as NOT serving, and recorded so.
  g = deployGuest({ env: '', active: true, fail: 'start', restartWorks: false });
  r = await runDeployOperation({ params: PARAMS(), exec: g });
  assert.match(r.error, /not serving/i);
});

test('deploy-op: a responding port with an unverified or failed credential is exactly that', async () => {
  const noGuard = deployGuest({ env: '', active: true });
  const r1 = await runDeployOperation({ params: PARAMS({ secrets: { configs: [] }, guard: null }), exec: noGuard });
  assert.equal(r1.ok, true);
  assert.equal(r1.verification.state, 'app_healthy');
  assert.match(r1.verification.next, /no data guard recorded/);
  assert.equal(r1.followUp, null, 'no guard: nothing to read back, no follow-up');
  assert.equal(r1.verification.observations.credentialUse.outcome, 'not_applicable');
  const mismatch = deployGuest({ env: 'AUTH_JWT_SECRET=x\nAUTH_MASTER_SECRET=configured-key-value\n', active: true, probe: probeRows([encryptUnder('some-other-key')]) });
  const r2 = await runDeployOperation({ params: PARAMS(), exec: mismatch });
  assert.equal(r2.ok, true, 'the app serves');
  assert.equal(r2.verification.state, 'recovery_required');
  assert.equal(r2.verification.failedAt, 'credential_decryptable');
  assert.match(r2.verification.next, /never roll the environment key back on its own/);
  const rls = deployGuest({ env: 'AUTH_JWT_SECRET=x\nAUTH_MASTER_SECRET=k\n', active: true, probe: 'PROBE:rls\nRLS:on\n' });
  const r3 = await runDeployOperation({ params: PARAMS(), exec: rls });
  assert.equal(r3.verification.state, 'app_healthy');
  assert.match(r3.verification.next, /credential decryptable was not checked/);
});

test('deploy-op: no run contract → skipped; the contract is read from the guest when the plan has none; a previous writer that survives the reap refuses the deploy', async () => {
  const g = deployGuest({ yaml: 'name: x\n' });
  assert.deepEqual(await runDeployOperation({ params: PARAMS({ contract: null }), exec: g }), { ok: true, skipped: true });
  const g2 = deployGuest({ env: '', active: true });
  const r2 = await runDeployOperation({ params: PARAMS({ contract: null, secrets: { configs: [] }, guard: null }), exec: g2 });
  assert.equal(r2.ok, true);
  assert.ok(g2.calls.some((c) => c.phase === 'contract'));
  const alive = deployGuest({ env: '', active: true, orphans: 2 });
  await assert.rejects(runDeployOperation({ params: PARAMS(), exec: alive }), (e) => e instanceof PreviousWriterAliveError && e.code === 'PREVIOUS_WRITER_ALIVE');
  assert.deepEqual(alive.calls.map((c) => c.phase), ['reap', 'reap'], 'reaped twice, then refused before any other command');
});

test('interpretCredentialUse: the application-owned rung reads the app\'s own answer', () => {
  const body = (o) => `SIGNIN:200\n${JSON.stringify(o)}\nLDAPS:200\n`;
  assert.equal(interpretCredentialUse(body({ configured: true, masterKey: 'current', masterKeyInventory: { total: 2, current: 2, legacy: 0, unreadable: 0, complete: true } })).verified, true);
  assert.equal(interpretCredentialUse(body({ configured: true, masterKey: 'rekeyed', masterKeyInventory: { total: 1, current: 1, complete: true } })).verified, true);
  const legacy = interpretCredentialUse(body({ configured: true, masterKey: 'legacy', masterKeyInventory: { total: 2, current: 1, legacy: 1, unreadable: 0, complete: false } }));
  assert.equal(legacy.verified, false);
  assert.match(legacy.detail, /legacy 1/);
  assert.equal(interpretCredentialUse(body({ configured: false, masterKey: 'none', masterKeyInventory: { total: 0, complete: true } })).verified, null, 'nothing stored: unverified, not verified');
  assert.equal(interpretCredentialUse('SIGNIN:401\n').verified, null);
  assert.equal(interpretCredentialUse('SIGNIN:200\nnot json\nLDAPS:200\n').verified, false);
  assert.equal(interpretCredentialUse('SIGNIN:200\n{}\nLDAPS:403\n').verified, false);
  assert.equal(interpretCredentialUse('').verified, null);
});

// ── the runner executes a submitted deploy ──────────────────────────────

test('submitDeployJob validates and de-duplicates; the runner executes the job to a terminal record every caller reads back as the same result shape', async () => {
  const d = db();
  const bad = submitDeployJob(d, { app: 'pp-x', params: PARAMS({ contract: { hasContract: true, start: 'npm start', install: 'npm ci\nrm -rf /' } }) });
  assert.match(bad.error, /single line/);
  const first = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), requestedBy: 'alice', via: 'ui', nowMs: T0 });
  assert.equal(first.created, true);
  const again = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), requestedBy: 'bob', via: 'mcp', nowMs: T0 + 1 });
  assert.equal(again.created, false);
  assert.equal(again.job.id, first.job.id, 'a repeated submission observes the open job');
  const g = deployGuest({ env: '', active: true });
  const out = await runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 2 }, { reconcileFirst: false });
  assert.equal(out.ran.length, 2, 'the deploy, then the follow-up verification it queued');
  assert.equal(out.ran[0].status, 'succeeded');
  assert.equal(out.ran[1].kind, 'verify_app');
  const row = getJob(d, first.job.id);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.outcome, 'serving', 'execution status, separate from verification');
  assert.equal(JSON.parse(row.verification_json).state, 'credential_decryptable');
  assert.deepEqual(JSON.parse(row.verification_json).pending, ['credential_use_verified']);
  const follow = getJob(d, JSON.parse(row.progress_json).verification_job_id);
  assert.equal(follow.kind, 'verify_app', 'the application-owned check is a persisted follow-up job');
  assert.equal(follow.status, 'succeeded');
  assert.equal(follow.outcome, 'no_verification_credentials', 'no review login was supplied to this executor: an explicit outcome, not a pass');
  assert.equal(JSON.parse(row.verification_json).rungs.credential_use_verified.value, null, 'the deploy record carries the rung, unverified');
  assert.equal(row.owner, RUNNER);
  const result = deployResultFromJob(row);
  assert.equal(result.ok, true);
  assert.equal(result.step, 'serving');
  assert.deepEqual(result.minted, ['AUTH_JWT_SECRET', 'AUTH_MASTER_SECRET']);
  assert.equal(result.verification.state, 'credential_decryptable');
  assert.equal(result.jobId, row.id);
  assert.equal(readLock(d, 'pp-x'), null);
  assert.ok(listEvents(d, row.id).some((e) => e.kind === 'step' && e.phase === 'reap_previous_writer'));
  const dump = JSON.stringify(row) + JSON.stringify(listEvents(d, row.id));
  for (const v of [...g.state.env.matchAll(/=("?)(.+?)\1$/gm)].map((m) => m[2]).filter((x) => x.length > 10)) assert.equal(dump.includes(v), false);
  // A second submission after completion is a new job that mints nothing.
  const second = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 + 10 });
  assert.equal(second.created, true);
  const g2 = deployGuest({ env: g.state.env, active: true, probe: probeRows([]) });
  const out2 = await runOnce({ db: d, owner: RUNNER, exec: g2, nowMs: () => T0 + 11 }, { reconcileFirst: false });
  assert.deepEqual(deployResultFromJob(getJob(d, second.job.id)).minted, []);
  assert.equal(g2.state.envWrites || 0, 0);
  assert.equal(out2.ran[0].status, 'succeeded');
});

test('waitForJob replays step events to the caller and returns the terminal row; a runner heartbeat is what makes the backend hand a deploy over', async () => {
  const d = db();
  assert.equal(runnerAvailable(d, { nowMs: T0 }), null);
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300, nowMs: T0 });
  assert.equal(runnerAvailable(d, { nowMs: T0 + 1000 }).owner, RUNNER);
  assert.equal(runnerAvailable(d, { nowMs: T0 + 60_000 }), null, 'a stale heartbeat is not a runner');
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS({ secrets: { configs: [] }, guard: null }), nowMs: T0 });
  const seen = [];
  const g = deployGuest({ env: '', active: true });
  const [row] = await Promise.all([
    waitForJob(d, sub.job.id, { pollMs: 1, onEvent: (e) => { if (e.kind === 'step') seen.push(e.phase); }, nowMs: () => Date.now() }),
    runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 1 }, { reconcileFirst: false }),
  ]);
  assert.equal(row.status, 'succeeded');
  assert.ok(seen.includes('install') && seen.includes('health'), `step events replayed: ${seen.join(',')}`);
  assert.equal(await waitForJob(d, 'nope', { pollMs: 1 }), null);
});

test('deployProject with a live runner submits and returns the job id (detach) without touching any guest', async (t) => {
  const d = db();
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300 });
  configureContainerLockStore({ getDb: () => d, owner: BACKEND });
  t.after(() => configureContainerLockStore(null));
  const out = await deployProject({ containerName: 'pp-z', webPort: 4000, requestedBy: 'alice', via: 'ui', detach: true });
  assert.equal(out.ok, true);
  assert.equal(out.submitted, true);
  const job = getJob(d, out.jobId);
  assert.equal(job.kind, 'deploy');
  assert.equal(job.status, 'queued');
  assert.equal(job.requested_by, 'alice');
  const params = parseJson(job.plan_json).params;
  assert.equal(params.container, 'pp-z');
  assert.equal(params.webPort, 4000);
  assert.equal(params.contract, null, 'no contract passed: the executor reads the guest\'s manifest');
  assert.deepEqual(params.secrets.configs, [], 'no registry in this sandbox: nothing to mint');
});

// ── cancel, fence, interruption ─────────────────────────────────────────

test('cancel: honoured at a safe checkpoint before the stop (nothing stopped); after the stop the deploy finishes bringing the app up and records the cancel as declined', async () => {
  const d = db();
  let sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS({ secrets: { configs: [] }, guard: null }), nowMs: T0 });
  const early = deployGuest({ env: '', active: true, hooks: { build: () => requestCancel(d, { id: sub.job.id, by: 'alice' }) } });
  let out = await runOnce({ db: d, owner: RUNNER, exec: early, nowMs: () => T0 + 1 }, { reconcileFirst: false });
  assert.equal(out.ran[0].status, 'cancelled');
  assert.equal(early.calls.some((c) => c.phase === 'stop'), false);
  assert.equal(getJob(d, sub.job.id).status, 'cancelled');
  assert.equal(readLock(d, 'pp-x'), null);
  sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS({ secrets: { configs: [] }, guard: null }), nowMs: T0 + 2 });
  const late = deployGuest({ env: '', active: true, hooks: { stop: () => requestCancel(d, { id: sub.job.id, by: 'alice' }) } });
  out = await runOnce({ db: d, owner: RUNNER, exec: late, nowMs: () => T0 + 3 }, { reconcileFirst: false });
  assert.equal(out.ran[0].status, 'succeeded');
  assert.ok(late.calls.some((c) => c.phase === 'unit_swap') && late.calls.some((c) => c.phase === 'health'), 'the app was brought up');
  assert.ok(listEvents(d, sub.job.id).some((e) => e.kind === 'cancel_declined'));
  const queued = createJob(d, { kind: 'verify_app', app: 'pp-q', nowMs: T0 });
  assert.deepEqual(requestCancel(d, { id: queued.id, by: 'bob' }), { ok: true, state: 'cancelled' });
  assert.equal(getJob(d, queued.id).status, 'cancelled');
});

test('fence: when ownership moves mid-deploy the runner stops before its next guest command; the new owner\'s record is untouched by it', async () => {
  const d = db();
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS({ secrets: { configs: [] }, guard: null }), nowMs: T0 });
  const g = deployGuest({ env: '', active: true, hooks: { build: () => { d.prepare(`UPDATE setup_jobs SET owner = ?, epoch = epoch + 1 WHERE id = ?`).run(RUNNER2, sub.job.id); } } });
  const out = await runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 1 }, { reconcileFirst: false });
  assert.equal(out.ran[0].status, 'fenced');
  assert.equal(g.calls.some((c) => c.phase === 'stop'), false, 'the disruptive step never ran under the old owner');
  const row = getJob(d, sub.job.id);
  assert.equal(row.status, 'running');
  assert.equal(row.owner, RUNNER2);
  assert.equal(readLock(d, 'pp-x'), null, 'the fenced runner released its own lease');
});

test('interruption at every checkpoint: a dead owner is reconciled to resume, recover or verify — never silently cleared', async () => {
  const cases = [
    ['install', { app_stopped: false, resumable: true }, 'resume'],
    ['build_done', { app_stopped: false, resumable: true }, 'resume'],
    ['stopping_app', { app_stopped: true, resumable: false, disruptive: true }, 'recover'],
    ['migrating', { app_stopped: true, resumable: false, disruptive: true, migration_in_progress: true, recovery: { migration: { retry: 'resume', ledger: '_migrations' } } }, 'recover'],
    ['secrets_minted', { app_stopped: true, resumable: false, recovery: { generatedKeys: ['AUTH_MASTER_SECRET'] } }, 'recover'],
    ['unit_written', { app_stopped: true, unit_swapped: true }, 'recover'],
    ['app_started', { app_stopped: false, unit_swapped: true }, 'verify'],
    ['verified', { app_stopped: false, unit_swapped: true, verification_state: 'credential_decryptable' }, 'record_interrupted'],
  ];
  for (const [phase, cp, expected] of cases) {
    const d = db();
    const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
    const claimed = claimNextJob(d, { owner: RUNNER2, kinds: ['deploy'], leaseMs: 1000, nowMs: T0 });
    acquireLock(d, { app: 'pp-x', owner: RUNNER2, operation: 'deploy', jobId: claimed.id, leaseMs: 1000, nowMs: T0 });
    checkpoint(d, { id: claimed.id, owner: RUNNER2, epoch: claimed.epoch, phase, checkpoint: { container: 'pp-x', webPort: 3000, unit: 'mock2-dev.service', ...cp }, nowMs: T0 });
    const dec = reconcileDecision({ job: getJob(d, claimed.id), lock: readLock(d, 'pp-x'), nowMs: T0 + 60_000 });
    assert.equal(dec.action, expected, phase);
    const s = reconcile({ db: d, owner: RUNNER, nowMs: T0 + 60_000 });
    if (expected === 'resume') {
      assert.deepEqual(s.requeued, [claimed.id]);
      assert.equal(getJob(d, claimed.id).status, 'queued');
      assert.equal(readLock(d, 'pp-x'), null);
      // …and it runs again from the start, minting nothing twice.
      const g = deployGuest({ env: 'AUTH_JWT_SECRET=a\nAUTH_MASTER_SECRET=b\n', active: true, probe: probeRows([encryptUnder('b')]) });
      const out = await runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 61_000 }, { reconcileFirst: false });
      assert.equal(out.ran[0].status, 'succeeded');
      assert.equal(g.state.envWrites || 0, 0);
    } else if (expected === 'recover') {
      assert.equal(s.recoveryQueued.length, 1);
      const rec = getJob(d, s.recoveryQueued[0].recovery);
      assert.equal(rec.kind, 'recover_app');
      assert.deepEqual(parseJson(rec.plan_json).params.guard, GUARD, 'the guard reference reaches the recovery');
      if (cp.recovery?.generatedKeys) assert.deepEqual(parseJson(rec.plan_json).params.origin.generatedKeys, ['AUTH_MASTER_SECRET'], 'the minted names travel too');
      assert.equal(getJob(d, claimed.id).status, 'recovery_required');
      if (cp.migration_in_progress) assert.match(getJob(d, claimed.id).reason, /A migration was in flight \(retry class: resume\)/);
      assert.ok(readLock(d, 'pp-x').stale_since, 'the lease is kept, flagged stale');
      const g = deployGuest({ env: 'AUTH_JWT_SECRET=a\nAUTH_MASTER_SECRET=b\n', active: false, probe: probeRows([encryptUnder('b')]) });
      const out = await runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 61_000 }, { reconcileFirst: false });
      assert.equal(out.ran[0].kind, 'recover_app');
      assert.equal(out.ran[0].status, 'succeeded');
      assert.equal(out.ran[0].verification.state, 'credential_decryptable');
      assert.ok(g.calls.some((c) => c.phase === 'start_unit'));
      assert.equal(readLock(d, 'pp-x'), null);
    } else if (expected === 'verify') {
      assert.equal(s.recoveryQueued[0].kind, 'verify_app');
      const ver = getJob(d, s.recoveryQueued[0].recovery);
      assert.equal(ver.kind, 'verify_app');
      const dead = getJob(d, claimed.id);
      assert.equal(dead.status, 'failed');
      assert.equal(dead.outcome, 'interrupted_unverified');
      assert.match(dead.reason, /recovery references are kept/);
      assert.equal(readLock(d, 'pp-x'), null);
      const g = deployGuest({ env: 'AUTH_JWT_SECRET=a\nAUTH_MASTER_SECRET=b\n', active: true, probe: probeRows([encryptUnder('b')]) });
      const out = await runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 61_000 }, { reconcileFirst: false });
      assert.equal(out.ran[0].kind, 'verify_app');
      assert.equal(g.calls.some((c) => c.phase === 'start_unit'), false, 'verify never starts the unit');
      assert.equal(out.ran[0].verification.state, 'credential_decryptable');
    } else {
      assert.deepEqual(s.interrupted, [claimed.id]);
      assert.equal(readLock(d, 'pp-x'), null);
    }
  }
});

test('the backend boot sweep reads a dead runner deploy the same way, and never touches a live one', () => {
  const d = db();
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS(), nowMs: T0 });
  const claimed = claimNextJob(d, { owner: RUNNER2, kinds: ['deploy'], leaseMs: 1000, nowMs: T0 });
  checkpoint(d, { id: claimed.id, owner: RUNNER2, epoch: claimed.epoch, phase: 'stopping_app', checkpoint: { app_stopped: true, disruptive: true, container: 'pp-x' }, nowMs: T0 });
  assert.deepEqual(sweepSetupEngineOnBoot(d, { owner: BACKEND, nowMs: T0 + 500 }), { interrupted: [], recoveryQueued: [], skipped: [] }, 'live lease: nothing');
  assert.deepEqual(sweepSetupEngineOnBoot(d, { owner: BACKEND, nowMs: T0 + 60_000 }), { interrupted: [], recoveryQueued: [], skipped: [] }, 'a runner\'s dead job is the runner\'s to reconcile, not the backend\'s');
  assert.equal(getJob(d, sub.job.id).status, 'running');
});

// ── contention ──────────────────────────────────────────────────────────

test('contention: a restore is refused while the runner deploys (no change), and a deploy defers while a restore holds the app (no guest command)', async (t) => {
  const d = db();
  configureContainerLockStore({ getDb: () => d, owner: BACKEND });
  t.after(() => configureContainerLockStore(null));
  // The runner holds pp-x for a deploy.
  const sub = submitDeployJob(d, { app: 'pp-x', params: PARAMS({ secrets: { configs: [] }, guard: null }), nowMs: T0 });
  const claimed = claimNextJob(d, { owner: RUNNER, kinds: ['deploy'], nowMs: T0 });
  acquireLock(d, { app: 'pp-x', owner: RUNNER, operation: 'deploy', jobId: claimed.id, leaseMs: 60_000, nowMs: Date.now() });
  let ran = false;
  await assert.rejects(withContainerLock('pp-x', 'restore_project_db', async () => { ran = true; }, { wait: false, job: { kind: 'restore_project_db' } }), (e) => e instanceof ContainerBusyError && /deploy/.test(e.holder));
  assert.equal(ran, false);
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM setup_jobs WHERE kind = 'restore_project_db'`).get().n, 0);
  // The other way: a restore (backend) holds pp-y; the runner's deploy defers without a guest call.
  acquireLock(d, { app: 'pp-y', owner: BACKEND, operation: 'restore_snapshot', leaseMs: 60_000, nowMs: T0 });
  const sub2 = submitDeployJob(d, { app: 'pp-y', params: PARAMS({ container: 'pp-y', secrets: { configs: [] }, guard: null }), nowMs: T0 });
  const g = deployGuest({ env: '', active: true });
  const out = await runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 1 }, { reconcileFirst: false });
  assert.equal(out.ran[0].status, 'deferred');
  assert.equal(g.calls.length, 0);
  assert.match(getJob(d, sub2.job.id).reason, /held by backend@pp#100:aaaa \(restore_snapshot\)/);
  assert.equal(readLock(d, 'pp-y').owner, BACKEND);
});

// ── real processes ──────────────────────────────────────────────────────

test('a guest script carrying the deploy marker is really killed by the reap and none survive (real child process)', { skip: !HAS_PKILL && 'pkill/pgrep not installed' }, async () => {
  const child = spawn('sh', ['-c', `: ${DEPLOY_MARKER}_realtest; sleep 60`], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  assert.doesNotThrow(() => process.kill(child.pid, 0), 'the stale writer is alive before the reap');
  const localSh = { guest: (_c, script, { timeoutMs = 10_000 } = {}) => new Promise((resolve) => {
    const p = spawn('sh', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (x) => { stdout += x; }); p.stderr.on('data', (x) => { stderr += x; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
    p.stdin.end(script);
  }) };
  const r = await localSh.guest('local', reapOrphansScript());
  assert.equal(parseOrphans(r.stdout), 0, `no survivors: ${r.stdout} ${r.stderr}`);
  await new Promise((r2) => setTimeout(r2, 100));
  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  if (alive) { try { const st = readFileSync(`/proc/${child.pid}/stat`, 'utf8'); alive = !/\) Z /.test(st); } catch { alive = false; } }
  assert.equal(alive, false, 'the stale writer is dead');
  child.on('error', () => {});
});

test('a deploy submitted by a process that then exits is executed by the runner (real child process)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-deploy-'));
  try {
    const dbPath = join(root, 'proxypilot.db');
    const d0 = new DatabaseSync(dbPath); ensureSetupEngineSchema(d0); d0.close();
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { submitDeployJob } from ${JSON.stringify(`${REPO}admin/backend/src/lib/setup-engine/backend.js`)};
      const d = new DatabaseSync(${JSON.stringify(dbPath)});
      const r = submitDeployJob(d, { app: 'pp-x', params: ${JSON.stringify(PARAMS({ secrets: { configs: [] }, guard: null }))}, requestedBy: 'api-process', via: 'ui' });
      console.log(r.job.id);
      d.close();
      process.exit(0);
    `;
    const submit = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(submit.status, 0, submit.stderr);
    const jobId = submit.stdout.trim();
    const d = new DatabaseSync(dbPath);
    assert.equal(getJob(d, jobId).status, 'queued', 'the submitting process is gone; the job is not');
    const g = deployGuest({ env: '', active: true });
    const out = await runOnce({ db: d, owner: RUNNER, exec: g, nowMs: () => Date.now() });
    assert.equal(out.ran[0].id, jobId);
    assert.equal(out.ran[0].status, 'succeeded');
    assert.equal(getJob(d, jobId).requested_by, 'api-process');
    assert.equal(deployResultFromJob(getJob(d, jobId)).ok, true);
    d.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── the authorization boundary ──────────────────────────────────────────

test('every /api/setup mutation is admin + fresh sudo behind the global CSRF check, audited; the runner accepts only its kinds and validated parameters', () => {
  const routes = readFileSync(`${REPO}admin/backend/src/routes/setup.js`, 'utf8');
  const posts = [...routes.matchAll(/setupRouter\.post\('([^']+)', ([^)]*)\)/g)].map((m) => [m[1], m[2]]);
  assert.ok(posts.length >= 4, `mutations found: ${posts.map((p) => p[0]).join(', ')}`);
  for (const [path, guards] of posts) assert.match(guards, /requireAdmin, requireSudo/, `${path} is admin + sudo`);
  for (const action of ['SETUP_DEPLOY_REQUESTED', 'SETUP_JOB_CANCEL_REQUESTED', 'SETUP_RECOVERY_REQUESTED', 'SETUP_JOB_RETRIED']) assert.ok(routes.includes(action), `${action} audited`);
  const index = readFileSync(`${REPO}admin/backend/src/index.js`, 'utf8');
  assert.ok(index.indexOf("app.use('/api/', csrfProtection)") < index.indexOf("app.use('/api/setup', authenticateToken, blockPendingRole, setupRouter)"), 'CSRF is mounted before the setup routes');
  assert.deepEqual([...RUNNER_JOB_KINDS], ['deploy', 'recover_app', 'verify_app', 'probe', 'restore_db', 'restore_snapshot', 'retry_secrets', 'instance_create', 'instance_start', 'instance_stop', 'instance_restart', 'instance_delete', 'snapshot_create', 'snapshot_delete', 'guest_setup', 'config_set', 'device_add', 'device_remove', 'network_pin', 'forward_apply', 'forward_remove', 'egress_set', 'keycloak_setup', 'pomerium_apply', 'infisical_apply', 'openbao_apply'], 'existing runner verbs plus the accepted G4/G5 and current G6 guided apply kinds; operator secrets are never queued');
  assert(!RUNNER_JOB_KINDS.includes('openbao_operator'), 'transient shares/bootstrap tokens never become runner jobs');
  const executor = readFileSync(`${REPO}admin/backend/src/lib/setup-engine/executor.js`, 'utf8');
  assert.ok(executor.indexOf('validateRunnerJob(job)') < executor.indexOf('acquireLock(db, { app: job.app'), 'validated before the lease is taken');
  const runner = readFileSync(`${REPO}cli/src/setup-runner/runner.js`, 'utf8');
  assert.match(runner, /from '\.\.\/\.\.\/\.\.\/admin\/backend\/src\/lib\/setup-engine\/executor\.js'/, 'the runner runs the shared executor');
});
