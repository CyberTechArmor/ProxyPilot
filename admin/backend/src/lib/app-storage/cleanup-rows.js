// Application storage — the cleanup row and busy helpers shared by the
// cleanup service (backend) and the storage_cleanup job (host runner).
// Kept apart from cleanup-service.js on purpose: that module imports the
// check service (perform-check → host measures → lxc-zip), and the setup
// engine's executor must not pull that graph in just to read a row.

import { guestBusy } from './targets.js';

const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

// A cleanup row in either spelling → the camelCase view the API returns.
export function cleanupRow(row) {
  if (!row) return null;
  return {
    id: row.id, targetKey: row.target_key ?? row.targetKey, checkId: row.check_id ?? row.checkId,
    origin: row.origin, status: row.status, jobId: row.job_id ?? row.jobId ?? null, scope: row.scope ?? null,
    selection: parse(row.selection_json ?? row.selection) || [], result: parse(row.result_json ?? row.result),
    createdAt: row.created_at ?? row.createdAt, finishedAt: row.finished_at ?? row.finishedAt ?? null,
    requestedBy: row.requested_by ?? row.requestedBy ?? null,
  };
}

// busyFrom(activity) → the plain reason the target cannot be cleaned now, or
// null. Anything the activity reports — an open job, a running build, a held
// lease, any stated reason — counts: refuse rather than race it.
export function busyFrom(activity) {
  if (!activity) return null;
  const reasons = Array.isArray(activity.reasons) ? activity.reasons : [];
  if (!guestBusy(activity) && !reasons.length) return null;
  if (reasons.length) return String(reasons[0]);
  if (activity.buildActive) return 'A build is running.';
  if (activity.leaseHeld) return 'Another operation holds the application.';
  return `A ${activity.openJobs?.[0]?.kind || 'change'} is in progress.`;
}
