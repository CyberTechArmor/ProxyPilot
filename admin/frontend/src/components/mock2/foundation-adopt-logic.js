// Moving a pre-foundation project onto the application foundation — the pure
// rules behind the adoption part of ProjectFoundation.jsx (user decision
// 2026-10-25). No React, no I/O: the readings of the API shapes, the words,
// the request body and the "what can the person do now" decisions live here
// so they can be tested with node --test (tests/foundation-adopt-logic.test.mjs).
//
// The API (built in parallel with this panel, so every reader is tolerant: a
// missing field reads as "not reported", never as a crash or as "done"):
//   POST …/foundation/adopt/plan      editor        → { ok, plan, blockers, plan_token }
//   POST …/foundation/adopt           editor + sudo { plan_token, acknowledge_downtime: true, features? }
//                                                   → 202 { ok, adoption } | 409 { code: 'PLAN_STALE', message }
//   GET  …/foundation/adopt           viewer        → { adoption: null | { id, state, step, steps, error, … } }
//   POST …/foundation/adopt/rollback  editor + sudo → { ok, adoption }
//   POST …/foundation/adopt/resume    editor + sudo → { ok, adoption }

import { DEPENDENT_CAPABILITIES, LOCAL_EMBEDDINGS_WARNING, detailText, formatBytes, formatCount } from './foundation-panel-logic.js';

export const ADOPT_ACTION = 'Move onto the application foundation';
export const ADOPT_INTRO = 'Moving it gives the app the foundation\'s database, file storage and search. '
  + 'You see a check first, and the move can be rolled back.';
export const SAFETY_TEXT = 'A snapshot of the project is taken first, so the move can be rolled back. Nothing is deleted.';
export const STALE_TEXT = 'The project changed after the check, so it was checked again. Review the new plan and confirm again.';
export const PLAN_STALE = 'PLAN_STALE';
export const ACTIVE_ADOPTION_STATES = Object.freeze(['running', 'rolling_back']);
export const ADOPTION_POLL_MS = 3000;

const first = (...vals) => vals.find((v) => v !== undefined && v !== null);
const unique = (list) => [...new Set(list)];

