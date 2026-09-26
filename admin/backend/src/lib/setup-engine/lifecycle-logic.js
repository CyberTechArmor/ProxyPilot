// Setup engine — the PURE layer of the Incus lifecycle and snapshot jobs
// (platform ledger A-17.2 … A-17.5): which kinds exist, what parameters each
// accepts, the FIXED host command each renders, what state each expects
// afterwards, how each behaves when its owner dies, and how a target's
// identity is bound so a replay never acts on a resource the operator did
// not confirm.
//
// No I/O. The runner validates a claimed job with validateLifecycleParams
// before it renders anything, and the argv it renders comes from
// lifecycleArgv alone: a job carries names, flags and an allowlisted config
// map — never a command, an option string or an argv.
//
//   instance_start     incus start <name>                        → Running
//   instance_stop      incus stop <name> [--force]               → Stopped
//   instance_restart   incus restart <name> [--force]            → Running
//   instance_delete    (incus stop <name> [--force];) incus delete <name> → absent
//   instance_create    incus launch <image> <name> --profile <p> [--config k=v]… [--device root,size=<size>] [--vm] [--network <bridge>] → present, Running
//   snapshot_create    incus snapshot create <name> <snap> (legacy form discovered) [+ user.note] → snapshot present
//   snapshot_delete    incus snapshot delete <name> <snap>       → snapshot absent
//
// Interruption is operation-specific. An idempotent kind (start, stop, both
// snapshot verbs, delete) is RESUMED: the resumed job re-reads the resource,
// finishes when the end state already holds, and otherwise issues the same
// command against the same identity. A kind whose replay could act twice on
// a resource in an unknown state (restart, create) is NEVER replayed after
// its command was issued: the record ends recovery_required naming the
// check, and nothing is issued again.

import { CONTAINER_NAME_RE, redact } from './logic.js';
import { validateSetupParams, FIXUP_PHASES, SETUP_PHASES } from './setup-logic.js';

export const LIFECYCLE_JOB_KINDS = Object.freeze(['instance_create', 'instance_start', 'instance_stop', 'instance_restart', 'instance_delete', 'snapshot_create', 'snapshot_delete']);
export const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const IMAGE_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9:/._-]{0,199}$/;
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
export const NETWORK_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,14}$/;
export const SIZE_RE = /^[1-9][0-9]{0,6}(MB|MiB|GB|GiB)$/;
export const NOTE_MAX = 500;

// The `--config` keys `incus launch` may carry, each with the value shape it
// accepts. Anything else is refused at validation — a guest is configured
// after birth through the config verbs and their own allowlist.
export const LAUNCH_CONFIG_ALLOWLIST = Object.freeze({
  'security.nesting': /^(true|false)$/,
  'security.guestapi': /^false$/,
  'security.privileged': /^(true|false)$/,
  'security.syscalls.intercept.mknod': /^(true|false)$/,
  'security.syscalls.intercept.setxattr': /^(true|false)$/,
  'security.syscalls.intercept.bpf': /^(true|false)$/,
  'security.syscalls.intercept.bpf.devices': /^(true|false)$/,
  'raw.lxc': /^lxc\.apparmor\.profile=unconfined$/,
  'limits.cpu': /^[1-9][0-9]{0,2}$/,
  'limits.memory': SIZE_RE,
  'boot.autostart': /^(true|false)$/,
});

// What a kind does to the resource, and how an interrupted attempt is handled.
//   replay 'idempotent'  a resumed job re-reads and finishes or re-issues the
//                        same command against the same identity
//   replay 'never'       after the command was issued the outcome is uncertain
//                        and the job is NOT resumed: recovery_required
export const LIFECYCLE_PROFILE = Object.freeze({
  instance_start: { target: 'instance', expect: 'Running', replay: 'idempotent', removes: false, creates: false },
  instance_stop: { target: 'instance', expect: 'Stopped', replay: 'idempotent', removes: false, creates: false },
  instance_restart: { target: 'instance', expect: 'Running', replay: 'never', removes: false, creates: false },
  instance_delete: { target: 'instance', expect: 'absent', replay: 'idempotent', removes: true, creates: false },
  instance_create: { target: 'instance', expect: 'Running', replay: 'never', removes: false, creates: true },
  snapshot_create: { target: 'snapshot', expect: 'present', replay: 'idempotent', removes: false, creates: true },
  snapshot_delete: { target: 'snapshot', expect: 'absent', replay: 'idempotent', removes: true, creates: false },
});

export function isLifecycleKind(kind) { return LIFECYCLE_JOB_KINDS.includes(kind); }

