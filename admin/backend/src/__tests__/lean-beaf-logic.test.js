// Lean BEAF Pro rules (R01–R12) — pure decision-layer tests.
//
// Follows the repo's stub-at-the-module-boundary pattern: only
// lib/lean-beaf-logic.js is imported (no DB, no better-sqlite3), so this
// file passes in the sandbox. The DB wiring (lean-beaf-store.js) and the
// router are thin funnels over these decisions; access-control placement
// (R01) is asserted structurally in the route-mounting test below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  LBP_STAGES, isValidStage, stageIndex, validateStageChange,
  LBP_OUTCOMES, isArchived, validateCloseOut, assertMutableProject,
  validateNewProject, deriveLocationLabel, deriveMovement,
  summarizeActivityEntries, latestScheduleOccurrence, dueScheduleMarker,
  validateMetricReport, newMetricDefinitionStatus, canEditFeedback,
  canonicalLinkPair, ideaCheckMatches, howItWentLine, pipelineCounts,
  projectSpanDays, investedHours, archiveMeta, archiveMetaAnalysis,
  buildBrief, formatMetricValue, summarizeScopeChange, validateLocation,
  validateBlocker, validateBreakBarrier, blockerDurationDays,
} from '../lib/lean-beaf-logic.js';

const __testDir = dirname(fileURLToPath(import.meta.url));

// ---- R01: everyone (non-pending) can view and edit every project ----

test('R01: /api/lbp is mounted behind authenticateToken + blockPendingRole but NOT an admin gate', () => {
  const indexSrc = readFileSync(join(__testDir, '..', 'index.js'), 'utf8');
  const mountLine = indexSrc.split('\n').find((l) => l.includes(`app.use('/api/lbp'`));
  assert.ok(mountLine, '/api/lbp must be mounted');
  assert.match(mountLine, /authenticateToken/);
  assert.match(mountLine, /blockPendingRole/);
  assert.doesNotMatch(mountLine, /requireAdmin/);
});

test('R01: only catalog/approval/link surfaces are admin-gated inside the router', () => {
  const routerSrc = readFileSync(join(__testDir, '..', 'routes', 'lean-beaf.js'), 'utf8');
  const adminGated = routerSrc.split('\n').filter((l) => l.includes('requireAdmin') && l.includes('router.'));
  // Core project editing must NOT appear here.
  for (const line of adminGated) {
    assert.doesNotMatch(line, /\/projects\/:id\/(stage|scope|close|comments|tasks|feedback|learnings|files|metric-reports|time-events)/);
  }
});

// ---- R02: stage enum + logged changes ----

test('R02: the seven stages, in rollout order', () => {
  assert.deepEqual(LBP_STAGES, ['Idea', 'MVP', 'Testing', 'Site', 'POD', 'Region', 'All']);
  assert.equal(isValidStage('POD'), true);
  assert.equal(isValidStage('Blocked'), false); // no "blocked" axis — deliberate
  assert.equal(stageIndex('Idea'), 0);
  assert.equal(stageIndex('All'), 6);
});

test('R02: stage changes validate both directions, reject no-ops and unknowns, and flag skips', () => {
  assert.equal(validateStageChange('Idea', 'MVP').ok, true);
  assert.equal(validateStageChange('POD', 'Testing').ok, true);  // backwards is allowed
  assert.equal(validateStageChange('Idea', 'Idea').ok, false);   // no-op
  assert.equal(validateStageChange('Idea', 'Done').ok, false);   // not a stage
  assert.equal(validateStageChange('Idea', 'Site').skipped, true);   // skip logged
  assert.equal(validateStageChange('Idea', 'MVP').skipped, false);
});

// ---- R03: scope changes produce a movement-log summary ----

test('R03: summarizeScopeChange describes exactly what changed', () => {
  const locs = new Map([[1, { name: 'West' }], [2, { name: 'East' }], [3, { name: 'Northside' }]]);
  const summary = summarizeScopeChange(
    { testers_text: '', site_id: null, pod_ids: [1], planned_pod_ids: [], region_id: null },
    { testers_text: '', site_id: 3, pod_ids: [1, 2], planned_pod_ids: [], region_id: null },
    locs,
  );
  assert.match(summary, /Site set: Northside/);
  assert.match(summary, /POD added: East/);
  assert.equal(summarizeScopeChange({ pod_ids: [1] }, { pod_ids: [1] }, locs), '');
});

