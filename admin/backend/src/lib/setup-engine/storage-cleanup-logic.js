// Setup engine — the storage cleanup job's contract, pure (DESIGN §3.2).
// Kept apart from storage-cleanup-op.js so logic.js (the pure decision
// layer every module imports) does not pull the operation's dependencies.
//
// A storage_cleanup job carries two REFERENCES and nothing else: the cleanup
// row's id and the target key. Paths, identities and actions are read by the
// operation from the stored cleanup row and its check — never from the plan.
// submitRunnerJob adds `container` (= the job's app) and an empty `steps`;
// both are accepted exactly so, nothing more.

export const STORAGE_CLEANUP_JOB_KINDS = Object.freeze(['storage_cleanup']);
export const CLEANUP_ID_RE = /^cln_[a-f0-9-]{36}$/;
export const TARGET_KEY_RE = /^(application|project):[1-9][0-9]*$/;

export function validateStorageCleanupJob(job, plan = {}) {
  const fail = reason => ({ ok: false, reason });
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return fail('Storage cleanup jobs carry only a cleanup reference.');
  if (!Object.keys(plan).every(k => k === 'params' || k === 'steps')) return fail('Storage cleanup jobs carry only a cleanup reference.');
  if (plan.steps !== undefined && !(Array.isArray(plan.steps) && plan.steps.length === 0)) return fail('Storage cleanup jobs carry no steps.');
  const p = plan.params;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return fail('Storage cleanup jobs carry a cleanup reference.');
  if (!Object.keys(p).every(k => ['cleanupId', 'targetKey', 'container'].includes(k))) return fail('Storage cleanup jobs carry only cleanupId and targetKey; no path, command or script.');
  if (!CLEANUP_ID_RE.test(String(p.cleanupId || ''))) return fail('cleanupId must be a cleanup id (cln_<uuid>).');
  if (!TARGET_KEY_RE.test(String(p.targetKey || ''))) return fail('targetKey must be application:<id> or project:<id>.');
  if (p.container !== undefined && p.container !== job?.app) return fail('plan container differs from the job app');
  return { ok: true };
}

// The reconciler's decision for a storage_cleanup whose owner died: resume
// from the per-item checkpoint (the resumed job first finishes this
// cleanup's quarantine entries and re-verifies the interrupted item), else
// record the interruption (no item had been started).
export function storageCleanupDecision(checkpoint) {
  if (checkpoint?.storageCleanup === true && checkpoint.resumable === true) return { action: 'resume', reason: 'Resume the storage cleanup from its last item: finish this cleanup\'s quarantine entries, re-verify the interrupted item, never redo a finished one.' };
  return { action: 'record_interrupted', reason: 'The storage cleanup was interrupted before its first item; nothing was removed.' };
}
