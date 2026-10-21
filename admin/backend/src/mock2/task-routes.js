// Task continuity — the HTTP API over a project's tasks (mock2_tasks).
//
// A task is what Flightdeck remembers independently of the chat: one build per
// request, or one ask-lane investigation. These routes let the task strip list
// them, open one, resume it and stop it. The database row is authoritative;
// the portable files under state/tasks/<key>/ mirror it and authorize nothing,
// so nothing here reads them.
//
// Auth: mounted on the mock2 router (already authenticateToken +
// blockPendingRole + CSRF via /api/ + rate-limited). Each route adds
// requireMock2Role — 'viewer' for reads, 'editor' for resume/stop — and resume
// adds refuseIfArchived. Resume reuses the existing machinery only: a build
// resumes through runner.retryCycle (a build a person authorized; its resume
// context carries the task's recovery section), an investigation continues
// read-only in the ask lane. Stop of a live build has exactly the effect of the
// cycle interrupt route (stop_after_step via cycles.requestCycleInterrupt).
// The decisions live in task-sync.js / task-logic.js and are unit-tested there.
//
// Terminology (risk R7): nothing here is named "agent".

import { z } from 'zod';
import { requireMock2Role } from './authz.js';
import { isValidTaskKey } from './task-logic.js';
import {
  listTaskShapes, getTaskShapeByKey, resumeTaskByKey, stopTaskByKey,
} from './task-sync.js';

const listSchema = z.object({
  scope: z.enum(['unfinished', 'all']).default('unfinished'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const resumeSchema = z.object({
  message: z.string().trim().max(4000).optional(),
});

// An invalid key is indistinguishable from an unknown one (404) — and is never
// passed on to a lookup or a path builder.
function keyOr404(req, res) {
  const key = String(req.params.key || '');
  if (!isValidTaskKey(key)) {
    res.status(404).json({ error: 'Task not found' });
    return null;
  }
  return key;
}

export function registerTaskRoutes(router, refuseIfArchived) {
  // ---- read: the project's tasks + the one the strip shows ----
  router.get('/projects/:id/tasks', requireMock2Role('viewer'), async (req, res) => {
    const parsed = listSchema.safeParse(req.query || {});
    if (!parsed.success) return res.status(400).json({ error: 'scope must be unfinished or all; limit 1–100' });
    try {
      res.json(await listTaskShapes(req.mock2Project.id, parsed.data));
    } catch (err) {
      res.status(500).json({ error: `Could not list tasks: ${err?.message || 'unknown error'}` });
    }
  });

  // ---- read: one task ----
  router.get('/projects/:id/tasks/:key', requireMock2Role('viewer'), async (req, res) => {
    const key = keyOr404(req, res);
    if (!key) return;
    try {
      const task = await getTaskShapeByKey(req.mock2Project.id, key);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({ task });
    } catch (err) {
      res.status(500).json({ error: `Could not read the task: ${err?.message || 'unknown error'}` });
    }
  });

  // ---- resume: a build through retryCycle, an investigation read-only ----
  router.post('/projects/:id/tasks/:key/resume', requireMock2Role('editor'), refuseIfArchived, async (req, res) => {
    const key = keyOr404(req, res);
    if (!key) return;
    const parsed = resumeSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'message must be text (at most 4000 characters)' });
    try {
      const r = await resumeTaskByKey({
        project: req.mock2Project, key, message: parsed.data.message || '',
        user: req.user, actingAsAdmin: req.mock2Access?.actingAsAdmin ? 1 : 0, ip: req.ip,
      });
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(500).json({ error: `Could not resume the task: ${err?.message || 'unknown error'}` });
    }
  });

  // ---- stop: a live build after its current step; otherwise mark stopped ----
  // No refuseIfArchived: stopping is always allowed (an archived project has
  // nothing running, and marking its task stopped changes no container).
  router.post('/projects/:id/tasks/:key/stop', requireMock2Role('editor'), async (req, res) => {
    const key = keyOr404(req, res);
    if (!key) return;
    try {
      const r = await stopTaskByKey({ project: req.mock2Project, key, user: req.user, ip: req.ip });
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(500).json({ error: `Could not stop the task: ${err?.message || 'unknown error'}` });
    }
  });
}
