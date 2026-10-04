import { z } from 'zod';
import { assertRevision, fail, parse, siteOrigin, validId } from './operational-projects-logic.js';

const id = z.string().uuid();
const name = z.string().trim().min(1).max(200);
const hint = z.string().trim().max(200).default('');
const origin = z.string().max(2048);
const create = z.object({ name, kind: z.enum(['website-login', 'oauth']), origin, account_hint: hint }).strict();
const update = z.object({ name, origin, account_hint: hint }).strict();
const share = z.object({ recipient_id: id, permission: z.enum(['view_metadata', 'propose_use']),
  expires_at: z.string().datetime(), reviewed_statement: z.literal('Share this exact browser connection metadata version with this member') }).strict();
const list = z.object({ after: id.optional(), limit: z.string().regex(/^\d{1,2}$/).transform(Number)
  .refine(n => n >= 1 && n <= 50).default('25') }).strict();
const empty = z.object({}).strict();
const versionList = z.object({ after: z.string().regex(/^[1-9]\d{0,14}$/).transform(Number).refine(Number.isSafeInteger).optional(),
  limit: list.shape.limit }).strict();

// A plan is not an enrolled credential or OAuth account. No adapter exists for
// these drafts, so the capability truthfully excludes enrollment and execution.
export const browserConnectionCapabilities = () => ({ contract_version: 'browser-connection-metadata.v1',
  metadata_available: true, enrollment_available: false, execution_available: false,
  oauth_authorization_available: false, credential_version: null,
  code: 'CUSTODY_AND_PROVIDER_UNCONFIGURED', permissions: ['view_metadata', 'propose_use'] });

