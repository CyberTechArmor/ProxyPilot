// Setup engine — the container snapshot restore as ONE operation (A-14),
// over the HOST executor (argv arrays to `incus`, never a shell string):
//
//   query     `incus list <name> --format json`: the snapshot exists, what
//             the instance snapshot covers (root disk) and what it does not
//             (custom volumes) — refused unless a partial restore was
//             accepted by name
//   protect   the pre-restore snapshot, identified by name AND created_at
//             (a retry reuses a recorded one only when both still match)
//   ── checkpoint (disruptive) ──
//   restore   `incus snapshot restore <name> <snap>`
//   after     the guest is running again if it was before; a managed app
//             gets the full verification ladder as a follow-up
//
// Every coordination record (checkpoints, the pre-restore snapshot's
// identity, the outcome) lives in the engine's own database on the host,
// outside the guest being restored.

import { snapshotArgv, isSnapshotCliShapeError, SNAPSHOT_CLI_SUBCOMMAND, SNAPSHOT_CLI_LEGACY } from '../mcp-logic.js';
import { parseInstanceList, snapshotPlanVerdict } from './restore-logic.js';
import { hostArgv, noopJob, tailOf } from './op-kit.js';
import { sanitizeReason } from './logic.js';

export function resolveRestoreSnapshotPlan(params = {}) {
  return {
    container: String(params.container || ''),
    snapshot: String(params.snapshot || ''),
    acceptPartial: params.acceptPartial === true,
    webPort: params.webPort != null ? Number(params.webPort) : null,
    unit: params.unit ? String(params.unit) : null,
    guard: params.guard || null,
    managed: params.managed === true,
    preRestorePrefix: String(params.preRestorePrefix || 'pp-pre-restore'),
  };
}

// createSnapshotWithFallback(host, name, snap) → { ok, form } | { ok: false, error }
// The CLI form (subcommand vs legacy) is discovered by the client's own
// answer, as routes/mcp.js does; every other failure is returned as itself.
export async function createSnapshotWithFallback(host, name, snap, { form = SNAPSHOT_CLI_SUBCOMMAND, timeoutMs = 120_000 } = {}) {
  let r = await host(['incus', ...snapshotArgv('create', name, snap, form)], { timeoutMs });
  if (r.code !== 0 && isSnapshotCliShapeError(r.stderr)) {
    const other = form === SNAPSHOT_CLI_SUBCOMMAND ? SNAPSHOT_CLI_LEGACY : SNAPSHOT_CLI_SUBCOMMAND;
    const retry = await host(['incus', ...snapshotArgv('create', name, snap, other)], { timeoutMs });
    if (retry.code === 0) return { ok: true, form: other };
    r = isSnapshotCliShapeError(retry.stderr) ? r : retry;
  }
  if (r.code !== 0) return { ok: false, error: tailOf(r, 300) || 'unknown error' };
  return { ok: true, form };
}

