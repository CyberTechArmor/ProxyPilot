// Setup engine — the project database restore as ONE operation (A-13),
// executed by the runner (or the backend in-process under backend-allowed)
// under the app's lease, with checkpoints and protected copies.
//
//   inspect   read-only: the dump's identity, format and origin server, the
//             guard rows it carries, the key that will be in force after
//             the restore (the environment copy's or the current one) —
//             read in memory, never recorded
//   bind      the recovery set (bindRecoverySet) and the compatibility
//             verdict (compatibilityVerdict); either failing REFUSES here,
//             before anything is stopped
//   protect   pre-restore dump + environment copy (reused on a retry only
//             when they revalidate by size and sha256)
//   ── checkpoint (disruptive) ──
//   stop      the unit (the writer table's only writer)
//   restore   psql -f, errors counted
//   env       the recovery set's environment put in force (recovery_set mode)
//   start     the unit, health polled
//   → followUp: verify_app (unit, port, health, credential, application check)

import {
  DB_DUMPS_DIR, bindRecoverySet, dumpHeaderVerdict, serverCompatible, parseCopyRows, compatibilityVerdict,
  inspectScript, parseInspect, protectScript, parseProtect, verifyArtifactScript, artifactMatches, restoreScript, parseRestore, swapEnvScript,
} from './restore-logic.js';
import { containedGuest, noopJob, tailOf } from './op-kit.js';
import { unitStatusScript, parseUnitStatus, startUnitScript, parseStartUnit, portProbeScript, parsePortProbe, healthScript, parseHealth, DEFAULT_UNIT, CONTAINMENT_RUN_DIR } from './guest-probes.js';
import { sanitizeReason } from './logic.js';

export function resolveRestoreDbPlan(params = {}) {
  return {
    container: String(params.container || ''),
    dumpsDir: String(params.dumpsDir || DB_DUMPS_DIR),
    dumpName: String(params.dump?.name || ''),
    envCopyName: params.envCopy?.name ? String(params.envCopy.name) : null,
    environmentFile: String(params.environmentFile || '/etc/environment'),
    unit: String(params.unit || DEFAULT_UNIT),
    webPort: Number(params.webPort) || 3000,
    guard: params.guard || null,
    guardKey: params.guardKey || null,
    runDir: String(params.runDir || CONTAINMENT_RUN_DIR),
  };
}

