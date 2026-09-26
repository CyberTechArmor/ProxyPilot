// The independent host runner (cli/src/setup-runner/*): the guest probes and
// their parsers, the R4 ladder built from observations, a claimed job
// executed against a scripted guest (start → port → health → credential),
// the fence (a job whose ownership moved stops before touching the target),
// the reconcile of a dead backend's and a dead runner's leases, the deferral
// when another live holder has the app, and the serve loop. All against a
// real SQLite database (node:sqlite).

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  unitStatusScript, parseUnitStatus, startUnitScript, parseStartUnit, portProbeScript, parsePortProbe, healthScript, parseHealth,
  activeKeyScript, credentialProbeScript, credentialVerdict, verificationFromObservations,
} from '../../../../cli/src/setup-runner/probes.js';
import { reconcile, executeJob, runOnce, serve, FencedError } from '../../../../cli/src/setup-runner/runner.js';
import { setupRunnerCommand, hostGuestExec, EXIT } from '../../../../cli/src/commands/setup-runner.js';
import {
  ensureSetupEngineSchema, createJob, startJob, acquireLock, readLock, checkpoint, getJob, listEvents, claimNextJob, takeoverLock, liveRunners,
} from '../lib/setup-engine/store.js';
import { ownerIdentity } from '../lib/setup-engine/logic.js';
import { sweepSetupEngineOnBoot } from '../lib/setup-engine/backend.js';
import { masterKeyFor } from '../mock2/auth-data-logic.js';
import { createCipheriv, randomBytes } from 'node:crypto';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const T0 = Date.parse('2026-09-21T12:00:00.000Z');
const BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const OLD_RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 299, instance: 'oooo' });
const GUARD = { table: 'auth_connections', schema: 'public', secret_column: 'secret_ciphertext', nonce_column: 'secret_nonce', filter: "provider = 'ldaps'", legacy_default: 'dev-insecure-master-secret-change-me' };

function db() {
  const d = new DatabaseSync(':memory:');
  ensureSetupEngineSchema(d);
  return d;
}

// A ciphertext the component's own cipher would write (auth-data-logic decryptUnderMaster).
function encryptUnder(master, plaintext = 'bind-password') {
  const key = masterKeyFor(master);
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return { ciphertext: Buffer.concat([ct, tag]).toString('base64'), nonce: nonce.toString('base64') };
}

// A scripted guest: answers by matching what the script asks for. `state`
// is mutable so a start changes what the next status read sees.
function scriptedGuest(state) {
  const calls = [];
  return {
    calls,
    guest: async (container, script) => {
      calls.push({ container, script });
      if (/STALE_WRITERS:/.test(script)) return { code: 0, stdout: `STALE_WRITERS:${state.survivors ?? 0}\n` };
      if (/UNIT_LOADED/.test(script)) {
        return { code: 0, stdout: `UNIT_LOADED:${state.loaded ? 'yes' : 'no'}\nUNIT_ENABLED:enabled\nUNIT_ACTIVE:${state.active ? 'active' : 'inactive'}\n` };
      }
      if (/START_RC/.test(script)) {
        state.active = state.startWorks !== false;
        return { code: 0, stdout: `START_RC:${state.startWorks === false ? 1 : 0}\nUNIT_ACTIVE:${state.active ? 'active' : 'failed'}\n` };
      }
      if (/PORT_SERVING/.test(script)) {
        return { code: 0, stdout: state.active && state.serves !== false ? 'PORT_SERVING:302\n' : 'PORT_NOT_SERVING:000\n' };
      }
      if (/ROOT:/.test(script) && /HEALTH:/.test(script)) {
        return { code: 0, stdout: `ROOT:${state.rootCode ?? 302}\nHEALTH:${state.healthCode ?? 200}\nLOGIN:200\n` };
      }
      if (/AUTH_MASTER_SECRET/.test(script)) return { code: 0, stdout: `${state.envKey ?? ''}\n` };
      if (/PROBE:/.test(script) || /psql/.test(script)) return { code: 0, stdout: state.probe ?? 'PROBE:ok\nTARGET:127.0.0.1:5432/app schema=public\nRLS:off\n' };
      return { code: 1, stdout: '', stderr: 'unexpected script' };
    },
  };
}

