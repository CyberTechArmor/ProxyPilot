// Lean BEAF Pro — schema (migration 700) + catalog seeds.
//
// Imported by src/db.js, which registers `lbpMigration700` in the main-DB
// migrations registry (block 700). Kept out of db.js only for size; the
// registration and version reservation still live there per the repo rule.
// No imports here — db.js hands us its live handle inside runMigration().
//
// All tables are additive (nothing existing is touched) and prefixed lbp_.
// User references are TEXT (main users.id is a UUID); cross-checks against
// the users table happen in the store, not via FKs, matching how the rest
// of the codebase treats user ids in feature tables.

export function lbpMigration700(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Admin-maintained rollout geography: Region → PODs → Sites.
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('site', 'pod', 'region')),
      parent_id INTEGER REFERENCES lbp_locations(id) ON DELETE SET NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // The project. Stage is the ONLY lifecycle axis (no status/priority/due
  // dates — deliberately removed in design). outcome NULL = active;
  // rolled_out/abandoned = archived (read-only, R09).
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      description TEXT,
      stage TEXT NOT NULL DEFAULT 'Idea'
        CHECK (stage IN ('Idea', 'MVP', 'Testing', 'Site', 'POD', 'Region', 'All')),
      start_date TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      outcome TEXT CHECK (outcome IN ('rolled_out', 'abandoned')),
      outcome_at TEXT,
      outcome_by TEXT,
      outcome_reason TEXT,
      outcome_takeaway TEXT,
      last_activity_at TEXT,
      mock2_project_id INTEGER,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_lbp_projects_outcome ON lbp_projects(outcome)`);

  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_project_assignees (
      project_id INTEGER NOT NULL REFERENCES lbp_projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      PRIMARY KEY (project_id, user_id)
    )
  `);

  // 1:1 rollout scope (R03). POD membership (current + planned) is the
  // junction table below so "one or more PODs" stays relational.
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_rollout_scopes (
      project_id INTEGER PRIMARY KEY REFERENCES lbp_projects(id) ON DELETE CASCADE,
      testers_text TEXT,
      site_id INTEGER,
      region_id INTEGER
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_scope_pods (
      project_id INTEGER NOT NULL REFERENCES lbp_projects(id) ON DELETE CASCADE,
      location_id INTEGER NOT NULL,
      planned INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, location_id, planned)
    )
  `);

  // Every mutation writes one entry (comment | system subtypes). Powers
  // movement tracking (R04) and the grounded briefs (R07).
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES lbp_projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      author_id TEXT,
      body TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_lbp_activity_project ON lbp_activity(project_id, created_at DESC)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_lbp_activity_created ON lbp_activity(created_at DESC)`);

  // Meeting markers accumulate as history; current = latest (R05).
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_meeting_markers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT 1,
      marked_at TEXT NOT NULL,
      marked_by TEXT,
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'schedule'))
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_lbp_markers_at ON lbp_meeting_markers(marked_at DESC)`);

  // One weekly schedule per workspace; occurrences materialize markers
  // lazily (source='schedule') when any meeting-aware endpoint is read.
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_meeting_schedules (
      workspace_id INTEGER PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 0,
      day_of_week INTEGER NOT NULL DEFAULT 1,
      time_hhmm TEXT NOT NULL DEFAULT '09:00',
      updated_by TEXT,
      updated_at TEXT
    )
  `);

  // Workspace metric catalog (R06). Members propose; admin approves
  // ('active') before first use.
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_metric_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT 1,
      name TEXT NOT NULL,
      unit TEXT NOT NULL CHECK (unit IN ('count', 'hours', 'currency', 'percent')),
      direction TEXT NOT NULL DEFAULT 'up',
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('active', 'proposed', 'retired')),
      proposed_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Immutable evidence rows (R06): no UPDATE/DELETE surface exists;
  // corrections are new reports pointing at the old via corrects_report_id.
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_metric_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES lbp_projects(id) ON DELETE CASCADE,
      metric_definition_id INTEGER NOT NULL,
      value REAL NOT NULL,
      period_label TEXT,
      source_text TEXT,
      source_url TEXT,
      file_id INTEGER,
      location_id INTEGER,
      corrects_report_id INTEGER,
      reported_by TEXT,
      reported_at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_lbp_reports_project ON lbp_metric_reports(project_id, reported_at DESC)`);

  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_time_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES lbp_projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      hours REAL,
      note TEXT,
      location_id INTEGER,
      created_by TEXT,
      created_at TEXT NOT NULL
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES lbp_projects(id) ON DELETE CASCADE,
      source_name TEXT,
      source_role TEXT,
      sentiment TEXT NOT NULL DEFAULT 'neutral'
        CHECK (sentiment IN ('positive', 'neutral', 'needs_work')),
      body TEXT NOT NULL,
      captured_by TEXT,
      captured_at TEXT NOT NULL,
      updated_at TEXT
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES lbp_projects(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES lbp_projects(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime TEXT,
      size_bytes INTEGER,
      uploaded_by TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // Bidirectional links, one row per canonical (min,max) pair (R11); may
  // point at archived projects.
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_project_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_a INTEGER NOT NULL,
      project_b INTEGER NOT NULL,
      note TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (project_a, project_b)
    )
  `);

  // Project to-dos with one level of subtasks. Top-level count is
  // informational only — never a headline progress figure (locked design).
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES lbp_projects(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES lbp_tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TEXT NOT NULL,
      done_at TEXT
    )
  `);

  // ---- catalog seeds (idempotent: only when empty) ----

  const haveWorkspace = d.prepare(`SELECT COUNT(*) AS n FROM lbp_workspaces`).get().n;
  if (haveWorkspace === 0) {
    d.prepare(`INSERT INTO lbp_workspaces (id, name) VALUES (1, 'Spec Ops')`).run();
  }

  const haveLocations = d.prepare(`SELECT COUNT(*) AS n FROM lbp_locations`).get().n;
  if (haveLocations === 0) {
    const insLoc = d.prepare(`INSERT INTO lbp_locations (name, kind, parent_id) VALUES (?, ?, ?)`);
    const region = insLoc.run('North Region', 'region', null).lastInsertRowid;
    const west = insLoc.run('West', 'pod', region).lastInsertRowid;
    insLoc.run('East', 'pod', region);
    insLoc.run('Central', 'pod', region);
    insLoc.run('Northside', 'site', west);
    insLoc.run('Lakeview', 'site', west);
    insLoc.run('Downtown', 'site', west);
  }

  const haveMetrics = d.prepare(`SELECT COUNT(*) AS n FROM lbp_metric_definitions`).get().n;
  if (haveMetrics === 0) {
    const insMet = d.prepare(
      `INSERT INTO lbp_metric_definitions (name, unit, direction, status) VALUES (?, ?, ?, 'active')`,
    );
    insMet.run('Appointments generated', 'count', 'up');
    insMet.run('Man-hours saved', 'hours', 'up');
    insMet.run('Cost saved ($)', 'currency', 'up');
    insMet.run('Calls deflected', 'count', 'up');
    insMet.run('Documents processed', 'count', 'up');
  }
}

// Migration 701 (additive) — blockers. Operator addition (Thomas, 2026-07):
// a project can be flagged "blocked" with a reason and a date (defaults to
// today, editable). "Break barrier" resolves the open flag and records the
// date. Each block→break cycle is one immutable row, so the table doubles as
// the blocker audit trail. A project is derived-blocked iff it has a row with
// resolved_at IS NULL. This supersedes the original "no blocked flag" default.
export function lbpMigration701Blockers(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_blockers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES lbp_projects(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      blocked_at TEXT NOT NULL,
      blocked_by TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      resolved_note TEXT,
      created_at TEXT NOT NULL
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_lbp_blockers_project ON lbp_blockers(project_id, created_at DESC)`);
  // Fast "is this project currently blocked?" lookup (open rows only).
  d.exec(`CREATE INDEX IF NOT EXISTS idx_lbp_blockers_open ON lbp_blockers(project_id) WHERE resolved_at IS NULL`);
}