function humanize(id) {
  const s = String(id ?? '').replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function lowerFirst(s) {
  // "About 3 minutes" reads as "about 3 minutes" inside a sentence; an
  // acronym ("DNS …") keeps its capitals.
  return s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

// An elapsed time, exact to the second: "45 s", "2 min 5 s", "1 h 3 min".
export function formatDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return null;
  const s = Math.round(v / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

// An estimate, rounded so it never claims false precision.
function about(seconds) {
  if (seconds < 60) return 'under a minute';
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 6) / 10;
  return `about ${h} hour${h === 1 ? '' : 's'}`;
}

// plan.downtime: a number of seconds, a sentence, or an object with
// { text } / { estimate_seconds } / { min_seconds, max_seconds }.
export function downtimeText(downtime) {
  if (downtime == null) return null;
  if (typeof downtime === 'string') return downtime.trim() || null;
  if (typeof downtime === 'number') return Number.isFinite(downtime) && downtime >= 0 ? about(downtime) : null;
  if (typeof downtime !== 'object') return null;
  const text = first(downtime.text, downtime.summary, downtime.label, downtime.message);
  if (typeof text === 'string' && text.trim()) return text.trim();
  const lo = Number(first(downtime.min_seconds, downtime.low_seconds));
  const hi = Number(first(downtime.max_seconds, downtime.high_seconds));
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo && lo >= 0) {
    if (hi < 60) return 'under a minute';
    const a = Math.max(1, Math.round(lo / 60));
    const b = Math.max(a, Math.round(hi / 60));
    return a === b ? about(hi) : `about ${a}–${b} minutes`;
  }
  const sec = Number(first(downtime.estimate_seconds, downtime.estimated_seconds, downtime.seconds));
  if (Number.isFinite(sec) && sec >= 0) return about(sec);
  const ms = Number(first(downtime.estimate_ms, downtime.ms));
  if (Number.isFinite(ms) && ms >= 0) return about(ms / 1000);
  return null;
}

export function ackText(downtime) {
  return downtime
    ? `I understand the app is offline for ${lowerFirst(downtime)} during the move.`
    : 'I understand the app is offline during the move.';
}

// ---------------------------------------------------------------------------
// Blockers — a plain reason plus the next step. The server's own next step
// wins; known kinds of code get theirs; anything else still gets one.
// ---------------------------------------------------------------------------

const NEXT_STEP = Object.freeze([
  [/ARCHIVED/, 'Unarchive the project, then check again.'],
  [/DISK|SPACE|STORAGE_FULL/, 'Free up space on the host or give the container more disk, then check again.'],
  [/OFFLINE|NOT_ONLINE|STOPPED|ASLEEP|NOT_RUNNING|^(FOUNDATION|PROJECT)_UNAVAILABLE$/, 'Wake the project, then check again.'],
  [/RUNNING|BUSY|IN_PROGRESS|LOCKED/, 'Wait for it to finish, then check again.'],
  [/ALREADY/, 'Nothing to move. Reload the page.'],
]);
export const GENERIC_NEXT_STEP = 'Fix this, then check again.';

export function blockerNextStep(blocker) {
  const own = blocker && typeof blocker === 'object'
    ? first(blocker.next_step, blocker.next, blocker.hint, blocker.action_text)
    : null;
  if (typeof own === 'string' && own.trim()) return own.trim();
  const code = String((blocker && typeof blocker === 'object' && blocker.code) || '').toUpperCase();
  for (const [re, text] of NEXT_STEP) if (code && re.test(code)) return text;
  return GENERIC_NEXT_STEP;
}

export function blockerView(blocker) {
  if (typeof blocker === 'string') return { code: null, message: blocker.trim(), next: GENERIC_NEXT_STEP };
  if (!blocker || typeof blocker !== 'object') return { code: null, message: '', next: GENERIC_NEXT_STEP };
  const message = String(first(blocker.message, blocker.reason, blocker.text) ?? (blocker.code ? humanize(blocker.code) : '')).trim();
  return { code: blocker.code ? String(blocker.code) : null, message, next: blockerNextStep(blocker) };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const STEP_TITLE = Object.freeze({
  snapshot: 'Take a snapshot',
  take_snapshot: 'Take a snapshot',
  stop_app: 'Stop the app',
  install_stack: 'Install the foundation stack',
  provision_stack: 'Install the foundation stack',
  start_stack: 'Start the foundation stack',
  copy_database: 'Copy the database',
  dump_database: 'Copy the database',
  migrate_database: 'Copy the database',
  restore_database: 'Load the database into the foundation',
  verify_database: 'Check the copied database',
  move_secrets: 'Move secrets into encrypted storage',
  seal_secrets: 'Move secrets into encrypted storage',
  add_foundation_module: 'Add the foundation module to the app',
  scaffold: 'Add the foundation module to the app',
  start_app: 'Start the app',
  verify: 'Check the app',
  health_check: 'Check the app',
});

export function stepTitle(name, label) {
  if (typeof label === 'string' && label.trim()) return label.trim();
  const key = String(name ?? '').toLowerCase();
  return STEP_TITLE[key] || humanize(name) || 'Step';
}

const STEP_STATE = Object.freeze({
  pending: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped',
});

function stepView(s, i, now) {
  const step = s && typeof s === 'object' ? s : { name: String(s ?? '') };
  const state = STEP_STATE[step.state] ? step.state : 'pending';
  const start = Date.parse(step.started_at);
  const end = state === 'running' ? now : Date.parse(step.finished_at);
  const name = String(step.name ?? `step_${i + 1}`);
  return {
    name,
    title: stepTitle(name, first(step.label, step.title)),
    state,
    stateLabel: STEP_STATE[state],
    detail: detailText(step.detail),
    durationText: Number.isFinite(start) && Number.isFinite(end) && end >= start && state !== 'pending' ? formatDuration(end - start) : null,
  };
}

// ---------------------------------------------------------------------------
// Plan (POST …/adopt/plan)
// ---------------------------------------------------------------------------

export function featureChoices(features) {
  const f = features && typeof features === 'object' ? features : {};
  const v = (x) => (x === 'off' || x === false ? 'off' : 'on');
  return { storage: v(f.storage), embeddings: v(f.embeddings) };
}

export function planView(res) {
  const r = res && typeof res === 'object' ? res : {};
  const p = r.plan && typeof r.plan === 'object' ? r.plan : {};
  const blockers = (Array.isArray(r.blockers) ? r.blockers : []).map(blockerView).filter((b) => b.message);
  const steps = (Array.isArray(p.steps) ? p.steps : []).map((s, i) => {
    if (typeof s === 'string') return { name: `step_${i + 1}`, summary: s };
    const name = String(s?.name ?? `step_${i + 1}`);
    const summary = first(s?.summary, s?.description, s?.label, s?.title);
    return { name, summary: typeof summary === 'string' && summary.trim() ? summary.trim() : stepTitle(name) };
  });
  const db = p.database && typeof p.database === 'object' ? p.database : {};
  const sizeText = formatBytes(db.size_bytes);
  const tables = Array.isArray(db.tables) ? db.tables.length : (db.tables == null ? NaN : Number(db.tables));
  const tablesText = Number.isFinite(tables) && tables >= 0 ? `${formatCount(tables)} table${tables === 1 ? '' : 's'}` : null;
  const disk = p.disk && typeof p.disk === 'object' ? p.disk : {};
  const free = disk.free_bytes == null ? NaN : Number(disk.free_bytes);
  const needed = disk.needed_bytes == null ? NaN : Number(disk.needed_bytes);
  const freeText = Number.isFinite(free) ? formatBytes(free) : null;
  const neededText = Number.isFinite(needed) ? formatBytes(needed) : null;
  const secrets = unique((Array.isArray(p.secrets_to_move) ? p.secrets_to_move : [])
    .map((s) => (typeof s === 'string' ? s : s?.name))
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim()));
  const warnings = unique((Array.isArray(p.warnings) ? p.warnings : [])
    .map((w) => (typeof w === 'string' ? w : w?.message))
    .filter((w) => typeof w === 'string' && w.trim())
    .map((w) => w.trim()));
  const token = typeof r.plan_token === 'string' && r.plan_token ? r.plan_token : null;
  return {
    blocked: blockers.length > 0,
    blockers,
    steps,
    downtime: downtimeText(p.downtime),
    databaseText: [sizeText, tablesText].filter(Boolean).join(' · ') || null,
    diskText: freeText && neededText ? `${freeText} free · ${neededText} needed` : freeText ? `${freeText} free` : neededText ? `${neededText} needed` : null,
    diskShort: Number.isFinite(free) && Number.isFinite(needed) ? free < needed : false,
    secrets,
    features: featureChoices(p.features),
    warnings,
    token,
    // Without a token there is nothing to confirm against: check again.
    canConfirm: blockers.length === 0 && !!token,
  };
}

// What a feature switch in the plan says under it.
export function featureNote(name, value) {
  if (value === 'off') {
    const lost = (DEPENDENT_CAPABILITIES[name] || []).join(', ');
    return `Off until you turn it on later. Unavailable meanwhile: ${lost}.`;
  }
  return name === 'embeddings'
    ? LOCAL_EMBEDDINGS_WARNING
    : 'Bundled storage inside the app\'s container. You can switch to an external S3 later.';
}

// ---------------------------------------------------------------------------
// Confirm (POST …/adopt)
// ---------------------------------------------------------------------------

export function adoptBody({ token, acknowledge, features } = {}) {
  const errors = {};
  if (!token) errors.token = 'Check the project again first.';
  if (!acknowledge) errors.acknowledge = 'Tick the box to confirm the downtime.';
  const f = featureChoices(features);
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    body: { plan_token: token || null, acknowledge_downtime: true, features: { storage: f.storage, embeddings: f.embeddings } },
  };
}