// ── probes ──────────────────────────────────────────────────────────────

test('probe scripts refuse unsafe unit names, ports and env paths, and parse their own markers', () => {
  assert.throws(() => unitStatusScript('evil; rm -rf /'), /not a \.service name/);
  assert.throws(() => portProbeScript(70000), /not a port/);
  assert.throws(() => activeKeyScript('../etc/environment'), /absolute path/);
  assert.throws(() => credentialProbeScript({ table: 'x; drop' }), /data guard is not valid/);
  assert.match(unitStatusScript('mock2-dev.service'), /systemctl is-active 'mock2-dev\.service'/);
  assert.deepEqual(parseUnitStatus('UNIT_LOADED:yes\nUNIT_ENABLED:enabled\nUNIT_ACTIVE:active\n'), { observed: true, loaded: true, enabled: 'enabled', active: 'active', isActive: true });
  assert.deepEqual(parseUnitStatus(''), { observed: false, loaded: null, enabled: null, active: null, isActive: false });
  assert.deepEqual(parseStartUnit('Job failed\nSTART_RC:1\nUNIT_ACTIVE:failed\n'), { observed: true, rc: 1, active: 'failed' });
  assert.match(startUnitScript('mock2-dev.service'), /systemctl start 'mock2-dev\.service'/);
  assert.deepEqual(parsePortProbe('PORT_SERVING:302\n'), { observed: true, responding: true, code: 302 });
  assert.deepEqual(parsePortProbe('PORT_NOT_SERVING:000\n'), { observed: true, responding: false, code: 0 });
  assert.deepEqual(parsePortProbe('garbage'), { observed: false, responding: null, code: null });
  assert.match(portProbeScript(3000), /http:\/\/127\.0\.0\.1:3000\//);
  assert.match(healthScript(3000), /\/api\/health/);
  assert.equal(parseHealth('ROOT:302\nHEALTH:200\nLOGIN:200\n').healthy, true);
  assert.equal(parseHealth('ROOT:200\nHEALTH:404\nLOGIN:404\n').healthy, true, 'no health endpoint and no auth is still healthy');
  assert.equal(parseHealth('ROOT:200\nHEALTH:404\nLOGIN:404\n').hasAuth, false);
  const sick = parseHealth('ROOT:500\nHEALTH:503\nLOGIN:200\n');
  assert.equal(sick.healthy, false);
  assert.match(sick.why, /root answered 500; \/api\/health answered 503/);
  assert.equal(parseHealth('').observed, false);
  assert.match(activeKeyScript('/etc/environment'), /AUTH_MASTER_SECRET/);
  const cred = credentialProbeScript(GUARD);
  assert.match(cred, /public\.auth_connections/);
  assert.match(cred, /PGPASSFILE/);
});

test('credentialVerdict follows the gate-one MASTERKEY_ROWS codes and never returns the key', () => {
  const key = 'a-real-master-secret-value';
  const rowOk = encryptUnder(key);
  const rowDev = encryptUnder('dev-insecure-master-secret-change-me');
  const probe = (rows) => `PROBE:ok\nTARGET:127.0.0.1:5432/app schema=public\nRLS:off\n${rows.map((r) => `ROW:${r.ciphertext}|${r.nonce}`).join('\n')}\n`;
  const ok = credentialVerdict({ guard: GUARD, envKey: key, probeStdout: probe([rowOk]) });
  assert.equal(ok.verified, true);
  assert.equal(ok.code, 200);
  assert.equal(ok.keyState, 'set');
  assert.equal(JSON.stringify(ok).includes(key), false);
  const bad = credentialVerdict({ guard: GUARD, envKey: key, probeStdout: probe([rowOk, rowDev]) });
  assert.equal(bad.verified, false);
  assert.equal(bad.code, 404);
  const empty = credentialVerdict({ guard: GUARD, envKey: key, probeStdout: 'PROBE:ok\nTARGET:x\nRLS:off\n' });
  assert.equal(empty.verified, true);
  assert.equal(empty.code, 204);
  assert.equal(empty.vacuous, true);
  const rls = credentialVerdict({ guard: GUARD, envKey: key, probeStdout: 'PROBE:rls\nRLS:on\n' });
  assert.equal(rls.verified, null);
  assert.equal(rls.code, 500);
  const devKey = credentialVerdict({ guard: GUARD, envKey: '', probeStdout: probe([rowDev]) });
  assert.equal(devKey.verified, true, 'under the development default every row decrypts — verified, and keyState says which key that is');
  assert.equal(devKey.keyState, 'unset');
  assert.equal(credentialVerdict({ guard: null }).verified, null);
});

test('verificationFromObservations climbs the ladder only as far as what was observed, and a port answering after an inactive status read is the port\'s call', () => {
  const unit = parseUnitStatus('UNIT_LOADED:yes\nUNIT_ENABLED:enabled\nUNIT_ACTIVE:inactive\n');
  const port = parsePortProbe('PORT_SERVING:302\n');
  const v = verificationFromObservations({ unit, port });
  assert.equal(v.state, 'port_responding');
  assert.equal(v.facts.unitActive, true);
  const healthy = verificationFromObservations({ unit, port, health: parseHealth('ROOT:200\nHEALTH:200\nLOGIN:200\n') });
  assert.equal(healthy.state, 'app_healthy');
  const full = verificationFromObservations({ unit, port, health: parseHealth('ROOT:200\nHEALTH:200\nLOGIN:200\n'), credential: { verified: true, code: 200, detail: 'x' } });
  assert.equal(full.state, 'credential_decryptable');
  const down = verificationFromObservations({ unit, port: parsePortProbe('PORT_NOT_SERVING:000\n') });
  assert.equal(down.state, 'recovery_required');
  assert.equal(down.failedAt, 'port_responding');
  const noGuard = verificationFromObservations({ unit, port, health: parseHealth('ROOT:200\nHEALTH:200\nLOGIN:200\n'), credential: { verified: null, code: null, detail: 'no data guard recorded' } });
  assert.equal(noGuard.state, 'app_healthy');
  assert.match(noGuard.next, /no data guard recorded/);
  assert.equal(verificationFromObservations({ unit: parseUnitStatus('UNIT_LOADED:no\nUNIT_ENABLED:unknown\nUNIT_ACTIVE:unknown\n') }).state, 'recovery_required');
});

// ── executeJob ──────────────────────────────────────────────────────────

function queuedRecovery(d, { guard = GUARD, kind = 'recover_app', origin = null } = {}) {
  return createJob(d, { kind, app: 'pp-x', plan: { steps: kind === 'recover_app' ? ['start_unit', 'probe_port', 'health_check', 'verify_credential'] : ['unit_status', 'probe_port', 'health_check', 'verify_credential'], params: { container: 'pp-x', webPort: 3000, unit: 'mock2-dev.service', guard, environmentFile: '/etc/environment', origin } }, requestedBy: 'alice', via: 'ui', nowMs: T0 });
}

test('executeJob recover_app: starts the stopped unit, probes, verifies the credential, records credential_decryptable and releases the lease', async () => {
  const d = db();
  const key = 'a-real-master-secret-value';
  const row = encryptUnder(key);
  const state = { loaded: true, active: false, envKey: key, probe: `PROBE:ok\nTARGET:127.0.0.1:5432/app schema=public\nRLS:off\nROW:${row.ciphertext}|${row.nonce}\n` };
  const g = scriptedGuest(state);
  const job = queuedRecovery(d);
  const claimed = claimNextJob(d, { owner: RUNNER, kinds: ['recover_app'], nowMs: T0 });
  const r = await executeJob(claimed, { db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 1000 });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.verification.state, 'credential_decryptable');
  assert.ok(g.calls.some((c) => /systemctl start/.test(c.script)), 'the unit was started');
  assert.ok(g.calls.every((c) => c.container === 'pp-x'));
  const row2 = getJob(d, job.id);
  assert.equal(row2.status, 'succeeded');
  assert.equal(row2.outcome, 'credential_decryptable');
  assert.match(row2.reason, /decrypts under the configured key/);
  const ver = JSON.parse(row2.verification_json);
  assert.equal(ver.observations.credential.code, 200);
  assert.equal(JSON.stringify(row2).includes(key), false, 'the active key never lands in the row');
  assert.equal(listEvents(d, job.id).some((e) => e.data_json && e.data_json.includes(key)), false);
  assert.equal(readLock(d, 'pp-x'), null, 'lease released');
  const phases = listEvents(d, job.id).filter((e) => e.kind === 'checkpoint').map((e) => e.phase);
  assert.deepEqual(phases, ['reap_previous_writer', 'unit_status', 'start_unit', 'probe_port', 'health_check', 'read_active_key', 'verify_credential']);
});

