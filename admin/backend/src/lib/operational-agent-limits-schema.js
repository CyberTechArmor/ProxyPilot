// Additive A3 follow-up. Project limits are unset by default. The run-table
// rebuild removes the pilot's 300-second/20-action CHECKs without changing
// existing run, attempt or event identities and history.
export function operationalAgentLimitsMigration1108(d) {
  d.exec(`
    ALTER TABLE ops_projects ADD COLUMN agent_limits_json TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE ops_projects ADD COLUMN agent_limits_revision INTEGER NOT NULL DEFAULT 1
      CHECK(agent_limits_revision > 0);
    CREATE TABLE ops_agent_runs_new (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
      site_origin TEXT NOT NULL,
      site_revision INTEGER NOT NULL CHECK(site_revision > 0),
      guide_version_id TEXT NOT NULL,
      guide_hash TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      project_limits_revision INTEGER NOT NULL CHECK(project_limits_revision >= 0),
      max_seconds INTEGER CHECK(max_seconds > 0),
      max_actions INTEGER CHECK(max_actions > 0),
      state TEXT NOT NULL CHECK(state IN
        ('prepared','starting','running','cancelling','cancelled','blocked','failed','completed')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
      action_count INTEGER NOT NULL DEFAULT 0 CHECK(action_count >= 0),
      started_at TEXT NOT NULL,
      deadline_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id,profile_id) REFERENCES ops_agent_profiles(project_id,id),
      FOREIGN KEY(project_id,guide_version_id) REFERENCES ops_guide_versions(project_id,id)
    );
    INSERT INTO ops_agent_runs_new (
      id,project_id,profile_id,profile_revision,site_origin,site_revision,
      guide_version_id,guide_hash,policy_digest,project_limits_revision,
      max_seconds,max_actions,state,revision,fence,action_count,
      started_at,deadline_at,updated_at)
    SELECT id,project_id,profile_id,profile_revision,site_origin,site_revision,
      guide_version_id,guide_hash,policy_digest,0,
      max_seconds,max_actions,state,revision,fence,action_count,
      started_at,deadline_at,updated_at FROM ops_agent_runs;
    DROP TABLE ops_agent_runs;
    ALTER TABLE ops_agent_runs_new RENAME TO ops_agent_runs;
    CREATE UNIQUE INDEX ops_agent_one_active_run ON ops_agent_runs(profile_id)
      WHERE state IN ('prepared','starting','running','cancelling');
    CREATE TRIGGER ops_agent_runs_terminal_no_update BEFORE UPDATE ON ops_agent_runs
      WHEN OLD.state IN ('cancelled','blocked','failed','completed')
      BEGIN SELECT RAISE(ABORT,'Terminal agent run is immutable'); END;
    CREATE TRIGGER ops_agent_runs_no_delete BEFORE DELETE ON ops_agent_runs
      BEGIN SELECT RAISE(ABORT,'Agent run history is immutable'); END;
  `);
  const broken = d.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) throw new Error('Operations limit migration broke foreign keys');
}
