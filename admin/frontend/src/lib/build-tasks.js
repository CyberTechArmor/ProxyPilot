// Derive a Claude-Code-style task/step list for a build cycle.
//
// A build cycle has a coarse persisted `status` and a fine, ephemeral live
// `job.phase` (plus the gate battery and a deploy sub-state). None of them is a
// "steps remaining" counter on its own — this module composes them into a fixed
// phase skeleton with a live state per phase so the UI can show what's running
// and roughly how many steps are left, even though the exact time is unknown.
//
// Pure (no React) so the mapping is easy to reason about and reuse.

// The fixed end-to-end skeleton every build walks through, in order.
export const BUILD_PHASES = [
  { key: 'audit', label: 'Audit & plan', active: 'Checking the change against the rules and framework' },
  { key: 'build', label: 'Write the code', active: 'Editing files in the fenced container' },
  { key: 'verify', label: 'Run the gate battery', active: 'Verifying the pinned gates' },
  { key: 'checkpoint', label: 'Checkpoint into the repo', active: 'Committing the change' },
  { key: 'deploy', label: 'Deploy the app', active: 'Install → migrate → build → start on the live URL' },
];

const FAILED_STATUSES = ['failed', 'abandoned', 'refused_quota', 'interrupted'];
const BLOCKED_STATUSES = ['awaiting_user', 'awaiting_admin'];

// Map a gate report status to a task state.
function gateState(status) {
  if (status === 'passed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'active';
  return 'pending';
}

// How far along are we? Returns the ordinal (index into BUILD_PHASES) of the
// phase currently in flight, derived from the strongest available signal.
function currentOrdinal({ status, phase, gates, deploy }) {
  if (deploy === 'deploying' || deploy === 'serving' || deploy === 'deploy_failed') return 4;
  if (phase === 'checkpoint') return 3;
  const gateStarted = gates.some((g) => g && g.status && g.status !== 'pending');
  if (phase === 'deploying') return 4;
  if (gateStarted) return 2;
  if (status === 'running' || ['starting', 'running', 'retrying'].includes(phase)) return 1;
  return 0; // queued / estimating / awaiting_* → still in the audit/plan phase
}

// deriveBuildTasks(cycle, job) → { tasks, done, total, remaining, terminal, headline }
//   tasks: [{ key, label, state, detail, sub? }]   state ∈ pending|active|done|failed|blocked
//   terminal: 'succeeded' | 'failed' | 'deploy_failed' | 'paused' | null
export function deriveBuildTasks(cycle, job) {
  if (!cycle) {
    return { tasks: [], done: 0, total: BUILD_PHASES.length, remaining: BUILD_PHASES.length, terminal: null, headline: null };
  }
  const status = cycle.status;
  const phase = job?.phase || null;
  const gates = Array.isArray(cycle.gates) ? cycle.gates : [];
  const deploy = cycle.deploy_status || null;

  // A soft-paused cycle is 'interrupted' + pause_reason: a resumable checkpoint,
  // NOT a failure — so it doesn't paint the task list red; its current step reads
  // as blocked (paused), waiting on a Resume.
  const paused = status === 'interrupted' && !!cycle.pause_reason;
  const succeeded = status === 'succeeded';
  const failed = FAILED_STATUSES.includes(status) && !paused;
  const blocked = BLOCKED_STATUSES.includes(status) || paused;
  const deployFailed = deploy === 'deploy_failed';
  const terminal = succeeded
    ? 'succeeded'
    : deployFailed ? 'deploy_failed'
      : paused ? 'paused'
        : failed ? 'failed' : null;

  const cur = currentOrdinal({ status, phase, gates, deploy });

  const tasks = BUILD_PHASES.map((p, i) => {
    let state;
    if (succeeded) {
      // Everything ran; a skipped deploy (placeholder project) still reads "done".
      state = 'done';
    } else if (i < cur) {
      state = 'done';
    } else if (i > cur) {
      state = 'pending';
    } else if (blocked) {
      state = 'blocked';
    } else if (failed || (p.key === 'deploy' && deployFailed)) {
      state = 'failed';
    } else {
      state = 'active';
    }

    let detail = null;
    if (state === 'active') {
      // The live "Step N · …" runner line is the best in-phase detail we have.
      detail = (p.key === 'build' && job?.message) ? job.message
        : (p.key === 'deploy' && job?.message) ? job.message
          : p.active;
    } else if (state === 'blocked') {
      detail = paused
        ? 'Paused on a token/time budget — resume to continue'
        : status === 'awaiting_admin'
          ? 'Waiting on an admin to resolve a framework deviation'
          : 'Waiting on you to confirm a rule question in the chat';
    }

    // The verify phase expands into the individual gates so the user watches
    // them go green one by one.
    const sub = p.key === 'verify' && gates.length
      ? gates.map((g) => ({
        key: g.name,
        label: g.name,
        state: succeeded ? 'done' : gateState(g.status),
      }))
      : undefined;

    return { key: p.key, label: p.label, state, detail, sub };
  });

  const done = tasks.filter((t) => t.state === 'done').length;
  const total = tasks.length;
  const remaining = terminal ? 0 : Math.max(0, total - done);
  const activeTask = tasks.find((t) => t.state === 'active' || t.state === 'blocked') || null;
  const headline = succeeded
    ? 'Build complete'
    : deployFailed ? 'Deploy failed'
      : paused ? 'Build paused'
        : failed ? 'Build stopped'
          : activeTask ? activeTask.label : 'Starting…';

  return { tasks, done, total, remaining, terminal, headline };
}
