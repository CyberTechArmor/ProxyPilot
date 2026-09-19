// ZFS storage management — freshness and alerts. Pure.
//
// Answers, per pool and per guest: when was the last snapshot, the last
// successful replication, the last scrub — and whether that is within what
// the policy promises. The same record feeds the Storage page, the MCP
// `storage_freshness` tool, export_grc_evidence, and the 15-minute monitor
// that raises notifications (bell + webhooks) on the conditions below.

import { effectiveRetention, snapshotMaxAgeMs, replicationMaxAgeMs, SCRUB_MAX_AGE_MS } from './policy.js';
import { smartVerdict } from './parse.js';

const BAD_POOL_STATES = new Set(['DEGRADED', 'FAULTED', 'UNAVAIL', 'REMOVED', 'SUSPENDED']);

// Datasets Incus creates for its own bookkeeping under <pool>/incus. They are
// not operator data: `containers` and `virtual-machines` only hold the guest
// datasets (reported per guest), `images` is a re-downloadable cache,
// `deleted/*` is Incus's recycle area, `custom` and `buckets` are the parents
// of volumes (the volumes themselves are data and stay reportable).
const INCUS_STRUCTURAL = new Set(['containers', 'virtual-machines', 'images', 'custom', 'buckets', 'deleted']);

function incusStructural(name, incusRoot) {
  if (!incusRoot) return false;
  if (name === incusRoot) return true;
  if (!name.startsWith(`${incusRoot}/`)) return false;
  const rel = name.slice(incusRoot.length + 1).split('/');
  if (rel.length === 1) return INCUS_STRUCTURAL.has(rel[0]);
  return rel[0] === 'deleted' || rel[0] === 'images';
}

/**
 * Are automatic snapshots something this host has been asked for, and is the
 * thing that takes them actually running? `backup` comes from the service:
 *   { pool, policy_applied, sanoid_installed, timer_present, timer_state }
 * Until the operator applies a backup policy ProxyPilot promises no snapshots,
 * so nothing is "overdue" — and when sanoid itself is missing or its timer is
 * down, that one fact is the alert, not one stale row per dataset.
 * No `backup` at all (callers that do not know) keeps the strict behaviour.
 */
export function backupPosture(backup) {
  if (!backup) return { known: false, expect_snapshots: true, reason: null };
  const out = {
    known: true, pool: backup.pool || null, policy_applied: backup.policy_applied === true,
    sanoid_installed: backup.sanoid_installed !== false, timer_present: backup.timer_present !== false,
    timer_state: backup.timer_state || null, timer_enabled: backup.timer_enabled || null,
  };
  if (!out.policy_applied) return { ...out, expect_snapshots: false, reason: 'not_configured' };
  if (!out.sanoid_installed) return { ...out, expect_snapshots: false, reason: 'sanoid_missing' };
  if (!out.timer_present || (out.timer_state && out.timer_state !== 'active')) return { ...out, expect_snapshots: false, reason: 'timer_inactive' };
  return { ...out, expect_snapshots: true, reason: null };
}

function ageOf(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
}