// The adoption a write answered with; a write that answered none still
// started (or resumed / rolled back) one, so the panel shows it at once and
// the next read fills it in.
export function answeredAdoption(res, fallbackState = 'running', previous = null) {
  const a = res?.adoption && typeof res.adoption === 'object' ? res.adoption : null;
  const base = previous && typeof previous === 'object' ? previous : { steps: [], error: null, rollback_available: false };
  return a ? { ...base, ...a } : { ...base, state: fallbackState, error: null };
}

// ---------------------------------------------------------------------------
// Progress (GET …/adopt)
// ---------------------------------------------------------------------------

const ADOPTION_STATE = Object.freeze({
  running: { label: 'Moving', tone: 'info', title: 'Moving onto the application foundation' },
  succeeded: { label: 'Moved', tone: 'ok', title: 'Moved onto the foundation' },
  failed: { label: 'Stopped', tone: 'bad', title: 'The move stopped' },
  rolling_back: { label: 'Rolling back', tone: 'info', title: 'Rolling back the move' },
  rolled_back: { label: 'Rolled back', tone: 'muted', title: 'The move was rolled back' },
});

export function isAdoptionActive(adoption) {
  return !!adoption && ACTIVE_ADOPTION_STATES.includes(adoption.state);
}

// The state an adoption just ended in, when it was running (or rolling back)
// a moment ago and is not any more.
export function adoptionEnded(prevState, nextState) {
  if (!ACTIVE_ADOPTION_STATES.includes(prevState)) return null;
  if (!nextState || ACTIVE_ADOPTION_STATES.includes(nextState)) return null;
  return nextState;
}

