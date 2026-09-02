// Reversible project archive / unarchive (the MCP set_project_lifecycle verb).
//
// The UI's Archive (mock2/provision.js startArchive) is a teardown: checkpoint
// → push → DESTROY the container → 'archived', with Rehydrate rebuilding the
// guest from the bare repo. That is the right end-state for a project nobody
// will touch again, but it is not what "free the host for a while" needs: the
// guest's snapshot history, its bridge and its uncommitted scratch are gone,
// and coming back is a full re-provision.
//
// This module is the light version: checkpoint (so a UI Rehydrate of an
// MCP-archived project still loses nothing), snapshot, STOP the guest, force
// boot.autostart off, mark 'archived'. Everything else — routes, DNS, the
// checkout, the database, the bridge, the container itself — stays. Unarchive
// is the exact reversal, driven by the state the archive recorded on the row
// (mock2_projects.archive_state_json, migration 557).
//
// Every host effect goes through the injected `deps` so the round trip is
// unit-testable against a fake Incus (no better-sqlite3, no nsenter):
//
//   deps.incus(argv, { timeoutMs })        → { status, stdout, stderr, timedOut }
//   deps.snapshot(containerName, snapName) → { name } | { error }
//   deps.checkpoint(containerName)         → { ok, detail }   (best effort)
//   deps.containerStatus(containerName)    → 'running' | 'stopped' | 'none' | null
//   deps.waitForIp(containerName)          → ip string | null
//   deps.updateProject(id, patch)          → the updated row
//   deps.now()                             → ISO-8601 string

import { lifecycleRefusal, parseArchiveState, containerStatusWord, defaultSnapshotName } from './mcp-logic.js';

const STOP_TIMEOUT_MS = 180000;
const CONFIG_TIMEOUT_MS = 60000;

function tail(s, n = 300) {
  return String(s || '').trim().slice(-n);
}

async function readAutostart(deps, containerName) {
  const r = await deps.incus(['config', 'get', containerName, 'boot.autostart'], { timeoutMs: CONFIG_TIMEOUT_MS });
  if (r.status !== 0) return { error: tail(r.stderr) || 'incus config get failed' };
  return { value: String(r.stdout || '').trim() };
}

async function writeAutostart(deps, containerName, value) {
  const argv = value === '' || value == null
    ? ['config', 'unset', containerName, 'boot.autostart']
    : ['config', 'set', containerName, `boot.autostart=${value}`];
  const r = await deps.incus(argv, { timeoutMs: CONFIG_TIMEOUT_MS });
  if (r.status !== 0) return { error: tail(r.stderr) || 'incus config write failed' };
  return { ok: true };
}

// null from deps.containerStatus means "the host could not be asked" — never
// "the guest is gone". Both verbs stop there rather than guess.
async function guestStatus(deps, containerName) {
  const raw = await deps.containerStatus(containerName);
  if (raw === null || raw === undefined) {
    return { error: `Could not query incus for ${containerName} — the host did not answer, so the guest's state is unknown (not absent). Retry when incus is reachable.` };
  }
  return { status: containerStatusWord(raw) };
}

/**
 * Archive one project. Returns { error } (nothing changed, except possibly a
 * snapshot that is reported inside the message) or the result payload.
 */