// runRestoreSnapshotOperation({ params, exec, job, reuse, log }) →
//   { ok: true, step: 'restored', preRestore, restoredTo, coverage, partial, status, followUp }
//   { ok: false, step, error, ... }
export async function runRestoreSnapshotOperation({ params, exec, job = noopJob(), reuse = [], log = () => {} }) {
  const p = resolveRestoreSnapshotPlan(params);
  const host = hostArgv(exec);
  if (!host) return { ok: false, step: 'executor', error: 'this executor offers no host command channel; a snapshot restore needs the host runner' };
  const report = (key, label) => { try { job.onStep?.(key, label); } catch { /* */ } };
  const mark = (phase, data, message) => { try { job.checkpoint(phase, data, message); } catch { /* */ } };
  const fail = (step, error, extra = {}) => ({ ok: false, step, error: sanitizeReason(error, 800), ...extra });
  const list = async () => {
    const r = await host(['incus', 'list', p.container, '--format', 'json'], { timeoutMs: 30_000 });
    if (r.code !== 0) return { error: `incus list failed: ${tailOf(r, 300)}` };
    return { instance: parseInstanceList(r.stdout, p.container) };
  };

  // 1) query and validate before anything.
  job.fence({ safe: true });
  report('query', 'Reading the guest and its snapshots…');
  const q = await list();
  if (q.error) return fail('query', q.error);
  const verdict = snapshotPlanVerdict({ instance: q.instance, snapshot: p.snapshot, acceptPartial: p.acceptPartial });
  if (!verdict.ok) return fail('coverage', verdict.reason, { coverage: verdict.coverage || null });
  const wasRunning = String(q.instance.status || '').toLowerCase() === 'running';
  const recovery = { container: p.container, restoredTo: p.snapshot, coverage: verdict.coverage, partial: verdict.partial, wasRunning, preRestore: null };
  mark('validated', { app_stopped: false, resumable: true, container: p.container, unit: p.unit || undefined, webPort: p.webPort || undefined, recovery }, `restore to ${p.snapshot} (${verdict.target.created_at || 'no timestamp'}) validated; ${verdict.reason}`);

  // 2) the pre-restore snapshot: reused only when name AND created_at still match.
  report('protect', 'Taking the pre-restore snapshot…');
  let pre = null;
  const prior = reuse.find((g) => g.kind === 'snapshot' && g.where === p.container && g.name);
  if (prior) {
    const found = (q.instance.snapshots || []).find((s) => s && s.name === prior.name);
    if (found && (!prior.created_at || found.created_at === prior.created_at)) { pre = { name: found.name, created_at: found.created_at || null, reused: true }; job.event?.('reuse', `pre-restore snapshot ${found.name} from the previous attempt still exists with its recorded timestamp and is reused`, { name: found.name }); }
    else job.event?.('reuse', `pre-restore snapshot ${prior.name} from the previous attempt ${found ? 'has a different timestamp' : 'is gone'}; a new one is taken`, { name: prior.name });
  }
  if (!pre) {
    const name = `${p.preRestorePrefix}-${String(job.id || 'adhoc').slice(0, 8)}-${Date.now().toString(36)}`;
    const c = await createSnapshotWithFallback(host, p.container, name);
    if (!c.ok) return fail('protect', `refusing to restore without a pre-restore snapshot: ${c.error}`);
    const again = await list();
    const found = again.instance && (again.instance.snapshots || []).find((s) => s && s.name === name);
    if (!found) return fail('protect', `the pre-restore snapshot ${name} was reported created but is not on the instance; refusing to continue`);
    pre = { name, created_at: found.created_at || null, reused: false };
    job.generated({ kind: 'snapshot', name, where: p.container, created_at: pre.created_at });
  }
  recovery.preRestore = pre;

  // 3) the boundary.
  mark('restoring', { app_stopped: true, disruptive: true, container: p.container, unit: p.unit || undefined, webPort: p.webPort || undefined, recovery }, `restoring ${p.container} to ${p.snapshot}; pre-restore snapshot ${pre.name}`);
  job.fence({ safe: false });
  report('restore', `Restoring ${p.container} to ${p.snapshot}…`);
  const r = await host(['incus', ...snapshotArgv('restore', p.container, p.snapshot)], { timeoutMs: 10 * 60_000 });
  if (r.code !== 0) {
    const after = await list();
    return fail('restore', `incus snapshot restore failed: ${tailOf(r, 300) || 'unknown error'} (pre-restore snapshot ${pre.name} exists)`, { restartAttempted: true, unitStarted: false, status: after.instance?.status || null, preRestore: pre });
  }

  // 4) after: running again if it was before.
  const after = await list();
  let status = after.instance?.status || null;
  if (wasRunning && String(status || '').toLowerCase() !== 'running') {
    const s = await host(['incus', 'start', p.container], { timeoutMs: 120_000 });
    const again = await list();
    status = again.instance?.status || status;
    if (s.code !== 0 || String(status || '').toLowerCase() !== 'running') return fail('start', `${p.container} was restored to ${p.snapshot} but did not start again: ${tailOf(s, 300)}`, { restartAttempted: true, unitStarted: false, status, preRestore: pre });
  }
  mark('restored', { app_stopped: false, disruptive: false, unit_swapped: !!p.managed, container: p.container, unit: p.unit || undefined, webPort: p.webPort || undefined, recovery }, `restored to ${p.snapshot}; guest ${status}`);
  log('restore_snapshot', `${p.container}: restored to ${p.snapshot}; pre-restore ${pre.name}; ${status}`);
  return {
    ok: true, step: 'restored', preRestore: pre, restoredTo: p.snapshot, coverage: verdict.coverage, partial: verdict.partial, status, wasRunning, recovery,
    // A managed application is verified up the whole ladder; another guest
    // is not an application ProxyPilot can check — said so, not assumed.
    followUp: p.managed ? { kind: 'verify_app', steps: ['unit_status', 'probe_port', 'health_check', 'verify_credential', 'verify_credential_use'], rung: 'credential_use_verified', revision: null } : null,
    verification: p.managed ? null : { state: 'not_applicable', label: `not applicable: ${p.container} is not a managed application; Incus reports it ${status}`, outcome: 'not_applicable' },
  };
}
