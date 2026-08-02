// Project clone — PURE decision layer (native-free).
//
// Two modes (operator request, 2026-07-31):
//   'fresh' — the new project gets the source's full git history (app code +
//             committed state/) and its asset library, but starts with a
//             fresh database (the app's own migrations run on first deploy).
//   'full'  — everything 'fresh' brings, plus the source container's
//             in-container Postgres dumped and restored into the clone.
//
// The impure half (clone.js) validates the source, creates the row, and hands
// off to provision.startCloneProvision.

export const CLONE_MODES = ['fresh', 'full'];

export function normalizeCloneMode(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return CLONE_MODES.includes(s) ? s : null;
}

// The project-row fields a clone inherits from its source. Everything else is
// either identity (name/slug/domain), runtime state re-derived by provisioning
// (container, bridge, ports, deployed_commit), or per-project history that the
// cloned repo already carries in state/ (rules, inventory, change records).
// current_mockup_id is NOT copied — mockup rows belong to the source project.
export function cloneCopyPatch(source) {
  const patch = {};
  for (const col of [
    'description', 'design_preset', 'harness', 'suggest_mode', 'clarify_mode',
    'design_approved_at', 'design_inventory_seq',
    // The clone keeps the source's provider choice and its already-made design
    // choice (a clone of a designed project must not re-prompt the popup).
    'provider_preference', 'design_choice_at',
  ]) {
    if (source?.[col] != null) patch[col] = source[col];
  }
  return patch;
}

// Whether a clone request is valid against the source's state. 'full' needs
// the source container running (the dump pipes out of it live); 'fresh' only
// needs the bare repo, which survives archive (ADR-006).
export function cloneSourceError(source, mode) {
  if (!source) return 'Source project not found';
  if (!source.repo_path) return 'Source project has no repository to clone';
  if (source.lifecycle === 'provisioning') return 'Source project is still provisioning — wait for it to finish';
  if (source.lifecycle === 'failed_provisioning') return 'Source project never provisioned successfully — nothing to clone';
  if (mode === 'full' && source.lifecycle !== 'active') {
    return 'Bringing the database over needs the source project online — wake it first, or clone fresh';
  }
  return null;
}
