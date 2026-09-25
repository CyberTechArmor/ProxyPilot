import { randomUUID } from 'node:crypto';
import { createOperationsWorkflow } from './operational-projects-workflow.js';
import { createOperationalAgentsStore } from './operational-agents-store.js';
import {
  assertEligible, assertOperation, assertRevision, fail, parse, resolveOperationsRole, schemas, validId,
} from './operational-projects-logic.js';

// DB is injected. This module cannot open the live database or import runtime,
// provisioning, credential, Dev Studio or setup code. All writes are synchronous
// immediate transactions: authorization and state changes share one lock.
export function createOperationsStore(db, { now = () => new Date().toISOString(), uuid = randomUUID, evidenceFactory } = {}) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const tx = fn => db.transaction(fn).immediate();
  const user = id => one('SELECT id, username, role FROM users WHERE id = ?', id);
  function eligible(actor) { assertEligible(actor, user(actor?.id ?? '')); }
  function targetUser(id) {
    if (!validId(id)) fail(400, 'Invalid account ID');
    const u = user(id);
    if (!u || !['user', 'admin'].includes(u.role)) fail(400, 'Eligible account required');
    return u;
  }
  function access(actor, id, action = 'read') {
    eligible(actor);
    if (!validId(id)) fail(404, 'Operational record not found');
    const p = one('SELECT * FROM ops_projects WHERE id = ?', id);
    if (!p) fail(404, 'Operational record not found');
    const grant = one('SELECT role FROM ops_project_grants WHERE project_id = ? AND user_id = ?', id, actor.id);
    const role = resolveOperationsRole(p, actor.id, grant);
    assertOperation(role, action, !!p.archived_at);
    return { p, role };
  }
  function event(actor, id, action, subject = null, metadata = {}) {
    run(`INSERT INTO ops_project_events(project_id,actor_id,action,subject_id,created_at,request_id,metadata_json)
      VALUES (?,?,?,?,?,?,?)`, id, actor.id, action, subject, now(), actor.requestId || uuid(), JSON.stringify(metadata));
  }
  function bump(id) { run('UPDATE ops_projects SET revision = revision + 1, updated_at = ? WHERE id = ?', now(), id); }
  function pendingOffer(p) {
    const e = one("SELECT * FROM ops_project_events WHERE project_id = ? AND action = 'ownership_offered' ORDER BY id DESC LIMIT 1", p.id);
    if (!e) return null;
    const m = JSON.parse(e.metadata_json);
    if (m.revision !== p.revision || m.owner_id !== p.owner_user_id || m.expires_at <= now()) return null;
    return { id: e.subject_id, ...m };
  }
  function summary(p, role, actorId) {
    const offer = pendingOffer(p);
    return { ...p, own_role: role, current_version: workflow.current(p.id), owner_name: user(p.owner_user_id)?.username ?? 'Deleted account',
      ownership_offer: offer && (role === 'owner' || offer.target_user_id === actorId) ? offer : null };
  }
  function mutation(actor, id, action, expected, fn) {
    return tx(() => {
      const { p, role } = access(actor, id, action);
      assertRevision(expected, p.revision);
      const output = fn(p, role);
      bump(id);
      return { ...output, revision: p.revision + 1 };
    });
  }
  const evidence = evidenceFactory?.({one,all,run,tx,access,event,bump,now,uuid});
  const workflow = createOperationsWorkflow({one,all,run,tx,access,event,bump,now,uuid,evidence});
  const agents = createOperationalAgentsStore({one,all,run,tx,access,eligible,event,bump,now,uuid,user,workflow});
  return {
    ...(evidence ? { evidence } : {}),
    ...workflow.methods,
    ...agents,
    assertActor: eligible,
    create(actor, input) {
      const v = parse(schemas.create, input);
      return tx(() => {
        eligible(actor);
        const id = uuid(), timestamp = now();
        run(`INSERT INTO ops_projects(id,name,description,owner_user_id,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?)`, id, v.name, v.description, actor.id, actor.id, timestamp, timestamp);
        run('INSERT INTO ops_guide_drafts(project_id,updated_by,updated_at) VALUES (?,?,?)', id, actor.id, timestamp);
        run('INSERT INTO ops_guide_state(project_id) VALUES (?)',id);
        event(actor, id, 'created');
        return summary(one('SELECT * FROM ops_projects WHERE id = ?', id), 'owner', actor.id);
      });
    },
    list(actor, input = {}) {
      eligible(actor);
      const q = parse(schemas.list, input);
      const rows = all(`SELECT p.* FROM ops_projects p WHERE
        (p.owner_user_id = ? OR EXISTS (SELECT 1 FROM ops_project_grants g WHERE g.project_id = p.id AND g.user_id = ?))
        AND (? = 'all' OR (? = 'active' AND p.archived_at IS NULL) OR (? = 'archived' AND p.archived_at IS NOT NULL))
        AND p.id > ? ORDER BY p.id LIMIT ?`, actor.id, actor.id, q.state, q.state, q.state, q.after || '', q.limit + 1);
      return { projects: rows.slice(0, q.limit).map(p => summary(p,
        resolveOperationsRole(p, actor.id, one('SELECT role FROM ops_project_grants WHERE project_id = ? AND user_id = ?', p.id, actor.id)), actor.id)),
      next_cursor: rows.length > q.limit ? rows[q.limit - 1].id : null };
    },
    get(actor, id) { const { p, role } = access(actor, id); return summary(p, role, actor.id); },
    update(actor, id, expected, input) {
      const v = parse(schemas.project, input);
      return mutation(actor, id, 'edit', expected, p => {
        run('UPDATE ops_projects SET name = ?, description = ? WHERE id = ?', v.name ?? p.name, v.description ?? p.description, id);
        event(actor, id, 'updated', null, { fields: Object.keys(v) });
        return { ok: true };
      });
    },
    draft(actor, id) {
      access(actor, id);
      const state=workflow.draftState(id);
      return { ...one('SELECT * FROM ops_guide_drafts WHERE project_id = ?', id), ...state, status: state.pending_submission ? 'pending' : state.phase,
        contributors: all('SELECT user_id FROM ops_draft_contributors WHERE project_id = ? ORDER BY user_id', id).map(r => r.user_id) };
    },
    saveDraft(actor, id, expected, input) {
      const v = parse(schemas.draft, input);
      return tx(() => {
        access(actor, id, 'edit');
        workflow.editable(id);
        const d = one('SELECT * FROM ops_guide_drafts WHERE project_id = ?', id);
        assertRevision(expected, d.revision);
        run(`UPDATE ops_guide_drafts SET title = ?, instructions = ?, revision = revision + 1,
          updated_by = ?, updated_at = ? WHERE project_id = ?`, v.title ?? d.title, v.instructions ?? d.instructions, actor.id, now(), id);
        run('INSERT OR IGNORE INTO ops_draft_contributors(project_id,user_id) VALUES (?,?)', id, actor.id);
        bump(id);
        event(actor, id, 'draft_saved', null, { draft_revision: d.revision + 1, fields: Object.keys(v) });
        return { revision: d.revision + 1, status: 'draft' };
      });
    },
    roster(actor, id) {
      const { p } = access(actor, id, 'access');
      return { owner: { user_id: p.owner_user_id, username: user(p.owner_user_id)?.username ?? 'Deleted account' }, revision: p.revision,
        members: all(`SELECT g.user_id,g.role,u.username,u.role AS account_role FROM ops_project_grants g
          LEFT JOIN users u ON u.id = g.user_id WHERE g.project_id = ? ORDER BY g.user_id`, id).map(m => ({
          user_id: m.user_id, username: m.username ?? 'Deleted account', role: m.role, active: ['admin','user'].includes(m.account_role),
        })) };
    },
    candidate(actor, id, input) {
      access(actor, id, 'access');
      const { identifier } = parse(schemas.candidate, input);
      const u = validId(identifier) ? user(identifier) : one('SELECT id, username, role FROM users WHERE username = ?', identifier);
      if (!u || !['user','admin'].includes(u.role)) fail(404, 'Eligible account not found');
      return { user_id: u.id, username: u.username };
    },
    grant(actor, id, target, expected, input) {
      const v = parse(schemas.grant, input);
      return mutation(actor, id, 'grant', expected, p => {
        targetUser(target);
        if (target === p.owner_user_id) fail(409, 'Owner access cannot be changed through membership');
        run(`INSERT INTO ops_project_grants(project_id,user_id,role,granted_by,granted_at) VALUES (?,?,?,?,?)
          ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role,granted_by=excluded.granted_by,granted_at=excluded.granted_at`, id, target, v.role, actor.id, now());
        run("UPDATE ops_access_requests SET state='approved',revision=revision+1,decided_at=?,decided_by=? WHERE project_id=? AND user_id=? AND state='pending'",now(),actor.id,id,target);
        event(actor, id, 'member_set', target, { role: v.role });
        return { ok: true };
      });
    },
    remove(actor, id, target, expected) {
      return mutation(actor, id, actor.id === target ? 'leave' : 'revoke', expected, p => {
        if (target === p.owner_user_id) fail(409, 'Transfer ownership before leaving');
        if (!validId(target) || !one('SELECT 1 FROM ops_project_grants WHERE project_id = ? AND user_id = ?', id, target)) fail(404, 'Member not found');
        run('DELETE FROM ops_project_grants WHERE project_id = ? AND user_id = ?', id, target);
        event(actor, id, 'member_removed', target);
        return { ok: true };
      });
    },
    archive(actor, id, expected, input) {
      const v = parse(schemas.archive, input);
      return mutation(actor, id, 'archive', expected, () => {
        run('UPDATE ops_projects SET archived_at = ?, archived_by = ?, archive_reason = ? WHERE id = ?', now(), actor.id, v.reason, id);
        event(actor, id, 'archived', null, { reason: v.reason });
        return { ok: true };
      });
    },
    restore(actor, id, expected) {
      return mutation(actor, id, 'restore', expected, p => {
        if (!p.archived_at) fail(409, 'Operational record is not archived');
        run('UPDATE ops_projects SET archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE id = ?', id);
        event(actor, id, 'restored');
        return { ok: true };
      });
    },
    offer(actor, id, expected, input) {
      const v = parse(schemas.offer, input);
      return mutation(actor, id, 'offer', expected, p => {
        targetUser(v.target_user_id);
        if (v.target_user_id === p.owner_user_id || !one('SELECT 1 FROM ops_project_grants WHERE project_id = ? AND user_id = ?', id, v.target_user_id)) fail(400, 'Choose an existing non-owner member');
        const offer = { id: uuid(), owner_id: p.owner_user_id, target_user_id: v.target_user_id, revision: p.revision + 1,
          expires_at: new Date(Date.parse(now()) + 86400000).toISOString() };
        event(actor, id, 'ownership_offered', offer.id, offer);
        return { offer };
      });
    },
    decideOffer(actor, id, offerId, expected, input) {
      const v = parse(schemas.decision, input);
      return mutation(actor, id, 'read', expected, p => {
        if (p.archived_at) fail(409, 'Operational record is archived');
        const offer = pendingOffer(p);
        if (!offer || offer.id !== offerId) fail(409, 'Ownership offer is stale or expired');
        if ((v.decision === 'cancel' && actor.id !== p.owner_user_id) || (v.decision !== 'cancel' && actor.id !== offer.target_user_id)) fail(403, 'Only the owner may cancel; only the target may accept or decline');
        if (v.decision === 'accept') {
          targetUser(p.owner_user_id);
          targetUser(offer.target_user_id);
          if (!one('SELECT 1 FROM ops_project_grants WHERE project_id = ? AND user_id = ?', id, actor.id)) fail(409, 'Target is no longer a member');
          run('UPDATE ops_projects SET owner_user_id = ? WHERE id = ?', actor.id, id);
          run('DELETE FROM ops_project_grants WHERE project_id = ? AND user_id = ?', id, actor.id);
          run("INSERT INTO ops_project_grants(project_id,user_id,role,granted_by,granted_at) VALUES (?,?,'editor',?,?)", id, p.owner_user_id, actor.id, now());
        }
        event(actor, id, `ownership_${v.decision}`, offerId);
        return { ok: true };
      });
    },
    events(actor, id, input = {}) {
      const { role } = access(actor, id);
      const q = parse(schemas.events, input);
      const rows = all('SELECT * FROM ops_project_events WHERE project_id = ? AND id > ? ORDER BY id LIMIT ?', id, q.after, q.limit + 1);
      return { events: rows.slice(0, q.limit).map(({ metadata_json, ...e }) => {
        const sensitive = e.action.startsWith('member_') || e.action.startsWith('ownership_');
        return { ...e, subject_id: sensitive && role !== 'owner' ? null : e.subject_id,
          metadata: sensitive && role !== 'owner' ? {} : JSON.parse(metadata_json) };
      }), next_cursor: rows.length > q.limit ? String(rows[q.limit - 1].id) : null };
    },
  };
}