export function adoptionView(adoption, now = Date.now()) {
  if (!adoption || typeof adoption !== 'object') return null;
  const a = adoption;
  const state = typeof a.state === 'string' ? a.state : 'unknown';
  const meta = ADOPTION_STATE[state] || { label: humanize(state) || 'Unknown', tone: 'muted', title: 'Move onto the foundation' };
  const active = ACTIVE_ADOPTION_STATES.includes(state);
  const steps = (Array.isArray(a.steps) ? a.steps : []).map((s, i) => stepView(s, i, now));
  const current = steps.find((s) => s.state === 'running')
    || (a.step ? steps.find((s) => s.name === String(a.step)) : null)
    || steps.find((s) => s.state === 'failed')
    || null;
  const settled = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  const start = Number.isFinite(Date.parse(a.created_at)) ? Date.parse(a.created_at) : Date.parse(a.steps?.[0]?.started_at);
  const end = active ? now : Date.parse(a.finished_at);
  const elapsed = Number.isFinite(start) && Number.isFinite(end) && end >= start ? formatDuration(end - start) : null;
  const rollbackAvailable = a.rollback_available === true;
  const resumeFlag = first(a.resume_available, a.resumable);
  const canResume = state === 'failed' && (typeof resumeFlag === 'boolean' ? resumeFlag : true);
  const canRollback = rollbackAvailable && (state === 'failed' || state === 'succeeded');
  let outcome = null;
  if (state === 'running') outcome = 'You can leave this page. The move keeps going, and this list updates by itself.';
  else if (state === 'rolling_back') outcome = 'The project is going back to the snapshot taken before the move.';
  else if (state === 'succeeded') {
    outcome = 'The app now runs on the foundation: its database, file storage and search.'
      + (rollbackAvailable ? ' You can still roll back to the snapshot taken before the move.' : '');
  } else if (state === 'rolled_back') outcome = 'The project is back as it was before the move. Nothing was deleted.';
  else if (state === 'failed') {
    outcome = 'Nothing is deleted.'
      + (canResume && canRollback ? ' Resume to continue from the failed step, or roll back to the snapshot taken before the move.'
        : canResume ? ' Resume to continue from the failed step.'
          : canRollback ? ' Roll back to the snapshot taken before the move.' : '');
  }
  const error = state === 'failed' ? (detailText(a.error) || 'The move stopped before it finished.') : null;
  // The step list belongs to a move that runs or stopped; a finished move is
  // a short confirmation, and a roll back has no steps of its own.
  const showSteps = (state === 'running' || state === 'failed') && steps.length > 0;
  // The current step's detail, unless the error already says the same.
  const detail = current?.detail || null;
  const currentDetail = detail && !(error && error.toLowerCase().includes(detail.toLowerCase().replace(/\.$/, ''))) ? detail : null;
  return {
    id: a.id == null ? null : String(a.id),
    state,
    label: meta.label,
    tone: meta.tone,
    title: meta.title,
    active,
    steps,
    showSteps,
    current,
    currentDetail,
    progressText: showSteps ? `${settled} of ${steps.length} steps done` : null,
    // null while rolling back: the bar shows that it runs, not how far.
    percent: state === 'running' && steps.length ? Math.round((settled / steps.length) * 100) : null,
    elapsedText: !elapsed ? null
      : state === 'running' ? `${elapsed} so far`
        : state === 'failed' || state === 'succeeded' ? `Took ${elapsed}` : null,
    error,
    canResume,
    canRollback,
    outcome,
  };
}

// Whether an editor may start a (new) move: nothing is under way, the last
// move was rolled back, or it failed with no other way forward.
export function canStartAdoption(adoption, canEdit) {
  if (!canEdit) return false;
  if (!adoption) return true;
  if (adoption.state === 'rolled_back') return true;
  if (adoption.state === 'failed') {
    const v = adoptionView(adoption);
    return !v.canResume && !v.canRollback;
  }
  return false;
}

// What the panel shows once the project runs on the foundation: a move still
// under way or stopped, or the success with its Roll back (while offered, or
// right after it finished on this page).
export function showAdoptionWhenReady(adoption, { justMoved = false } = {}) {
  if (!adoption) return false;
  if (ACTIVE_ADOPTION_STATES.includes(adoption.state) || adoption.state === 'failed') return true;
  return adoption.state === 'succeeded' && (adoption.rollback_available === true || justMoved);
}

export function rollbackCopy(state) {
  return state === 'succeeded'
    ? 'The project goes back to the snapshot taken before the move. Anything the app saved after the move is not in that snapshot. Nothing is deleted.'
    : 'The project goes back to the snapshot taken before the move. Nothing is deleted.';
}
