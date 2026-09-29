// A4 credential bindings. Metadata only: a binding names an operator-authorized
// project, profile and binding UUID, a revision, a non-secret username and an
// OpenBao KV v2 path and version. There is no value, secret or hash column and
// no route writes it (activation stays off). A run pins the binding revision it
// was prepared with; history is append-only and a revoked binding is final.
export function operationalCredentialBindingMigration1110(d) {
  d.exec(`
    CREATE TABLE ops_agent_credential_bindings (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin = 'https://demo.fractionate.ai'),
      username TEXT NOT NULL CHECK(length(username) BETWEEN 3 AND 256),
      vault_mount TEXT NOT NULL CHECK(length(vault_mount) BETWEEN 1 AND 63),
      vault_path TEXT NOT NULL CHECK(length(vault_path) BETWEEN 1 AND 200),
      vault_version INTEGER NOT NULL CHECK(vault_version > 0),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY(project_id,profile_id) REFERENCES ops_agent_profiles(project_id,id)
    );
    CREATE UNIQUE INDEX ops_agent_one_active_binding ON ops_agent_credential_bindings(profile_id)
      WHERE state = 'active';
    CREATE TRIGGER ops_agent_credential_bindings_revoked_final BEFORE UPDATE ON ops_agent_credential_bindings
      WHEN OLD.state = 'revoked'
      BEGIN SELECT RAISE(ABORT,'Revoked credential binding is immutable'); END;
    CREATE TRIGGER ops_agent_credential_bindings_no_delete BEFORE DELETE ON ops_agent_credential_bindings
      BEGIN SELECT RAISE(ABORT,'Credential binding history is immutable'); END;
    CREATE TABLE ops_agent_credential_binding_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      binding_id TEXT NOT NULL REFERENCES ops_agent_credential_bindings(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK(kind IN ('created','rotated','revoked')),
      revision INTEGER NOT NULL CHECK(revision > 0),
      vault_version INTEGER NOT NULL CHECK(vault_version > 0),
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER ops_agent_credential_binding_events_no_update BEFORE UPDATE ON ops_agent_credential_binding_events
      BEGIN SELECT RAISE(ABORT,'Credential binding history is immutable'); END;
    CREATE TRIGGER ops_agent_credential_binding_events_no_delete BEFORE DELETE ON ops_agent_credential_binding_events
      BEGIN SELECT RAISE(ABORT,'Credential binding history is immutable'); END;
    ALTER TABLE ops_agent_runs ADD COLUMN credential_binding_id TEXT
      REFERENCES ops_agent_credential_bindings(id);
    ALTER TABLE ops_agent_runs ADD COLUMN credential_binding_revision INTEGER
      CHECK(credential_binding_revision IS NULL OR credential_binding_revision > 0);
  `);
}