test('executeJob: a port that never answers is recovery_required with the procedure, never "recovered"; an unhealthy app likewise; a mismatched key is recovery_required at the credential rung', async () => {
  const d = db();
  const cases = [
    [{ loaded: true, active: false, startWorks: false, serves: false }, 'not_serving', 'port_responding', /journalctl/],
    [{ loaded: true, active: true, rootCode: 500 }, 'unhealthy', 'app_healthy', /read its log/],
    [{ loaded: true, active: true, envKey: 'wrong-key-value', probe: `PROBE:ok\nTARGET:x\nRLS:off\nROW:${encryptUnder('right-key').ciphertext}|${encryptUnder('right-key').nonce}\n` }, 'recovery_required', 'credential_decryptable', /recovery set/],
    [{ loaded: false }, 'unit_missing', 'configured', /redeploy/],
  ];
  for (const [state, outcome, failedAt, next] of cases) {
    queuedRecovery(d);
    const claimed = claimNextJob(d, { owner: RUNNER, kinds: ['recover_app'], nowMs: T0 });
    const r = await executeJob(claimed, { db: d, owner: RUNNER, exec: scriptedGuest(state), nowMs: () => T0 });
    assert.equal(r.status, 'recovery_required', outcome);
    assert.equal(r.verification.state, 'recovery_required');
    assert.equal(r.verification.failedAt, failedAt, outcome);
    assert.match(r.verification.next, next);
    const row = getJob(d, claimed.id);
    assert.equal(row.status, 'recovery_required');
    if (outcome !== 'recovery_required') assert.equal(row.outcome, outcome);
    assert.equal(readLock(d, 'pp-x'), null);
  }
});