const isBool = (v) => v == null || typeof v === 'boolean';
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// validateLifecycleParams(kind, params) → { ok } | { ok: false, reason }.
// Shape only, and strict: every parameter is a name, a flag or an allowlisted
// key; nothing here is ever interpolated into a shell.
export function validateLifecycleParams(kind, p = {}) {
  if (!isLifecycleKind(kind)) return { ok: false, reason: `kind '${kind}' is not a lifecycle job` };
  if (!isPlainObject(p)) return { ok: false, reason: 'params must be an object' };
  if (!CONTAINER_NAME_RE.test(String(p.container || ''))) return { ok: false, reason: 'container must be an Incus guest name' };
  if (p.command != null || p.script != null || p.argv != null || p.args != null || p.options != null) return { ok: false, reason: 'a lifecycle job never carries a command, arguments or options' };
  if (!isBool(p.force)) return { ok: false, reason: 'force must be a boolean' };
  if (p.force === true && !['instance_stop', 'instance_restart', 'instance_delete'].includes(kind)) return { ok: false, reason: `force applies to stop, restart and delete, not ${kind}` };
  if (!isBool(p.managed)) return { ok: false, reason: 'managed must be a boolean' };
  // The post-start fix-up (A-17.7): a start / restart may ask for the NAT and
  // DNS phases as a follow-up; a create may carry the whole setup plan (the
  // guest identity is bound by the executor from the launched guest).
  if (!isBool(p.fixup)) return { ok: false, reason: 'fixup must be a boolean' };
  if (p.fixup === true && !['instance_start', 'instance_restart'].includes(kind)) return { ok: false, reason: `fixup applies to start and restart, not ${kind}` };
  if (p.setup != null) {
    if (kind !== 'instance_create') return { ok: false, reason: `a ${kind} job carries no setup plan` };
    if (!isPlainObject(p.setup)) return { ok: false, reason: 'setup must be a plan of phases' };
    if (p.setup.expect != null || p.setup.container != null) return { ok: false, reason: 'the setup plan of a create binds its identity from the launched guest, not from the request' };
    const sv = validateSetupParams({ ...p.setup, container: String(p.container) });
    if (!sv.ok) return { ok: false, reason: `setup: ${sv.reason}` };
  }
  if (p.expect != null) {
    if (!isPlainObject(p.expect)) return { ok: false, reason: 'expect must be an identity record' };
    for (const k of Object.keys(p.expect)) if (!['uuid', 'created_at', 'status'].includes(k)) return { ok: false, reason: `expect.${k} is not an identity field` };
    if (p.expect.uuid != null && !/^[0-9a-fA-F-]{8,64}$/.test(String(p.expect.uuid))) return { ok: false, reason: 'expect.uuid must be an Incus volatile uuid' };
    if (p.expect.created_at != null && !Number.isFinite(Date.parse(String(p.expect.created_at)))) return { ok: false, reason: 'expect.created_at must be a timestamp' };
    if (p.expect.status != null && !/^[A-Za-z]{1,20}$/.test(String(p.expect.status))) return { ok: false, reason: 'expect.status must be an Incus status word' };
  }
  const prof = LIFECYCLE_PROFILE[kind];
  if (prof.target === 'snapshot') {
    if (!SNAPSHOT_NAME_RE.test(String(p.snapshot || ''))) return { ok: false, reason: 'snapshot must be a snapshot name' };
  } else if (p.snapshot != null) {
    return { ok: false, reason: `a ${kind} job carries no snapshot name` };
  }
  if (kind === 'snapshot_create') {
    if (p.note != null) {
      if (typeof p.note !== 'string' || p.note.length > NOTE_MAX || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(p.note)) return { ok: false, reason: `note must be text of at most ${NOTE_MAX} characters` };
    }
  } else if (p.note != null) {
    return { ok: false, reason: `a ${kind} job carries no note` };
  }
  if (kind === 'instance_create') {
    if (!IMAGE_ALIAS_RE.test(String(p.image || '')) || String(p.image).startsWith('-')) return { ok: false, reason: 'image must be an Incus image alias (e.g. images:debian/13)' };
    if (p.profile != null && !PROFILE_NAME_RE.test(String(p.profile))) return { ok: false, reason: 'profile must be a profile name' };
    if (p.network != null && !NETWORK_NAME_RE.test(String(p.network))) return { ok: false, reason: 'network must be a bridge name' };
    if (!isBool(p.vm)) return { ok: false, reason: 'vm must be a boolean' };
    if (p.rootSize != null && !SIZE_RE.test(String(p.rootSize))) return { ok: false, reason: 'rootSize must be a size like 20GiB' };
    if (p.config != null) {
      if (!isPlainObject(p.config)) return { ok: false, reason: 'config must be a map of allowlisted launch keys' };
      for (const [k, v] of Object.entries(p.config)) {
        const re = LAUNCH_CONFIG_ALLOWLIST[k];
        if (!re) return { ok: false, reason: `config key '${k}' is not on the launch allowlist (${Object.keys(LAUNCH_CONFIG_ALLOWLIST).join(', ')})` };
        if (typeof v !== 'string' || !re.test(v)) return { ok: false, reason: `config ${k}=${String(v).slice(0, 40)} is not an accepted value` };
      }
    }
  } else {
    for (const k of ['image', 'profile', 'network', 'vm', 'rootSize', 'config', 'setup']) if (p[k] != null) return { ok: false, reason: `a ${kind} job carries no ${k}` };
  }
  if (JSON.stringify(p) !== JSON.stringify(redact(p))) return { ok: false, reason: 'the plan carries a value that looks like a secret; plans carry references only' };
  return { ok: true };
}

