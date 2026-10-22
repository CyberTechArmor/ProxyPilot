// Mock2 task continuity — PURE decision layer. Native-free, unit-tested
// stub-first (risk R9): imports nothing that opens a DB, hits the network, or
// touches Incus (harness-safety.js and continuity-convention.js are pure too).
//
// A TASK is what Flightdeck remembers independently of the chat: one build per
// mock2_requests row, or one ask-lane investigation. The database row
// (mock2_tasks, migration 562; store in tasks.js) is authoritative for what ran
// and what was authorized; the portable files under state/tasks/<key>/
// (task-files.js writes them) are a mirror that authorizes nothing. Everything
// decidable without the DB lives here: the task key, redaction, the cycle →
// task status table, how "continue" / "stop" / "only explain" route before the
// model receives its tools, what is uncertain after a crash, and the exact
// text of task.json, handoff.md and the resume-context recovery section.
//
// Terminology (risk R7): the AI build component is the RUNNER; nothing here is
// named "agent" (AGENTS.md is a file name owned by continuity-convention.js).

import { redactSecrets } from './harness-safety.js';
import { TASK_SCHEMA, taskJsonPath, taskHandoffPath } from './continuity-convention.js';

export const TASK_INTENTS = Object.freeze(['build', 'investigation']);
export const TASK_STATUSES = Object.freeze(['active', 'interrupted', 'blocked', 'failed', 'completed', 'stopped']);
export const UNFINISHED_TASK_STATUSES = Object.freeze(['active', 'interrupted', 'blocked', 'failed']);
export const FINISHED_TASK_STATUSES = Object.freeze(['completed', 'stopped']);
// "continue" never reaches back further than this: a week-old interrupted task
// is more likely forgotten than meant, and resuming it would spend budget on
// something the person did not have in mind.
export const CONTINUATION_STALE_DAYS = 7;
export const MAX_COMPLETED_STEPS = 30;
export const MAX_UNCERTAIN = 8;
export const RECOVERY_SECTION_MAX = 3000;
export const MAX_GUIDANCE_CHARS = 500;
export const TASK_KEY_RE = /^t\d{1,10}-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const TASK_AUTHORITY_NOTE = 'ProxyPilot database. This file is a portable mirror; it authorizes nothing.';
export const DEFAULT_TASK_FOLDER = '/srv/app';

// Field bounds. The files are committed into the project's repo, so every
// free-text field is clipped as well as redacted.
const GOAL_MAX = 500;
const STEP_MAX = 300;
const ITEM_MAX = 500;
const LIST_LIMITS = Object.freeze({ blockers: 10, remaining: 30, uncertain: MAX_UNCERTAIN, checks: 40 });

const nowIso = () => new Date().toISOString();
const DAY_MS = 86_400_000;

// ---- key / slug ----

// Secret shapes beyond harness-safety's model-key list: what a person pastes
// into a chat message ("the token=… is wrong", a curl with a Bearer header, a
// PEM key). Values only — the key name stays so the sentence still reads.
const PEM_PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
// A Bearer value must look like a token (8+ chars with a digit or symbol), so
// prose such as "Bearer authentication" survives.
const BEARER_RE = /\b(Bearer)\s+(?=[A-Za-z0-9\-._~+/]*[0-9\-._~+/])[A-Za-z0-9\-._~+/]{8,}=*/gi;
const ASSIGNED_SECRET_RE = /\b([A-Za-z0-9_]*?(?:password|passwd|token|secret|api[_-]?key))(\s*=(?!=)\s*)("[^"]*"|'[^']*'|[^\s&;,'"]+)/gi;
const JSON_SECRET_RE = /("[A-Za-z0-9_]*?(?:password|passwd|token|secret|api[_-]?key)[A-Za-z0-9_]*"\s*:\s*)"[^"]*"/gi;

function redactTaskSecrets(text) {
  return redactSecrets(String(text ?? ''))
    .replace(PEM_PRIVATE_KEY_RE, '[REDACTED PRIVATE KEY]')
    .replace(BEARER_RE, '$1 [REDACTED]')
    .replace(JSON_SECRET_RE, '$1"[REDACTED]"')
    .replace(ASSIGNED_SECRET_RE, '$1$2[REDACTED]');
}

