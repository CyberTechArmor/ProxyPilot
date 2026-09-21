// `proxypilot setup-runner` — the independent host runner's command surface.
//
//   proxypilot setup-runner serve        the long-running loop (systemd unit)
//   proxypilot setup-runner once         reconcile + drain the queue, then exit
//   proxypilot setup-runner reconcile    look at dead leases only
//   proxypilot setup-runner status       locks and recent jobs
//
// Root on the host, over the backend's SQLite file — the same locator the
// recovery command uses (src/recovery/install.js). The runner never takes a
// command from a job: it recognises a handful of job kinds and their
// validated parameters, and executes fixed scripts inside the named guest.

import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveInstall } from '../recovery/install.js';
import { ensureSetupEngineSchema, listLocks, listJobs, jobView } from '../../../admin/backend/src/lib/setup-engine/store.js';
import { ownerIdentity } from '../../../admin/backend/src/lib/setup-engine/logic.js';
import { reconcile, runOnce, serve } from '../setup-runner/runner.js';
import { hostReviewLogin } from '../setup-runner/review-login.js';
import * as output from '../output.js';

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, REFUSED: 2, NOT_ROOT: 3 });

async function defaultOpenDb(dbPath) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { fileMustExist: true, timeout: 5000 });
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  return db;
}

// The guest executor: `incus exec <name> -- sh` with the script on stdin,
// and the host channel: one argv array, spawned directly (never a shell
// string — a snapshot restore is `['incus', 'snapshot', 'restore', name,
// snap]`). Root on the host; no nsenter (this is the host).
export function hostGuestExec({ spawnImpl = spawn, incusBin = 'incus' } = {}) {
  return {
    host(argv, { timeoutMs = 120_000 } = {}) {
      return new Promise((resolve) => {
        if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) { resolve({ code: -1, stdout: '', stderr: 'host commands are argv arrays of strings' }); return; }
        let child;
        try { child = spawnImpl(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, stdout: '', stderr: e.message }); return; }
        let stdout = ''; let stderr = ''; let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch { /* */ } resolve({ code: 124, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]` }); } }, timeoutMs);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message }); } });
        child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } });
      });
    },
    guest(container, script, { timeoutMs = 90_000 } = {}) {
      return new Promise((resolve) => {
        const child = spawnImpl(incusBin, ['exec', String(container), '--', 'sh'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch { /* */ } resolve({ code: 124, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs}ms]` }); } }, timeoutMs);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message }); } });
        child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } });
        child.stdin.end(script);
      });
    },
  };
}

function defaultDeps() {
  return {
    openDb: defaultOpenDb,
    getuid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    exec: hostGuestExec(),
    hostname: () => os.hostname(),
    log: (...a) => console.log(`${new Date().toISOString()} setup-runner:`, ...a),
    stdout: (l) => console.log(l),
    fs: undefined,
  };
}

async function open(opts, deps) {
  if (deps.getuid() !== 0) return { error: 'the setup runner must run as root on the ProxyPilot host', code: EXIT.NOT_ROOT };
  const install = resolveInstall({ installDir: opts.installDir, envPath: opts.env, dbPath: opts.db }, deps.fs);
  if (!install.ok) return { error: install.message, code: EXIT.REFUSED };
  const db = await deps.openDb(install.dbPath);
  ensureSetupEngineSchema(db);
  const owner = ownerIdentity({ kind: 'runner', host: deps.hostname(), pid: process.pid, instance: crypto.randomUUID().slice(0, 8) });
  return { db, owner, install };
}

export async function setupRunnerCommand(action, opts = {}, globalOpts = {}, depsIn = {}) {
  const deps = { ...defaultDeps(), ...depsIn };
  const json = !!globalOpts.json;
  let db = null;
  try {
    const o = await open(opts, deps);
    if (o.error) {
      if (json) deps.stdout(JSON.stringify({ ok: false, error: o.error }));
      else output.error(o.error);
      return o.code;
    }
    db = o.db;
    const runDeps = {
      db, owner: o.owner, exec: deps.exec, log: json ? () => {} : deps.log, nowMs: deps.nowMs,
      reviewLogin: deps.reviewLogin || hostReviewLogin({ dbPath: o.install.dbPath, envPath: o.install.envPath, log: json ? () => {} : deps.log }),
    };
    switch (action) {
      case 'serve': {
        await serve(runDeps, { pollMs: Number(opts.pollMs) || 2000, shouldStop: deps.shouldStop || (() => false), sleep: deps.sleep });
        return EXIT.OK;
      }
      case 'once': {
        const r = await runOnce(runDeps, { max: Number(opts.max) || 5 });
        if (json) deps.stdout(JSON.stringify({ ok: true, ...r }, null, 2));
        else {
          output.info(`reconciled: ${JSON.stringify(r.reconciled)}`);
          for (const j of r.ran) output.info(`${j.kind} ${j.app} (${j.id}): ${j.status} — ${j.verification?.label || j.outcome || ''}`);
          if (!r.ran.length) output.info('no queued runner jobs');
        }
        return EXIT.OK;
      }
      case 'reconcile': {
        const r = reconcile({ db, owner: o.owner, nowMs: deps.nowMs ? deps.nowMs() : Date.now(), log: runDeps.log });
        if (json) deps.stdout(JSON.stringify({ ok: true, ...r }, null, 2));
        else output.info(JSON.stringify(r));
        return EXIT.OK;
      }
      case 'status': {
        const now = deps.nowMs ? deps.nowMs() : Date.now();
        const locks = listLocks(db).map((l) => ({ ...l, stale: !l.lease_expires_at || Date.parse(l.lease_expires_at) <= now }));
        const jobs = listJobs(db, { limit: Number(opts.limit) || 20 }).map(jobView);
        if (json) { deps.stdout(JSON.stringify({ ok: true, database: o.install.dbPath, owner: o.owner, locks, jobs }, null, 2)); return EXIT.OK; }
        deps.stdout(`Database: ${o.install.dbPath}`);
        output.table(['APP', 'OWNER', 'OPERATION', 'EPOCH', 'STALE', 'RECOVERY JOB'], locks.map((l) => [l.app, l.owner, l.operation, l.epoch, l.stale ? 'yes' : 'no', l.recovery_job_id || '-']));
        deps.stdout('');
        output.table(['ID', 'KIND', 'APP', 'STATUS', 'PHASE', 'STATE', 'REASON'], jobs.map((j) => [j.id.slice(0, 8), j.kind, j.app, j.status, j.phase || '-', j.verification?.state || '-', (j.reason || '').slice(0, 60)]));
        return EXIT.OK;
      }
      default:
        output.error(`unknown action '${action}' (serve, once, reconcile, status)`);
        return EXIT.REFUSED;
    }
  } catch (e) {
    if (json) deps.stdout(JSON.stringify({ ok: false, error: e.message }));
    else output.error(`setup-runner failed: ${e.message}`);
    return EXIT.ERROR;
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}