// lifecycleArgv(kind, params) → the fixed argv for the kind's mutation, or
// throws on a plan that did not validate. `snapshot_create` renders the
// subcommand form; the operation discovers the legacy form from the client's
// own answer (restore-snapshot-op createSnapshotWithFallback).
export function lifecycleArgv(kind, p, { snapshotForm = 'subcommand' } = {}) {
  const v = validateLifecycleParams(kind, p);
  if (!v.ok) throw new Error(`refusing to render a command for an invalid plan: ${v.reason}`);
  const name = String(p.container);
  const force = p.force === true ? ['--force'] : [];
  switch (kind) {
    case 'instance_start': return ['incus', 'start', name];
    case 'instance_stop': return ['incus', 'stop', name, ...force];
    case 'instance_restart': return ['incus', 'restart', name, ...force];
    case 'instance_delete': return ['incus', 'delete', name];
    case 'instance_create': {
      const argv = ['incus', 'launch', String(p.image), name, '--profile', String(p.profile || 'default')];
      for (const k of Object.keys(LAUNCH_CONFIG_ALLOWLIST)) if (p.config && p.config[k] != null) argv.push('--config', `${k}=${p.config[k]}`);
      // An Incus VM block volume cannot be shrunk after launch. Apply an
      // explicit root size atomically at creation, or fail the launch.
      if (p.rootSize) argv.push('--device', `root,size=${p.rootSize}`);
      if (p.network) argv.push('--network', String(p.network));
      if (p.vm === true) argv.push('--vm');
      return argv;
    }
    case 'snapshot_create': return snapshotForm === 'legacy' ? ['incus', 'snapshot', name, String(p.snapshot)] : ['incus', 'snapshot', 'create', name, String(p.snapshot)];
    case 'snapshot_delete': return ['incus', 'snapshot', 'delete', name, String(p.snapshot)];
    default: throw new Error(`no command for ${kind}`);
  }
}

// The read every lifecycle job does before and after its command.
export function instanceListArgv(name) { return ['incus', 'list', String(name), '--format', 'json']; }
// A snapshot may carry a best-effort note after creation.
export function snapshotNoteArgv(name, snap, note) { return ['incus', 'config', 'set', `${name}/snapshots/${snap}`, `user.note=${note}`]; }
// A half-created guest left by a failed launch (validated absent first).
export function cleanupArgv(name) { return ['incus', 'delete', String(name), '--force']; }

// instanceIdentity(instance) → what makes THIS guest this guest: Incus's
// volatile uuid and its creation time. A guest recreated under the same name
// has a different identity.
export function instanceIdentity(instance) {
  if (!instance) return null;
  const cfg = instance.config || instance.expanded_config || {};
  return { uuid: cfg['volatile.uuid'] || null, created_at: instance.created_at || null, status: instance.status || null };
}

export function snapshotIdentity(instance, snapshot) {
  const s = (instance?.snapshots || []).find((x) => x && x.name === snapshot) || null;
  return s ? { created_at: s.created_at || null } : null;
}

// identityMatches(expected, actual) → { ok, why }. Only the fields the
// expectation carries are compared; an expectation without them binds
// nothing (and says so).
export function identityMatches(expected, actual) {
  if (!expected || (expected.uuid == null && expected.created_at == null)) return { ok: true, bound: false, why: 'no identity to compare' };
  if (!actual) return { ok: false, bound: true, why: 'the resource is gone' };
  if (expected.uuid != null && actual.uuid != null && String(expected.uuid) !== String(actual.uuid)) return { ok: false, bound: true, why: `uuid ${String(actual.uuid).slice(0, 8)}… differs from the confirmed ${String(expected.uuid).slice(0, 8)}…` };
  if (expected.created_at != null && actual.created_at != null && Date.parse(expected.created_at) !== Date.parse(actual.created_at)) return { ok: false, bound: true, why: `created ${actual.created_at}, not ${expected.created_at} as confirmed` };
  return { ok: true, bound: true, why: 'identity matches' };
}