// sanitizeTaskText — redact, trim, clip with '…'. Redaction runs BEFORE the
// clip so a secret straddling the cut is still masked whole.
export function sanitizeTaskText(text, { max = 2000 } = {}) {
  const s = redactTaskSecrets(text).trim();
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (s.length <= limit) return s;
  if (limit <= 1) return s.slice(0, limit);
  return `${s.slice(0, limit - 1).trimEnd()}…`;
}

// One line for a markdown bullet / a note: newlines collapsed.
function oneLine(text, max) {
  return sanitizeTaskText(String(text ?? '').replace(/\s+/g, ' '), { max });
}

// slug = goal lowercased, runs of non [a-z0-9] → '-', trimmed of '-', max 40
// (trailing '-' trimmed again after the cut), fallback 'task'. Redacted first:
// the slug becomes a folder name in the repo and a word in a commit message.
export function slugifyGoal(goal) {
  const slug = redactTaskSecrets(goal)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'task';
}

export function makeTaskKey(id, goal) {
  const n = Math.trunc(Number(id));
  return `t${Number.isFinite(n) && n >= 0 ? n : 0}-${slugifyGoal(goal)}`;
}

export function isValidTaskKey(key) {
  return typeof key === 'string' && TASK_KEY_RE.test(key);
}

// ---- hydrate ----

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' || typeof v === 'number').map(String);
}

function stepList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((s) => s && typeof s === 'object' && s.step != null)
    .map((s) => ({ step: String(s.step), at: s.at == null ? null : String(s.at) }));
}

function checkList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((c) => c && typeof c === 'object' && c.key != null)
    .map((c) => ({ key: String(c.key), status: c.status == null ? null : String(c.status) }));
}

const numOrNull = (v) => (v == null || v === '' ? null : Number(v));

// DB row → camelCase task. Bad JSON never throws: a damaged column reads as
// empty ([] / null) so one bad row cannot take down the chat poll.
export function hydrateTask(row) {
  if (!row || typeof row !== 'object') return null;
  const ctx = parseJson(row.context_json, null);
  return {
    id: Number(row.id),
    key: row.task_key ?? null,
    projectId: Number(row.project_id),
    intent: row.intent,
    status: row.status,
    goal: row.goal ?? '',
    requestId: numOrNull(row.request_id),
    lastCycleId: numOrNull(row.last_cycle_id),
    authorizedBy: numOrNull(row.authorized_by),
    authorizedAt: row.authorized_at ?? null,
    folder: row.folder ?? null,
    branch: row.branch ?? null,
    lastVerifiedStep: row.last_verified_step ?? null,
    nextStep: row.next_step ?? null,
    completedSteps: stepList(parseJson(row.completed_steps_json, [])),
    checks: checkList(parseJson(row.checks_json, [])),
    blockers: stringList(parseJson(row.blockers_json, [])),
    remaining: stringList(parseJson(row.remaining_json, [])),
    uncertain: stringList(parseJson(row.uncertain_json, [])),
    context: ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : null,
    revision: Number(row.revision ?? 1),
    filesRevision: Number(row.files_revision ?? 0),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    finishedAt: row.finished_at ?? null,
  };
}

// ---- cycle → task status ----

const LIVE_CYCLE_STATUSES = Object.freeze(['queued', 'estimating', 'running']);
// sweepMock2OnBoot (db.js) fails every running/estimating cycle with exactly
// this error. The build did not fail — the process died under it.
const ORPHANED_BY_RESTART = 'orphaned by restart';
const RESUME_FROM_CHECKPOINT = 'Resume from the last checkpoint';

