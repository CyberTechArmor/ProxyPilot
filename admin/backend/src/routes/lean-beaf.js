// Lean BEAF Pro — /api/lbp. Team-shared innovation project management.
//
// Access model (R01): every authenticated, non-pending user is a workspace
// member and can view + edit every project (the router is mounted behind
// authenticateToken + blockPendingRole in index.js — deliberately NOT
// admin-gated; everyone gets access). Admin-only surfaces: location catalog
// CRUD, metric-definition approval/retire, demo seed, and Build-LXC linking
// (Mock2 project creation is admin-gated elsewhere, so the link follows).
//
// Archived projects are read-only, API-enforced here via guardMutable()
// (R09). Every mutation writes one lbp_activity entry (movement + briefs).

import { Router } from 'express';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { mkdirSync, existsSync, createReadStream } from 'fs';
import { dirname, resolve, join, extname } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { logAudit } from '../db.js';
import * as store from '../lib/lean-beaf-store.js';
import { getBriefAiSettings, saveBriefAiSettings, generateAiBrief, answerBriefQuestion } from '../lib/lean-beaf-ai.js';
import { sampleDashboardMetrics, getConnections, saveConnection, LBP_DATA_SOURCES } from '../lib/lean-beaf-metrics.js';
import {
  LBP_STAGES, LBP_METRIC_UNITS, LBP_TIME_EVENT_TYPES, LBP_SENTIMENTS,
  isArchived, assertMutableProject, validateNewProject,
  validateStageChange, validateCloseOut, validateMetricReport,
  newMetricDefinitionStatus, canEditFeedback, canonicalLinkPair,
  ideaCheckMatches, deriveLocationLabel, deriveMovement, pipelineCounts,
  summarizeActivityEntries, summarizeScopeChange, archiveMeta,
  archiveMetaAnalysis, projectSpanDays, investedHours, buildBrief,
  validateLocation, stageIndex, validateBlocker, validateBreakBarrier,
  blockerDurationDays, describeSchedules, buildBriefsFeed, buildBriefRefs,
  buildAskContext,
} from '../lib/lean-beaf-logic.js';

const __filename = fileURLToPath(import.meta.url);
// src/routes -> src -> backend -> admin -> repo root
const PROJECT_ROOT = resolve(dirname(__filename), '..', '..', '..', '..');

// Uploaded files live next to the DB's data dir: data/lbp-files/.
const rawDbPath = process.env.DATABASE_PATH || './data/db/proxypilot.db';
const dbPath = rawDbPath.startsWith('/') ? rawDbPath : resolve(PROJECT_ROOT, rawDbPath);
const LBP_FILES_DIR = process.env.LBP_FILES_DIR || join(dirname(dirname(dbPath)), 'lbp-files');

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!existsSync(LBP_FILES_DIR)) mkdirSync(LBP_FILES_DIR, { recursive: true, mode: 0o700 });
    cb(null, LBP_FILES_DIR);
  },
  filename: (_req, file, cb) => {
    // Random stored name + original extension: never trust client paths.
    cb(null, `${randomBytes(16).toString('hex')}${extname(file.originalname || '').slice(0, 12)}`);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: Number(process.env.LBP_MAX_UPLOAD_BYTES || 50 * 1024 * 1024) },
});

// Mime types the inline viewer may render directly (everything else is
// download-only). Images + PDF cover the team's screenshots and documents.
const INLINE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf', 'text/plain',
]);

