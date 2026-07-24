// Lean BEAF Pro ("Pro" for projects) — pure decision logic.
//
// Innovation project management for the Spec Ops team: rollout pipeline
// (Idea → MVP → Testing → Site → POD → Region → All), meeting-to-meeting
// movement tracking, grounded evidence (metric reports, time events,
// feedback, learnings) and an archive with meta-analysis.
//
// No DB / network / clock access in here — everything takes plain data in
// and returns decisions, so the rules (R01–R12, see docs/features/
// lean-beaf-pro.md) are unit-testable without better-sqlite3 (the repo's
// stub-at-the-module-boundary test pattern). DB wiring lives in
// lean-beaf-store.js; HTTP in routes/lean-beaf.js.
//
// Deliberately absent (locked design decisions — do not add): progress
// status, priority, due dates, overdue mechanics. The rollout stage is the
// only lifecycle axis; movement between meetings is the accountability
// mechanism; blockers are activity/comments, not a field.

// ---- stages (R02) ----

export const LBP_STAGES = ['Idea', 'MVP', 'Testing', 'Site', 'POD', 'Region', 'All'];

export function isValidStage(stage) {
  return LBP_STAGES.includes(stage);
}

export function stageIndex(stage) {
  return LBP_STAGES.indexOf(stage);
}

// Stage moves are free in either direction and may skip steps (decided
// default: skipping is allowed and logged). The only invalid transition is
// to a non-stage or a no-op to the same stage.
export function validateStageChange(from, to) {
  if (!isValidStage(to)) return { ok: false, error: `"${to}" is not a rollout stage` };
  if (from === to) return { ok: false, error: 'Project is already at that stage' };
  return { ok: true, skipped: isValidStage(from) ? Math.abs(stageIndex(to) - stageIndex(from)) > 1 : false };
}

// ---- outcome / archive (R08, R09) ----

export const LBP_OUTCOMES = ['rolled_out', 'abandoned'];

export function isArchived(project) {
  return project?.outcome === 'rolled_out' || project?.outcome === 'abandoned';
}

// Close-out flow: reason AND takeaway are both required, outcome is exactly
// one of the two end states (R08).
export function validateCloseOut({ outcome, reason, takeaway }) {
  const errors = [];
  if (!LBP_OUTCOMES.includes(outcome)) errors.push('Outcome must be "rolled_out" or "abandoned"');
  if (!String(reason || '').trim()) errors.push('A reason is required to close a project');
  if (!String(takeaway || '').trim()) errors.push('A key takeaway is required to close a project');
  return errors.length ? { ok: false, errors } : { ok: true };
}

// R09: archived projects are read-only. The route layer calls this before
// every project-scoped mutation; only these actions stay allowed so revive
// (new project + link, R11) and meta work keep functioning.
const ARCHIVE_ALLOWED_ACTIONS = new Set(['link_add', 'link_remove']);
export function assertMutableProject(project, action = 'edit') {
  if (!project) return { ok: false, status: 404, error: 'Project not found' };
  if (isArchived(project) && !ARCHIVE_ALLOWED_ACTIONS.has(action)) {
    return {
      ok: false, status: 409,
      error: 'This project is archived and read-only. Revive it by creating a new project and linking it to this one.',
    };
  }
  return { ok: true };
}

// ---- project creation ----

