// Additive only: legacy projects and immutable run/guide history are retained.
export function operationalProjectTasksMigration1126(db) {
  db.exec(`
    CREATE TABLE ops_project_tasks (
      project_id TEXT PRIMARY KEY REFERENCES ops_projects(id),
      owner_user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
      request_sha256 TEXT NOT NULL, configuration_id TEXT REFERENCES ops_browser_agent_configurations(id),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), defaults_version TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_user_id,request_key)
    );
    CREATE TABLE ops_project_schedules (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_project_tasks(project_id),
      owner_user_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN('enabled','paused','deleted')),
      timing_json TEXT NOT NULL CHECK(json_valid(timing_json)), next_run_at TEXT,
      configuration_id TEXT NOT NULL REFERENCES ops_browser_agent_configurations(id),
      configuration_revision INTEGER NOT NULL, configuration_sha256 TEXT NOT NULL,
      guide_id TEXT NOT NULL, guide_sha256 TEXT NOT NULL, consent_sha256 TEXT NOT NULL,
      limits_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id,guide_id) REFERENCES ops_guide_versions(project_id,id)
    );
    CREATE UNIQUE INDEX ops_project_one_schedule ON ops_project_schedules(project_id) WHERE state!='deleted';
    CREATE INDEX ops_project_schedules_due ON ops_project_schedules(state,next_run_at);
    CREATE TABLE ops_project_schedule_occurrences (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES ops_project_schedules(id),
      schedule_revision INTEGER NOT NULL, due_at TEXT NOT NULL, local_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN('starting','started','blocked','missed','overlap','interrupted')),
      run_id TEXT REFERENCES ops_selected_browser_runs(id), result_code TEXT, created_at TEXT NOT NULL,
      UNIQUE(schedule_id,local_key)
    );
    ALTER TABLE ops_selected_browser_runs ADD COLUMN schedule_occurrence_id TEXT REFERENCES ops_project_schedule_occurrences(id);
    CREATE UNIQUE INDEX ops_project_occurrence_run ON ops_selected_browser_runs(schedule_occurrence_id) WHERE schedule_occurrence_id IS NOT NULL;
    CREATE TRIGGER ops_project_run_schedule_pin BEFORE UPDATE OF schedule_occurrence_id ON ops_selected_browser_runs
      WHEN NEW.schedule_occurrence_id IS NOT OLD.schedule_occurrence_id
      BEGIN SELECT RAISE(ABORT,'Scheduled run authority is immutable'); END;
    CREATE TRIGGER ops_project_occurrence_pins BEFORE UPDATE ON ops_project_schedule_occurrences
      WHEN NEW.id IS NOT OLD.id OR NEW.schedule_id IS NOT OLD.schedule_id OR NEW.schedule_revision IS NOT OLD.schedule_revision
        OR NEW.due_at IS NOT OLD.due_at OR NEW.local_key IS NOT OLD.local_key
      BEGIN SELECT RAISE(ABORT,'Scheduled occurrence pins are immutable'); END;
  `);
}