// ---- R04: moved iff activity after the current marker ----

test('R04: moved iff last activity is after the marker; idle days otherwise; no marker = moved', () => {
  const project = { last_activity_at: '2026-07-20T10:00:00.000Z', created_at: '2026-07-01T00:00:00.000Z' };
  const now = '2026-07-22T10:00:00.000Z';
  assert.equal(deriveMovement({ project, markerAt: '2026-07-19T09:00:00.000Z', now }).moved, true);
  const stalled = deriveMovement({ project, markerAt: '2026-07-21T09:00:00.000Z', now });
  assert.equal(stalled.moved, false);
  assert.equal(stalled.days_idle, 2);
  assert.equal(deriveMovement({ project, markerAt: null, now }).moved, true);
});

// ---- R05: markers accumulate; schedule auto-marks ----

test('R05: latestScheduleOccurrence finds the most recent weekly occurrence', () => {
  // 2026-07-22 is a Wednesday. Schedule: Mondays 09:00.
  const now = new Date('2026-07-22T15:00:00');
  const occ = latestScheduleOccurrence({ active: 1, day_of_week: 1, time_hhmm: '09:00' }, now);
  assert.equal(occ.getDay(), 1);
  assert.ok(occ <= now);
  assert.equal(latestScheduleOccurrence({ active: 0, day_of_week: 1, time_hhmm: '09:00' }, now), null);
  assert.equal(latestScheduleOccurrence({ active: 1, day_of_week: 9, time_hhmm: '09:00' }, now), null);
});

test('R05: dueScheduleMarker fires only when the occurrence is newer than the latest marker', () => {
  const now = new Date('2026-07-22T15:00:00');
  const schedule = { active: 1, day_of_week: 1, time_hhmm: '09:00' };
  const due = dueScheduleMarker({ schedule, lastMarkerAt: '2026-07-01T00:00:00.000Z', now });
  assert.ok(due, 'a marker is due');
  assert.equal(dueScheduleMarker({ schedule, lastMarkerAt: now.toISOString(), now }), null);
});

// ---- R06: metric reports need catalog metric + source; approval first ----

test('R06: report requires an ACTIVE catalog metric, a number, and at least one source', () => {
  const active = { name: 'Calls deflected', status: 'active' };
  assert.equal(validateMetricReport({ definition: active, value: 12, source_text: 'ACD export' }).ok, true);
  assert.equal(validateMetricReport({ definition: active, value: 12, source_url: 'https://x' }).ok, true);
  assert.equal(validateMetricReport({ definition: active, value: 12, file_id: 3 }).ok, true);
  assert.equal(validateMetricReport({ definition: active, value: 12 }).ok, false); // no source
  assert.equal(validateMetricReport({ definition: active, value: 'nope', source_text: 's' }).ok, false);
  assert.equal(validateMetricReport({ definition: null, value: 1, source_text: 's' }).ok, false);
  assert.equal(validateMetricReport({ definition: { name: 'New', status: 'proposed' }, value: 1, source_text: 's' }).ok, false);
});

test('R06: member proposals need admin approval; admin creations are live at once', () => {
  assert.equal(newMetricDefinitionStatus({ isAdmin: false }), 'proposed');
  assert.equal(newMetricDefinitionStatus({ isAdmin: true }), 'active');
});

test('R06: reports are immutable — the router exposes no PATCH/DELETE for them', () => {
  const routerSrc = readFileSync(join(__testDir, '..', 'routes', 'lean-beaf.js'), 'utf8');
  assert.doesNotMatch(routerSrc, /router\.(patch|put|delete)\([^)]*metric-reports/);
});

// ---- R07: briefs only state numbers traceable to records ----

