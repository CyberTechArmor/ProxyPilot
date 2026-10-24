// /api/mock2/projects/:id/database-exception — the person's recorded request
// for SQLite (app foundation, 2026-10; docs/features/app-foundation.md).
//
//   GET    → { exception: null | { engine, request_text, recorded_by, created_at } }
//   PUT    { engine: 'sqlite', request_text, acknowledge: true } → { exception }
//   DELETE → { exception: null, cleared: boolean }
//
// Auth: mounted on the mock2 router (authenticateToken + blockPendingRole +
// CSRF + rate limit). Reads need the project's viewer role; recording or
// clearing needs the editor role — the same check as the project's other write
// routes — plus sudo, and is audited (MOCK2_DATABASE_EXCEPTION_SET /
// MOCK2_DATABASE_EXCEPTION_CLEARED). Recording also refuses an archived
// project; clearing never does (it only makes the rule stricter).
//
// This is the ONLY writer. A build cannot reach it (it has no session), and no
// MCP tool calls it (ratchet in mock2-database-exception.test.js). Every
// dependency is injected so the routes test without Express or mock2.db.
//
// Terminology (risk R7): nothing here is named "agent".

import { validateExceptionInput } from './database-exception-logic.js';

const PATH = '/projects/:id/database-exception';

export function registerDatabaseExceptionRoutes(router, deps = {}) {
  const { requireRole, refuseIfArchived, requireSudo, store, audit } = deps;
  for (const [k, v] of Object.entries({ requireRole, refuseIfArchived, requireSudo, audit })) {
    if (typeof v !== 'function') throw new TypeError(`registerDatabaseExceptionRoutes: ${k} dependency is required`);
  }
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function' || typeof store.clear !== 'function') {
    throw new TypeError('registerDatabaseExceptionRoutes: store dependency is required');
  }

  router.get(PATH, requireRole('viewer'), (req, res) => {
    try {
      res.json({ exception: store.get(req.mock2Project.id) });
    } catch (err) {
      res.status(500).json({ error: `Could not read the database exception: ${err?.message || 'unknown error'}` });
    }
  });

  router.put(PATH, requireRole('editor'), refuseIfArchived, requireSudo, (req, res) => {
    const v = validateExceptionInput(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error, code: v.code });
    const project = req.mock2Project;
    try {
      const previous = store.get(project.id);
      const recordedBy = req.user?.username || (req.user?.id != null ? `user:${req.user.id}` : 'unknown');
      const exception = store.set(project.id, v.value, recordedBy);
      audit(req.user?.id ?? null, 'MOCK2_DATABASE_EXCEPTION_SET', 'mock2_project', project.id, {
        engine: v.value.engine,
        request_text: v.value.request_text,
        replaced: !!previous,
        acting_as_admin: !!req.mock2Access?.actingAsAdmin,
      }, req.ip);
      res.json({ exception });
    } catch (err) {
      res.status(500).json({ error: `Could not record the database exception: ${err?.message || 'unknown error'}` });
    }
  });

  router.delete(PATH, requireRole('editor'), requireSudo, (req, res) => {
    const project = req.mock2Project;
    try {
      const previous = store.clear(project.id);
      if (previous) {
        audit(req.user?.id ?? null, 'MOCK2_DATABASE_EXCEPTION_CLEARED', 'mock2_project', project.id, {
          engine: previous.engine,
          recorded_by: previous.recorded_by,
          recorded_at: previous.created_at,
          acting_as_admin: !!req.mock2Access?.actingAsAdmin,
        }, req.ip);
      }
      res.json({ exception: null, cleared: !!previous });
    } catch (err) {
      res.status(500).json({ error: `Could not clear the database exception: ${err?.message || 'unknown error'}` });
    }
  });
}