test('executeJob: no data guard → app_healthy with the deferral named; verify_app never starts the unit; a refused job kind or a plan with a command is refused before any guest command', async () => {
  const d = db();
  queuedRecovery(d, { guard: null, kind: 'verify_app' });
  const g = scriptedGuest({ loaded: true, active: true });
  const claimed = claimNextJob(d, { owner: RUNNER, kinds: ['verify_app'], nowMs: T0 });
  const r = await executeJob(claimed, { db: d, owner: RUNNER, exec: g, nowMs: () => T0 });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.verification.state, 'app_healthy');
  assert.match(r.verification.next, /no data guard recorded/);
  assert.equal(g.calls.some((c) => /systemctl start/.test(c.script)), false);

  const bad = createJob(d, { kind: 'recover_app', app: 'pp-y', plan: { params: { container: 'pp-y', command: 'rm -rf /' } }, nowMs: T0 });
  const c2 = claimNextJob(d, { owner: RUNNER, kinds: ['recover_app'], nowMs: T0 });
  const g2 = scriptedGuest({ loaded: true, active: true });
  const r2 = await executeJob(c2, { db: d, owner: RUNNER, exec: g2, nowMs: () => T0 });
  assert.equal(r2.status, 'refused');
  assert.equal(g2.calls.length, 0, 'nothing ran in the guest');
  assert.equal(getJob(d, bad.id).status, 'refused');
});