export function validateNewProject({ name, stage, start_date } = {}) {
  const errors = [];
  if (!String(name || '').trim()) errors.push('A project name is required');
  if (String(name || '').trim().length > 200) errors.push('Project name is too long (max 200 characters)');
  if (stage != null && !isValidStage(stage)) errors.push(`"${stage}" is not a rollout stage`);
  if (start_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(start_date))) {
    errors.push('start_date must be YYYY-MM-DD');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// ---- current location label (derived, never stored) ----

// stage + rollout scope → the 📍 label. locationsById maps id → {name, kind}.
export function deriveLocationLabel({ stage, scope = {}, locationsById = new Map() }) {
  const name = (id) => locationsById.get(id)?.name || null;
  switch (stage) {
    case 'Testing': {
      const t = String(scope.testers_text || '').trim();
      return t ? `Testers: ${t}` : 'Testing — testers not set';
    }
    case 'Site':
      return name(scope.site_id) || 'Site not set';
    case 'POD': {
      const pods = (scope.pod_ids || []).map(name).filter(Boolean);
      const planned = (scope.planned_pod_ids || []).map(name).filter(Boolean);
      if (pods.length === 0) return 'POD not set';
      let label = `POD ${pods.join(' + ')}`;
      if (planned.length) label += ` (planned: ${planned.join(' + ')})`;
      return label;
    }
    case 'Region':
      return name(scope.region_id) || 'Region not set';
    case 'All':
      return 'Everywhere';
    default:
      // Idea / MVP: nothing is live anywhere yet.
      return 'Pre-rollout';
  }
}

// ---- movement (R04) ----

const DAY_MS = 24 * 60 * 60 * 1000;

// A project "moved" iff it has ≥1 activity entry strictly after the current
// meeting marker. No marker yet → everything counts as moved (first meeting
// hasn't happened; there is no baseline to be stalled against). Archived
// projects are excluded by the caller (they are neither moved nor stalled).
export function deriveMovement({ project, markerAt, now = new Date().toISOString() }) {
  const last = project.last_activity_at || project.created_at || null;
  const moved = markerAt ? (last != null && last > markerAt) : true;
  let daysIdle = null;
  if (!moved && last) {
    daysIdle = Math.max(0, Math.floor((new Date(now).getTime() - new Date(last).getTime()) / DAY_MS));
  }
  return { moved, days_idle: daysIdle };
}

// Human-readable "what actually changed" lines for the Since-last-meeting
// list, from raw activity entries (payloads already parsed).
export function summarizeActivityEntries(entries = []) {
  const lines = [];
  for (const e of entries) {
    const p = e.payload || {};
    switch (e.type) {
      case 'stage_change': lines.push(`Stage ${p.from} → ${p.to}`); break;
      case 'scope_change': lines.push(p.summary || 'Rollout scope updated'); break;
      case 'task_done': lines.push(`Task done: ${p.title || ''}`.trim()); break;
      case 'metric_report': lines.push(`Reported ${p.metric || 'a metric'}: ${p.value ?? ''} ${p.unit || ''}`.trim()); break;
      case 'file_added': lines.push(`File added: ${p.name || ''}`.trim()); break;
      case 'feedback_added': lines.push(`Feedback captured (${p.sentiment || 'noted'})`); break;
      case 'learning_added': lines.push('Learning recorded'); break;
      case 'blocked': lines.push(`Blocked${p.reason ? `: ${p.reason}` : ''}`); break;
      case 'unblocked': lines.push('Barrier broken (unblocked)'); break;
      case 'outcome_set': lines.push(p.outcome === 'rolled_out' ? 'Closed — rolled out ✓' : 'Closed — abandoned ✕'); break;
      case 'time_event': lines.push(`${p.event_type || 'Time'} logged${p.hours ? ` (${p.hours}h)` : ''}`); break;
      case 'lxc_linked': lines.push('Linked to an LXC build project'); break;
      case 'link_added': lines.push('Related project linked'); break;
      case 'comment': lines.push('Comment added'); break;
      case 'created': lines.push('Project created'); break;
      default: lines.push('Updated'); break;
    }
  }
  return lines;
}

// ---- meeting schedule (R05) ----

// Schedule {active, frequency 'daily'|'weekly', day_of_week 0(Sun)–6 (weekly
// only), time_hhmm 'HH:MM'} → the most recent occurrence at-or-before `now`
// (Date), or null. Pure (no clock); the store passes now and compares to the
// latest marker to decide whether to lazily materialize a schedule marker.
// Frequency defaults to 'weekly' so pre-703 callers keep their behavior.
// Time (and weekly day_of_week) are interpreted in UTC, NOT the server's local
// timezone — so a schedule fires at the same absolute instant regardless of
// where the server runs, and the client formats it into the viewer's own
// timezone for display. (Interpreting in server-local time made "13:45" fire at
// an instant that then rendered as a different wall-clock on the client.)
export function latestScheduleOccurrence(schedule, now) {
  if (!schedule || !schedule.active) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(String(schedule.time_hhmm || ''));
  if (!m) return null;
  const occ = new Date(now.getTime());
  occ.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  const freq = schedule.frequency || 'weekly';
  if (freq === 'daily') {
    // Today's occurrence, or yesterday's if today's time hasn't arrived yet.
    if (occ.getTime() > now.getTime()) occ.setUTCDate(occ.getUTCDate() - 1);
    return occ;
  }
  const dow = Number(schedule.day_of_week);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
  // Walk back to the scheduled weekday (0..6 days), then one more week if
  // today's occurrence is still in the future.
  const back = (occ.getUTCDay() - dow + 7) % 7;
  occ.setUTCDate(occ.getUTCDate() - back);
  if (occ.getTime() > now.getTime()) occ.setUTCDate(occ.getUTCDate() - 7);
  return occ;
}

// Should a single schedule auto-mark now? Only when its latest occurrence is
// newer than the latest existing marker — markers accumulate as history and
// never delete anything (R05). Kept for callers that pass one schedule.
export function dueScheduleMarker({ schedule, lastMarkerAt, now }) {
  const occ = latestScheduleOccurrence(schedule, now);
  if (!occ) return null;
  if (lastMarkerAt && new Date(lastMarkerAt).getTime() >= occ.getTime()) return null;
  return occ.toISOString();
}

// Across MANY active schedules: the distinct occurrence timestamps that are
// newer than the latest marker and should each become a schedule marker.
// Sorted ascending, deduped (a daily + weekly landing on the same minute is
// one meeting). At most one per schedule per call — no backfilling every
// missed occurrence.
export function dueScheduleMarkers({ schedules = [], lastMarkerAt = null, now }) {
  const cutoff = lastMarkerAt ? new Date(lastMarkerAt).getTime() : null;
  const seen = new Set();
  const out = [];
  for (const s of schedules) {
    const occ = latestScheduleOccurrence(s, now);
    if (!occ) continue;
    if (cutoff != null && cutoff >= occ.getTime()) continue;
    const iso = occ.toISOString();
    if (seen.has(iso)) continue;
    seen.add(iso);
    out.push(iso);
  }
  return out.sort();
}

// Human summary of the active schedules for the meeting bar.
export function describeSchedules(schedules = []) {
  const active = schedules.filter((s) => s.active);
  if (active.length === 0) return null;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return active
    .map((s) => (s.frequency === 'daily' ? `Daily ${s.time_hhmm}` : `${DOW[s.day_of_week] || '?'} ${s.time_hhmm}`))
    .join(' · ');
}

// ---- briefs list (Briefs page: daily + between-meeting notes) ----

// Grounded summary of movement in a time window (from, to]. `from`/`to` are
// ISO strings or null (open-ended). Each moved project cites the activity ids
// behind it (R07). Comments (the "notes between meetings") are included via
// summarizeActivityEntries.
export function buildWindowBrief({ from = null, to = null, label = '', projects = [], activityEntries = [] }) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const inWindow = (iso) => (from ? iso > from : true) && (to ? iso <= to : true);
  const recent = activityEntries.filter((e) => inWindow(e.created_at));
  const grouped = new Map();
  for (const e of recent) {
    if (!grouped.has(e.project_id)) grouped.set(e.project_id, []);
    grouped.get(e.project_id).push(e);
  }
  const moved = [...grouped.entries()]
    .filter(([id]) => byId.has(id))
    .map(([id, entries]) => ({
      project_id: id,
      name: byId.get(id)?.name || `#${id}`,
      archived: isArchived(byId.get(id)),
      changes: summarizeActivityEntries(entries),
      activity_ids: entries.map((e) => e.id),
    }));
  const text = moved.length
    ? `${moved.length} project${moved.length === 1 ? '' : 's'} moved (${recent.length} update${recent.length === 1 ? '' : 's'}).`
    : 'No movement recorded in this window.';
  return { from, to, label, moved, entry_count: recent.length, text };
}

