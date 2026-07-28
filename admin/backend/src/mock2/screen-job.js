// Mock2 SCREEN WORK — live progress for the things that drive a browser.
//
// WHY THIS EXISTS. The screen check and Design options both take a minute or
// two: launch Chromium, sign in, screenshot at two widths, measure, call a
// model, post to the chat. Both were fire-and-forget. The chat polls only while
// a BUILD cycle is live, an ask is streaming, or a rule question is open — a
// screen check is none of those, so nothing refreshed and the operator's report
// was exactly right: "I had to refresh the page for it to show up."
//
// Worse than the refresh: for those two minutes the product showed no sign of
// working at all. A toast said "running", and then nothing — no way to tell a
// slow capture from a dead one, on the one surface that is a picture of the app
// and therefore the obvious place to say "I am looking at it right now".
//
// So: one in-memory record per project, the same shape and lifetime as the ask
// job (activeAskJobs), exposed on the chat payload and on its own light
// endpoint so the preview can watch it without pulling the whole chat.
//
// In-memory ON PURPOSE. This is progress, not history — the findings land in
// the chat, which is the durable record. A backend restart mid-capture loses
// the progress line and nothing else, and a stale record would be worse than
// no record: it would show a spinner for work that is not happening.
//
// Terminology (risk R7): nothing here is named "agent".

const jobs = new Map();

// A job older than this is a lie: the process that owned it is gone (a restart,
// a crash inside the browser driver). Read-time expiry rather than a timer, so
// there is nothing to clean up and nothing to leak.
export const SCREEN_JOB_MAX_AGE_MS = 10 * 60 * 1000;
// How long a finished job stays visible. Long enough that the operator sees
// "done" rather than the spinner simply vanishing.
export const SCREEN_JOB_DONE_TTL_MS = 20 * 1000;

export const SCREEN_JOB_KINDS = Object.freeze({
  review: 'Screen check',
  options: 'Design options',
});

export function getScreenJob(projectId) {
  const j = jobs.get(Number(projectId));
  if (!j) return null;
  const age = Date.now() - j.updatedAt;
  const done = j.phase === 'done' || j.phase === 'failed';
  if (age > (done ? SCREEN_JOB_DONE_TTL_MS : SCREEN_JOB_MAX_AGE_MS)) {
    jobs.delete(Number(projectId));
    return null;
  }
  return j;
}

// startScreenJob(projectId, kind) → the record. Overwrites any previous one:
// two screen checks on one project is a person pressing twice, and the second
// is the one they are waiting for.
export function startScreenJob(projectId, kind = 'review') {
  const label = SCREEN_JOB_KINDS[kind] || SCREEN_JOB_KINDS.review;
  const job = {
    kind, label, phase: 'starting', message: `${label} starting…`,
    startedAt: Date.now(), updatedAt: Date.now(), shots: 0,
  };
  jobs.set(Number(projectId), job);
  return job;
}

// Progress. `message` is written for a person watching a picture of their app —
// "Screenshotting /notes at 390px", not "phase 3/7".
export function updateScreenJob(projectId, patch = {}) {
  const cur = jobs.get(Number(projectId));
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  jobs.set(Number(projectId), next);
  return next;
}

export function finishScreenJob(projectId, { ok = true, message = '' } = {}) {
  const cur = jobs.get(Number(projectId));
  if (!cur) return null;
  const next = {
    ...cur,
    phase: ok ? 'done' : 'failed',
    message: message || (ok ? `${cur.label} finished — the findings are in the chat.` : `${cur.label} could not finish.`),
    updatedAt: Date.now(),
  };
  jobs.set(Number(projectId), next);
  return next;
}

export function screenJobActive(projectId) {
  const j = getScreenJob(projectId);
  return !!j && j.phase !== 'done' && j.phase !== 'failed';
}

// Test seams only.
//
// _resetScreenJobs: the map is module state, and a test that starts a job would
// otherwise leak it into the next one.
//
// _ageScreenJob: expiry is the one behaviour that cannot be exercised any other
// way — every write stamps `updatedAt` with the current time on purpose, so a
// patch cannot backdate a job and a test would otherwise have to sleep for ten
// minutes.
export function _resetScreenJobs() {
  jobs.clear();
}

export function _ageScreenJob(projectId, ms) {
  const cur = jobs.get(Number(projectId));
  if (!cur) return null;
  const next = { ...cur, updatedAt: cur.updatedAt - Number(ms || 0) };
  jobs.set(Number(projectId), next);
  return next;
}