export function humanAge(ms) {
  if (ms == null) return 'never';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

function latest(list) {
  let best = null;
  for (const s of list) if (s.created_at && (!best || s.created_at > best.created_at)) best = s;
  return best;
}

/**
 * computeFreshness({ pools, poolStatus, datasets, snapshots, instances, managed, policy, replication, devices, now })
 *   pools/poolStatus  parseZpoolList / parseZpoolStatus
 *   instances         [{ name, status, pool, dataset }] (dataset set for guests on a managed pool)
 *   replication       [{ name, sources, target, schedule, enabled, last_run_at, last_success_at, last_error }]
 * Returns { at, pools, guests, datasets, replication, summary }.
 */
export function computeFreshness({ pools = [], poolStatus = [], datasets = [], snapshots = [], instances = [], managed = null, policy, replication = [], backup = null, now = Date.now() } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const posture = backupPosture(backup && !backup.pool && managed ? { ...backup, pool: (managed.incus || managed.backups || managed.exports || '').split('/')[0] || null } : backup);
  const expect = posture.expect_snapshots;
  const gate = (status) => (expect || (status !== 'stale' && status !== 'none') ? status : 'not_configured');
  const bySnapDataset = new Map();
  for (const s of snapshots) { if (!bySnapDataset.has(s.dataset)) bySnapDataset.set(s.dataset, []); bySnapDataset.get(s.dataset).push(s); }

  const poolsOut = pools.map((p) => {
    const st = poolStatus.find((x) => x.name === p.name) || {};
    const scan = st.scan || { state: 'none' };
    const lastScrub = scan.function === 'scrub' && scan.state === 'finished' ? scan.last_end : null;
    const scrubAge = ageOf(lastScrub, nowMs);
    const scrubErrors = scan.function === 'scrub' ? (scan.errors || 0) : 0;
    const vdevErrors = (st.vdevs || []).flatMap((g) => g.devices).reduce((n, d) => n + (d.read_errors || 0) + (d.write_errors || 0) + (d.cksum_errors || 0), 0);
    // `zpool status -j` reports error_count: 0 on a healthy pool; only a
    // count above zero is a fault (the text form says "No known data errors").
    const hasDataErrors = st.error_count != null ? st.error_count > 0 : !!(st.errors && !/no known data errors/i.test(st.errors));
    const dataErrors = hasDataErrors ? (st.errors || `${st.error_count} data errors`) : null;
    return {
      name: p.name, health: p.health || st.state || null, healthy: !BAD_POOL_STATES.has(p.health || st.state),
      capacity_pct: p.capacity_pct, fragmentation_pct: p.fragmentation_pct, size_bytes: p.size_bytes, free_bytes: p.free_bytes,
      scrub: { state: scan.state, in_progress: scan.state === 'in_progress', percent: scan.percent ?? null, last_at: lastScrub, age_ms: scrubAge, age: humanAge(scrubAge), errors: scrubErrors, status: scan.state === 'in_progress' ? 'running' : scrubAge == null ? 'never' : scrubAge > SCRUB_MAX_AGE_MS ? 'overdue' : 'ok' },
      device_errors: vdevErrors, data_errors: dataErrors, data_error_count: st.error_count ?? null, status_text: st.status || null, action: st.action || null,
      degraded_members: (st.vdevs || []).flatMap((g) => g.devices).filter((d) => d.state && d.state !== 'ONLINE').map((d) => ({ name: d.name, state: d.state })),
    };
  });

  const datasetsOut = datasets.filter((d) => d.type !== 'snapshot').map((d) => {
    const guest = instances.find((i) => i.dataset === d.name);
    const eff = policy ? effectiveRetention(d.name, { managed, policy, guest: guest?.name || null }) : { class: null, enabled: true, retention: null };
    const last = latest(bySnapDataset.get(d.name) || []);
    const age = ageOf(last?.created_at, nowMs);
    const max = eff.enabled ? snapshotMaxAgeMs(eff.retention) : null;
    return {
      name: d.name, class: eff.class, policy_enabled: eff.enabled, retention: eff.retention, guest: guest?.name || null,
      structural: incusStructural(d.name, managed?.incus || null),
      snapshot_count: (bySnapDataset.get(d.name) || []).length, last_snapshot_at: last?.created_at || null, last_snapshot: last?.snapshot || null,
      age_ms: age, age: humanAge(age), max_age_ms: max,
      status: gate(!max ? 'unmanaged' : age == null ? 'none' : age > max ? 'stale' : 'ok'),
    };
  });

  const guestsOut = instances.map((i) => {
    const ds = datasetsOut.find((d) => d.name === i.dataset) || null;
    const repl = replication.filter((r) => r.enabled !== false && i.dataset && r.sources.some((s) => i.dataset === s || i.dataset.startsWith(`${s}/`)));
    const lastRepl = repl.map((r) => r.last_success_at).filter(Boolean).sort().pop() || null;
    const replAge = ageOf(lastRepl, nowMs);
    return {
      name: i.name, type: i.type, status: i.status, pool: i.pool, dataset: i.dataset || null, on_managed_pool: !!i.dataset,
      last_snapshot_at: ds?.last_snapshot_at || null, snapshot_age: ds?.age || 'never', snapshot_status: ds ? ds.status : 'unmanaged',
      structural: !!ds?.structural,
      last_replication_at: lastRepl, replication_age: humanAge(replAge), replicated_by: repl.map((r) => r.name),
      replication_status: !repl.length ? 'none' : replAge == null ? 'never' : replAge > Math.min(...repl.map((r) => replicationMaxAgeMs(r.schedule))) ? 'stale' : 'ok',
    };
  });

  const replicationOut = replication.map((r) => {
    const age = ageOf(r.last_success_at, nowMs);
    const max = replicationMaxAgeMs(r.schedule);
    return { ...r, age_ms: age, age: humanAge(age), max_age_ms: max, status: r.enabled === false ? 'disabled' : r.last_error && (!r.last_success_at || (r.last_run_at && r.last_run_at > r.last_success_at)) ? 'failed' : age == null ? 'never' : age > max ? 'stale' : 'ok' };
  });

  const summary = {
    pools: poolsOut.length, unhealthy_pools: poolsOut.filter((p) => !p.healthy).length, scrubs_overdue: poolsOut.filter((p) => p.scrub.status === 'overdue' || p.scrub.status === 'never').length,
    guests_on_zfs: guestsOut.filter((g) => g.on_managed_pool).length, guests_stale: guestsOut.filter((g) => g.snapshot_status === 'stale' || g.snapshot_status === 'none').length,
    datasets_stale: datasetsOut.filter((d) => !d.structural && (d.status === 'stale' || d.status === 'none')).length, replication_jobs: replicationOut.length,
    replication_unhealthy: replicationOut.filter((r) => ['stale', 'failed', 'never'].includes(r.status)).length,
  };
  return { at: new Date(nowMs).toISOString(), backup: posture, pools: poolsOut, datasets: datasetsOut, guests: guestsOut, replication: replicationOut, summary };
}

/**
 * Alert conditions → [{ key, level, event, title, body, subject }]. Every key
 * is stable per subject so the notification row dedupes and resolves.
 */
export function storageAlerts(freshness, devices = []) {
  const out = [];
  for (const p of freshness.pools || []) {
    if (!p.healthy) out.push({ key: `storage:pool-health:${p.name}`, level: 'error', event: 'storage.pool_health', subject: p.name, title: `ZFS pool ${p.name} is ${p.health}`, body: `${p.status_text || 'The pool is not healthy.'}${p.degraded_members.length ? ` Members: ${p.degraded_members.map((m) => `${m.name} ${m.state}`).join(', ')}.` : ''}${p.action ? ` ${p.action}` : ''}` });
    if (p.scrub.errors > 0 || p.data_errors || p.device_errors > 0) out.push({ key: `storage:pool-errors:${p.name}`, level: 'error', event: 'storage.scrub_errors', subject: p.name, title: `ZFS pool ${p.name} reports errors`, body: `${p.scrub.errors > 0 ? `Last scrub found ${p.scrub.errors} error(s). ` : ''}${p.device_errors > 0 ? `${p.device_errors} device read/write/checksum error(s). ` : ''}${p.data_errors ? `Errors: ${p.data_errors}` : ''}`.trim() });
    if (p.scrub.status === 'overdue') out.push({ key: `storage:scrub-overdue:${p.name}`, level: 'warning', event: 'storage.scrub_overdue', subject: p.name, title: `ZFS pool ${p.name} has not been scrubbed for ${p.scrub.age}`, body: 'Enable the monthly scrub timer on the Storage page (zpool_scrub with timer: true).' });
    if (p.capacity_pct != null && p.capacity_pct >= 90) out.push({ key: `storage:pool-capacity:${p.name}`, level: 'warning', event: 'storage.pool_capacity', subject: p.name, title: `ZFS pool ${p.name} is ${p.capacity_pct}% full`, body: 'ZFS performance degrades past ~80–90% capacity; prune snapshots or add capacity.' });
  }
  for (const d of devices) {
    const v = d.smart_verdict || smartVerdict(d.smart);
    if (v.level === 'fail') out.push({ key: `storage:smart:${d.serial || d.name}`, level: 'error', event: 'storage.smart_failure', subject: d.path, title: `SMART failure on ${d.path}${d.model ? ` (${d.model})` : ''}`, body: `${v.reason}. Serial ${d.serial || '?'}${d.in_pool ? `, member of pool ${d.in_pool} — replace_disk` : ''}.` });
    else if (v.level === 'warn') out.push({ key: `storage:smart:${d.serial || d.name}`, level: 'warning', event: 'storage.smart_warning', subject: d.path, title: `SMART warning on ${d.path}${d.model ? ` (${d.model})` : ''}`, body: `${v.reason}. Serial ${d.serial || '?'}${d.in_pool ? `, member of pool ${d.in_pool}` : ''}.` });
  }
  // Snapshot staleness is only a fault where snapshots were actually promised.
  // Before a backup policy exists, or while the thing that takes them is not
  // running, say that once for the pool instead of once per dataset.
  const b = freshness.backup;
  if (b && b.expect_snapshots === false) {
    const subject = b.pool || 'zfs';
    if (b.reason === 'not_configured') {
      out.push({ key: `storage:backups-unconfigured:${subject}`, level: 'info', event: 'storage.backups_unconfigured', subject, title: `No snapshot policy on ${subject} yet`, body: 'Storage → Backup policy (or the set_backup_policy tool) writes /etc/sanoid/sanoid.conf and starts sanoid.timer. Until then ProxyPilot takes no automatic snapshots — and reports none as overdue.' });
    } else {
      out.push({
        key: `storage:snapshots-not-running:${subject}`, level: 'error', event: 'storage.snapshots_not_running', subject,
        title: b.reason === 'sanoid_missing' ? 'A backup policy is set but sanoid is not installed' : 'A backup policy is set but sanoid.timer is not running',
        body: b.reason === 'sanoid_missing'
          ? 'No automatic snapshots are being taken. Install the storage toolchain (Storage → Preflight → Install, or the install_storage_toolchain tool).'
          : `No automatic snapshots are being taken (sanoid.timer is ${b.timer_present ? b.timer_state || 'inactive' : 'not installed'}). Re-apply the backup policy, or run \`systemctl enable --now sanoid.timer\` on the host.`,
      });
    }
  } else {
    for (const g of freshness.guests || []) {
      if (g.on_managed_pool && (g.snapshot_status === 'stale' || g.snapshot_status === 'none')) out.push({ key: `storage:snapshot-stale:${g.dataset}`, level: 'warning', event: 'storage.snapshot_stale', subject: g.name, title: `No recent snapshot of guest ${g.name}`, body: `Last snapshot: ${g.snapshot_age === 'never' ? 'never' : `${g.snapshot_age} ago`} (policy expects one within the retention window). Is sanoid.timer running?` });
    }
    for (const d of freshness.datasets || []) {
      if (d.guest) continue;      // reported per guest above
      if (d.structural) continue; // Incus's own bookkeeping datasets, not operator data
      if (d.status === 'stale' || d.status === 'none') out.push({ key: `storage:snapshot-stale:${d.name}`, level: 'warning', event: 'storage.snapshot_stale', subject: d.name, title: `No recent snapshot of ${d.name}`, body: `Last snapshot: ${d.age === 'never' ? 'never' : `${d.age} ago`} (class ${d.class}).` });
    }
  }
  for (const r of freshness.replication || []) {
    if (r.status === 'failed') out.push({ key: `storage:replication:${r.name}`, level: 'error', event: 'storage.replication_failed', subject: r.name, title: `Replication ${r.name} failed`, body: `${r.last_error || 'syncoid reported an error'} (target ${r.target}).` });
    else if (r.status === 'stale' || r.status === 'never') out.push({ key: `storage:replication:${r.name}`, level: 'warning', event: 'storage.replication_stale', subject: r.name, title: `Replication ${r.name} is ${r.status === 'never' ? 'yet to succeed' : `${r.age} old`}`, body: `Target ${r.target}, schedule ${r.schedule}. run_replication runs it now; replication_status shows the log.` });
  }
  return out;
}

/** Keys the monitor should consider resolved: every stable key not in the current alert set. */
export const ALERT_KEY_PREFIXES = Object.freeze(['storage:pool-health:', 'storage:pool-errors:', 'storage:scrub-overdue:', 'storage:pool-capacity:', 'storage:smart:', 'storage:snapshot-stale:', 'storage:backups-unconfigured:', 'storage:snapshots-not-running:', 'storage:replication:']);
