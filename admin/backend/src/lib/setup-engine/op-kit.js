// Setup engine — what every operation over a guest shares: the contained
// guest executor (every script in the job's cgroup, the containment refusal,
// the fence that is a safe cancel point until the disruptive step) and the
// no-op job handle. deploy-op.js carries its own copy of this wrapper from
// before this module existed; the restores and the retry mint use this one.

import { containedScript, parseContainment, CONTAINMENT_RUN_DIR, CONTAINMENT_UNAVAILABLE_RC } from './guest-probes.js';
import { ContainmentUnavailableError } from './deploy-op.js';

export { ContainmentUnavailableError };

export function noopJob() {
  return { id: null, fence: () => {}, checkpoint: () => 0, generated: () => 0, event: () => {}, onStep: null };
}

export function tailOf(r, n = 800) {
  return `${r?.stdout || ''}${r?.stderr ? `\n${r.stderr}` : ''}`.trim().slice(-n);
}

// containedGuest({ exec, container, job, runDir }) → { guest, markDisruptive,
// containment() }. `guest(phase, script, timeoutMs)` fences (safe until the
// disruptive step), runs the script inside the job's cgroup and throws
// ContainmentUnavailableError when the guest offers no mechanism.
export function containedGuest({ exec, container, job = noopJob(), runDir = CONTAINMENT_RUN_DIR }) {
  const jobId = String(job.id || 'adhoc');
  let disruptive = false;
  let containment = null;
  const guest = async (phase, script, timeoutMs = 90_000) => {
    job.fence({ safe: !disruptive });
    const r = (await exec.guest(container, containedScript(jobId, script, { runDir }), { timeoutMs })) || { code: -1, stdout: '', stderr: 'no result from the guest executor' };
    const c = parseContainment(r.stderr);
    if ((c && c.kind === 'none') || (r.code === CONTAINMENT_UNAVAILABLE_RC && !c)) throw new ContainmentUnavailableError(container, (r.stderr || '').trim().split('\n').filter((l) => !/^CONTAINMENT:/.test(l)).join(' ').slice(0, 200));
    if (c && !containment) { containment = c; job.event?.('containment', `scripts run under ${c.kind}${c.ref ? ` (${c.ref})` : ''}`, { kind: c.kind }); }
    return r;
  };
  return { guest, markDisruptive: () => { disruptive = true; }, containment: () => containment, jobId };
}

// hostArgv(exec) → the host executor as argv arrays only (never a shell
// string), or null when the executor offers none.
export function hostArgv(exec) {
  if (!exec || typeof exec.host !== 'function') return null;
  return async (argv, { timeoutMs = 120_000 } = {}) => {
    if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) throw new Error('host commands are argv arrays of strings');
    const r = await exec.host(argv, { timeoutMs });
    return r || { code: -1, stdout: '', stderr: 'no result from the host executor' };
  };
}