// stateVerdict(kind, { instance, snapshot }) → { ok, observed, expected }:
// does the resource read as the kind promises after its command?
export function stateVerdict(kind, { instance, snapshot = null }) {
  const prof = LIFECYCLE_PROFILE[kind];
  if (prof.target === 'snapshot') {
    const present = !!(instance && (instance.snapshots || []).some((s) => s && s.name === snapshot));
    const observed = !instance ? 'guest absent' : present ? 'present' : 'absent';
    return { ok: !!instance && (prof.expect === 'present' ? present : !present), observed, expected: prof.expect };
  }
  if (prof.expect === 'absent') return { ok: !instance, observed: instance ? String(instance.status || 'present') : 'absent', expected: 'absent' };
  const status = instance ? String(instance.status || '') : null;
  return { ok: !!instance && status.toLowerCase() === prof.expect.toLowerCase(), observed: status || 'absent', expected: prof.expect };
}

// alreadyDone(kind, { instance, snapshot, issued }) → is there nothing left to
// do? Start of a running guest, stop of a stopped one, and — only when the
// interrupted attempt had already ISSUED its command — a delete whose target
// is gone or a snapshot that exists. Before any command was issued, an absent
// delete target or an existing snapshot is somebody else's doing, reported
// as such rather than claimed.
export function alreadyDone(kind, { instance, snapshot = null, issued = false }) {
  const verdict = stateVerdict(kind, { instance, snapshot });
  if (!verdict.ok) return false;
  const prof = LIFECYCLE_PROFILE[kind];
  if (kind === 'instance_start' || kind === 'instance_stop') return true;
  if (prof.removes || prof.creates) return issued === true;
  return false;
}

export function lifecycleOutcomeStep(kind) {
  return { instance_start: 'started', instance_stop: 'stopped', instance_restart: 'restarted', instance_delete: 'deleted', instance_create: 'created', snapshot_create: 'snapshot_created', snapshot_delete: 'snapshot_deleted' }[kind] || 'completed';
}

// The verification a lifecycle job records: the resource's own state, read
// back; the application ladder does not apply unless the caller asked for a
// follow-up on a managed app (start / restart), which the executor queues.
export function lifecycleVerification(kind, verdict, { container, snapshot = null }) {
  const what = LIFECYCLE_PROFILE[kind].target === 'snapshot' ? `snapshot ${snapshot} of ${container}` : container;
  return {
    state: verdict.ok ? 'not_applicable' : 'recovery_required',
    outcome: verdict.ok ? 'resource_state_verified' : 'resource_state_mismatch',
    label: verdict.ok ? `verified: Incus reports ${what} ${verdict.observed} (expected ${verdict.expected}); the application ladder does not apply to a lifecycle job` : `Incus reports ${what} ${verdict.observed}, expected ${verdict.expected}`,
    failedAt: verdict.ok ? null : 'resource_state',
    next: verdict.ok ? null : `read 'incus list ${container} --format json' and decide; nothing further was issued`,
    facts: { resource: { kind, container, snapshot, observed: verdict.observed, expected: verdict.expected } },
  };
}

// The follow-up a lifecycle job queues for the guest setup (A-17.7): the
// whole plan a create carried, bound to the guest the launch read back; the
// NAT + DNS fix-up a start / restart asked for. Pure: the executor creates
// the job from this.
export function setupFollowUpFor(kind, p, identity) {
  const expect = identity && (identity.uuid != null || identity.created_at != null) ? { ...(identity.uuid != null ? { uuid: String(identity.uuid) } : {}), ...(identity.created_at != null ? { created_at: String(identity.created_at) } : {}) } : null;
  if (kind === 'instance_create' && p.setup) {
    const phases = [...SETUP_PHASES].filter((ph) => p.setup.phases.includes(ph));
    return { kind: 'guest_setup', params: { ...p.setup, container: String(p.container), phases, ...(expect ? { expect } : {}) } };
  }
  if ((kind === 'instance_start' || kind === 'instance_restart') && p.fixup === true) {
    return { kind: 'guest_setup', params: { container: String(p.container), phases: [...FIXUP_PHASES], ...(expect ? { expect } : {}) } };
  }
  return null;
}