test('executeJob: a live foreign lease defers the job; a dead backend\'s lease is taken over (epoch bumped) and the origin job gets the result', async () => {
  const d = db();
  // Live: the backend is deploying pp-x right now.
  acquireLock(d, { app: 'pp-x', owner: BACKEND, operation: 'deploy', leaseMs: 60_000, nowMs: T0 });
  queuedRecovery(d);
  let claimed = claimNextJob(d, { owner: RUNNER, kinds: ['recover_app'], nowMs: T0 });
  const g = scriptedGuest({ loaded: true, active: true });
  let r = await executeJob(claimed, { db: d, owner: RUNNER, exec: g, nowMs: () => T0 + 1 });
  assert.equal(r.status, 'deferred');
  assert.equal(g.calls.length, 0);
  assert.match(getJob(d, claimed.id).reason, /held by backend@pp#100:aaaa \(deploy\)/);
  assert.equal(readLock(d, 'pp-x').owner, BACKEND, 'the live lease is untouched');

  // Dead: the same lease, expired — the case a recovery exists for.
  const origin = createJob(d, { kind: 'deploy', app: 'pp-x', nowMs: T0 });
  startJob(d, { id: origin.id, owner: BACKEND, nowMs: T0 });
  queuedRecovery(d, { origin: { jobId: origin.id, kind: 'deploy', phase: 'stopping_app' } });
  claimed = claimNextJob(d, { owner: RUNNER, kinds: ['recover_app'], nowMs: T0 + 120_000 });
  r = await executeJob(claimed, { db: d, owner: RUNNER, exec: scriptedGuest({ loaded: true, active: false, envKey: '', probe: 'PROBE:ok\nTARGET:x\nRLS:off\n' }), nowMs: () => T0 + 120_000 });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.verification.state, 'credential_decryptable');
  assert.equal(readLock(d, 'pp-x'), null, 'the taken-over lease is released when done');
  const ev = listEvents(d, claimed.id);
  const takeover = ev.find((e) => e.kind === 'lock_takeover');
  assert.ok(takeover);
  assert.equal(JSON.parse(takeover.data_json).previous_owner, BACKEND);
  assert.equal(JSON.parse(takeover.data_json).epoch, 2);
  const onOrigin = listEvents(d, origin.id).find((e) => e.kind === 'recovery_result');
  assert.ok(onOrigin);
  assert.match(onOrigin.message, /succeeded/);
});

test('executeJob: the fence — when ownership moves mid-run, the runner stops before the next guest command and writes nothing more', async () => {
  const d = db();
  queuedRecovery(d);
  const claimed = claimNextJob(d, { owner: RUNNER, kinds: ['recover_app'], nowMs: T0 });
  const state = { loaded: true, active: false };
  const g = scriptedGuest(state);
  let n = 0;
  const exec = {
    guest: async (...a) => {
      n += 1;
      if (n === 2) {
        // Another runner reclaimed the job (its lease had lapsed): epoch moves.
        d.prepare(`UPDATE setup_jobs SET owner = ?, epoch = epoch + 1 WHERE id = ?`).run(OLD_RUNNER, claimed.id);
      }
      return g.guest(...a);
    },
  };
  const r = await executeJob(claimed, { db: d, owner: RUNNER, exec, nowMs: () => T0 });
  assert.equal(r.status, 'fenced');
  assert.equal(n, 2, 'the third guest command never ran');
  const row = getJob(d, claimed.id);
  assert.equal(row.status, 'running', 'the job is the new owner\'s now; the fenced runner did not finish it');
  assert.equal(row.owner, OLD_RUNNER);
  assert.equal(readLock(d, 'pp-x'), null, 'its own lease (epoch 1) was released');
});

// ── reconcile ───────────────────────────────────────────────────────────