// The task status a build cycle row implies (the table in the spec). Returns
// null for a status this layer does not know, so a new cycle status never
// silently rewrites a task.
export function buildTaskStatusFromCycle(cycle) {
  if (!cycle || typeof cycle !== 'object') return null;
  const error = cycle.error ? sanitizeTaskText(cycle.error, { max: ITEM_MAX }) : '';
  const out = (status, { blockers = [], nextStep = null, canResume = false } = {}) => ({ status, blockers, nextStep, canResume });
  switch (cycle.status) {
    case 'queued':
    case 'estimating':
    case 'running':
      return out('active');
    case 'awaiting_user':
      // A pending/verified live checklist is the calm "built, now check it
      // in the real app" end (cycle-logic.queueMayAdvancePast) — done, not blocked.
      if (['pending', 'verified'].includes(cycle.verification_state)) {
        return out('completed', { nextStep: cycle.verification_state === 'pending' ? 'Verify the change in the live app' : null });
      }
      return out('blocked', { blockers: ['Waiting for answers to open questions'] });
    case 'awaiting_admin': {
      const reason = cycle.halt_reason ? sanitizeTaskText(cycle.halt_reason, { max: ITEM_MAX }) : error;
      return out('blocked', { blockers: [reason || 'Waiting for an administrator'], canResume: true });
    }
    case 'refused_quota':
      return out('blocked', { blockers: [error ? `Over budget — ${error}` : 'Over budget'], canResume: true });
    case 'interrupted':
      return out('interrupted', { nextStep: RESUME_FROM_CHECKPOINT, canResume: true });
    case 'failed':
      if (String(cycle.error || '').trim() === ORPHANED_BY_RESTART) {
        return out('interrupted', { nextStep: RESUME_FROM_CHECKPOINT, canResume: true });
      }
      return out('failed', { blockers: [error || 'The build failed'], canResume: true });
    case 'abandoned':
      return out('stopped', { canResume: true });
    case 'succeeded':
      return out('completed');
    default:
      return null;
  }
}

// ---- message classification ----

// Whole-message phrase sets, matched after normalisation (lowercase, one space,
// straight apostrophes, polite words and trailing punctuation/emoji stripped).
// Deliberately NOT here: "go ahead" — after a plan it means "build it", which
// must stay an explicit build instruction, never a resume of something older.
const CONTINUE_PHRASES = new Set([
  'continue', 'keep going', 'carry on', 'go on', 'resume', 'proceed', 'try again', 'retry', 'again',
  'finish', 'finish it', 'finish this', 'finish up',
  'finish the build', 'finish the task', 'finish the job', 'finish the work',
  'pick it up', 'pick it back up', 'pick up where you left off', 'continue where you left off',
  'do it again', 'run it again', 'same again',
]);
const STOP_PHRASES = new Set([
  'stop', 'stop it', 'stop that', 'stop the build', 'stop building', 'stop working',
  'cancel', 'cancel it', 'cancel the build', 'abort', 'halt', 'pause', 'pause the build',
  "don't continue", 'do not continue', 'never mind', 'nevermind',
]);
// "Answer, change nothing" — the newer instruction wins. Two shapes only, so a
// build request that merely mentions the words ("make the email field
// read-only", "don't touch the footer, fix the nav") still builds:
//   * a LEADING directive (after the polite words normalizeMessage strips);
//   * a WHOLE-INTENT phrase anywhere ("… Don't change anything.").
const EXPLAIN_ONLY_LEADING_RE = /^(?:only explain|just explain|explain only|only tell me|just tell me|only answer|just answer)\b/i;
const EXPLAIN_ONLY_ANYWHERE_RE = new RegExp(
  "\\b(?:(?:don'?t|do not) (?:change|build|edit) anything|(?:don'?t|do not) make any changes"
  + '|without changing anything|without making any changes|no code changes)\\b',
  'i',
);
const straightApostrophes = (s) => String(s ?? '').replace(/[\u2018\u2019\u02BC]/g, "'");
const GUIDED_CONTINUE_SEP_RE = /^(continue|resume|try again|retry|keep going|finish(?: it| this)?)\s*[,:;—–-]\s*(.+)$/i;
const GUIDED_CONTINUE_WORD_RE = /^(continue|resume|try again|retry|keep going)\s+(?:and|but|with)\s+(.+)$/i;

const EDGE_EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}\s]+|[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}\s]+$/gu;
const TRAILING_PUNCT_RE = /[\s.!?…,;:~)\]]+$/u;
const LEADING_POLITE_RE = /^(?:please|okay|ok)\b[\s,.!:;-]*/i;
const TRAILING_POLITE_RE = /[\s,]+(?:please|okay|ok)$/i;

function normalizeMessage(text) {
  let s = straightApostrophes(text).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 8; i += 1) {
    const before = s;
    s = s.replace(EDGE_EMOJI_RE, '').replace(TRAILING_PUNCT_RE, '').trim();
    s = s.replace(LEADING_POLITE_RE, '').replace(TRAILING_POLITE_RE, '').trim();
    if (s === before) break;
  }
  return s;
}

