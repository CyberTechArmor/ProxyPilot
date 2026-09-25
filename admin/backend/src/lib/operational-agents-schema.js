// A2 metadata only. No execution, provider or credential tables are created here.
export function operationalAgentsMigration1106(d) {
  d.exec(`
    ALTER TABLE ops_projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'hidden'
      CHECK(visibility IN ('hidden','read-only','collaborative'));
    ALTER TABLE ops_projects ADD COLUMN site_origin TEXT;
    ALTER TABLE ops_projects ADD COLUMN site_revision INTEGER NOT NULL DEFAULT 1 CHECK(site_revision > 0);
    CREATE TABLE ops_access_requests (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending','approved','declined','cancelled')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      requested_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT,
      UNIQUE(project_id,id)
    );
    CREATE UNIQUE INDEX ops_one_pending_access_request ON ops_access_requests(project_id,user_id)
      WHERE state='pending';
    CREATE INDEX ops_access_requests_project ON ops_access_requests(project_id,state,requested_at);
    CREATE TABLE ops_agent_profiles (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id) ON DELETE RESTRICT,
      display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
      workflow_type TEXT NOT NULL CHECK(workflow_type IN ('synthetic_sign_in')),
      proposed_actions_json TEXT NOT NULL, proposed_origins_json TEXT NOT NULL,
      budgets_json TEXT NOT NULL, guide_version_id TEXT, guide_hash TEXT,
      assigned_site_revision INTEGER,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL, deleted_at TEXT,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,guide_version_id) REFERENCES ops_guide_versions(project_id,id),
      CHECK((guide_version_id IS NULL AND guide_hash IS NULL) OR
            (guide_version_id IS NOT NULL AND guide_hash IS NOT NULL))
    );
    CREATE INDEX ops_agent_profiles_project ON ops_agent_profiles(project_id,deleted_at,id);
    CREATE TABLE ops_agent_denials (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL,
      requested_project_id TEXT, action TEXT NOT NULL, status INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER ops_agent_denials_no_update BEFORE UPDATE ON ops_agent_denials
      BEGIN SELECT RAISE(ABORT,'Agent denial history is immutable'); END;
    CREATE TRIGGER ops_agent_denials_no_delete BEFORE DELETE ON ops_agent_denials
      BEGIN SELECT RAISE(ABORT,'Agent denial history is immutable'); END;
  `);
}