test('reconcile: a dead backend that stopped an app gets a recovery job and a stale, kept lease; one that had not gets interrupted and released; a dead runner\'s resumable job is requeued and then runs', async () => {
  const d = db();
  // dead deploy, app stopped
  const stopped = createJob(d, { kind: 'deploy', app: 'pp-a', configRefs: { webPort: 4000, guard: GUARD }, nowMs: T0 });
  startJob(d, { id: stopped.id, owner: BACKEND, leaseMs: 1000, nowMs: T0 });
  acquireLock(d, { app: 'pp-a', owner: BACKEND, operation: 'deploy', jobId: stopped.id, leaseMs: 1000, nowMs: T0 });
  checkpoint(d, { id: stopped.id, owner: BACKEND, epoch: 1, phase: 'stopping_app', checkpoint: { app_stopped: true, container: 'pp-a', webPort: 4000, unit: 'mock2-dev.service', disruptive: true }, nowMs: T0 });
  // dead deploy, nothing disruptive
  const clean = createJob(d, { kind: 'deploy', app: 'pp-b', nowMs: T0 });
  startJob(d, { id: clean.id, owner: BACKEND, leaseMs: 1000, nowMs: T0 });
  acquireLock(d, { app: 'pp-b', owner: BACKEND, operation: 'deploy', jobId: clean.id, leaseMs: 1000, nowMs: T0 });
  // dead runner, resumable
  const mine = createJob(d, { kind: 'verify_app', app: 'pp-c', plan: { steps: ['unit_status', 'probe_port'], params: { container: 'pp-c', webPort: 3000 } }, nowMs: T0 });
  claimNextJob(d, { owner: OLD_RUNNER, kinds: ['verify_app'], leaseMs: 1000, nowMs: T0 });
  checkpoint(d, { id: mine.id, owner: OLD_RUNNER, epoch: 1, phase: 'probe_port', checkpoint: { resumable: true }, nowMs: T0 });

  const s = reconcile({ db: d, owner: RUNNER, nowMs: T0 + 60_000 });
  assert.deepEqual(s.interrupted, [clean.id]);
  assert.deepEqual(s.requeued, [mine.id]);
  assert.equal(s.recoveryQueued.length, 1);
  assert.equal(s.recoveryQueued[0].job, stopped.id);
  assert.equal(getJob(d, stopped.id).status, 'recovery_required');
  assert.equal(getJob(d, clean.id).status, 'failed');
  assert.equal(getJob(d, mine.id).status, 'queued');
  assert.equal(readLock(d, 'pp-b'), null);
  assert.equal(readLock(d, 'pp-c'), null);
  const la = readLock(d, 'pp-a');
  assert.equal(la.owner, BACKEND);
  assert.ok(la.stale_since);
  const rec = getJob(d, s.recoveryQueued[0].recovery);
  assert.equal(rec.kind, 'recover_app');
  assert.deepEqual(JSON.parse(rec.plan_json).params.guard, GUARD, 'the guard reference travels to the recovery');
  // Idempotent.
  assert.deepEqual(reconcile({ db: d, owner: RUNNER, nowMs: T0 + 61_000 }), { requeued: [], interrupted: [], recoveryQueued: [], skipped: [] });

  // The loop now runs both queued jobs: the recovery (taking over pp-a's stale lease) and the requeued verify.
  const guests = { 'pp-a': scriptedGuest({ loaded: true, active: false, envKey: '', probe: 'PROBE:ok\nTARGET:x\nRLS:off\n' }), 'pp-c': scriptedGuest({ loaded: true, active: true }) };
  const exec = { guest: (c, s2, o) => guests[c].guest(c, s2, o) };
  const out = await runOnce({ db: d, owner: RUNNER, exec, nowMs: () => T0 + 62_000 }, { reconcileFirst: false });
  // Three: the recovery, the requeued verify, and the application-owned
  // check the recovery queues for the deploy it brought up.
  assert.equal(out.ran.length, 3);
  assert.equal(out.ran.filter((j) => j.kind === 'verify_app').length, 2);
  const recRun = out.ran.find((j) => j.kind === 'recover_app');
  assert.equal(recRun.status, 'succeeded');
  assert.equal(recRun.verification.state, 'credential_decryptable');
  assert.ok(guests['pp-a'].calls.some((c) => /systemctl start/.test(c.script)), 'pp-a was started');
  assert.equal(readLock(d, 'pp-a'), null, 'the stale lease is gone once recovery finished');
  const ver = out.ran.find((j) => j.kind === 'verify_app');
  assert.equal(ver.status, 'succeeded');
  assert.equal(ver.verification.state, 'port_responding', 'a two-step plan proves only the port');
  // A new deploy on pp-a is possible again.
  assert.equal(acquireLock(d, { app: 'pp-a', owner: BACKEND, operation: 'deploy', nowMs: T0 + 63_000 }).ok, true);
});

