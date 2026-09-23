// A leaf module: db.js imports the schema without pulling the Keycloak/SSO graph into its evaluation.
export const KEYCLOAK_LDAP_APP = 'pp-keycloak-ldap';
export const KEYCLOAK_LDAP_SCHEMA = `
CREATE TABLE IF NOT EXISTS setup_keycloak_ldap (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, config_json TEXT, linked_json TEXT,
 installation_id TEXT, component_id TEXT, mapper_id TEXT, status_json TEXT NOT NULL DEFAULT '{}',
 admin_ref TEXT, bind_ref TEXT, last_job_id TEXT, updated_by TEXT, updated_at TEXT NOT NULL
);
`;
