// Task continuity — the words and rules behind the build chat's task strip and
// behind "routed" send answers. Pure (no React, no API) so the copy and the
// state mapping are testable with node --test (tests/task-strip-logic.test.mjs).
//
// The server remembers each build ask and each investigation as a TASK, apart
// from the chat (TaskShape, snake_case; the database is authoritative and the
// project's state/tasks/<key>/ files only mirror it). The chat poll carries the
// one that matters right now as `current_task`, and a send whose words are
// "continue", "try again", "stop" or "only explain" is resolved against it on
// the server and answered with { routed: { action, task, note } } instead of
// the send's usual shape.

// The resume route's limit for the guidance text that rides a Resume.
export const RESUME_GUIDANCE_MAX = 4000;

// Routed actions after which something is running (a resumed build, a
// continued or read-only investigation).
export const ROUTED_WORK_STARTED = new Set(['resume_build', 'continue_investigation', 'investigate']);

// The parent re-polls its cycle when work started AND when the routed action
// points at or changes the live build ('attach' = "it is already running, look
// here"; 'stop_build' = the same effect as Interrupt, which refreshes too).
const ROUTED_REFRESH_PARENT = new Set([...ROUTED_WORK_STARTED, 'attach', 'stop_build']);

// Said when the server's note is missing — never leave a send unexplained.
const ROUTED_FALLBACK_NOTES = {
  resume_build: 'Resuming the build',
  attach: 'Already running — showing its progress',
  continue_investigation: 'Continuing the investigation',
  investigate: 'Answering without changing anything',
  stop_build: 'Stopping the build after its current step',
  stop_task: 'Stopped',
  nothing_to_stop: 'Nothing is running to stop.',
  answer_required: 'Waiting for your answers before it can continue.',
};

// The routed answer inside a send's response, or null for an ordinary answer.
// Any object under `routed` counts: its presence means the server did NOT do
// the send's normal thing, so the caller must not read the normal fields.
export function routedOf(res) {
  const routed = res && typeof res === 'object' ? res.routed : null;
  return routed && typeof routed === 'object' ? routed : null;
}

export function routedNoteText(routed) {
  const note = typeof routed?.note === 'string' ? routed.note.trim() : '';
  if (note) return note;
  return ROUTED_FALLBACK_NOTES[routed?.action] || 'Done';
}

export function routedRefreshesParent(action) {
  return ROUTED_REFRESH_PARENT.has(action);
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const texts = (v) => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);

// TaskShape → what the strip shows, or null when nothing is shown (no task,
// stopped, completed, or a status this build does not know).
//   state      — stable machine name (data attribute + tests)
//   tone       — colour family
//   label      — "Building", "Interrupted", …  (always followed by ": subject")
//   subject    — the goal, or the first blocker for a resumable block
//   detail     — the second line at rest (null = none)
//   resumeLabel— the primary button ("Resume" / "Try again"), null = none
//   stop       — 'row' (beside Resume), 'details' (inside the expansion) or null
//   show       — offer "Show" (scroll to the question the task waits on)
//   checkFirst — the verify-before-repeating list (only when not live)
export function describeTask(task) {
  if (!task || typeof task !== 'object') return null;
  const status = task.status;
  if (status === 'stopped' || status === 'completed') return null;
  const goal = text(task.goal) || 'Untitled task';
  const investigation = task.intent === 'investigation';
  const live = task.live === true;
  const next = text(task.next_step);
  const blockers = texts(task.blockers);
  const base = {
    goal, live, investigation, resumeLabel: null, stop: null, show: false, checkFirst: [],
  };

  // Live (or active and about to be): no buttons — the composer's Interrupt
  // and the activity stream already own a running build.
  if (live || status === 'active') {
    const label = investigation ? 'Investigating' : (task.resumed ? 'Resuming build' : 'Building');
    const state = investigation ? 'investigating' : (task.resumed ? 'resuming' : 'building');
    return { ...base, state, tone: 'live', label, subject: goal, detail: null };
  }

  const checkFirst = texts(task.uncertain);
  const canResume = task.can_resume !== false;
  if (status === 'interrupted') {
    return {
      ...base, state: 'interrupted', tone: 'paused', label: 'Interrupted', subject: goal,
      detail: next ? `Next: ${next}` : null,
      resumeLabel: canResume ? 'Resume' : null, stop: 'row', checkFirst,
    };
  }
  if (status === 'failed') {
    // Stop is offered inside the expansion only: the row stays the one action
    // the spec names (Try again), but a failed task the person has given up on
    // must still be dismissable without starting another build.
    return {
      ...base, state: 'failed', tone: 'error', label: 'Stopped with an error', subject: goal,
      detail: blockers[0] || (next ? `Next: ${next}` : null),
      resumeLabel: canResume ? 'Try again' : null, stop: 'details', checkFirst,
    };
  }
  if (status === 'blocked') {
    if (task.can_resume === true) {
      return {
        ...base, state: 'blocked', tone: 'blocked', label: 'Blocked', subject: blockers[0] || goal,
        detail: blockers[0] ? goal : (next ? `Next: ${next}` : null),
        resumeLabel: 'Resume', checkFirst,
      };
    }
    // Waiting on the person (open questions): the question cards in the chat
    // are where it is answered, so the strip points there instead of resuming.
    return {
      ...base, state: 'waiting', tone: 'waiting', label: 'Waiting on you', subject: goal,
      detail: blockers[0] || null, show: true, checkFirst,
    };
  }
  return null;
}

// The expansion's contents. Empty sections are left out; `any` says whether
// there is anything to expand at all (the row is a plain line when not).
export function taskDetails(task) {
  const steps = Array.isArray(task?.completed_steps) ? task.completed_steps : [];
  const done = steps.map((s) => text(s?.step)).filter(Boolean).slice(-5);
  const checks = (Array.isArray(task?.checks) ? task.checks : [])
    .map((c) => ({ key: text(c?.key), status: text(c?.status) }))
    .filter((c) => c.key);
  const out = {
    nextStep: text(task?.next_step),
    lastVerified: text(task?.last_verified_step),
    blockers: texts(task?.blockers),
    remaining: texts(task?.remaining),
    checks,
    done,
    folder: text(task?.files?.task_json).replace(/\/task\.json$/, '/') || null,
  };
  out.any = !!(out.nextStep || out.lastVerified || out.blockers.length || out.remaining.length
    || out.checks.length || out.done.length);
  return out;
}