// classifyContinuationMessage — conservative, WHOLE-message matching for
// continue/stop (a sentence that merely contains "stop" — "stop the timer from
// resetting" — is an instruction, not a stop). Returns { kind, guidance }.
export function classifyContinuationMessage(text) {
  const original = String(text ?? '').trim();
  const core = normalizeMessage(original);
  if (!core) return { kind: 'other', guidance: '' };
  const lower = core.toLowerCase();
  if (STOP_PHRASES.has(lower)) return { kind: 'stop', guidance: '' };
  if (CONTINUE_PHRASES.has(lower)) return { kind: 'continue', guidance: '' };
  if (EXPLAIN_ONLY_LEADING_RE.test(core) || EXPLAIN_ONLY_ANYWHERE_RE.test(straightApostrophes(original).replace(/\s+/g, ' '))) {
    return { kind: 'explain_only', guidance: original };
  }
  const m = core.match(GUIDED_CONTINUE_SEP_RE) || core.match(GUIDED_CONTINUE_WORD_RE);
  if (m) {
    const guidance = m[2].trim();
    if (!guidance) return { kind: 'continue', guidance: '' };
    // A newer explanation-only instruction can follow the continuation phrase.
    // Inspect that clause before a route can resume a build with write tools.
    // Strip only the optional conjunction and ordinary polite words; mentions
    // inside an implementation request ("add a just explain tooltip") stay builds.
    const directive = normalizeMessage(guidance.replace(/^(?:and|but|with)\b[\s,:;—–-]*/i, ''));
    if (EXPLAIN_ONLY_LEADING_RE.test(directive)) return { kind: 'explain_only', guidance: original };
    if (guidance.length <= MAX_GUIDANCE_CHARS) return { kind: 'continue', guidance };
  }
  return { kind: 'other', guidance: '' };
}

// ---- picking a task ----

function updatedMs(task) {
  const ms = Date.parse(task?.updatedAt ?? '');
  return Number.isFinite(ms) ? ms : -Infinity;
}

// Newest first: updatedAt, ties → higher id.
function compareNewest(a, b) {
  const d = updatedMs(b) - updatedMs(a);
  if (d !== 0 && !Number.isNaN(d)) return d;
  return Number(b?.id || 0) - Number(a?.id || 0);
}

function newestOf(tasks) {
  return [...tasks].sort(compareNewest)[0] || null;
}

const isFresh = (task, nowMs) => {
  const ms = updatedMs(task);
  return ms !== -Infinity && nowMs - ms <= CONTINUATION_STALE_DAYS * DAY_MS;
};

// The task "continue" means: an unfinished one, or a stopped one only when it
// is the newest task overall ("stop" … "actually, continue"); never one older
// than CONTINUATION_STALE_DAYS.
export function pickContinuationTask(tasks, { nowMs } = {}) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && typeof t === 'object');
  if (!list.length) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const newest = newestOf(list);
  const candidates = list.filter((t) => UNFINISHED_TASK_STATUSES.includes(t.status) || (t.status === 'stopped' && t === newest));
  return newestOf(candidates.filter((t) => isFresh(t, now)));
}

// The task the chat strip shows: a live one first, else the newest unfinished.
export function pickCurrentTask(tasks) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && typeof t === 'object');
  return newestOf(list.filter((t) => t.live === true))
    || newestOf(list.filter((t) => UNFINISHED_TASK_STATUSES.includes(t.status)));
}

// A task's own canResume annotation wins; without one, the statuses the cycle
// table marks resumable (interrupted / failed / stopped) are.
function resumable(task) {
  if (typeof task?.canResume === 'boolean') return task.canResume;
  return ['interrupted', 'failed', 'stopped'].includes(task?.status);
}