// The Briefs feed: a "Today" daily brief plus one brief per meeting-to-meeting
// period, newest first. `markers` are newest-first {marked_at}. Every figure
// traces to an activity record (R07).
export function buildBriefsFeed({ markers = [], projects = [], activityEntries = [], now = new Date().toISOString() }) {
  const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
  const today = buildWindowBrief({ from: dayStart, to: null, label: 'Today', projects, activityEntries });
  const periods = [];
  const latestAt = markers[0]?.marked_at || null;
  periods.push(buildWindowBrief({
    from: latestAt, to: null,
    label: latestAt ? 'Since last meeting' : 'Since the start',
    projects, activityEntries,
  }));
  for (let i = 0; i < markers.length; i++) {
    periods.push(buildWindowBrief({
      from: markers[i + 1]?.marked_at || null,
      to: markers[i].marked_at,
      label: 'Meeting period',
      projects, activityEntries,
    }));
  }
  return { today, periods };
}

// ---- metrics (R06) ----

export const LBP_METRIC_UNITS = ['count', 'hours', 'currency', 'percent'];
export const LBP_TIME_EVENT_TYPES = ['Work session', 'Training', 'Site visit', 'Go-live', 'Meeting'];
export const LBP_SENTIMENTS = ['positive', 'neutral', 'needs_work'];

// A metric report needs an ACTIVE catalog metric, a numeric value, and at
// least one source (text / url / file). Reports are immutable — corrections
// are new reports referencing the old one (corrects_report_id).
export function validateMetricReport({ definition, value, source_text, source_url, file_id } = {}) {
  const errors = [];
  if (!definition) errors.push('Pick a metric from the catalog');
  else if (definition.status !== 'active') errors.push(`"${definition.name}" is not approved yet — an admin must approve it before first use`);
  if (value == null || Number.isNaN(Number(value))) errors.push('A numeric value is required');
  const hasSource = String(source_text || '').trim() || String(source_url || '').trim() || file_id != null;
  if (!hasSource) errors.push('A source is required — where does this number come from? (text, link or file)');
  return errors.length ? { ok: false, errors } : { ok: true };
}