test('R07: buildBrief cites an activity/report id for every project line', () => {
  const projects = [
    { id: 1, name: 'Reminders', stage: 'POD', outcome: null },
    { id: 2, name: 'Intake', stage: 'Site', outcome: null },
  ];
  const activityEntries = [
    { id: 11, project_id: 1, type: 'stage_change', created_at: '2026-07-21T10:00:00Z', payload: { from: 'Site', to: 'POD' } },
  ];
  const brief = buildBrief({
    mode: 'since_meeting', projects, activityEntries,
    markerAt: '2026-07-20T00:00:00Z', now: '2026-07-22T00:00:00Z',
  });
  assert.match(brief.text, /1 of 2 active projects moved/);
  assert.match(brief.text, /Reminders: Stage Site → POD \[activity #11\]/);
  assert.match(brief.text, /No movement.*Intake/);
  assert.deepEqual(brief.citations, [{ kind: 'activity', id: 11 }]);
});

test('R07: leadership brief with no reports states none rather than inventing figures', () => {
  const brief = buildBrief({ mode: 'leadership', projects: [{ id: 1, name: 'X', stage: 'MVP', outcome: null }], metricReports: [], now: '2026-07-22T00:00:00Z' });
  assert.match(brief.text, /No metric reports on record/);
  assert.equal(brief.citations.length, 0);
});

test('R07: leadership brief cites each metric report id', () => {
  const brief = buildBrief({
    mode: 'leadership',
    projects: [{ id: 1, name: 'E-Fax Bot', stage: 'Region', outcome: null }],
    metricReports: [{ id: 7, project_id: 1, value: 120, unit: 'hours', metric_name: 'Man-hours saved', period_label: 'June', reported_at: '2026-07-01T00:00:00Z' }],
    now: '2026-07-22T00:00:00Z',
  });
  assert.match(brief.text, /E-Fax Bot: Man-hours saved 120h \(June\) \[report #7\]/);
  assert.deepEqual(brief.citations, [{ kind: 'metric_report', id: 7 }]);
});

// ---- R08: close-out requires outcome + reason + takeaway ----

test('R08: exactly two outcomes; reason and takeaway are mandatory', () => {
  assert.deepEqual(LBP_OUTCOMES, ['rolled_out', 'abandoned']);
  assert.equal(validateCloseOut({ outcome: 'rolled_out', reason: 'Adopted', takeaway: 'Champions work' }).ok, true);
  assert.equal(validateCloseOut({ outcome: 'abandoned', reason: '', takeaway: 't' }).ok, false);
  assert.equal(validateCloseOut({ outcome: 'abandoned', reason: 'r', takeaway: ' ' }).ok, false);
  assert.equal(validateCloseOut({ outcome: 'paused', reason: 'r', takeaway: 't' }).ok, false);
});

// ---- R09: archived projects are read-only (links excepted for revive) ----

test('R09: assertMutableProject blocks archived edits with 409, allows links', () => {
  const archived = { id: 1, outcome: 'abandoned' };
  const blocked = assertMutableProject(archived, 'edit');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  assert.equal(assertMutableProject(archived, 'link_add').ok, true);
  assert.equal(assertMutableProject({ id: 2, outcome: null }, 'edit').ok, true);
  assert.equal(assertMutableProject(null).status, 404);
  assert.equal(isArchived({ outcome: 'rolled_out' }), true);
  assert.equal(isArchived({ outcome: null }), false);
});

// ---- R10: idea checker over ALL projects ever, with how-it-went ----

test('R10: matches need ≥3 chars and search name/description/learnings/outcome notes', () => {
  const candidates = [
    { id: 1, name: 'Paper Referral OCR', stage: 'Testing', outcome: 'abandoned', outcome_reason: 'OCR accuracy plateaued', outcome_takeaway: 'Fix the input format first', learnings: ['Fax image quality too inconsistent'] },
    { id: 2, name: 'Two-Way Patient Texting', stage: 'All', outcome: 'rolled_out', outcome_takeaway: 'Champions drove adoption', learnings: [] },
    { id: 3, name: 'Referral Triage Automation', stage: 'MVP', outcome: null, learnings: [] },
  ];
  assert.deepEqual(ideaCheckMatches('re', candidates), []); // <3 chars
  const matches = ideaCheckMatches('referral ocr', candidates);
  assert.ok(matches.length >= 2);
  assert.equal(matches[0].id, 1); // strongest match first (name hit on both tokens)
  assert.match(matches[0].how_it_went, /^Abandoned at Testing/);
  const activeMatch = matches.find((m) => m.id === 3);
  assert.match(activeMatch.how_it_went, /^Active — currently at MVP/);
  // learnings text is searched too
  const viaLearning = ideaCheckMatches('fax image quality', candidates);
  assert.equal(viaLearning[0].id, 1);
});

test('R10: how-it-went lines cover all three outcomes', () => {
  assert.match(howItWentLine({ outcome: 'rolled_out', stage: 'All', outcome_takeaway: 'x' }), /Rolled out at All — x/);
  assert.match(howItWentLine({ outcome: 'abandoned', stage: 'MVP', outcome_reason: 'y' }), /Abandoned at MVP — y/);
  assert.match(howItWentLine({ outcome: null, stage: 'Idea' }), /Active — currently at Idea/);
});

// ---- R11: bidirectional unique links ----

test('R11: link pairs canonicalize so (a,b) === (b,a); self-links rejected', () => {
  assert.deepEqual(canonicalLinkPair(7, 3), { ok: true, a: 3, b: 7 });
  assert.deepEqual(canonicalLinkPair(3, 7), { ok: true, a: 3, b: 7 });
  assert.equal(canonicalLinkPair(3, 3).ok, false);
  assert.equal(canonicalLinkPair(3, null).ok, false);
});

// ---- R12: archive figures computed from stored records only ----

test('R12: archiveMeta counts + hours come straight from rows', () => {
  const projects = [
    { id: 1, outcome: 'rolled_out', stage: 'All' },
    { id: 2, outcome: 'abandoned', stage: 'Testing' },
    { id: 3, outcome: null, stage: 'MVP' },
  ];
  const timeEventsByProject = new Map([
    [1, [{ hours: 10 }, { hours: 2.5 }]],
    [2, [{ hours: 4 }, { hours: null }]],
    [3, [{ hours: 99 }]], // active project hours are NOT "invested in closed"
  ]);
  const meta = archiveMeta({ projects, timeEventsByProject });
  assert.deepEqual(meta, { ideas_attempted: 3, rolled_out: 1, abandoned: 1, hours_invested: 16.5 });
});

test('R12: meta-analysis paragraph states only numbers present in meta', () => {
  const meta = { ideas_attempted: 3, rolled_out: 1, abandoned: 1, hours_invested: 16.5 };
  const text = archiveMetaAnalysis({ meta, abandonedProjects: [{ stage: 'Testing' }] });
  assert.match(text, /attempted 3 ideas/);
  assert.match(text, /1 rolled out, 1 abandoned/);
  assert.match(text, /50%/);
  assert.match(text, /16\.5 logged hours/);
  assert.match(text, /died at Testing \(1 of 1\)/);
  assert.match(archiveMetaAnalysis({ meta: { ideas_attempted: 0 } }), /No projects yet/);
});

// ---- blockers (operator addition: blocked flag + break-barrier audit) ----

test('blocker: reason required, date must be YYYY-MM-DD; break-barrier date optional', () => {
  assert.equal(validateBlocker({ reason: 'waiting on vendor' }).ok, true);
  assert.equal(validateBlocker({ reason: 'x', date: '2026-07-20' }).ok, true);
  assert.equal(validateBlocker({ reason: '' }).ok, false);
  assert.equal(validateBlocker({ reason: 'x', date: '07/20/2026' }).ok, false);
  assert.equal(validateBreakBarrier({}).ok, true);
  assert.equal(validateBreakBarrier({ date: '2026-07-22' }).ok, true);
  assert.equal(validateBreakBarrier({ date: 'nope' }).ok, false);
});

test('blockerDurationDays spans blocked_at → resolved_at (or now if still open)', () => {
  assert.equal(blockerDurationDays({ blocked_at: '2026-07-20', resolved_at: '2026-07-22' }), 2);
  assert.equal(blockerDurationDays({ blocked_at: '2026-07-20', resolved_at: null }, '2026-07-25T00:00:00Z'), 5);
  assert.equal(blockerDurationDays({}), null);
});

// ---- supporting decisions ----

test('new-project validation: name required, stage/date shape checked', () => {
  assert.equal(validateNewProject({ name: 'X' }).ok, true);
  assert.equal(validateNewProject({ name: '  ' }).ok, false);
  assert.equal(validateNewProject({ name: 'X', stage: 'Done' }).ok, false);
  assert.equal(validateNewProject({ name: 'X', start_date: '07/22/2026' }).ok, false);
  assert.equal(validateNewProject({ name: 'X', stage: 'Testing', start_date: '2026-07-22' }).ok, true);
});

test('location label derives from stage + scope, never stored', () => {
  const locations = new Map([
    [1, { name: 'West' }], [2, { name: 'East' }], [3, { name: 'Northside' }], [4, { name: 'North Region' }],
  ]);
  assert.equal(deriveLocationLabel({ stage: 'Idea', scope: {}, locationsById: locations }), 'Pre-rollout');
  assert.equal(deriveLocationLabel({ stage: 'Testing', scope: { testers_text: 'Front desk' }, locationsById: locations }), 'Testers: Front desk');
  assert.equal(deriveLocationLabel({ stage: 'Site', scope: { site_id: 3 }, locationsById: locations }), 'Northside');
  assert.equal(
    deriveLocationLabel({ stage: 'POD', scope: { pod_ids: [1, 2], planned_pod_ids: [] }, locationsById: locations }),
    'POD West + East',
  );
  assert.equal(
    deriveLocationLabel({ stage: 'POD', scope: { pod_ids: [1], planned_pod_ids: [2] }, locationsById: locations }),
    'POD West (planned: East)',
  );
  assert.equal(deriveLocationLabel({ stage: 'Region', scope: { region_id: 4 }, locationsById: locations }), 'North Region');
  assert.equal(deriveLocationLabel({ stage: 'All', scope: {}, locationsById: locations }), 'Everywhere');
});

test('feedback: author-editable for 24h, then locked; never editable by others', () => {
  const feedback = { captured_by: 'u1', captured_at: '2026-07-21T12:00:00.000Z' };
  assert.equal(canEditFeedback({ feedback, userId: 'u1', now: '2026-07-22T11:00:00.000Z' }), true);
  assert.equal(canEditFeedback({ feedback, userId: 'u1', now: '2026-07-22T13:00:00.000Z' }), false);
  assert.equal(canEditFeedback({ feedback, userId: 'u2', now: '2026-07-21T13:00:00.000Z' }), false);
});

test('pipeline counts active projects per stage; archived excluded', () => {
  const counts = pipelineCounts([
    { stage: 'Idea', outcome: null }, { stage: 'Idea', outcome: null },
    { stage: 'POD', outcome: null }, { stage: 'All', outcome: 'rolled_out' },
  ]);
  assert.deepEqual(counts.find((c) => c.stage === 'Idea'), { stage: 'Idea', count: 2 });
  assert.deepEqual(counts.find((c) => c.stage === 'All'), { stage: 'All', count: 0 });
});

test('span + invested hours', () => {
  assert.equal(projectSpanDays({ start_date: '2026-07-01', outcome_at: '2026-07-15T00:00:00Z' }), 14);
  assert.equal(investedHours([{ hours: 1.5 }, { hours: null }, { hours: 2 }]), 3.5);
});

test('activity summaries render human lines per entry type', () => {
  const lines = summarizeActivityEntries([
    { type: 'stage_change', payload: { from: 'MVP', to: 'Testing' } },
    { type: 'metric_report', payload: { metric: 'Calls deflected', value: 40, unit: 'count' } },
    { type: 'outcome_set', payload: { outcome: 'abandoned' } },
  ]);
  assert.deepEqual(lines, ['Stage MVP → Testing', 'Reported Calls deflected: 40 count', 'Closed — abandoned ✕']);
});

test('metric value formatting per unit', () => {
  assert.equal(formatMetricValue(1200, 'currency'), '$1,200');
  assert.equal(formatMetricValue(35, 'percent'), '35%');
  assert.equal(formatMetricValue(8, 'hours'), '8h');
  assert.equal(formatMetricValue(42, 'count'), '42');
});

test('location hierarchy: region → pod → site', () => {
  assert.equal(validateLocation({ name: 'X', kind: 'region' }).ok, true);
  assert.equal(validateLocation({ name: 'X', kind: 'pod', parent: { kind: 'region' } }).ok, true);
  assert.equal(validateLocation({ name: 'X', kind: 'site', parent: { kind: 'region' } }).ok, false);
  assert.equal(validateLocation({ name: '', kind: 'site' }).ok, false);
  assert.equal(validateLocation({ name: 'X', kind: 'city' }).ok, false);
});