// resolveTaskRoute — what a chat message means for the project's tasks, decided
// BEFORE the model receives its tools. lane: 'build' | 'ask'. An investigation
// is continued read-only in either lane: it never authorizes a build.
export function resolveTaskRoute({ message, lane, tasks, nowMs } = {}) {
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && typeof t === 'object');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const c = classifyContinuationMessage(message);
  const route = (action, task, reason, guidance = '') => ({ action, taskKey: task?.key ?? null, guidance, reason });

  if (c.kind === 'other') return route('pass', null, 'not_a_continuation');

  if (c.kind === 'explain_only') {
    if (lane === 'build') return route('investigate', null, 'explain_only_in_build_lane', c.guidance);
    return route('pass', null, 'explain_only_in_ask_lane');
  }

  if (c.kind === 'stop') {
    const liveBuild = newestOf(list.filter((t) => t.live === true && t.intent === 'build'));
    if (liveBuild) return route('stop_build', liveBuild, 'stop_live_build');
    // An ask has no interrupt: a live investigation finishes its answer (it
    // changes nothing). Say so rather than mark an older task stopped instead.
    const liveInvestigation = newestOf(list.filter((t) => t.live === true));
    if (liveInvestigation) return route('nothing_to_stop', liveInvestigation, 'investigation_cannot_stop');
    const unfinished = newestOf(list.filter((t) => UNFINISHED_TASK_STATUSES.includes(t.status) && isFresh(t, now)));
    if (unfinished) return route('stop_task', unfinished, 'stop_unfinished_task');
    return route('nothing_to_stop', null, 'nothing_running_or_unfinished');
  }

  // continue (± guidance)
  const picked = pickContinuationTask(list, { nowMs: now });
  if (!picked) return route('pass', null, 'no_task_to_continue');
  if (picked.live === true) return route('attach', picked, 'task_already_running', c.guidance);
  if (picked.intent === 'investigation') return route('continue_investigation', picked, 'continue_investigation', c.guidance);
  if (picked.status === 'blocked' && picked.canResume === false) return route('answer_required', picked, 'build_waiting_for_answers', c.guidance);
  if (resumable(picked)) return route('resume_build', picked, 'resume_build', c.guidance);
  return route('pass', null, 'build_not_resumable');
}

// ---- crash evidence ----

const TOOL_SUMMARY_KEYS = Object.freeze(['command', 'cmd', 'path', 'file', 'from', 'url', 'query', 'name']);

function toolCallSummary(meta) {
  const input = meta?.input && typeof meta.input === 'object' ? meta.input : null;
  if (!input) return '';
  for (const k of TOOL_SUMMARY_KEYS) {
    if (typeof input[k] === 'string' && input[k].trim()) return oneLine(input[k], 120);
  }
  let json = '';
  try { json = JSON.stringify(input); } catch { json = ''; }
  return json && json !== '{}' ? oneLine(json, 120) : '';
}

// uncertainFromEvents — operations a stopped cycle may or may not have
// completed, phrased as instructions. Events are cycle-event rows in seq order.
//
// Tool calls: the runner logs a turn's calls, then a result per call, and only
// asks the model again once every call of the turn was handled — so a call
// still unanswered when the NEXT turn starts was handled anyway (some paths,
// e.g. a rejected finish, answer the model without a tool_result event). Only
// the last turn's unanswered calls are uncertain.
export function uncertainFromEvents(events, { cycle } = {}) {
  const out = [];
  const add = (line) => { if (line && !out.includes(line) && out.length < MAX_UNCERTAIN) out.push(line); };
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e === 'object')
    .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
  let pending = [];
  let prevKind = null;
  let deployOpen = false;
  for (const e of list) {
    const meta = e.meta && typeof e.meta === 'object' ? e.meta : {};
    if (e.kind === 'tool_call') {
      if (prevKind !== 'tool_call') pending = [];
      pending.push({ name: String(meta.name || e.content || 'a tool'), summary: toolCallSummary(meta) });
    } else if (e.kind === 'tool_result') {
      const name = meta.name ? String(meta.name) : null;
      const i = name ? pending.findIndex((p) => p.name === name) : -1;
      pending.splice(i >= 0 ? i : 0, pending.length ? 1 : 0);
    } else if (e.kind === 'ai_message' || e.kind === 'gate' || e.kind === 'checkpoint') {
      pending = [];
    }
    if (e.kind === 'deploy') {
      // The runner logs a deploy's OUTCOME (meta.ok true/false); a deploy
      // event without one is a deploy that started and never reported back.
      deployOpen = typeof meta.ok !== 'boolean';
    }
    prevKind = e.kind;
  }
  if (deployOpen || cycle?.deploy_status === 'deploying') {
    add('A deploy was in progress when the build stopped — check whether the app serves the new version before deploying again');
  }
  for (const p of pending) {
    const name = oneLine(p.name, 60) || 'a tool';
    add(`Check whether ${name}${p.summary ? ` (${p.summary})` : ''} completed before repeating it`);
  }
  return out;
}