// New metric definitions: members propose (status 'proposed'), a workspace
// admin approves before first use. An admin creating one activates it
// immediately.
export function newMetricDefinitionStatus({ isAdmin }) {
  return isAdmin ? 'active' : 'proposed';
}

// ---- blockers (operator addition: blocked flag + break-barrier audit) ----

// Flag a blocker: a reason is required; the date defaults to today and is
// editable but must be a plain YYYY-MM-DD. Breaking the barrier (resolve)
// takes an optional date, same shape.
export function validateBlocker({ reason, date } = {}) {
  const errors = [];
  if (!String(reason || '').trim()) errors.push('A reason is required to flag a blocker');
  if (date != null && date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    errors.push('The blocker date must be YYYY-MM-DD');
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function validateBreakBarrier({ date } = {}) {
  if (date != null && date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return { ok: false, errors: ['The resolved date must be YYYY-MM-DD'] };
  }
  return { ok: true };
}

// Days a blocker stood open (blocked_at → resolved_at, or → now if still open).
export function blockerDurationDays(blocker, now = new Date().toISOString()) {
  if (!blocker?.blocked_at) return null;
  const end = blocker.resolved_at || now.slice(0, 10);
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(blocker.blocked_at).getTime()) / DAY_MS));
}

// ---- feedback (decided default: author-editable for 24h, then locked) ----

const FEEDBACK_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export function canEditFeedback({ feedback, userId, now = new Date().toISOString() }) {
  if (!feedback) return false;
  if (String(feedback.captured_by) !== String(userId)) return false;
  const age = new Date(now).getTime() - new Date(feedback.captured_at).getTime();
  return age <= FEEDBACK_EDIT_WINDOW_MS;
}

// ---- project links (R11) ----

// Links are one row per pair, rendered bidirectionally. Canonicalize so
// (a,b) and (b,a) collide on the UNIQUE index.
export function canonicalLinkPair(a, b) {
  const x = Number(a); const y = Number(b);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x <= 0 || y <= 0) {
    return { ok: false, error: 'Both projects are required for a link' };
  }
  if (x === y) return { ok: false, error: 'A project cannot be linked to itself' };
  return { ok: true, a: Math.min(x, y), b: Math.max(x, y) };
}

// ---- idea checker (R10) ----

const tokenize = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

// Live idea checker: fires at ≥3 typed chars, searches ALL projects ever
// (active + archived) across name, description, learnings and outcome
// notes. Each candidate: {id, name, description, stage, outcome,
// outcome_reason, outcome_takeaway, learnings: [body]}. Returns up to
// `limit` matches, best first, each with a how-it-went line.
export function ideaCheckMatches(query, candidates = [], { limit = 5 } = {}) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];
  const qTokens = tokenize(q);
  if (qTokens.length === 0) return [];
  const scored = [];
  for (const c of candidates) {
    const name = String(c.name || '').toLowerCase();
    const hayFields = [
      [name, 5],
      [String(c.description || '').toLowerCase(), 2],
      [(c.learnings || []).join(' ').toLowerCase(), 2],
      [String(c.outcome_reason || '').toLowerCase(), 2],
      [String(c.outcome_takeaway || '').toLowerCase(), 2],
    ];
    let score = 0;
    if (name.includes(q.toLowerCase())) score += 10;
    for (const t of qTokens) {
      for (const [hay, w] of hayFields) {
        if (hay.includes(t)) score += w;
      }
    }
    if (score > 0) scored.push({ candidate: c, score });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit).map(({ candidate: c, score }) => ({
    id: c.id,
    name: c.name,
    stage: c.stage,
    outcome: c.outcome || null,
    score,
    how_it_went: howItWentLine(c),
  }));
}

export function howItWentLine(project) {
  if (project.outcome === 'rolled_out') {
    return `Rolled out at ${project.stage}${project.outcome_takeaway ? ` — ${project.outcome_takeaway}` : ''}`;
  }
  if (project.outcome === 'abandoned') {
    return `Abandoned at ${project.stage}${project.outcome_reason ? ` — ${project.outcome_reason}` : ''}`;
  }
  return `Active — currently at ${project.stage}`;
}

// ---- pipeline + archive rollups (R12: computed from stored records only) ----