export function createBrowserConnectionsStore({ one, all, run, tx, access, event, now, uuid, user }) {
  function membership(pid, uid) {
    const p = one('SELECT owner_user_id FROM ops_projects WHERE id=?', pid);
    const role = p?.owner_user_id === uid ? 'owner' : one('SELECT role FROM ops_project_grants WHERE project_id=? AND user_id=?', pid, uid)?.role;
    const epoch = one(`SELECT COALESCE(MAX(id),0) n FROM ops_project_events WHERE project_id=?
      AND ((subject_id=? AND action IN('member_granted','member_set','member_removed')) OR action='ownership_accept')`, pid, uid).n;
    return { role, epoch };
  }
  function row(pid, cid) {
    const value = validId(cid) && one('SELECT * FROM ops_browser_connections WHERE project_id=? AND id=?', pid, cid);
    if (!value) fail(404, 'Browser connection not found');
    return value;
  }
  function grantCurrent(r, actor) {
    const current = membership(r.project_id, actor.id);
    return all(`SELECT * FROM ops_browser_connection_grants WHERE connection_id=? AND version=?
      AND recipient_id=? AND membership_role=? AND membership_event_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY id`,
      r.id, r.version, actor.id, current.role, current.epoch, now());
  }
  function visible(actor, pid, cid) {
    access(actor, pid);
    const r = row(pid, cid);
    if (r.contributor_id !== actor.id && (r.status === 'revoked' || !grantCurrent(r, actor).length)) fail(404, 'Browser connection not found');
    return r;
  }
  function managed(actor, pid, cid, { archived = false } = {}) {
    const { p } = access(actor, pid);
    const r = row(pid, cid);
    if (r.contributor_id !== actor.id) fail(404, 'Browser connection not found');
    if (!archived && p.archived_at) fail(409, 'Operational record is archived');
    return r;
  }
  function active(r) { if (r.status !== 'draft') fail(409, 'Browser connection is revoked'); }
  function projectOrigin(value) {
    const normalized = siteOrigin(value);
    if (!normalized) fail(400, 'An exact HTTPS origin is required');
    return normalized;
  }
  function projection(actor, r) {
    return { id: r.id, project_id: r.project_id, contributor_id: r.contributor_id, revision: r.revision,
      version: r.version, name: r.name, kind: r.kind, origin: r.origin, account_hint: r.account_hint,
      status: r.status, created_at: r.created_at, updated_at: r.updated_at, revoked_at: r.revoked_at,
      own_rights: r.contributor_id === actor.id ? ['view_metadata', 'manage_metadata'] :
        [...new Set(grantCurrent(r, actor).map(g => g.permission))],
      capability: browserConnectionCapabilities() };
  }
  function snapshot(actor, r) {
    run(`INSERT INTO ops_browser_connection_versions(connection_id,version,name,origin,account_hint,saved_by,saved_at)
      VALUES(?,?,?,?,?,?,?)`, r.id, r.version, r.name, r.origin, r.account_hint, actor.id, now());
  }
  function bump(r) { run('UPDATE ops_browser_connections SET revision=revision+1,updated_at=? WHERE id=?', now(), r.id); }
  function revokeGrants(actor, r, reason) {
    run(`UPDATE ops_browser_connection_grants SET revoked_at=?,revoked_by=?,revoke_reason=?
      WHERE connection_id=? AND revoked_at IS NULL`, now(), actor.id, reason, r.id);
  }
  const audit = (actor, r, action, extra = {}) => event(actor, r.project_id, action, r.id,
    { revision: r.revision, version: r.version, ...extra });
  return {
    browserConnections(actor, pid, input = {}) {
      access(actor, pid);
      const q = parse(list, input);
      const current = membership(pid, actor.id);
      const records = all(`SELECT c.* FROM ops_browser_connections c WHERE c.project_id=? AND c.id>?
        AND (c.contributor_id=? OR (c.status='draft' AND EXISTS(SELECT 1 FROM ops_browser_connection_grants g
          WHERE g.connection_id=c.id AND g.version=c.version AND g.recipient_id=? AND g.membership_role=?
          AND g.membership_event_id=? AND g.revoked_at IS NULL AND g.expires_at>?)))
        ORDER BY c.id LIMIT ?`, pid, q.after || '', actor.id, actor.id, current.role, current.epoch, now(), q.limit + 1);
      return { connections: records.slice(0, q.limit).map(r => projection(actor, r)),
        next_cursor: records.length > q.limit ? records[q.limit - 1].id : null, capability: browserConnectionCapabilities() };
    },
    browserConnection(actor, pid, cid) { return { connection: projection(actor, visible(actor, pid, cid)) }; },
    createBrowserConnection(actor, pid, expected, input) {
      const v = parse(create, input), target = projectOrigin(v.origin);
      return tx(() => {
        const { p } = access(actor, pid, 'run');
        assertRevision(expected, p.revision);
        const cid = uuid(), at = now();
        run(`INSERT INTO ops_browser_connections(id,project_id,contributor_id,revision,version,status,name,kind,origin,
          account_hint,created_at,updated_at) VALUES(?,?,?,1,1,'draft',?,?,?,?,?,?)`, cid, pid, actor.id,
        v.name, v.kind, target, v.account_hint, at, at);
        const r = row(pid, cid); snapshot(actor, r); audit(actor, r, 'browser_connection_metadata_created');
        return { connection: projection(actor, r) };
      });
    },
    updateBrowserConnection(actor, pid, cid, expected, input) {
      const v = parse(update, input), target = projectOrigin(v.origin);
      return tx(() => {
        const old = managed(actor, pid, cid); active(old); assertRevision(expected, old.revision);
        revokeGrants(actor, old, 'metadata_version_changed');
        run(`UPDATE ops_browser_connections SET revision=revision+1,version=version+1,name=?,origin=?,account_hint=?,updated_at=? WHERE id=?`,
          v.name, target, v.account_hint, now(), old.id);
        const r = row(pid, cid); snapshot(actor, r); audit(actor, r, 'browser_connection_metadata_updated', { prior_version: old.version });
        return { connection: projection(actor, r) };
      });
    },
    revokeBrowserConnection(actor, pid, cid, expected, input = {}) {
      parse(empty, input);
      return tx(() => {
        const r = managed(actor, pid, cid, { archived: true }); assertRevision(expected, r.revision);
        if (r.status === 'revoked') return { connection: projection(actor, r) };
        revokeGrants(actor, r, 'connection_revoked');
        run(`UPDATE ops_browser_connections SET status='revoked',revision=revision+1,updated_at=?,revoked_at=? WHERE id=?`, now(), now(), r.id);
        const revoked = row(pid, cid); audit(actor, revoked, 'browser_connection_metadata_revoked');
        return { connection: projection(actor, revoked) };
      });
    },
    grantBrowserConnection(actor, pid, cid, expected, input) {
      const v = parse(share, input);
      return tx(() => {
        const r = managed(actor, pid, cid); active(r); assertRevision(expected, r.revision);
        const target = user(v.recipient_id);
        if (!target || !['user', 'admin'].includes(target.role) || v.recipient_id === actor.id) fail(400, 'Choose another current project member');
        const { p } = access(actor, pid);
        if (p.owner_user_id !== v.recipient_id && !one('SELECT 1 FROM ops_project_grants WHERE project_id=? AND user_id=?', pid, v.recipient_id)) fail(400, 'Choose another current project member');
        const expiry = Date.parse(v.expires_at), at = Date.parse(now());
        if (expiry <= at) fail(400, 'Grant expiry must be in the future');
        const prior = one(`SELECT * FROM ops_browser_connection_grants WHERE connection_id=? AND recipient_id=? AND permission=? AND revoked_at IS NULL`, r.id, v.recipient_id, v.permission);
        if (prior && prior.expires_at > now()) fail(409, 'An unexpired grant already exists');
        if (prior) run('UPDATE ops_browser_connection_grants SET revoked_at=?,revoked_by=?,revoke_reason=? WHERE id=?', now(), actor.id, 'expired_replaced', prior.id);
        const gid = uuid();
        const member = membership(pid, v.recipient_id);
        run(`INSERT INTO ops_browser_connection_grants(id,connection_id,version,recipient_id,permission,membership_role,membership_event_id,expires_at,granted_by,granted_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, gid, r.id, r.version, v.recipient_id, v.permission, member.role, member.epoch, new Date(expiry).toISOString(), actor.id, now());
        bump(r); const current = row(pid, cid);
        audit(actor, current, 'browser_connection_metadata_granted', { grant_id: gid, recipient_id: v.recipient_id, permission: v.permission });
        return { connection: projection(actor, current), grant: one('SELECT * FROM ops_browser_connection_grants WHERE id=?', gid) };
      });
    },
    revokeBrowserConnectionGrant(actor, pid, cid, gid, expected, input = {}) {
      parse(empty, input);
      return tx(() => {
        const r = managed(actor, pid, cid, { archived: true }); assertRevision(expected, r.revision);
        const g = validId(gid) && one('SELECT * FROM ops_browser_connection_grants WHERE connection_id=? AND id=?', r.id, gid);
        if (!g) fail(404, 'Browser connection grant not found');
        if (!g.revoked_at) {
          run('UPDATE ops_browser_connection_grants SET revoked_at=?,revoked_by=?,revoke_reason=? WHERE id=?', now(), actor.id, 'contributor_revoked', gid);
          if (r.status !== 'revoked') bump(r);
          audit(actor, row(pid, cid), 'browser_connection_metadata_grant_revoked', { grant_id: gid });
        }
        return { connection: projection(actor, row(pid, cid)), grant: one('SELECT * FROM ops_browser_connection_grants WHERE id=?', gid) };
      });
    },
    browserConnectionGrants(actor, pid, cid, input = {}) {
      const r = managed(actor, pid, cid, { archived: true }), q = parse(list, input);
      const records = all('SELECT * FROM ops_browser_connection_grants WHERE connection_id=? AND id>? ORDER BY id LIMIT ?', r.id, q.after || '', q.limit + 1);
      return { grants: records.slice(0, q.limit), next_cursor: records.length > q.limit ? records[q.limit - 1].id : null };
    },
    browserConnectionVersions(actor, pid, cid, input = {}) {
      const r = managed(actor, pid, cid, { archived: true }), q = parse(versionList, input);
      // Only the contributor sees historical metadata. A current share cannot
      // disclose an earlier account/origin that was never shared with them.
      const records = all('SELECT * FROM ops_browser_connection_versions WHERE connection_id=? AND version<? ORDER BY version DESC LIMIT ?', r.id, q.after || Number.MAX_SAFE_INTEGER, q.limit + 1);
      return { versions: records.slice(0, q.limit), next_cursor: records.length > q.limit ? String(records[q.limit - 1].version) : null };
    },
  };
}
