// Main database migration 1100. Definitions only; never opens a database.
export function operationalProjectsMigration1100(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS ops_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
      description TEXT NOT NULL DEFAULT '', owner_user_id TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      archived_at TEXT, archived_by TEXT, archive_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS ops_projects_owner ON ops_projects(owner_user_id, id);
    CREATE TABLE IF NOT EXISTS ops_project_grants (
      project_id TEXT NOT NULL REFERENCES ops_projects(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('viewer','operator','editor','reviewer')),
      granted_by TEXT NOT NULL, granted_at TEXT NOT NULL,
      PRIMARY KEY(project_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS ops_grants_user ON ops_project_grants(user_id,project_id);
    CREATE TABLE IF NOT EXISTS ops_guide_drafts (
      project_id TEXT PRIMARY KEY REFERENCES ops_projects(id) ON DELETE RESTRICT,
      title TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ops_draft_contributors (
      project_id TEXT NOT NULL REFERENCES ops_guide_drafts(project_id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL, PRIMARY KEY(project_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS ops_project_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES ops_projects(id) ON DELETE RESTRICT,
      actor_id TEXT NOT NULL, action TEXT NOT NULL, subject_id TEXT,
      created_at TEXT NOT NULL, request_id TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS ops_events_project ON ops_project_events(project_id,id);
    CREATE TRIGGER IF NOT EXISTS ops_events_no_update BEFORE UPDATE ON ops_project_events
      BEGIN SELECT RAISE(ABORT, 'Operational history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ops_events_no_delete BEFORE DELETE ON ops_project_events
      BEGIN SELECT RAISE(ABORT, 'Operational history is immutable'); END;
  `);
  // User IDs deliberately have no user FK: deleting an account must neither
  // delete operational history nor break existing user-deletion behavior.
}

export function operationalProjectsMigration1101(d) {
  d.exec(`
    CREATE TABLE ops_guide_submissions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id),
      draft_revision INTEGER NOT NULL, base_version_id TEXT,
      title TEXT NOT NULL, instructions TEXT NOT NULL, content_hash TEXT NOT NULL,
      contributors_json TEXT NOT NULL, submitted_by TEXT NOT NULL, submitted_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','changes_requested','cancelled')),
      revision INTEGER NOT NULL DEFAULT 1, decided_by TEXT, decided_at TEXT, reason TEXT,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,base_version_id) REFERENCES ops_guide_versions(project_id,id)
    );
    CREATE UNIQUE INDEX ops_one_pending ON ops_guide_submissions(project_id) WHERE state='pending';
    CREATE TABLE ops_guide_versions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id),
      version_number INTEGER NOT NULL CHECK(version_number>0), submission_id TEXT NOT NULL UNIQUE,
      approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, content_hash TEXT NOT NULL,
      predecessor_id TEXT, UNIQUE(project_id,id), UNIQUE(project_id,version_number),
      FOREIGN KEY(project_id,submission_id) REFERENCES ops_guide_submissions(project_id,id),
      FOREIGN KEY(project_id,predecessor_id) REFERENCES ops_guide_versions(project_id,id)
    );
    CREATE TABLE ops_guide_state (
      project_id TEXT PRIMARY KEY REFERENCES ops_projects(id), base_version_id TEXT,
      phase TEXT NOT NULL DEFAULT 'draft' CHECK(phase IN ('draft','published')),
      FOREIGN KEY(project_id,base_version_id) REFERENCES ops_guide_versions(project_id,id)
    );
    INSERT INTO ops_guide_state(project_id) SELECT id FROM ops_projects;
    CREATE TABLE ops_version_withdrawals (
      project_id TEXT NOT NULL, version_id TEXT NOT NULL UNIQUE,
      actor_id TEXT NOT NULL, created_at TEXT NOT NULL, reason TEXT NOT NULL,
      FOREIGN KEY(project_id,version_id) REFERENCES ops_guide_versions(project_id,id)
    );
    CREATE TRIGGER ops_submission_content_immutable BEFORE UPDATE ON ops_guide_submissions
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
      OR NEW.draft_revision IS NOT OLD.draft_revision OR NEW.base_version_id IS NOT OLD.base_version_id
      OR NEW.title IS NOT OLD.title OR NEW.instructions IS NOT OLD.instructions
      OR NEW.content_hash IS NOT OLD.content_hash OR NEW.contributors_json IS NOT OLD.contributors_json
      OR NEW.submitted_by IS NOT OLD.submitted_by OR NEW.submitted_at IS NOT OLD.submitted_at
      OR OLD.state <> 'pending' OR NEW.state='pending' OR NEW.revision <> OLD.revision+1
      OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL
      BEGIN SELECT RAISE(ABORT,'Submission is immutable or transition invalid'); END;
  `);
  for (const table of ['ops_guide_submissions','ops_guide_versions','ops_version_withdrawals']) {
    d.exec(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Guide history is immutable'); END;`);
    if (table !== 'ops_guide_submissions') d.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Guide history is immutable'); END;`);
  }
}

export function operationalProjectsMigration1102(d) {
  d.exec(`CREATE TABLE ops_manual_runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id), version_id TEXT NOT NULL,
    recorder_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('completed','blocked','aborted')), notes TEXT NOT NULL,
    corrects_run_id TEXT UNIQUE, reason TEXT, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
    UNIQUE(project_id,id), UNIQUE(project_id,recorder_id,idempotency_key),
    FOREIGN KEY(project_id,version_id) REFERENCES ops_guide_versions(project_id,id),
    FOREIGN KEY(project_id,corrects_run_id) REFERENCES ops_manual_runs(project_id,id)
  );
  CREATE INDEX ops_runs_project ON ops_manual_runs(project_id,id);
  CREATE TRIGGER ops_runs_correction BEFORE INSERT ON ops_manual_runs
    WHEN NEW.corrects_run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ops_manual_runs old WHERE old.id=NEW.corrects_run_id AND old.project_id=NEW.project_id
      AND old.version_id=NEW.version_id AND old.recorder_id=NEW.recorder_id AND NEW.id<>old.id)
    BEGIN SELECT RAISE(ABORT,'Invalid correction provenance'); END;
  CREATE TRIGGER ops_runs_no_update BEFORE UPDATE ON ops_manual_runs BEGIN SELECT RAISE(ABORT,'Run history is immutable'); END;
  CREATE TRIGGER ops_runs_no_delete BEFORE DELETE ON ops_manual_runs BEGIN SELECT RAISE(ABORT,'Run history is immutable'); END;`);
}