export async function archiveProject({ project, pinned, latestCycle, queuedBuilds, stopContainer = true, policy, containerName, deps }) {
  const probe = await guestStatus(deps, containerName);
  if (probe.error) return { error: probe.error };
  const status = probe.status;
  const refusal = lifecycleRefusal({ project, action: 'archive', pinned, latestCycle, queuedBuilds, containerStatus: status }, policy);
  if (refusal) return { error: refusal };

  const previousLifecycle = project.lifecycle;
  const hasGuest = status !== 'none';
  let previousAutostart = null;
  let snapshot = null;
  let checkpoint = null;
  let stoppedByArchive = false;

  if (hasGuest) {
    const auto = await readAutostart(deps, containerName);
    if (auto.error) return { error: `Could not read boot.autostart on ${containerName}: ${auto.error}` };
    previousAutostart = auto.value;

    // Checkpoint first, while the guest is still up: a UI Rehydrate later
    // rebuilds from the bare repo, and this is what makes that lossless.
    if (status === 'running') {
      checkpoint = await deps.checkpoint(containerName);
    }

    // Snapshot BEFORE anything changes — the undo path must exist first
    // (same rule as set_lxc_config).
    const snap = await deps.snapshot(containerName, defaultSnapshotName(new Date(deps.now()), 'pp-mcp-pre-archive'));
    if (snap.error) return { error: `Refusing to archive without a snapshot: ${snap.error}` };
    snapshot = snap.name;

    if (stopContainer && status === 'running') {
      // Clean shutdown only — no --force. A guest that will not stop cleanly
      // is exactly the case a human should look at.
      const r = await deps.incus(['stop', containerName], { timeoutMs: STOP_TIMEOUT_MS });
      if (r.status !== 0) {
        const why = r.timedOut
          ? `timed out — the guest did not stop cleanly within ${STOP_TIMEOUT_MS / 1000}s (no force-kill is issued over MCP)`
          : tail(r.stderr) || 'unknown error';
        return { error: `Could not stop ${containerName}: ${why}. Nothing was archived (pre-archive snapshot ${snapshot} was taken and is harmless).` };
      }
      stoppedByArchive = true;
    }

    const w = await writeAutostart(deps, containerName, 'false');
    if (w.error) {
      // Undo the stop we just did so the guest is exactly as we found it.
      if (stoppedByArchive) await deps.incus(['start', containerName], { timeoutMs: STOP_TIMEOUT_MS });
      return { error: `Could not set boot.autostart=false on ${containerName}: ${w.error}. Nothing was archived (snapshot ${snapshot} was taken).` };
    }
  }

  const archivedAt = deps.now();
  const state = {
    via: 'mcp',
    archived_at: archivedAt,
    previous_lifecycle: previousLifecycle,
    previous_autostart: previousAutostart,
    stopped_container: stoppedByArchive,
    container_name: hasGuest ? containerName : null,
    snapshot,
  };
  deps.updateProject(project.id, {
    lifecycle: 'archived',
    archived_at: archivedAt,
    archive_state_json: JSON.stringify(state),
    ...(stoppedByArchive ? { container_ip: null } : {}),
  });

  const finalStatus = hasGuest ? containerStatusWord(await deps.containerStatus(containerName)) : 'none';
  return {
    project_id: project.id,
    name: project.name,
    action: 'archive',
    previous_lifecycle: previousLifecycle,
    lifecycle: 'archived',
    container: hasGuest ? containerName : null,
    container_status: finalStatus,
    container_stopped: stoppedByArchive,
    snapshot,
    checkpoint,
    previous_autostart: previousAutostart,
    autostart: hasGuest ? 'false' : null,
    kept: ['routes', 'dns', 'checkout', 'database', 'bare repo', 'bridge', 'container'],
    change_summary: `archived via MCP; container ${stoppedByArchive ? 'stopped' : hasGuest ? `left ${finalStatus}` : 'absent'}; ${snapshot ? `snapshot ${snapshot}` : 'no snapshot (no guest)'}`,
  };
}

/**
 * Unarchive one project — the reversal of archiveProject. Returns { error }
 * or the result payload (the caller republishes the route and probes it).
 */
export async function unarchiveProject({ project, policy, containerName, deps }) {
  const probe = await guestStatus(deps, containerName);
  if (probe.error) return { error: probe.error };
  const status = probe.status;
  const refusal = lifecycleRefusal({ project, action: 'unarchive', containerStatus: status }, policy);
  if (refusal) return { error: refusal };

  const state = parseArchiveState(project.archive_state_json);
  // A row archived from the UI whose guest still exists (it should not — the
  // UI destroys it) or an MCP archive whose state was lost: proceed with the
  // guest as found, touching nothing we cannot prove we changed.
  const previousLifecycle = state?.previous_lifecycle && state.previous_lifecycle !== 'archived' ? state.previous_lifecycle : 'active';
  const stoppedByArchive = !!state?.stopped_container;

  let autostart = null;
  if (state && 'previous_autostart' in state) {
    const w = await writeAutostart(deps, containerName, state.previous_autostart);
    if (w.error) return { error: `Could not restore boot.autostart on ${containerName}: ${w.error}. Still archived.` };
    autostart = state.previous_autostart === '' || state.previous_autostart == null ? null : state.previous_autostart;
  }

  let started = false;
  let ip = null;
  if (stoppedByArchive && status !== 'running') {
    const r = await deps.incus(['start', containerName], { timeoutMs: STOP_TIMEOUT_MS });
    if (r.status !== 0) {
      return { error: `Could not start ${containerName}: ${r.timedOut ? 'timed out' : tail(r.stderr) || 'unknown error'}. boot.autostart was restored; the project is still archived.` };
    }
    started = true;
    ip = await deps.waitForIp(containerName);
  }

  const finalStatus = containerStatusWord(await deps.containerStatus(containerName));
  // 'active' only when the guest is actually up; an idle-stopped project that
  // was archived without the archive stopping it goes back to 'stopped'.
  const lifecycle = finalStatus === 'running' ? 'active' : (previousLifecycle === 'stopped' ? 'stopped' : previousLifecycle);
  deps.updateProject(project.id, {
    lifecycle,
    archived_at: null,
    archive_state_json: null,
    last_activity_at: deps.now(),
    ...(ip ? { container_ip: ip } : {}),
  });

  return {
    project_id: project.id,
    name: project.name,
    action: 'unarchive',
    previous_lifecycle: 'archived',
    lifecycle,
    container: containerName,
    container_status: finalStatus,
    container_started: started,
    ...(started && !ip ? { warning: 'The container started but reported no IP within the wait window — the route may 502 until it does.' } : {}),
    snapshot: state?.snapshot || null,
    autostart,
    change_summary: `unarchived via MCP; container ${started ? 'started' : `left ${finalStatus}`}; boot.autostart ${autostart === null ? 'unset' : `restored to ${autostart}`}`,
  };
}