test('the backend boot sweep and the runner reconcile agree: a sweep-queued recovery is what the runner executes, once', async () => {
  const d = db();
  const stopped = createJob(d, { kind: 'deploy', app: 'pp-a', configRefs: { webPort: 4000 }, nowMs: T0 });
  startJob(d, { id: stopped.id, owner: BACKEND, leaseMs: 1000, nowMs: T0 });
  acquireLock(d, { app: 'pp-a', owner: BACKEND, operation: 'deploy', jobId: stopped.id, leaseMs: 1000, nowMs: T0 });
  checkpoint(d, { id: stopped.id, owner: BACKEND, epoch: 1, phase: 'stopping_app', checkpoint: { app_stopped: true, container: 'pp-a', webPort: 4000, disruptive: true }, nowMs: T0 });
  const successor = ownerIdentity({ kind: 'backend', host: 'pp', pid: 101, instance: 'bbbb' });
  const swept = sweepSetupEngineOnBoot(d, { owner: successor, nowMs: T0 + 60_000 });
  assert.equal(swept.recoveryQueued.length, 1);
  assert.deepEqual(reconcile({ db: d, owner: RUNNER, nowMs: T0 + 61_000 }), { requeued: [], interrupted: [], recoveryQueued: [], skipped: [] }, 'nothing more to queue');
  const out = await runOnce({ db: d, owner: RUNNER, exec: scriptedGuest({ loaded: true, active: false }), nowMs: () => T0 + 62_000 });
  assert.equal(out.ran.length, 1);
  assert.equal(out.ran[0].id, swept.recoveryQueued[0].recovery);
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM setup_jobs WHERE kind = 'recover_app'`).get().n, 1);
});

test('serve: reconciles on start, drains the queue each tick, stops when asked', async () => {
  const d = db();
  queuedRecovery(d, { guard: null });
  let ticks = 0;
  const out = [];
  await serve({ db: d, owner: RUNNER, exec: scriptedGuest({ loaded: true, active: true }), nowMs: () => T0 + ticks * 1000, log: (...a) => out.push(a.join(' ')) }, { pollMs: 1, shouldStop: () => ticks >= 3, sleep: async () => { ticks += 1; } });
  assert.equal(ticks, 3);
  assert.equal(d.prepare(`SELECT status FROM setup_jobs`).get().status, 'succeeded');
  assert.ok(out.some((l) => /claimed/.test(l)));
  assert.ok(out.some((l) => /stopping/.test(l)));
});

test('serve keeps a fresh runner heartbeat while a tick is awaiting work', async () => {
  const d = db();
  let now = T0;
  let stop = false;
  let releaseSleep;
  let enteredSleep;
  const sleeping = new Promise((resolve) => { enteredSleep = resolve; });
  const running = serve({ db: d, owner: RUNNER, exec: scriptedGuest({ loaded: true, active: true }), nowMs: () => now }, {
    heartbeatEveryMs: 5,
    shouldStop: () => stop,
    sleep: () => {
      now = T0 + 31_000;
      enteredSleep();
      return new Promise((resolve) => { releaseSleep = resolve; });
    },
  });
  try {
    await sleeping;
    for (let i = 0; i < 20 && !liveRunners(d, { nowMs: now }).length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(liveRunners(d, { nowMs: now }).length, 1, 'the runner stays live beyond the 30-second deadline while awaiting work');
  } finally {
    stop = true;
    releaseSleep?.();
    await running;
    d.close();
  }
});

// ── the command ─────────────────────────────────────────────────────────

test('setup-runner command: root only; once/reconcile/status over the file-backed database', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'pp-runner-'));
  const previousKey = process.env.TOTP_ENCRYPTION_KEY;
  delete process.env.TOTP_ENCRYPTION_KEY;
  try {
    mkdirSync(join(root, 'data', 'db'), { recursive: true });
    const dbPath = join(root, 'data', 'db', 'proxypilot.db');
    const d0 = new DatabaseSync(dbPath); ensureSetupEngineSchema(d0);
    createJob(d0, { kind: 'verify_app', app: 'pp-x', plan: { steps: ['unit_status', 'probe_port'], params: { container: 'pp-x', webPort: 3000 } }, nowMs: T0 });
    d0.close();
    writeFileSync(join(root, '.env'), `DATABASE_PATH=/data/db/proxypilot.db\nTOTP_ENCRYPTION_KEY=${'e'.repeat(64)}\n`);
    const lines = [];
    const deps = { openDb: async (p) => new DatabaseSync(p), getuid: () => 0, hostname: () => 'pp', exec: scriptedGuest({ loaded: true, active: true }), stdout: (l) => lines.push(l), log: () => {}, nowMs: () => T0 + 5000 };
    assert.equal(await setupRunnerCommand('once', { installDir: root }, { json: true }, { ...deps, getuid: () => 1000 }), EXIT.NOT_ROOT);
    assert.equal(await setupRunnerCommand('once', { installDir: root }, { json: true }, deps), EXIT.OK);
    const once = JSON.parse(lines.at(-1));
    assert.equal(once.ran.length, 1);
    assert.equal(once.ran[0].status, 'succeeded');
    assert.equal(await setupRunnerCommand('reconcile', { installDir: root }, { json: true }, deps), EXIT.OK);
    assert.equal(await setupRunnerCommand('status', { installDir: root }, { json: true }, deps), EXIT.OK);
    const st = JSON.parse(lines.at(-1));
    assert.equal(st.jobs[0].status, 'succeeded');
    assert.match(st.owner, /^runner@pp#/);
    assert.equal(await setupRunnerCommand('status', { installDir: root }, {}, deps), EXIT.OK);
    assert.equal(await setupRunnerCommand('bogus', { installDir: root }, {}, deps), EXIT.REFUSED);
    assert.equal(await setupRunnerCommand('once', { installDir: join(root, 'nope') }, { json: true }, deps), EXIT.REFUSED);
  } finally {
    if (previousKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
    else process.env.TOTP_ENCRYPTION_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('hostGuestExec runs `incus exec <guest> -- sh` with the script on stdin and bounds it with a timeout', async () => {
  const seen = [];
  const fakeSpawn = (bin, args, opts) => {
    seen.push({ bin, args, opts });
    const { EventEmitter } = require_events();
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    let input = '';
    child.stdin = { end: (s) => { input = s; setTimeout(() => { child.stdout.emit('data', `got:${input.length}\n`); child.emit('close', 0); }, 5); } };
    child.kill = () => {};
    return child;
  };
  const exec = hostGuestExec({ spawnImpl: fakeSpawn, incusBin: 'incus' });
  const r = await exec.guest('pp-x', 'echo hi\n', { timeoutMs: 1000 });
  assert.deepEqual(seen[0].args, ['exec', 'pp-x', '--', 'sh']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'got:8\n');
  const slowSpawn = () => { const { EventEmitter } = require_events(); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { end() {} }; c.kill = () => {}; return c; };
  const slow = await hostGuestExec({ spawnImpl: slowSpawn }).guest('pp-x', 'sleep', { timeoutMs: 20 });
  assert.equal(slow.code, 124);
  assert.match(slow.stderr, /timeout/);
});

function require_events() { return { EventEmitter: EventEmitterCtor }; }
import { EventEmitter as EventEmitterCtor } from 'node:events';

// ── install wiring ──────────────────────────────────────────────────────

test('the unit runs the installed CLI as root with Restart=always, and install.sh / update.sh install and enable it', () => {
  const unit = readFileSync(`${REPO}deploy/proxypilot-setup-runner.service`, 'utf8');
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/proxypilot setup-runner serve/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.doesNotMatch(unit, /^User=/m, 'root: it starts units inside guests through incus');
  const install = readFileSync(`${REPO}install.sh`, 'utf8');
  assert.match(install, /deploy\/proxypilot-setup-runner\.service" \/etc\/systemd\/system\/proxypilot-setup-runner\.service/);
  assert.match(install, /systemctl enable proxypilot-setup-runner\.service/);
  const update = readFileSync(`${REPO}update.sh`, 'utf8').replace(/\r\n/g, '\n');
  assert.match(update, /install_setup_runner\(\) \{/);
  const readiness = update.indexOf('\n        install_setup_runner\n', update.indexOf('# Restart\n'));
  assert.ok(readiness > update.indexOf('install_setup_runner() {'), 'defined before the update reaches readiness (recovery also calls it)');
  assert.ok(readiness > update.indexOf('chmod 0755 /usr/local/bin/proxypilot'), 'called after the CLI wrapper exists');
});
