import { z } from 'zod';

// A4 credential binding metadata (migration 1110). A binding is an operator-
// authorized reference, never a secret: project, profile and binding UUIDs, a
// revision, the synthetic account's non-secret username, and the OpenBao KV v2
// mount, path and version that hold the value. The strict schemas below have
// no value field, so a value cannot be stored here even by mistake. The host
// credential broker keeps its own registry and re-checks the revision at every
// use; this store is what the backend pins into a run's launch contract. No
// route constructs it: A4 activation stays off.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schemas = {
  bind: z.object({ binding_id: uuid, project_id: uuid, profile_id: uuid,
    username: z.string().max(256).regex(/^[a-z0-9._+-]+@[a-z0-9.-]+$/),
    vault_mount: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    vault_path: z.string().regex(/^agents\/[a-z][a-z0-9-]{1,39}\/[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
    vault_version: version }).strict(),
  rotate: z.object({ binding_id: uuid, expected_revision: version, vault_version: version }).strict(),
  revoke: z.object({ binding_id: uuid }).strict(),
};
export const CREDENTIAL_ORIGIN = 'https://demo.fractionate.ai';
const fail = (code) => { const e = new Error(code); e.code = code; throw e; };
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) fail('INVALID_BINDING');
  return result.data;
};

export const publicBinding = (row) => row && ({ binding_id: row.id, project_id: row.project_id,
  profile_id: row.profile_id, origin: row.origin, username: row.username,
  vault: { mount: row.vault_mount, path: row.vault_path, version: row.vault_version },
  revision: row.revision, state: row.state, created_at: row.created_at, updated_at: row.updated_at,
  revoked_at: row.revoked_at });

export function createOperationalCredentialStore(db, clock = () => new Date()) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const stamp = () => clock().toISOString();
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Only the project's owner authorizes a binding for one of its profiles.
  function owned(actor, projectId) {
    const p = one('SELECT * FROM ops_projects WHERE id=?', projectId);
    if (!p || !actor?.id || p.owner_user_id !== actor.id) fail('FORBIDDEN');
    if (p.archived_at) fail('PROJECT_ARCHIVED');
    return p;
  }
  const event = (row, kind, actor) => run(`INSERT INTO ops_agent_credential_binding_events
    (binding_id,kind,revision,vault_version,actor_id,created_at) VALUES(?,?,?,?,?,?)`,
  row.id, kind, row.revision, row.vault_version, actor.id, stamp());
  const row = id => one('SELECT * FROM ops_agent_credential_bindings WHERE id=?', id);
  return {
    bind(actor, input) {
      const v = parse(schemas.bind, input);
      return tx(() => {
        const p = owned(actor, v.project_id);
        const profile = one('SELECT * FROM ops_agent_profiles WHERE project_id=? AND id=? AND deleted_at IS NULL',
          v.project_id, v.profile_id);
        if (!profile || profile.workflow_type !== 'synthetic_sign_in') fail('PROFILE_NOT_ELIGIBLE');
        if (p.site_origin !== CREDENTIAL_ORIGIN) fail('SITE_NOT_ELIGIBLE');
        if (row(v.binding_id)) fail('BINDING_EXISTS');
        const now = stamp();
        run(`INSERT INTO ops_agent_credential_bindings(id,project_id,profile_id,origin,username,vault_mount,
          vault_path,vault_version,revision,state,created_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,1,'active',?,?,?)`, v.binding_id, v.project_id, v.profile_id, CREDENTIAL_ORIGIN,
        v.username, v.vault_mount, v.vault_path, v.vault_version, actor.id, now, now);
        const created = row(v.binding_id);
        event(created, 'created', actor);
        return publicBinding(created);
      });
    },
    // A new revision (a new vault version, or a re-authorization of the same
    // one): every run pinned to the old revision is refused from now on.
    rotate(actor, input) {
      const v = parse(schemas.rotate, input);
      return tx(() => {
        const current = row(v.binding_id);
        if (!current) fail('BINDING_UNKNOWN');
        owned(actor, current.project_id);
        if (current.state !== 'active') fail('BINDING_REVOKED');
        if (current.revision !== v.expected_revision) fail('BINDING_REVISION_MISMATCH');
        run(`UPDATE ops_agent_credential_bindings SET revision=revision+1,vault_version=?,updated_at=?
          WHERE id=? AND revision=?`, v.vault_version, stamp(), v.binding_id, v.expected_revision);
        const rotated = row(v.binding_id);
        event(rotated, 'rotated', actor);
        return publicBinding(rotated);
      });
    },
    revoke(actor, input) {
      const v = parse(schemas.revoke, input);
      return tx(() => {
        const current = row(v.binding_id);
        if (!current) fail('BINDING_UNKNOWN');
        owned(actor, current.project_id);
        if (current.state !== 'active') fail('BINDING_REVOKED');
        const now = stamp();
        run("UPDATE ops_agent_credential_bindings SET state='revoked',revoked_at=?,updated_at=? WHERE id=?",
          now, now, v.binding_id);
        const revoked = row(v.binding_id);
        event(revoked, 'revoked', actor);
        return publicBinding(revoked);
      });
    },
    get(id) { return publicBinding(row(id)); },
  };
}
