// A3 identity and fencing only. There is no HTTP start route or installed runner.
export function operationalWorkerMigration1107(d) {
  d.exec(`
    CREATE TABLE ops_agent_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
      site_origin TEXT NOT NULL,
      site_revision INTEGER NOT NULL CHECK(site_revision > 0),
      guide_version_id TEXT NOT NULL,
      guide_hash TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      max_seconds INTEGER NOT NULL CHECK(max_seconds BETWEEN 1 AND 300),
      max_actions INTEGER NOT NULL CHECK(max_actions BETWEEN 1 AND 20),
      state TEXT NOT NULL CHECK(state IN
        ('prepared','starting','running','cancelling','cancelled','blocked','failed','completed')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
      action_count INTEGER NOT NULL DEFAULT 0 CHECK(action_count BETWEEN 0 AND 20),
      started_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id,profile_id) REFERENCES ops_agent_profiles(project_id,id),
      FOREIGN KEY(project_id,guide_version_id) REFERENCES ops_guide_versions(project_id,id)
    );
    CREATE UNIQUE INDEX ops_agent_one_active_run ON ops_agent_runs(profile_id)
      WHERE state IN ('prepared','starting','running','cancelling');
    CREATE TRIGGER ops_agent_runs_terminal_no_update BEFORE UPDATE ON ops_agent_runs
      WHEN OLD.state IN ('cancelled','blocked','failed','completed')
      BEGIN SELECT RAISE(ABORT,'Terminal agent run is immutable'); END;
    CREATE TRIGGER ops_agent_runs_no_delete BEFORE DELETE ON ops_agent_runs
      BEGIN SELECT RAISE(ABORT,'Agent run history is immutable'); END;
    CREATE TABLE ops_agent_worker_attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      attempt_no INTEGER NOT NULL CHECK(attempt_no > 0),
      fence INTEGER NOT NULL CHECK(fence > 0),
      state TEXT NOT NULL CHECK(state IN ('starting','running','stopped','lost')),
      lease_expires_at TEXT NOT NULL,
      workspace_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      stopped_at TEXT,
      UNIQUE(run_id,attempt_no), UNIQUE(run_id,fence)
    );
    CREATE UNIQUE INDEX ops_agent_one_active_attempt ON ops_agent_worker_attempts(run_id)
      WHERE state IN ('starting','running');
    CREATE TRIGGER ops_agent_worker_attempts_terminal_no_update BEFORE UPDATE ON ops_agent_worker_attempts
      WHEN OLD.state IN ('stopped','lost')
      BEGIN SELECT RAISE(ABORT,'Terminal worker attempt is immutable'); END;
    CREATE TRIGGER ops_agent_worker_attempts_no_delete BEFORE DELETE ON ops_agent_worker_attempts
      BEGIN SELECT RAISE(ABORT,'Worker attempt history is immutable'); END;
    CREATE TABLE ops_agent_worker_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      attempt_id TEXT,
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER ops_agent_worker_events_no_update BEFORE UPDATE ON ops_agent_worker_events
      BEGIN SELECT RAISE(ABORT,'Worker event history is immutable'); END;
    CREATE TRIGGER ops_agent_worker_events_no_delete BEFORE DELETE ON ops_agent_worker_events
      BEGIN SELECT RAISE(ABORT,'Worker event history is immutable'); END;
  `);
}