export function createLeanBeafRouter() {
  const router = Router();

  // ---- shared helpers ----

  const loadProject = (req, res) => {
    const project = store.getProject(Number(req.params.id));
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return null;
    }
    return project;
  };

  // R09 guard: archived projects reject every mutation (except links, which
  // route through their own action tag).
  const guardMutable = (project, res, action = 'edit') => {
    const check = assertMutableProject(project, action);
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return false;
    }
    return true;
  };

  const shapeSummary = (project, ctx) => {
    const scope = ctx.scopes.get(project.id) || {};
    const movement = isArchived(project)
      ? { moved: false, days_idle: null }
      : deriveMovement({ project, markerAt: ctx.markerAt });
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      stage: project.stage,
      stage_index: stageIndex(project.stage),
      start_date: project.start_date,
      pinned: !!project.pinned,
      outcome: project.outcome,
      outcome_at: project.outcome_at,
      outcome_reason: project.outcome_reason,
      outcome_takeaway: project.outcome_takeaway,
      last_activity_at: project.last_activity_at,
      mock2_project_id: project.mock2_project_id,
      board_pos: project.board_pos ?? 0,
      archived: isArchived(project),
      moved: movement.moved,
      days_idle: movement.days_idle,
      location_label: deriveLocationLabel({ stage: project.stage, scope, locationsById: ctx.locations }),
      assignees: ctx.assignees.get(project.id) || [],
      task_counts: ctx.taskCounts.get(project.id) || { total: 0, done: 0 },
      scope,
      // Blocked flag (derived from an open blocker row) so list / board /
      // overview cards can all render it.
      blocked: !!ctx.blockers.get(project.id),
      blocked_reason: ctx.blockers.get(project.id)?.reason || null,
      blocked_at: ctx.blockers.get(project.id)?.blocked_at || null,
      blocked_days: ctx.blockers.get(project.id) ? blockerDurationDays(ctx.blockers.get(project.id)) : null,
    };
  };

  const listContext = () => {
    store.ensureScheduledMarker();
    return {
      markerAt: store.latestMarker()?.marked_at || null,
      locations: store.locationsById(),
      scopes: store.scopesByProject(),
      assignees: store.assigneesByProject(),
      taskCounts: store.taskCountsByProject(),
      blockers: store.openBlockersByProject(),
    };
  };

  // ---- workspace basics ----

  router.get('/users', (_req, res) => {
    res.json({ users: store.listWorkspaceUsers() });
  });

  router.get('/locations', (req, res) => {
    res.json({ locations: store.listLocations({ includeInactive: req.query.all === '1' }) });
  });

  const locationSchema = z.object({
    name: z.string().min(1).max(120),
    kind: z.enum(['site', 'pod', 'region']),
    parent_id: z.number().int().positive().nullable().optional(),
  });

  router.post('/locations', requireAdmin, (req, res) => {
    const parsed = locationSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'name and kind (site|pod|region) are required' });
    const parent = parsed.data.parent_id ? store.getLocation(parsed.data.parent_id) : null;
    if (parsed.data.parent_id && !parent) return res.status(400).json({ error: 'Parent location not found' });
    const check = validateLocation({ name: parsed.data.name, kind: parsed.data.kind, parent });
    if (!check.ok) return res.status(400).json({ error: check.errors.join('; ') });
    const location = store.createLocation({ ...parsed.data, parent_id: parsed.data.parent_id ?? null });
    logAudit(req.user.id, 'LBP_LOCATION_CREATE', 'lbp_location', location.id, { name: location.name, kind: location.kind }, req.ip);
    res.status(201).json({ location });
  });

  router.patch('/locations/:id', requireAdmin, (req, res) => {
    const existing = store.getLocation(Number(req.params.id));
    if (!existing) return res.status(404).json({ error: 'Location not found' });
    const { name, parent_id, active } = req.body || {};
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'Location name cannot be empty' });
    const location = store.updateLocation(existing.id, { name, parent_id, active });
    logAudit(req.user.id, 'LBP_LOCATION_UPDATE', 'lbp_location', existing.id, { name, active }, req.ip);
    res.json({ location });
  });

  // ---- meetings (R05) ----

  router.get('/meetings', (_req, res) => {
    store.ensureScheduledMarker();
    const schedules = store.listSchedules();
    res.json({
      current: store.latestMarker(),
      history: store.listMarkers(),
      schedules,
      schedules_summary: describeSchedules(schedules),
    });
  });

  // Anyone can mark a meeting; markers accumulate and never delete. Optional
  // `at` lets an ad-hoc meeting be backdated / set to a different time.
  router.post('/meetings', (req, res) => {
    const at = typeof req.body?.at === 'string' && req.body.at.trim() ? req.body.at : undefined;
    const marker = store.addMarker({ markedBy: req.user.id, source: 'manual', markedAt: at });
    res.status(201).json({ marker });
  });

  // ---- meeting schedules (multiple recurring: daily | weekly) ----

  router.get('/schedules', (_req, res) => {
    res.json({ schedules: store.listSchedules() });
  });

  const scheduleSchema = z.object({
    label: z.string().max(80).nullable().optional(),
    frequency: z.enum(['daily', 'weekly']),
    day_of_week: z.number().int().min(0).max(6).nullable().optional(),
    time_hhmm: z.string().regex(/^\d{2}:\d{2}$/),
    active: z.boolean().optional(),
  }).refine((s) => s.frequency === 'daily' || (Number.isInteger(s.day_of_week) && s.day_of_week >= 0 && s.day_of_week <= 6), {
    message: 'A weekly schedule needs a day_of_week (0-6)',
  });

  router.post('/schedules', (req, res) => {
    const parsed = scheduleSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'frequency (daily|weekly), time_hhmm and a day for weekly are required' });
    const schedule = store.createSchedule({ ...parsed.data, createdBy: req.user.id });
    res.status(201).json({ schedule });
  });

  const schedulePatchSchema = z.object({
    label: z.string().max(80).nullable().optional(),
    frequency: z.enum(['daily', 'weekly']).optional(),
    day_of_week: z.number().int().min(0).max(6).nullable().optional(),
    time_hhmm: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    active: z.boolean().optional(),
  });

  router.patch('/schedules/:sid', (req, res) => {
    const existing = store.getScheduleRow(Number(req.params.sid));
    if (!existing) return res.status(404).json({ error: 'Schedule not found' });
    const parsed = schedulePatchSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid schedule fields' });
    res.json({ schedule: store.updateSchedule(existing.id, parsed.data) });
  });

  router.delete('/schedules/:sid', (req, res) => {
    const ok = store.deleteSchedule(Number(req.params.sid));
    if (!ok) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ ok: true });
  });

  // ---- briefs feed (Briefs page): today + between-meeting periods ----

  router.get('/briefs', (_req, res) => {
    store.ensureScheduledMarker();
    res.json(buildBriefsFeed({
      markers: store.listMarkers({ limit: 60 }),
      projects: store.listProjects(),
      activityEntries: store.listActivitySince(null),
    }));
  });

  // ---- dashboard ----

  router.get('/overview', (_req, res) => {
    const ctx = listContext();
    const projects = store.listProjects();
    const active = projects.filter((p) => !isArchived(p));
    const summaries = active.map((p) => shapeSummary(p, ctx));

    // "What actually changed" per moved project, from activity entries
    // since the marker.
    const since = ctx.markerAt;
    const recent = store.listActivitySince(since);
    const recentByProject = new Map();
    for (const e of recent) {
      if (!recentByProject.has(e.project_id)) recentByProject.set(e.project_id, []);
      recentByProject.get(e.project_id).push(e);
    }

    const moved = summaries.filter((s) => s.moved).map((s) => ({
      ...s,
      changes: summarizeActivityEntries(recentByProject.get(s.id) || []).slice(0, 4),
    }));
    const stalled = summaries.filter((s) => !s.moved)
      .sort((a, b) => (b.days_idle ?? 0) - (a.days_idle ?? 0));

    // Locations live = distinct locations referenced by active projects'
    // effective scope (site/pods/region), plus "everywhere" projects.
    const liveLocationIds = new Set();
    let everywhere = 0;
    for (const s of summaries) {
      if (s.stage === 'Site' && s.scope.site_id) liveLocationIds.add(s.scope.site_id);
      if (s.stage === 'POD') for (const id of s.scope.pod_ids || []) liveLocationIds.add(id);
      if (s.stage === 'Region' && s.scope.region_id) liveLocationIds.add(s.scope.region_id);
      if (s.stage === 'All') everywhere += 1;
    }

    res.json({
      tiles: {
        active_projects: active.length,
        moved_since_meeting: moved.length,
        no_movement: stalled.length,
        locations_live: liveLocationIds.size + (everywhere > 0 ? 1 : 0),
      },
      meeting: {
        current: store.latestMarker(),
        schedules: store.listSchedules(),
        schedules_summary: describeSchedules(store.listSchedules()),
      },
      moved,
      stalled,
      pipeline: pipelineCounts(projects),
      archived_count: projects.filter(isArchived).length,
    });
  });

  // ---- business metrics band + data-source connections ----

  // Leadership metrics band (Volume & capacity, Charge per visit, Attributed
  // lives, Per appointment cost) + the four levers. DUMMY sample data until a
  // real source is connected — the payload is flagged `sample: true` so the UI
  // labels it as not-yet-connected.
  router.get('/dashboard-metrics', (_req, res) => {
    res.json({ metrics: sampleDashboardMetrics() });
  });

  // Data-source connections (placeholder). Every member can see the wiring
  // state; only an admin can change it. No live integration runs yet.
  router.get('/connections', (_req, res) => {
    res.json({ sources: LBP_DATA_SOURCES, connections: getConnections() });
  });

  const connectionSchema = z.object({
    status: z.enum(['connected', 'disconnected']),
    endpoint: z.string().max(500).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
  });

  router.put('/connections/:key', requireAdmin, (req, res) => {
    const parsed = connectionSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'status (connected|disconnected) is required' });
    const connection = saveConnection(req.params.key, {
      status: parsed.data.status,
      endpoint: parsed.data.endpoint,
      notes: parsed.data.notes,
      updatedBy: req.user.username || req.user.id,
    });
    if (!connection) return res.status(404).json({ error: 'Unknown data source' });
    logAudit(req.user.id, 'LBP_CONNECTION_SET', 'lbp_connection', req.params.key, { status: connection.status }, req.ip);
    res.json({ connection });
  });

  // Build the deterministic, record-grounded brief for a mode (R07). Shared by
  // the free GET /brief and the AI restyle (POST /brief/ai) so both start from
  // the exact same grounded facts.
  const buildGroundedBrief = (rawMode) => {
    const mode = ['daily', 'since_meeting', 'leadership'].includes(rawMode) ? rawMode : 'daily';
    store.ensureScheduledMarker();
    const markerAt = store.latestMarker()?.marked_at || null;
    return buildBrief({
      mode,
      projects: store.listProjects(),
      activityEntries: store.listActivitySince(mode === 'leadership' ? null : markerAt && mode === 'since_meeting' ? markerAt : null),
      metricReports: store.listAllMetricReports(),
      markerAt,
    });
  };

  // Link metadata so the brief text can deep-link: which project each cited
  // record belongs to + the project-name list. Cheap; computed from the same
  // rows the brief already reads.
  const briefRefs = () => buildBriefRefs({
    projects: store.listProjects(),
    activityEntries: store.listActivitySince(null),
    metricReports: store.listAllMetricReports(),
  });

  // Grounded briefs (R07): deterministic, every number cites its record. No
  // model call, no spend — safe to auto-load on the dashboard.
  router.get('/brief', (req, res) => {
    res.json({ brief: buildGroundedBrief(req.query.mode), refs: briefRefs() });
  });

  // AI-restyled brief (explicit spend): restyles the SAME grounded facts with
  // the configured model, records the run for the audit, and returns the cost.
  // Falls back to the deterministic text (and says so) when the model isn't
  // configured, errors, or produces an ungrounded rewrite — the brief is never
  // empty and R07 always holds.
  router.post('/brief/ai', async (req, res) => {
    const grounded = buildGroundedBrief(req.body?.mode);
    const result = await generateAiBrief({
      grounded, userId: req.user.id, username: req.user.username || null,
    });
    res.json({ brief: { ...grounded, text: result.text }, ai: result, refs: briefRefs() });
  });

  // Grounded Q&A (explicit spend): answer a question about the portfolio using
  // ONLY a cited context assembled from stored records. Records a run
  // (mode 'question') and returns link refs so the answer's citations are
  // clickable too. Same R07 posture as the brief — an answer citing a record
  // not in the context is rejected.
  router.post('/brief/ask', async (req, res) => {
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'A question is required' });
    if (question.length > 500) return res.status(400).json({ error: 'Question is too long (max 500 characters)' });
    store.ensureScheduledMarker();
    const context = buildAskContext({
      projects: store.listProjects(),
      activityEntries: store.listActivitySince(null),
      metricReports: store.listAllMetricReports(),
      scopes: store.scopesByProject(),
      locationsById: store.locationsById(),
    });
    const result = await answerBriefQuestion({
      question, context, userId: req.user.id, username: req.user.username || null,
    });
    res.json({ answer: result, refs: briefRefs() });
  });

  // AI brief generation audit — who ran each brief, the model, and the cost.
  // Visible to every member (it's a shared team tool); model settings below are
  // admin-only.
  router.get('/brief-runs', (_req, res) => {
    res.json({ runs: store.listBriefRuns({ limit: 60 }), totals: store.briefRunTotals(), refs: briefRefs() });
  });

  // AI model settings. GET is non-secret (members see which model + cost basis
  // is in effect); PUT is admin-only (set the model / paste the API key).
  router.get('/brief-settings', (_req, res) => {
    res.json({ settings: getBriefAiSettings() });
  });

  const briefSettingsSchema = z.object({
    model: z.string().min(1).max(120).optional(),
    api_key: z.string().max(400).nullable().optional(),
    base_url: z.string().max(400).nullable().optional(),
  });

  router.put('/brief-settings', requireAdmin, (req, res) => {
    const parsed = briefSettingsSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid AI brief settings' });
    const settings = saveBriefAiSettings(parsed.data);
    logAudit(req.user.id, 'LBP_BRIEF_SETTINGS', 'lbp_workspace', 1, { model: settings.model, key_set: !!parsed.data.api_key }, req.ip);
    res.json({ settings });
  });

  // ---- archive (R09, R12) ----

  router.get('/archive', (_req, res) => {
    const ctx = listContext();
    const projects = store.listProjects();
    const timeEvents = store.timeEventsByProject();
    const meta = archiveMeta({ projects, timeEventsByProject: timeEvents });
    const shapeArchived = (p) => ({
      ...shapeSummary(p, ctx),
      final_stage: p.stage,
      span_days: projectSpanDays(p),
      invested_hours: Math.round(investedHours(timeEvents.get(p.id) || []) * 10) / 10,
    });
    const archived = projects.filter(isArchived);
    res.json({
      meta,
      analysis: archiveMetaAnalysis({ meta, abandonedProjects: archived.filter((p) => p.outcome === 'abandoned') }),
      rolled_out: archived.filter((p) => p.outcome === 'rolled_out').map(shapeArchived),
      abandoned: archived.filter((p) => p.outcome === 'abandoned').map(shapeArchived),
    });
  });

  // ---- projects ----

  router.get('/projects', (req, res) => {
    const ctx = listContext();
    let projects = store.listProjects();
    if (req.query.include !== 'archived') projects = projects.filter((p) => !isArchived(p));
    let summaries = projects.map((p) => shapeSummary(p, ctx));
    const filter = req.query.filter;
    if (filter === 'moved') summaries = summaries.filter((s) => s.moved && !s.archived);
    if (filter === 'stalled') summaries = summaries.filter((s) => !s.moved && !s.archived);
    if (filter === 'mine') summaries = summaries.filter((s) => s.assignees.some((a) => String(a.user_id) === String(req.user.id)));
    res.json({ projects: summaries, marker_at: ctx.markerAt });
  });

  // Live idea checker (R10): ≥3 chars, all projects ever, with outcome line.
  router.get('/idea-check', (req, res) => {
    const matches = ideaCheckMatches(String(req.query.q || ''), store.ideaCandidates());
    res.json({ matches });
  });

  const newProjectSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(20000).nullable().optional(),
    stage: z.enum(LBP_STAGES).optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    assignee_ids: z.array(z.string()).max(50).optional(),
    related_ids: z.array(z.number().int().positive()).max(10).optional(),
  });

  router.post('/projects', (req, res) => {
    const parsed = newProjectSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'A project name is required' });
    const check = validateNewProject(parsed.data);
    if (!check.ok) return res.status(400).json({ error: check.errors.join('; ') });
    const project = store.createProject({
      name: parsed.data.name.trim(),
      description: parsed.data.description ?? null,
      stage: parsed.data.stage || 'Idea',
      startDate: parsed.data.start_date,
      assigneeIds: parsed.data.assignee_ids || [String(req.user.id)],
      createdBy: req.user.id,
    });
    // Idea-checker matches offered as related links at create time (R10/R11).
    for (const otherId of parsed.data.related_ids || []) {
      const pair = canonicalLinkPair(project.id, otherId);
      if (pair.ok && store.getProject(otherId)) {
        store.addLink({ a: pair.a, b: pair.b, note: 'Linked at creation from the idea checker', createdBy: req.user.id });
        store.addActivity(project.id, { type: 'link_added', authorId: req.user.id, payload: { other_id: otherId } });
      }
    }
    logAudit(req.user.id, 'LBP_PROJECT_CREATE', 'lbp_project', project.id, { name: project.name }, req.ip);
    res.status(201).json({ project });
  });

  router.get('/projects/:id', async (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const ctx = listContext();
    const summary = shapeSummary(project, ctx);
    res.json({
      project: {
        ...summary,
        created_at: project.created_at,
        created_by: project.created_by,
        outcome_by: project.outcome_by,
        span_days: projectSpanDays(project),
        links: store.listLinksFor(project.id),
        lxc: await lxcInfoFor(project),
        // Blocker audit trail (each block→break cycle, newest first).
        blockers: store.listBlockers(project.id).map((b) => ({ ...b, duration_days: blockerDurationDays(b) })),
      },
    });
  });

  const patchSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(20000).nullable().optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    pinned: z.boolean().optional(),
  });

  router.patch('/projects/:id', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    // Pinning is a personal-ish view preference but shared here; allow it on
    // archived projects too? No — archive is read-only (R09), pin included.
    if (!guardMutable(project, res)) return;
    const parsed = patchSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid project fields' });
    const updated = store.updateProjectFields(project.id, parsed.data);
    res.json({ project: updated });
  });

  // Stage change (R02): either direction, skips allowed + logged.
  router.post('/projects/:id/stage', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const to = String(req.body?.stage || '');
    const check = validateStageChange(project.stage, to);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const updated = store.setStage(project.id, to);
    store.addActivity(project.id, {
      type: 'stage_change', authorId: req.user.id,
      payload: { from: project.stage, to, skipped: check.skipped },
    });
    res.json({ project: updated });
  });

  // Reorder cards vertically within a Kanban stage column (drag-sort). A view
  // preference — writes no activity, so it never counts as movement.
  const reorderSchema = z.object({
    stage: z.enum(LBP_STAGES),
    ordered_ids: z.array(z.number().int().positive()).max(500),
  });
  router.post('/projects/reorder', (req, res) => {
    const parsed = reorderSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'stage and ordered_ids are required' });
    store.reorderProjects(parsed.data.stage, parsed.data.ordered_ids);
    res.json({ ok: true });
  });

  // Rollout scope (R03): logs + counts as movement; never hard-blocks.
  const scopeSchema = z.object({
    testers_text: z.string().max(500).nullable().optional(),
    site_id: z.number().int().positive().nullable().optional(),
    region_id: z.number().int().positive().nullable().optional(),
    pod_ids: z.array(z.number().int().positive()).max(50).optional(),
    planned_pod_ids: z.array(z.number().int().positive()).max(50).optional(),
  });

  router.put('/projects/:id/scope', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const parsed = scopeSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid rollout scope' });
    const before = store.getScope(project.id);
    const after = store.setScope(project.id, {
      testers_text: parsed.data.testers_text ?? before.testers_text,
      site_id: parsed.data.site_id !== undefined ? parsed.data.site_id : before.site_id,
      region_id: parsed.data.region_id !== undefined ? parsed.data.region_id : before.region_id,
      pod_ids: parsed.data.pod_ids ?? before.pod_ids,
      planned_pod_ids: parsed.data.planned_pod_ids ?? before.planned_pod_ids,
    });
    const summary = summarizeScopeChange(before, after, store.locationsById());
    if (summary) {
      store.addActivity(project.id, { type: 'scope_change', authorId: req.user.id, payload: { summary } });
    }
    res.json({ scope: after });
  });

  router.post('/projects/:id/assignees', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map(String) : null;
    if (!ids) return res.status(400).json({ error: 'user_ids array is required' });
    store.setAssignees(project.id, ids);
    res.json({ ok: true });
  });

  // Close-out (R08): reason + takeaway required; warns (client-side) when no
  // metric exists for a roll-out, but does not block.
  router.post('/projects/:id/close', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const { outcome, reason, takeaway } = req.body || {};
    const check = validateCloseOut({ outcome, reason, takeaway });
    if (!check.ok) return res.status(400).json({ error: check.errors.join('; ') });
    const updated = store.closeProject(project.id, {
      outcome, reason: String(reason).trim(), takeaway: String(takeaway).trim(), userId: req.user.id,
    });
    store.addActivity(project.id, { type: 'outcome_set', authorId: req.user.id, payload: { outcome, final_stage: project.stage } });
    logAudit(req.user.id, 'LBP_PROJECT_CLOSE', 'lbp_project', project.id, { outcome }, req.ip);
    res.json({ project: updated });
  });

  // ---- blockers (blocked flag + break-barrier audit) ----

  // Full blocker history (audit trail).
  router.get('/projects/:id/blockers', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    res.json({
      blockers: store.listBlockers(project.id).map((b) => ({ ...b, duration_days: blockerDurationDays(b) })),
      open: store.getOpenBlocker(project.id) || null,
    });
  });

  // Flag a blocker: reason required, date defaults to today (editable). One
  // open blocker at a time — flag again only after breaking the barrier.
  router.post('/projects/:id/block', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const { reason, date } = req.body || {};
    const check = validateBlocker({ reason, date });
    if (!check.ok) return res.status(400).json({ error: check.errors.join('; ') });
    if (store.getOpenBlocker(project.id)) {
      return res.status(409).json({ error: 'This project is already blocked — break the barrier before flagging a new blocker' });
    }
    const blocker = store.addBlocker(project.id, { reason: String(reason).trim(), blocked_at: date || null, blockedBy: req.user.id });
    store.addActivity(project.id, { type: 'blocked', authorId: req.user.id, payload: { blocker_id: blocker.id, reason: blocker.reason, blocked_at: blocker.blocked_at } });
    logAudit(req.user.id, 'LBP_PROJECT_BLOCK', 'lbp_project', project.id, { reason: blocker.reason, blocked_at: blocker.blocked_at }, req.ip);
    res.status(201).json({ blocker });
  });

  // Break the barrier: resolve the open blocker, recording the date (defaults
  // today, editable) and an optional note.
  router.post('/projects/:id/unblock', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const { date, note } = req.body || {};
    const check = validateBreakBarrier({ date });
    if (!check.ok) return res.status(400).json({ error: check.errors.join('; ') });
    const resolved = store.resolveOpenBlocker(project.id, { resolved_at: date || null, resolvedBy: req.user.id, resolved_note: note ? String(note).trim() : null });
    if (!resolved) return res.status(400).json({ error: 'This project is not currently blocked' });
    store.addActivity(project.id, { type: 'unblocked', authorId: req.user.id, payload: { blocker_id: resolved.id, resolved_at: resolved.resolved_at, reason: resolved.reason } });
    logAudit(req.user.id, 'LBP_PROJECT_UNBLOCK', 'lbp_project', project.id, { blocker_id: resolved.id, resolved_at: resolved.resolved_at }, req.ip);
    res.json({ blocker: resolved });
  });

  // ---- activity + comments ----

  router.get('/projects/:id/activity', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const users = new Map(store.listWorkspaceUsers().map((u) => [String(u.id), u.username]));
    res.json({
      activity: store.listActivity(project.id).map((e) => ({
        ...e, author_name: e.author_id ? users.get(String(e.author_id)) || 'unknown' : null,
      })),
    });
  });

  router.post('/projects/:id/comments', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'A comment body is required' });
    const entry = store.addActivity(project.id, { type: 'comment', authorId: req.user.id, body });
    res.status(201).json({ entry });
  });

  // ---- tasks ----

  router.get('/projects/:id/tasks', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    res.json({ tasks: store.listTasks(project.id) });
  });

  router.post('/projects/:id/tasks', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: 'A task title is required' });
    const parentId = req.body?.parent_id ? Number(req.body.parent_id) : null;
    if (parentId) {
      const parent = store.getTask(parentId);
      if (!parent || parent.project_id !== project.id) return res.status(400).json({ error: 'Parent task not found on this project' });
      if (parent.parent_id) return res.status(400).json({ error: 'Subtasks cannot have their own subtasks' });
    }
    const task = store.addTask(project.id, { title, parent_id: parentId, createdBy: req.user.id });
    res.status(201).json({ task });
  });

  router.patch('/tasks/:taskId', (req, res) => {
    const task = store.getTask(Number(req.params.taskId));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const project = store.getProject(task.project_id);
    if (!guardMutable(project, res)) return;
    const { title, done } = req.body || {};
    if (title !== undefined && !String(title).trim()) return res.status(400).json({ error: 'Task title cannot be empty' });
    const updated = store.updateTask(task.id, { title, done });
    if (done === true && !task.done) {
      store.addActivity(project.id, { type: 'task_done', authorId: req.user.id, payload: { title: updated.title } });
    }
    res.json({ task: updated });
  });

  router.delete('/tasks/:taskId', (req, res) => {
    const task = store.getTask(Number(req.params.taskId));
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const project = store.getProject(task.project_id);
    if (!guardMutable(project, res)) return;
    store.deleteTask(task.id);
    res.json({ ok: true });
  });

  // ---- metric catalog + reports (R06) ----

  router.get('/metrics', (_req, res) => {
    res.json({ metrics: store.listMetricDefinitions() });
  });

  const metricDefSchema = z.object({
    name: z.string().min(1).max(120),
    unit: z.enum(LBP_METRIC_UNITS),
    direction: z.enum(['up', 'down']).optional(),
  });

  // Members propose (status 'proposed'); a workspace admin's create is
  // active immediately. Approval before first use is enforced at report time.
  router.post('/metrics', (req, res) => {
    const parsed = metricDefSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'name and unit (count|hours|currency|percent) are required' });
    const isAdmin = req.user.role === 'admin';
    const metric = store.createMetricDefinition({
      ...parsed.data,
      direction: parsed.data.direction || 'up',
      status: newMetricDefinitionStatus({ isAdmin }),
      proposedBy: req.user.id,
    });
    res.status(201).json({ metric });
  });

  router.post('/metrics/:id/approve', requireAdmin, (req, res) => {
    const metric = store.getMetricDefinition(Number(req.params.id));
    if (!metric) return res.status(404).json({ error: 'Metric not found' });
    res.json({ metric: store.setMetricDefinitionStatus(metric.id, 'active') });
  });

  router.post('/metrics/:id/retire', requireAdmin, (req, res) => {
    const metric = store.getMetricDefinition(Number(req.params.id));
    if (!metric) return res.status(404).json({ error: 'Metric not found' });
    res.json({ metric: store.setMetricDefinitionStatus(metric.id, 'retired') });
  });

  router.get('/projects/:id/metric-reports', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    res.json({ reports: store.listMetricReports(project.id) });
  });

  const reportSchema = z.object({
    metric_definition_id: z.number().int().positive(),
    value: z.number(),
    period_label: z.string().max(120).nullable().optional(),
    source_text: z.string().max(1000).nullable().optional(),
    source_url: z.string().max(2000).nullable().optional(),
    file_id: z.number().int().positive().nullable().optional(),
    location_id: z.number().int().positive().nullable().optional(),
    corrects_report_id: z.number().int().positive().nullable().optional(),
  });

  // Reports are immutable — there is deliberately no PATCH/DELETE surface.
  router.post('/projects/:id/metric-reports', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const parsed = reportSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'metric_definition_id and a numeric value are required' });
    const definition = store.getMetricDefinition(parsed.data.metric_definition_id);
    const check = validateMetricReport({ definition, ...parsed.data });
    if (!check.ok) return res.status(400).json({ error: check.errors.join('; ') });
    const report = store.addMetricReport(project.id, { ...parsed.data, reportedBy: req.user.id });
    store.addActivity(project.id, {
      type: 'metric_report', authorId: req.user.id,
      payload: { report_id: report.id, metric: definition.name, value: report.value, unit: definition.unit },
    });
    res.status(201).json({ report });
  });

  // ---- time events ----

  router.get('/projects/:id/time-events', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    res.json({ events: store.listTimeEvents(project.id) });
  });

  const timeEventSchema = z.object({
    type: z.enum(LBP_TIME_EVENT_TYPES),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hours: z.number().min(0).max(1000).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
    location_id: z.number().int().positive().nullable().optional(),
  });

  router.post('/projects/:id/time-events', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const parsed = timeEventSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: `type (${LBP_TIME_EVENT_TYPES.join('|')}) and date are required` });
    const event = store.addTimeEvent(project.id, { ...parsed.data, createdBy: req.user.id });
    store.addActivity(project.id, {
      type: 'time_event', authorId: req.user.id,
      payload: { event_type: event.type, hours: event.hours },
    });
    res.status(201).json({ event });
  });

  // ---- feedback ----

  router.get('/projects/:id/feedback', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    res.json({
      feedback: store.listFeedback(project.id).map((f) => ({
        ...f, editable: canEditFeedback({ feedback: f, userId: req.user.id }),
      })),
    });
  });

  const feedbackSchema = z.object({
    source_name: z.string().max(200).nullable().optional(),
    source_role: z.string().max(200).nullable().optional(),
    sentiment: z.enum(LBP_SENTIMENTS),
    body: z.string().min(1).max(10000),
  });

  router.post('/projects/:id/feedback', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const parsed = feedbackSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'sentiment (positive|neutral|needs_work) and body are required' });
    const feedback = store.addFeedback(project.id, { ...parsed.data, capturedBy: req.user.id });
    store.addActivity(project.id, { type: 'feedback_added', authorId: req.user.id, payload: { sentiment: feedback.sentiment } });
    res.status(201).json({ feedback });
  });

  // Author-editable for 24h, then locked (decided default).
  router.patch('/feedback/:feedbackId', (req, res) => {
    const feedback = store.getFeedback(Number(req.params.feedbackId));
    if (!feedback) return res.status(404).json({ error: 'Feedback not found' });
    const project = store.getProject(feedback.project_id);
    if (!guardMutable(project, res)) return;
    if (!canEditFeedback({ feedback, userId: req.user.id })) {
      return res.status(403).json({ error: 'Feedback is only editable by its author within 24 hours of capture' });
    }
    const parsed = feedbackSchema.safeParse({ ...feedback, ...req.body });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid feedback fields' });
    res.json({ feedback: store.updateFeedback(feedback.id, parsed.data) });
  });

  // ---- learnings ----

  router.get('/projects/:id/learnings', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    res.json({ learnings: store.listLearnings(project.id) });
  });

  router.post('/projects/:id/learnings', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'A learning body is required' });
    const learning = store.addLearning(project.id, { body, createdBy: req.user.id });
    store.addActivity(project.id, { type: 'learning_added', authorId: req.user.id });
    res.status(201).json({ learning });
  });

  // ---- files ----

  router.get('/projects/:id/files', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    res.json({
      files: store.listFiles(project.id).map((f) => ({
        ...f, inline: INLINE_MIMES.has(f.mime),
      })),
    });
  });

  router.post('/projects/:id/files', upload.single('file'), (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    if (!req.file) return res.status(400).json({ error: 'A file is required' });
    const file = store.addFile(project.id, {
      original_name: req.file.originalname || 'upload',
      stored_name: req.file.filename,
      mime: req.file.mimetype || null,
      size_bytes: req.file.size || null,
      uploadedBy: req.user.id,
    });
    store.addActivity(project.id, { type: 'file_added', authorId: req.user.id, payload: { name: file.original_name, file_id: file.id } });
    res.status(201).json({ file: { ...file, inline: INLINE_MIMES.has(file.mime) } });
  });

  // Inline viewer + download. Content-Disposition switches on ?download=1.
  router.get('/files/:fileId', (req, res) => {
    const file = store.getFile(Number(req.params.fileId));
    if (!file) return res.status(404).json({ error: 'File not found' });
    const path = join(LBP_FILES_DIR, file.stored_name);
    if (!existsSync(path)) return res.status(410).json({ error: 'File contents are missing on disk' });
    const inline = INLINE_MIMES.has(file.mime) && req.query.download !== '1';
    res.setHeader('Content-Type', file.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.original_name)}"`);
    createReadStream(path).pipe(res);
  });

  // ---- project links (R11 — allowed on archived projects) ----

  router.post('/projects/:id/links', (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    const otherId = Number(req.body?.other_id);
    const pair = canonicalLinkPair(project.id, otherId);
    if (!pair.ok) return res.status(400).json({ error: pair.error });
    const other = store.getProject(otherId);
    if (!other) return res.status(404).json({ error: 'The other project was not found' });
    const link = store.addLink({ a: pair.a, b: pair.b, note: String(req.body?.note || '').trim() || null, createdBy: req.user.id });
    // Log on the ACTIVE side(s) only — archived projects stay frozen.
    if (!isArchived(project)) store.addActivity(project.id, { type: 'link_added', authorId: req.user.id, payload: { other_id: otherId } });
    res.status(201).json({ link });
  });

  router.delete('/links/:linkId', (req, res) => {
    const link = store.getLink(Number(req.params.linkId));
    if (!link) return res.status(404).json({ error: 'Link not found' });
    store.removeLink(link.id);
    res.json({ ok: true });
  });

  // ---- Mock2 (LXC AI-dev project) integration ----

  // Link an existing Mock2 project to an LBP card ("Build LXC" completes by
  // calling this after the Mock2 create succeeds). Admin — Mock2 project
  // creation itself is admin-gated, so the link follows the same bar.
  router.post('/projects/:id/link-lxc', requireAdmin, async (req, res) => {
    const project = loadProject(req, res);
    if (!project) return;
    if (!guardMutable(project, res)) return;
    const mock2Id = Number(req.body?.mock2_project_id);
    if (!Number.isInteger(mock2Id) || mock2Id <= 0) return res.status(400).json({ error: 'mock2_project_id is required' });
    const info = await lookupMock2Project(mock2Id);
    if (!info) return res.status(404).json({ error: 'That LXC build project was not found (is the Projects module enabled?)' });
    const updated = store.linkMock2Project(project.id, mock2Id);
    store.addActivity(project.id, { type: 'lxc_linked', authorId: req.user.id, payload: { mock2_project_id: mock2Id, source: 'build_lxc' } });
    logAudit(req.user.id, 'LBP_LINK_LXC', 'lbp_project', project.id, { mock2_project_id: mock2Id }, req.ip);
    res.json({ project: updated, lxc: info });
  });

  // Demo portfolio seed (concept sample data). Admin, empty workspace only.
  router.post('/seed-demo', requireAdmin, (req, res) => {
    const result = store.seedDemoPortfolio({ userId: req.user.id });
    if (!result.ok) return res.status(409).json({ error: result.error });
    logAudit(req.user.id, 'LBP_SEED_DEMO', 'lbp_workspace', 1, {}, req.ip);
    res.status(201).json(result);
  });

  return router;
}

// Look up a linked Mock2 project (name, lifecycle, container) without making
// LBP depend on the gated module: dynamic import, and only when the gate is
// open. Returns null when disabled/absent — the UI then offers "Build LXC".
async function lookupMock2Project(mock2ProjectId) {
  try {
    const { resolveMock2Gate } = await import('../mock2/gating.js');
    const gate = resolveMock2Gate({ env: process.env, existsSync });
    if (!gate.enabled) return null;
    const { getProject } = await import('../mock2/projects.js');
    const p = getProject(mock2ProjectId);
    if (!p) return null;
    return {
      id: p.id, name: p.name, lifecycle: p.lifecycle,
      container_name: p.container_name || null,
      slug: p.slug || null,
    };
  } catch {
    return null;
  }
}

async function lxcInfoFor(project) {
  if (!project.mock2_project_id) return null;
  const info = await lookupMock2Project(project.mock2_project_id);
  // Keep the id visible even if the module is gated off right now, so the
  // UI can say "linked but unavailable" instead of offering a second build.
  return info || { id: project.mock2_project_id, name: null, lifecycle: 'unavailable', container_name: null, slug: null };
}