// runRestoreDbOperation({ params, exec, job, originJob, reuse, log }) →
//   { ok: true, step: 'restored', protected, restored, compatibility, errors, followUp }
//   { ok: false, step, error, protected?, restartAttempted?, unitStarted? }
// `originJob` is the job row that recorded the recovery set (resolved by
// the executor from params.envCopy.originJobId, for THIS app); `reuse` the
// artifacts a prior attempt recorded ({ kind, name, where, sha256, bytes }).
export async function runRestoreDbOperation({ params, exec, job = noopJob(), originJob = null, reuse = [], log = () => {} }) {
  const p = resolveRestoreDbPlan(params);
  const { container, unit, environmentFile } = p;
  const { guest, markDisruptive } = containedGuest({ exec, container, job, runDir: p.runDir });
  const report = (key, label) => { try { job.onStep?.(key, label); } catch { /* */ } };
  const mark = (phase, data, message) => { try { job.checkpoint(phase, data, message); } catch { /* */ } };
  const envCopyPath = p.envCopyName ? `/etc/${p.envCopyName}` : null;
  const recovery = { container, unit, webPort: p.webPort, environmentFile, guard: p.guard, protected: null, restore: { dump: `${p.dumpsDir}/${p.dumpName}`, envCopy: envCopyPath } };
  const fail = (step, error, extra = {}) => ({ ok: false, step, error: sanitizeReason(error, 800), recovery, ...extra });

  // 1) bind the recovery set: a job of this app recorded the pair, or none.
  const bind = bindRecoverySet({ app: container, dumpName: p.dumpName, envCopyName: p.envCopyName, originJob });
  if (!bind.ok) return fail('bind', bind.reason);
  mark('inspecting', { app_stopped: false, resumable: true, container, unit, webPort: p.webPort, recovery, mode: bind.mode }, `restore of ${p.dumpName} (${bind.mode}); nothing changed yet`);

  // 2) inspect, read-only.
  report('inspect', 'Reading the dump and the configuration it must match…');
  const ins = parseInspect((await guest('inspect', inspectScript({ dumpsDir: p.dumpsDir, dumpName: p.dumpName, envCopyPath, environmentFile, guard: p.guard, guardKey: p.guardKey, unit }), 60_000)).stdout);
  if (!ins.dump) return fail('inspect', `no such dump in ${container}: ${p.dumpsDir}/${p.dumpName}`);
  if (bind.expectedSha256 && ins.dump.sha256 !== bind.expectedSha256) return fail('bind', `${p.dumpName} is not the file job ${bind.origin} recorded (sha256 differs): the recovery set is broken`);
  const fmt = dumpHeaderVerdict(ins.head);
  if (!fmt.ok) return fail('inspect', `${p.dumpName}: ${fmt.reason}`);
  const srv = serverCompatible(fmt.dumpedFrom, ins.server && !/^(none|nopsql|unknown)$/.test(ins.server) ? ins.server : null);
  if (!srv.ok) return fail('inspect', srv.reason);
  if (ins.server === 'nopsql') return fail('inspect', `psql is not available in ${container}`);
  if (envCopyPath && ins.envCopy !== 'present') return fail('bind', `the environment copy ${envCopyPath} is missing in ${container}`);

  // 3) compatibility: the dump's protected rows under the key that will be in force.
  let compatibility;
  if (!p.guard) compatibility = { mode: 'not_applicable', established: true, detail: 'not applicable: the app has no protected credential rows' };
  else {
    if (!ins.copyPresent) return fail('inspect', `${p.dumpName} carries no COPY block for ${p.guard.schema || 'public'}.${p.guard.table}: only plain COPY-format dumps of this app are supported, so compatibility cannot be established`);
    const rows = parseCopyRows(ins.copyBlock, { secretColumn: p.guard.secret_column, nonceColumn: p.guard.nonce_column });
    if (!rows.found) return fail('inspect', `${p.dumpName}: ${rows.reason}`);
    const key = bind.mode === 'recovery_set' ? ins.keyCopy : ins.keyCurrent;
    const v = compatibilityVerdict({ guard: p.guard, rows: rows.rows, key, legacy: [p.guard.legacy_default] });
    compatibility = { mode: bind.mode, established: v.established, detail: v.detail, rows: v.classification };
    if (!v.established) return fail('compatibility', `compatibility of ${p.dumpName} with the ${bind.mode === 'recovery_set' ? `environment copy ${p.envCopyName}` : 'current configuration'} is NOT established: ${v.detail}. Restore it together with the environment copy of the same recovery set, or not at all`);
  }
  job.event?.('compatibility', compatibility.detail, { mode: compatibility.mode, established: true, rows: compatibility.rows || null });

  // 4) protected copies — reused from a prior attempt only when they revalidate.
  report('protect', 'Taking the pre-restore copies…');
  let prot = null;
  const priorDump = reuse.find((g) => g.kind === 'dump' && g.where === container && g.sha256);
  if (priorDump) {
    const check = artifactMatches((await guest('verify_artifact', verifyArtifactScript(priorDump.name), 30_000)).stdout, { path: priorDump.name, sha256: priorDump.sha256, bytes: priorDump.bytes ?? null });
    if (check.ok) { prot = { dbDump: { path: priorDump.name, bytes: check.bytes, sha256: check.sha256 }, dbDumpNote: null, envCopy: null, envCopyNote: null, reused: true }; job.event?.('reuse', `pre-restore dump ${priorDump.name} from the previous attempt revalidated (sha256 matches) and reused`, { path: priorDump.name }); } else job.event?.('reuse', `pre-restore dump from the previous attempt not reused: ${check.reason}; a new copy is taken`, { path: priorDump.name });
  }
  if (!prot || !prot.envCopy) {
    const fresh = parseProtect((await guest('protect', protectScript(String(job.id || 'adhoc'), { dumpsDir: p.dumpsDir, environmentFile }), 20 * 60_000)).stdout);
    prot = prot ? { ...prot, envCopy: fresh.envCopy, envCopyNote: fresh.envCopyNote } : { ...fresh, reused: false };
    if (!prot.reused && prot.dbDump) job.generated({ kind: 'dump', name: prot.dbDump.path, where: container, sha256: prot.dbDump.sha256, bytes: prot.dbDump.bytes });
  }
  if (!prot.dbDump) return fail('protect', `refusing to restore without a pre-restore dump: ${prot.dbDumpNote || 'capture failed'}`);
  if (!prot.envCopy) return fail('protect', `refusing to restore without a copy of ${environmentFile}: ${prot.envCopyNote || 'copy failed'}`);
  recovery.protected = { dbDump: prot.dbDump, envCopy: prot.envCopy, reused: !!prot.reused };

  // 5) the boundary: nothing above changed the guest; everything below does.
  const wasActive = ins.unitActive === 'active';
  mark('stopping_app', { app_stopped: true, disruptive: true, restore_in_progress: true, container, unit, webPort: p.webPort, recovery }, `stopping ${unit} before the restore; pre-restore dump ${prot.dbDump.path}`);
  markDisruptive();
  report('stop', 'Stopping the application for the restore…');
  const stop = await guest('stop', `systemctl stop ${unit} 2>&1 || true; echo STOPPED\n`, 90_000);
  if (!/STOPPED/.test(stop.stdout || '')) return fail('stop', `could not stop ${unit}: ${tailOf(stop, 300)}`, { restartAttempted: false });

  let envSwapped = false;
  report('restore', `Restoring ${p.dumpName}…`);
  const res = parseRestore((await guest('restore', restoreScript({ dumpsDir: p.dumpsDir, dumpName: p.dumpName }), 30 * 60_000)).stdout);
  mark('restored', { app_stopped: true, disruptive: true, restore_in_progress: false, container, unit, webPort: p.webPort, recovery, restore_rc: res.rc, restore_errors: res.errors }, `psql finished (rc ${res.rc}, ${res.errors} error line(s))`);
  if (res.rc == null || res.rc === 98) {
    return await bringUp('restore', `the dump could not be handed to psql (rc ${res.rc ?? 'none'}); the database is whatever psql left; pre-restore dump ${prot.dbDump.path}`);
  }
  if (bind.mode === 'recovery_set') {
    report('env', 'Putting the recovery set\'s environment in force…');
    const sw = await guest('env_swap', swapEnvScript({ envCopyPath, environmentFile }), 30_000);
    envSwapped = /ENV_SWAPPED:yes/.test(sw.stdout || '');
    if (!envSwapped) return await bringUp('env', `the database was restored but ${envCopyPath} could not be put in force as ${environmentFile}; the app runs under the previous configuration (copy: ${prot.envCopy})`);
  }
  return await bringUp(null, null);

  async function bringUp(failedStep, failedMsg) {
    report('start', 'Starting the application…');
    const st = parseStartUnit((await guest('start_unit', startUnitScript(unit), 120_000)).stdout);
    const started = st.active === 'active';
    mark('started', { app_stopped: !started, disruptive: false, restore_in_progress: false, container, unit, webPort: p.webPort, recovery, unit_swapped: true }, started ? 'unit started after the restore' : 'unit did not start after the restore');
    if (failedStep) return fail(failedStep, `${failedMsg}${started ? '' : `; ${unit} did not start afterwards (rc ${st.rc ?? '?'}, ${st.active || 'unknown'})`}`, { restartAttempted: true, unitStarted: started });
    if (!started) return fail('start', `${unit} did not start after the restore (rc ${st.rc ?? '?'}, ${st.active || 'unknown'}); pre-restore dump ${prot.dbDump.path}, environment copy ${prot.envCopy}`, { restartAttempted: true, unitStarted: false });
    const port = parsePortProbe((await guest('probe_port', portProbeScript(p.webPort), 30_000)).stdout);
    const h = parseHealth((await guest('health', healthScript(p.webPort), 90_000)).stdout);
    const unitNow = parseUnitStatus((await guest('unit_status', unitStatusScript(unit), 30_000)).stdout);
    const result = {
      ok: true, step: 'restored', recovery, protected: recovery.protected,
      restored: { dump: `${p.dumpsDir}/${p.dumpName}`, envCopy: envSwapped ? envCopyPath : null, mode: bind.mode, origin: bind.origin },
      compatibility, errors: res.errors, errorLines: res.errorLines, unitActive: unitNow.isActive, port, health: h,
      wasActive,
      followUp: { kind: 'verify_app', steps: ['unit_status', 'probe_port', 'health_check', 'verify_credential', 'verify_credential_use'], rung: 'credential_use_verified', revision: null },
    };
    log('restore_db', `${container}: restored ${p.dumpName} (${res.errors} error line(s)); unit ${unitNow.isActive ? 'active' : 'inactive'}`);
    return result;
  }
}