export function pipelineCounts(projects = []) {
  const active = projects.filter((p) => !isArchived(p));
  return LBP_STAGES.map((stage) => ({ stage, count: active.filter((p) => p.stage === stage).length }));
}

export function projectSpanDays(project, now = new Date().toISOString()) {
  const start = project.start_date || project.created_at;
  if (!start) return null;
  const end = project.outcome_at || now;
  return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / DAY_MS));
}

export function investedHours(timeEvents = []) {
  return timeEvents.reduce((sum, t) => sum + (Number(t.hours) || 0), 0);
}

// Archive meta tiles: every figure traces to stored rows (R12).
export function archiveMeta({ projects = [], timeEventsByProject = new Map() } = {}) {
  const archived = projects.filter(isArchived);
  const rolledOut = archived.filter((p) => p.outcome === 'rolled_out');
  const abandoned = archived.filter((p) => p.outcome === 'abandoned');
  const hours = archived.reduce(
    (sum, p) => sum + investedHours(timeEventsByProject.get(p.id) || []), 0,
  );
  return {
    ideas_attempted: projects.length,
    rolled_out: rolledOut.length,
    abandoned: abandoned.length,
    hours_invested: Math.round(hours * 10) / 10,
  };
}

// Grounded meta-analysis paragraph — states only numbers present in `meta`
// and the per-outcome arrays (R07/R12). No invented figures.
export function archiveMetaAnalysis({ meta, abandonedProjects = [] }) {
  if (!meta || meta.ideas_attempted === 0) {
    return 'No projects yet — the archive meta-analysis will appear once ideas have been attempted and closed out.';
  }
  const closed = meta.rolled_out + meta.abandoned;
  const parts = [];
  parts.push(`The team has attempted ${meta.ideas_attempted} idea${meta.ideas_attempted === 1 ? '' : 's'}; ${closed} closed out (${meta.rolled_out} rolled out, ${meta.abandoned} abandoned).`);
  if (closed > 0) {
    parts.push(`Success rate among closed projects: ${Math.round((meta.rolled_out / closed) * 100)}%.`);
  }
  if (meta.hours_invested > 0) {
    parts.push(`${meta.hours_invested} logged hours are invested in closed projects.`);
  }
  const deathStages = {};
  for (const p of abandonedProjects) deathStages[p.stage] = (deathStages[p.stage] || 0) + 1;
  const stages = Object.entries(deathStages).sort((a, b) => b[1] - a[1]);
  if (stages.length) {
    parts.push(`Abandoned ideas most often died at ${stages[0][0]} (${stages[0][1]} of ${meta.abandoned}).`);
  }
  return parts.join(' ');
}

// ---- AI briefs (R07: grounded — every number traces to a record id) ----