// ---- runner handoff parsing ----

// A heading is the word alone (markdown/bold allowed) or the word and a colon —
// so a DONE item that starts "Done with the API" stays an item.
const HANDOFF_HEADING_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(done|next steps?|gotchas?)\s*(?:\*\*|__)?\s*(:)?\s*(?:\*\*|__)?\s*(.*)$/i;
const BULLET_RE = /^\s*(?:[-*•]|\d{1,3}[.)])\s+(.*)$/;

// parseHandoffSections — the runner's context handoff (DONE / NEXT STEPS /
// GOTCHAS, any case, optional colons/markdown, bullets or numbered lines) as
// string arrays. Non-bullet lines continue the item above them.
export function parseHandoffSections(text) {
  const sections = { done: [], next: [], gotchas: [] };
  let current = null;
  let lastWasBlank = true;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(HANDOFF_HEADING_RE);
    if (h && (h[2] || !h[3].trim())) {
      const word = h[1].toLowerCase();
      current = word.startsWith('done') ? 'done' : word.startsWith('next') ? 'next' : 'gotchas';
      const rest = h[3].trim();
      if (rest) sections[current].push(rest);
      lastWasBlank = !rest;
      continue;
    }
    if (!current) continue;
    if (!line.trim()) { lastWasBlank = true; continue; }
    const b = line.match(BULLET_RE);
    const items = sections[current];
    if (b) {
      if (b[1].trim()) items.push(b[1].trim());
    } else if (items.length && !lastWasBlank) {
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
    } else {
      items.push(line.trim());
    }
    lastWasBlank = false;
  }
  for (const k of Object.keys(sections)) {
    sections[k] = sections[k].map((s) => oneLine(s, ITEM_MAX)).filter(Boolean);
  }
  return sections;
}

// appendStep — a new list with the step added, newest last, the `max` newest kept.
export function appendStep(steps, step, at, { max = MAX_COMPLETED_STEPS } = {}) {
  const list = stepList(steps);
  const text = oneLine(step, STEP_MAX);
  if (!text) return list.slice(-max);
  list.push({ step: text, at: at ? String(at) : nowIso() });
  return list.slice(-Math.max(1, max));
}

// ---- portable files ----

function cleanStrings(list, maxItems) {
  return stringList(list).map((s) => sanitizeTaskText(s, { max: ITEM_MAX })).filter(Boolean).slice(0, maxItems);
}

const textOrNull = (v, max) => {
  if (v == null) return null;
  const s = sanitizeTaskText(v, { max });
  return s || null;
};

