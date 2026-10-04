// Metadata namespace only. No secrets, vault handles, tokens or active adapter.
// User IDs intentionally have no user FK: account deletion preserves history.
export function operationalBrowserConnectionsMigration1124(db) {
  db.exec(`
    CREATE TABLE ops_browser_connections (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id),
      contributor_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
      version INTEGER NOT NULL CHECK(version>0), status TEXT NOT NULL CHECK(status IN('draft','revoked')),
      name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('website-login','oauth')),
      origin TEXT NOT NULL, account_hint TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revoked_at TEXT,
      CHECK((status='draft' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL)),
      UNIQUE(project_id,id)
    );
    CREATE INDEX ops_browser_connections_project ON ops_browser_connections(project_id,id);
    CREATE TRIGGER ops_browser_connection_identity BEFORE UPDATE ON ops_browser_connections
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
        OR NEW.contributor_id IS NOT OLD.contributor_id OR NEW.kind IS NOT OLD.kind
        OR NEW.created_at IS NOT OLD.created_at OR OLD.status='revoked'
        OR NEW.revision!=OLD.revision+1 OR NEW.version<OLD.version OR NEW.version>OLD.version+1
        OR ((NEW.name IS NOT OLD.name OR NEW.origin IS NOT OLD.origin OR NEW.account_hint IS NOT OLD.account_hint)
          AND NEW.version!=OLD.version+1)
      BEGIN SELECT RAISE(ABORT,'Browser connection identity and revocation are final'); END;
    CREATE TRIGGER ops_browser_connection_no_delete BEFORE DELETE ON ops_browser_connections
      BEGIN SELECT RAISE(ABORT,'Browser connection history is immutable'); END;
    CREATE TABLE ops_browser_connection_versions (
      connection_id TEXT NOT NULL REFERENCES ops_browser_connections(id), version INTEGER NOT NULL CHECK(version>0),
      name TEXT NOT NULL, origin TEXT NOT NULL, account_hint TEXT NOT NULL,
      saved_by TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY(connection_id,version)
    );
    CREATE TRIGGER ops_browser_connection_version_no_update BEFORE UPDATE ON ops_browser_connection_versions
      BEGIN SELECT RAISE(ABORT,'Browser connection version is immutable'); END;
    CREATE TRIGGER ops_browser_connection_version_no_delete BEFORE DELETE ON ops_browser_connection_versions
      BEGIN SELECT RAISE(ABORT,'Browser connection version history is immutable'); END;
    CREATE TABLE ops_browser_connection_grants (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES ops_browser_connections(id),
      version INTEGER NOT NULL CHECK(version>0), recipient_id TEXT NOT NULL,
      permission TEXT NOT NULL CHECK(permission IN('view_metadata','propose_use')),
      membership_role TEXT NOT NULL CHECK(membership_role IN('owner','viewer','operator','editor','reviewer')),
      membership_event_id INTEGER NOT NULL CHECK(membership_event_id>=0),
      expires_at TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at TEXT NOT NULL,
      revoked_at TEXT, revoked_by TEXT, revoke_reason TEXT,
      FOREIGN KEY(connection_id,version) REFERENCES ops_browser_connection_versions(connection_id,version)
    );
    CREATE INDEX ops_browser_connection_grant_recipient ON ops_browser_connection_grants(connection_id,recipient_id,expires_at);
    CREATE UNIQUE INDEX ops_browser_connection_one_live_grant ON ops_browser_connection_grants(connection_id,recipient_id,permission)
      WHERE revoked_at IS NULL;
    CREATE TRIGGER ops_browser_connection_grant_identity BEFORE UPDATE ON ops_browser_connection_grants
      WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.version IS NOT OLD.version
        OR NEW.recipient_id IS NOT OLD.recipient_id OR NEW.permission IS NOT OLD.permission
        OR NEW.membership_role IS NOT OLD.membership_role OR NEW.membership_event_id IS NOT OLD.membership_event_id
        OR NEW.expires_at IS NOT OLD.expires_at OR NEW.granted_by IS NOT OLD.granted_by
        OR NEW.granted_at IS NOT OLD.granted_at OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
      BEGIN SELECT RAISE(ABORT,'Browser connection grant identity and revocation are final'); END;
    CREATE TRIGGER ops_browser_connection_grant_no_delete BEFORE DELETE ON ops_browser_connection_grants
      BEGIN SELECT RAISE(ABORT,'Browser connection grant history is immutable'); END;
  `);
}