// Deterministic, record-grounded brief text. Modes: 'daily' (last 24h),
// 'since_meeting', 'leadership'. Inputs are plain rows; metric reports and
// activity entries carry ids, and every figure in the output cites the
// records it came from ([activity #12], [report #3]) so R07 holds by
// construction.
export function buildBrief({
  mode = 'daily',
  projects = [],
  activityEntries = [],   // parsed, each {id, project_id, type, created_at, payload}
  metricReports = [],     // each {id, project_id, value, period_label, metric_name, unit, reported_at}
  markerAt = null,
  now = new Date().toISOString(),
} = {}) {
  const active = projects.filter((p) => !isArchived(p));
  const byId = new Map(projects.map((p) => [p.id, p]));
  const sinceIso = mode === 'daily'
    ? new Date(new Date(now).getTime() - DAY_MS).toISOString()
    : (markerAt || null);
  const windowLabel = mode === 'daily' ? 'the last 24 hours'
    : (markerAt ? 'the last meeting' : 'the start (no meeting marked yet)');

  const inWindow = (iso) => (sinceIso ? iso > sinceIso : true);
  const recent = activityEntries.filter((e) => inWindow(e.created_at));
  const recentByProject = new Map();
  for (const e of recent) {
    if (!recentByProject.has(e.project_id)) recentByProject.set(e.project_id, []);
    recentByProject.get(e.project_id).push(e);
  }

  const lines = [];
  const citations = [];

  if (mode === 'leadership') {
    lines.push(`Leadership report — ${active.length} active innovation project${active.length === 1 ? '' : 's'} in the pipeline.`);
    for (const [stage, count] of Object.entries(Object.fromEntries(pipelineCounts(projects).filter((r) => r.count > 0).map((r) => [r.stage, r.count])))) {
      lines.push(`• ${count} at ${stage}`);
    }
    const reports = metricReports.slice().sort((a, b) => (a.reported_at < b.reported_at ? 1 : -1));
    if (reports.length === 0) {
      lines.push('No metric reports on record yet — impact figures will appear here once reported.');
    } else {
      lines.push('Reported impact (each figure from its metric report):');
      for (const r of reports.slice(0, 10)) {
        const project = byId.get(r.project_id);
        lines.push(`• ${project ? project.name : `Project ${r.project_id}`}: ${r.metric_name} ${formatMetricValue(r.value, r.unit)}${r.period_label ? ` (${r.period_label})` : ''} [report #${r.id}]`);
        citations.push({ kind: 'metric_report', id: r.id });
      }
    }
  } else {
    const movedIds = [...recentByProject.keys()].filter((id) => byId.get(id) && !isArchived(byId.get(id)));
    lines.push(`${movedIds.length} of ${active.length} active project${active.length === 1 ? '' : 's'} moved in ${windowLabel}.`);
    for (const id of movedIds) {
      const p = byId.get(id);
      const entries = recentByProject.get(id);
      const summary = summarizeActivityEntries(entries).slice(0, 3).join('; ');
      lines.push(`• ${p.name}: ${summary} [${entries.slice(0, 3).map((e) => `activity #${e.id}`).join(', ')}]`);
      for (const e of entries.slice(0, 3)) citations.push({ kind: 'activity', id: e.id });
    }
    const stalled = active.filter((p) => !recentByProject.has(p.id));
    if (stalled.length) {
      lines.push(`No movement in ${windowLabel}: ${stalled.map((p) => p.name).join(', ')}.`);
    }
  }

  return { mode, generated_at: now, since: sinceIso, text: lines.join('\n'), citations };
}

export function formatMetricValue(value, unit) {
  const n = Number(value);
  switch (unit) {
    case 'currency': return `$${n.toLocaleString('en-US')}`;
    case 'percent': return `${n}%`;
    case 'hours': return `${n}h`;
    default: return String(n);
  }
}

// ---- AI brief restyle (pure helpers) ----
//
// The dashboard brief can be restyled by a real model (the cheap fast Claude —
// Haiku 4.5 by default). The DB/network wiring lives in lean-beaf-ai.js; the
// pure pieces below (pricing, citation grounding, prompt text) live here so
// they stay unit-testable without better-sqlite3.

export const DEFAULT_BRIEF_MODEL = 'claude-haiku-4-5';

// USD per 1,000,000 tokens (input, output). Unknown models fall back to the
// Haiku floor so a cost still shows (flagged estimated by estimateBriefCost).
export const LBP_MODEL_PRICING = Object.freeze({
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'claude-sonnet-5': { in: 3.0, out: 15.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-opus-5': { in: 5.0, out: 25.0 },
  'claude-opus-4-8': { in: 5.0, out: 25.0 },
  'claude-opus-4-7': { in: 5.0, out: 25.0 },
  'claude-opus-4-6': { in: 5.0, out: 25.0 },
  'claude-fable-5': { in: 10.0, out: 50.0 },
});

// Price a run from token usage. `priced` is false when the model wasn't in the
// table (cost is then a Haiku-floor estimate).
export function estimateBriefCost({ model, inputTokens = 0, outputTokens = 0 } = {}) {
  const priced = Object.prototype.hasOwnProperty.call(LBP_MODEL_PRICING, model);
  const rate = LBP_MODEL_PRICING[model] || LBP_MODEL_PRICING[DEFAULT_BRIEF_MODEL];
  const cost = (Number(inputTokens) / 1e6) * rate.in + (Number(outputTokens) / 1e6) * rate.out;
  return { cost_usd: Math.round(cost * 1e6) / 1e6, priced };
}

// Citations in a brief, normalized to tokens like "activity#12" / "report#3".
// Matches every activity/report reference WHEREVER it appears — the
// deterministic brief GROUPS them inside one pair of brackets
// ("[activity #1, activity #2, activity #3]"), leadership mode uses a single
// pair ("[report #3]"), and an AI rewrite may re-bracket either way. We only
// care that each referenced record id is real, not how it is bracketed — so
// the extractor is bracket-agnostic (a bracket-strict regex here silently
// found zero citations in the grouped source and made every rewrite look
// ungrounded).
export function citationTokens(text) {
  const out = new Set();
  const re = /(activity|report)\s*#\s*(\d+)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.add(`${m[1].toLowerCase()}#${m[2]}`);
  return out;
}

// True iff every citation in `candidate` also appears in `source` — the R07
// safety check: a false result means an AI rewrite invented a record reference,
// so its text must be rejected in favor of the deterministic brief.
export function citationsGroundedIn(candidate, source) {
  const src = citationTokens(source);
  for (const tok of citationTokens(candidate)) {
    if (!src.has(tok)) return false;
  }
  return true;
}

const BRIEF_MODE_TITLE = {
  daily: 'Daily brief',
  since_meeting: 'Since the last meeting',
  leadership: 'Leadership report',
};

// System prompt: restyle grounded facts only, preserve citations, invent nothing.
export function briefSystemPrompt() {
  return [
    'You are the brief writer for "Lean BEAF Pro", the Spec Ops team\'s innovation',
    'project tracker. You will be handed a GROUNDED brief: facts already computed',
    'from the team\'s own records, where every number is followed by a citation',
    'token such as [activity #12] or [report #3].',
    '',
    'Rewrite these exact facts into a clear, engaging, well-structured brief for a',
    'busy team lead. You may reorganize, add light connective prose, and use short',
    'bullet points or a tight paragraph.',
    '',
    'HARD RULES (do not break):',
    '1. Never state any number, count, percentage, dollar figure or date that is',
    '   not already in the grounded facts. You are restyling, not analyzing.',
    '2. Keep every citation token exactly as written ([activity #12], [report #3])',
    '   and keep it attached to the fact it supports. Never invent a new citation.',
    '3. Do not invent project names, outcomes, or events. Use only what is given.',
    '4. If the facts say nothing moved, say so plainly — never fabricate progress.',
    '5. No preamble ("Here is the brief"), no sign-off. Return only the brief.',
    'Keep it concise — a short paragraph or a handful of bullets.',
  ].join('\n');
}

export function briefUserPrompt({ mode, groundedText } = {}) {
  const title = BRIEF_MODE_TITLE[mode] || 'Brief';
  return [
    `Mode: ${title}.`,
    '',
    'Grounded facts (rewrite these, preserving every citation):',
    '"""',
    String(groundedText || '').trim() || 'No activity on record.',
    '"""',
  ].join('\n');
}

// Link metadata for making a brief interactive: which project each cited record
// belongs to, and the project-name list for linkifying mentions. The frontend
// turns "[activity #N]" / "[report #N]" tokens and project-name mentions into
// links to the project detail (activity citations → Activity tab, reports →
// Metrics tab). Pure.
export function buildBriefRefs({ projects = [], activityEntries = [], metricReports = [] } = {}) {
  const activity = {};
  for (const e of activityEntries) activity[e.id] = e.project_id;
  const report = {};
  for (const r of metricReports) report[r.id] = r.project_id;
  return {
    // Longest names first so the frontend matches "Referral Triage Automation"
    // before a shorter project that is a prefix of it.
    projects: projects
      .map((p) => ({ id: p.id, name: p.name }))
      .sort((a, b) => b.name.length - a.name.length),
    activity,
    report,
  };
}

// ---- grounded Q&A ----

// System prompt for answering questions: answer only from the provided cited
// context, keep citations, admit when the answer isn't there (R07).
export function askSystemPrompt() {
  return [
    'You answer questions about the Spec Ops team\'s innovation projects, tracked',
    'in "Lean BEAF Pro". You are given a CONTEXT of facts assembled from the',
    'team\'s own records — every figure is followed by a citation token such as',
    '[activity #12] or [report #3].',
    '',
    'RULES:',
    '1. Answer ONLY from the context. Never state a number, date, stage or outcome',
    '   that is not in it — you have no other knowledge of these projects.',
    '2. When you use a fact that carries a citation, keep the citation token',
    '   ([activity #12], [report #3]) attached to it. Never invent a citation.',
    '3. If the context does not contain the answer, say so plainly (e.g. "That',
    '   isn\'t recorded yet") — do not guess or extrapolate.',
    '4. Use project names exactly as written. Be concise and direct.',
    'No preamble, no sign-off — just the answer.',
  ].join('\n');
}

export function askUserPrompt({ question, context } = {}) {
  return [
    'Context (the only facts you may use):',
    '"""',
    String(context || '').trim() || 'No projects on record.',
    '"""',
    '',
    `Question: ${String(question || '').trim()}`,
  ].join('\n');
}

// Assemble a grounded, cited facts document about the whole portfolio for Q&A.
// Pure — the route passes stored rows in. Every activity/report id appears as a
// citation so the answer can cite (and so citationsGroundedIn can validate it).
export function buildAskContext({
  projects = [], activityEntries = [], metricReports = [],
  scopes = new Map(), locationsById = new Map(), perProjectActivity = 8,
} = {}) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const active = projects.filter((p) => !isArchived(p));
  const archived = projects.filter(isArchived);

  const activityByProject = new Map();
  for (const e of activityEntries) {
    if (!activityByProject.has(e.project_id)) activityByProject.set(e.project_id, []);
    activityByProject.get(e.project_id).push(e);
  }

  const lines = [];

  lines.push('ACTIVE PROJECTS:');
  if (active.length === 0) lines.push('- (none)');
  for (const p of active) {
    const label = deriveLocationLabel({ stage: p.stage, scope: scopes.get(p.id) || {}, locationsById });
    lines.push(`- ${p.name} (project #${p.id}): stage ${p.stage}; ${label}`);
  }

  lines.push('', 'RECENT ACTIVITY (newest last, each cited):');
  let anyActivity = false;
  for (const p of active) {
    const entries = (activityByProject.get(p.id) || []).slice(-perProjectActivity);
    if (!entries.length) continue;
    anyActivity = true;
    const summary = summarizeActivityEntries(entries).join('; ');
    const ids = entries.map((e) => `activity #${e.id}`).join(', ');
    lines.push(`- ${p.name}: ${summary} [${ids}]`);
  }
  if (!anyActivity) lines.push('- (no activity recorded yet)');

  lines.push('', 'METRIC REPORTS (each cited):');
  if (metricReports.length === 0) lines.push('- (none reported yet)');
  for (const r of metricReports.slice(0, 40)) {
    const p = byId.get(r.project_id);
    lines.push(`- ${p ? p.name : `Project ${r.project_id}`}: ${r.metric_name} ${formatMetricValue(r.value, r.unit)}${r.period_label ? ` (${r.period_label})` : ''} [report #${r.id}]`);
  }

  if (archived.length) {
    lines.push('', 'CLOSED PROJECTS (archived, read-only):');
    for (const p of archived) {
      lines.push(`- ${p.name} (project #${p.id}): ${p.outcome === 'rolled_out' ? 'ROLLED OUT' : 'ABANDONED'} at ${p.stage}${p.outcome_takeaway ? ` — ${p.outcome_takeaway}` : ''}`);
    }
  }

  return lines.join('\n');
}

// ---- scope change summary (R03) ----

// Diff two scope shapes into a short human summary for the activity log.
// Both shapes: {testers_text, site_id, pod_ids:[], planned_pod_ids:[], region_id}.
export function summarizeScopeChange(before = {}, after = {}, locationsById = new Map()) {
  const name = (id) => locationsById.get(id)?.name || `#${id}`;
  const parts = [];
  if (String(before.testers_text || '') !== String(after.testers_text || '')) {
    parts.push(after.testers_text ? `Testers set: ${after.testers_text}` : 'Testers cleared');
  }
  if ((before.site_id ?? null) !== (after.site_id ?? null)) {
    parts.push(after.site_id ? `Site set: ${name(after.site_id)}` : 'Site cleared');
  }
  const podsDiff = arrayDiff(before.pod_ids || [], after.pod_ids || []);
  if (podsDiff.added.length) parts.push(`POD added: ${podsDiff.added.map(name).join(', ')}`);
  if (podsDiff.removed.length) parts.push(`POD removed: ${podsDiff.removed.map(name).join(', ')}`);
  const plannedDiff = arrayDiff(before.planned_pod_ids || [], after.planned_pod_ids || []);
  if (plannedDiff.added.length) parts.push(`Planned POD added: ${plannedDiff.added.map(name).join(', ')}`);
  if (plannedDiff.removed.length) parts.push(`Planned POD removed: ${plannedDiff.removed.map(name).join(', ')}`);
  if ((before.region_id ?? null) !== (after.region_id ?? null)) {
    parts.push(after.region_id ? `Region set: ${name(after.region_id)}` : 'Region cleared');
  }
  return parts.join('; ');
}

function arrayDiff(before, after) {
  const b = new Set(before.map(Number));
  const a = new Set(after.map(Number));
  return {
    added: [...a].filter((x) => !b.has(x)),
    removed: [...b].filter((x) => !a.has(x)),
  };
}

// ---- location catalog ----

export const LBP_LOCATION_KINDS = ['site', 'pod', 'region'];

export function validateLocation({ name, kind, parent } = {}) {
  const errors = [];
  if (!String(name || '').trim()) errors.push('A location name is required');
  if (!LBP_LOCATION_KINDS.includes(kind)) errors.push('Kind must be site, pod or region');
  // Hierarchy: Region → PODs → Sites. Parents are optional but must be the
  // right kind when set.
  if (kind === 'pod' && parent && parent.kind !== 'region') errors.push('A POD\'s parent must be a region');
  if (kind === 'site' && parent && parent.kind !== 'pod') errors.push('A site\'s parent must be a POD');
  if (kind === 'region' && parent) errors.push('A region cannot have a parent');
  return errors.length ? { ok: false, errors } : { ok: true };
}