// Migration 702 (additive) — manual vertical order within a Kanban column.
// board_pos is the drag-sorted position inside a stage column (lower = higher
// up). It only drives the Board; the List keeps its pinned/last-activity
// order. New rows default 0 and fall back to last-activity order among peers.
export function lbpMigration702BoardOrder(d) {
  const cols = d.prepare(`PRAGMA table_info(lbp_projects)`).all().map((c) => c.name);
  if (!cols.includes('board_pos')) {
    d.exec(`ALTER TABLE lbp_projects ADD COLUMN board_pos INTEGER NOT NULL DEFAULT 0`);
  }
}

// Migration 703 (additive) — MULTIPLE recurring meeting schedules. The
// original design had a single weekly schedule (lbp_meeting_schedules, one
// row per workspace); operators need several (e.g. a daily stand-up plus a
// weekly review, and the odd different-time day). lbp_schedules holds many
// rows, each daily or weekly. The single legacy row is migrated in if it was
// active. Ad-hoc meetings are still the "Mark meeting now" button.
export function lbpMigration703Schedules(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS lbp_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL DEFAULT 1,
      label TEXT,
      frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily', 'weekly')),
      day_of_week INTEGER,
      time_hhmm TEXT NOT NULL DEFAULT '09:00',
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // One-time migration of the legacy single schedule, if present and active
  // and nothing has been seeded into the new table yet.
  const already = d.prepare(`SELECT COUNT(*) AS n FROM lbp_schedules`).get().n;
  if (already === 0) {
    const legacy = d.prepare(`SELECT * FROM lbp_meeting_schedules WHERE workspace_id = 1`).get();
    if (legacy && legacy.active) {
      d.prepare(`
        INSERT INTO lbp_schedules (workspace_id, label, frequency, day_of_week, time_hhmm, active, created_at)
        VALUES (1, 'Weekly meeting', 'weekly', ?, ?, 1, ?)
      `).run(legacy.day_of_week ?? 1, legacy.time_hhmm || '09:00', legacy.updated_at || new Date(0).toISOString());
    }
  }
}