// renderTaskJson — state/tasks/<key>/task.json, schema mock2-task@1. Exactly
// the spec's keys in the spec's order; never authorizedBy, context, or anything
// else that could carry a person's identity or a value.
export function renderTaskJson(task) {
  const t = task || {};
  const doc = {
    schema: TASK_SCHEMA,
    taskId: t.key ?? null,
    intent: t.intent ?? null,
    status: t.status ?? null,
    goal: sanitizeTaskText(t.goal, { max: GOAL_MAX }),
    folder: t.folder || DEFAULT_TASK_FOLDER,
    branch: textOrNull(t.branch, 200),
    requestId: numOrNull(t.requestId),
    lastCycleId: numOrNull(t.lastCycleId),
    lastVerifiedStep: textOrNull(t.lastVerifiedStep, ITEM_MAX),
    nextStep: textOrNull(t.nextStep, ITEM_MAX),
    completedSteps: stepList(t.completedSteps).slice(-MAX_COMPLETED_STEPS)
      .map((s) => ({ step: sanitizeTaskText(s.step, { max: STEP_MAX }), at: s.at })),
    checks: checkList(t.checks).slice(0, LIST_LIMITS.checks)
      .map((c) => ({ key: sanitizeTaskText(c.key, { max: 80 }), status: c.status == null ? null : sanitizeTaskText(c.status, { max: 40 }) })),
    blockers: cleanStrings(t.blockers, LIST_LIMITS.blockers),
    remaining: cleanStrings(t.remaining, LIST_LIMITS.remaining),
    uncertain: cleanStrings(t.uncertain, LIST_LIMITS.uncertain),
    authorization: {
      source: 'person',
      action: t.intent === 'build' ? 'build-request' : 'question',
      at: t.authorizedAt || t.createdAt || null,
    },
    authority: TASK_AUTHORITY_NOTE,
    revision: Number(t.revision ?? 1),
    updatedAt: t.updatedAt ?? null,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const HANDOFF_DONE_SHOWN = 10;

function bullets(items, empty = 'none') {
  return items.length ? items.map((s) => `- ${s}`).join('\n') : `- ${empty}`;
}

// renderTaskHandoffMd — state/tasks/<key>/handoff.md, the short note for the
// next session (layout documented in state/tasks/README.md).
export function renderTaskHandoffMd(task) {
  const t = task || {};
  const steps = stepList(t.completedSteps).slice(-MAX_COMPLETED_STEPS);
  const shown = steps.slice(-HANDOFF_DONE_SHOWN).map((s) => `${oneLine(s.step, STEP_MAX)}${s.at ? ` (${s.at})` : ''}`);
  if (steps.length > shown.length) shown.unshift(`… ${steps.length - shown.length} earlier step(s) in task.json`);
  const list = (v, max) => stringList(v).map((s) => oneLine(s, ITEM_MAX)).filter(Boolean).slice(0, max);
  return [
    `# Task ${t.key ?? 'unknown'} — ${t.intent ?? 'task'} — ${t.status ?? 'unknown'}`,
    '',
    `**Goal:** ${oneLine(t.goal, GOAL_MAX) || '—'}`,
    '',
    `**Last verified step:** ${oneLine(t.lastVerifiedStep, ITEM_MAX) || '—'}`,
    `**Next step:** ${oneLine(t.nextStep, ITEM_MAX) || '—'}`,
    '',
    '## Done',
    bullets(shown),
    '## Remaining',
    bullets(list(t.remaining, LIST_LIMITS.remaining)),
    '## Verify before repeating',
    bullets(list(t.uncertain, LIST_LIMITS.uncertain)),
    '## Blockers',
    bullets(list(t.blockers, LIST_LIMITS.blockers)),
    '',
    'Resume in Flightdeck with "continue" or the Resume button. The ProxyPilot database is authoritative;',
    'this file authorizes nothing. Generated by ProxyPilot — edits are overwritten.',
    '',
  ].join('\n');
}

// ---- resume context ----

const RECOVERY_TAIL = 'Before continuing, inspect the working tree (git status, git diff against the last checkpoint, git log -3), the last check results, and the app\'s state; never repeat a deploy, migration, data change or external call whose outcome is uncertain until you have confirmed whether it already happened.';

// buildRecoverySection — what a RESUMED build reads in its resume context
// before its tools run. Never longer than RECOVERY_SECTION_MAX: the checkpoint
// header, the verify-before-repeating list and the inspection rule always fit;
// the remaining/checks/blockers lists give way first.
export function buildRecoverySection(task) {
  const t = task || {};
  const where = isValidTaskKey(t.key) ? taskJsonPath(t.key) : 'state/tasks/<task>/task.json';
  const head = [
    `TASK CHECKPOINT (${where})`,
    `Goal: ${oneLine(t.goal, 300) || '—'}`,
    `Status: ${t.status ?? 'unknown'}`,
    `Last verified step: ${oneLine(t.lastVerifiedStep, 300) || '—'}`,
    `Next step: ${oneLine(t.nextStep, 300) || '—'}`,
  ].join('\n');
  const uncertain = stringList(t.uncertain).map((s) => oneLine(s, 180)).filter(Boolean).slice(0, MAX_UNCERTAIN);
  const verify = `VERIFY BEFORE REPEATING:\n${uncertain.length ? uncertain.map((s) => `- ${s}`).join('\n') : '- nothing was recorded as uncertain'}`;
  const listBlock = (title, items) => (items.length ? `${title}:\n${items.map((s) => `- ${s}`).join('\n')}` : '');
  let middle = [
    listBlock('Remaining', stringList(t.remaining).map((s) => oneLine(s, 200)).filter(Boolean).slice(0, 12)),
    listBlock('Checks', checkList(t.checks).slice(0, 20).map((c) => `${oneLine(c.key, 60)}: ${oneLine(c.status ?? 'unknown', 30)}`)),
    listBlock('Blockers', stringList(t.blockers).map((s) => oneLine(s, 200)).filter(Boolean).slice(0, 5)),
  ].filter(Boolean).join('\n');
  const fixed = head.length + verify.length + RECOVERY_TAIL.length + 6; // the joining newlines
  const budget = RECOVERY_SECTION_MAX - fixed;
  if (middle.length > budget) middle = budget > 1 ? `${middle.slice(0, budget - 1).trimEnd()}…` : '';
  const out = [head, middle, verify, RECOVERY_TAIL].filter(Boolean).join('\n\n');
  return out.length <= RECOVERY_SECTION_MAX ? out : `${out.slice(0, RECOVERY_SECTION_MAX - 1)}…`;
}

// buildInvestigationContinuation — the ask-lane question for a continued
// investigation. Read-only by construction: it says so to the model, and the
// ask lane has no write tools anyway.
export function buildInvestigationContinuation({ task, guidance } = {}) {
  const t = task || {};
  const excerpt = t.context && typeof t.context.answerExcerpt === 'string' ? sanitizeTaskText(t.context.answerExcerpt, { max: 2500 }) : '';
  const g = sanitizeTaskText(guidance, { max: MAX_GUIDANCE_CHARS });
  return [
    `Continue the earlier investigation: ${oneLine(t.goal, GOAL_MAX) || '(no goal recorded)'}`,
    `What was found so far:\n${excerpt || '(nothing was recorded before it stopped)'}`,
    g ? `Now: ${g}` : '',
    'This is a read-only investigation: answer and propose; do not change code.',
  ].filter(Boolean).join('\n\n');
}

// routedNote — the one plain sentence the chat and the toast show for a route.
export function routedNote(action, task) {
  const goal = oneLine(task?.goal, 80) || 'the task';
  switch (action) {
    case 'resume_build': return `Resuming build: ${goal}`;
    case 'attach': return `Already running: ${goal} — showing its progress`;
    case 'continue_investigation': return `Continuing investigation: ${goal}`;
    case 'investigate': return 'Answering without changing anything';
    case 'stop_build': return `Stopping the build after its current step: ${goal}`;
    case 'stop_task': return `Stopped: ${goal}`;
    case 'nothing_to_stop':
      if (task && task.live === true && task.intent === 'investigation') {
        return `Nothing to stop — the answer to "${goal}" is already being written, and it changes nothing.`;
      }
      return 'Nothing is running to stop.';
    case 'answer_required': return `${goal} is waiting for your answers before it can continue.`;
    default: return '';
  }
}

// publicTaskShape — the snake_case TaskShape routes return and the UI reads.
// No authorized_by and no context: the strip needs neither, and the shape is
// served to every project viewer.
export function publicTaskShape(task, { live = false, resumed = false, canResume = null } = {}) {
  if (!task || typeof task !== 'object') return null;
  const isLive = !!(live || task.live === true);
  const canResumeOut = typeof canResume === 'boolean'
    ? canResume
    : (!isLive && resumable(task));
  const key = task.key ?? null;
  const valid = isValidTaskKey(key);
  return {
    key,
    id: task.id ?? null,
    intent: task.intent ?? null,
    status: task.status ?? null,
    unfinished: UNFINISHED_TASK_STATUSES.includes(task.status),
    goal: task.goal ?? '',
    request_id: task.requestId ?? null,
    last_cycle_id: task.lastCycleId ?? null,
    live: isLive,
    resumed: !!(resumed || task.resumed === true),
    can_resume: canResumeOut,
    last_verified_step: task.lastVerifiedStep ?? null,
    next_step: task.nextStep ?? null,
    remaining: stringList(task.remaining),
    blockers: stringList(task.blockers),
    uncertain: stringList(task.uncertain),
    checks: checkList(task.checks),
    completed_steps: stepList(task.completedSteps).slice(-MAX_COMPLETED_STEPS),
    files: valid ? { task_json: taskJsonPath(key), handoff_md: taskHandoffPath(key) } : null,
    created_at: task.createdAt ?? null,
    updated_at: task.updatedAt ?? null,
    finished_at: task.finishedAt ?? null,
  };
}
