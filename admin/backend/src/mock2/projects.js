// Mock2 project data access (mock2_projects, mock2_project_members,
// mock2_slug_history — all in mock2.db). Native (better-sqlite3) via
// getMock2Db, reached only on an enabled host through the gated router; user
// existence is validated against the MAIN DB's users table (getDb), since
// SQLite cannot enforce cross-database FKs (03-data-model.md).
//
// All decision logic (slug shape/reserved, derived status, response shape,
// active-FQDN/grace) lives in the pure slug.js / project-logic.js so it is
// unit-testable without this module. This file is the thin CRUD + the
// DB-aware never-reuse slug mint loop.
//
// Terminology (risk R7): nothing here is named "agent".

import { randomBytes } from 'crypto';
import { getMock2Db } from './db.js';
import { getDb } from '../db.js';
import { mintSlugCandidate, slugifyName, isReservedSlug, isValidSlugShape } from './slug.js';

const nowIso = () => new Date().toISOString();

// A project's URL slug is derived from its NAME (operator decision: the
// subdomain is `<name-slug>.<parent-domain>`), and duplicate names are REJECTED
// rather than numerically disambiguated. deriveProjectSlug throws a SlugError
// whose message is safe to show the user; the route surfaces it as a 409.
export class SlugError extends Error {
  constructor(message) { super(message); this.name = 'SlugError'; }
}

export function deriveProjectSlug(parentDomainId, name) {
  const slug = slugifyName(name);
  if (!slug || !isValidSlugShape(slug)) {
    throw new SlugError('The project name needs at least one letter or number to form a URL — please choose a different name.');
  }
  if (isReservedSlug(slug)) {
    throw new SlugError(`"${slug}" is a reserved name and can't be used in a URL — please choose a different project name.`);
  }
  const db = getMock2Db();
  const usedActive = db.prepare(`SELECT 1 FROM mock2_projects WHERE parent_domain_id = ? AND slug = ?`).get(parentDomainId, slug);
  // mock2_slug_history is the never-reuse list (ADR-006): a name that once lived
  // here can't come back, even after its project is deleted.
  const usedEver = db.prepare(`SELECT 1 FROM mock2_slug_history WHERE parent_domain_id = ? AND slug = ?`).get(parentDomainId, slug);
  if (usedActive || usedEver) {
    throw new SlugError(`The URL "${slug}" is already taken on this domain — please choose a different project name.`);
  }
  return slug;
}

// ---- projects ----

export function listProjects() {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_projects ORDER BY created_at DESC, id DESC`)
    .all();
}

export function getProject(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_projects WHERE id = ?`).get(id);
}

// Mint a slug that is unique for this parent domain AND has never been used
// before (mock2_slug_history is the never-reuse list — an old slug is blocked
// forever, ADR-006 / 03-data-model.md). Loops on the astronomically-rare
// collision or reserved hit; bounded so a broken RNG can't spin forever.
export function mintUniqueSlug(parentDomainId, rand = () => randomBytes(4).toString('hex')) {
  const db = getMock2Db();
  const usedActive = db.prepare(`SELECT 1 FROM mock2_projects WHERE parent_domain_id = ? AND slug = ?`);
  const usedEver = db.prepare(`SELECT 1 FROM mock2_slug_history WHERE parent_domain_id = ? AND slug = ?`);
  for (let i = 0; i < 64; i++) {
    const slug = mintSlugCandidate(rand());
    if (!slug) continue;
    if (usedActive.get(parentDomainId, slug)) continue;
    if (usedEver.get(parentDomainId, slug)) continue;
    return slug;
  }
  throw new Error('could not mint a unique slug after 64 attempts');
}

// Create a project row + its permanent slug-history reservation in one
// transaction. repo_path and container_name are DERIVED from the new row id
// (`repoPathFor`/`containerNameFor` are injected so this module stays free of
// the MOCK2_DATA_DIR/naming constants that live in provision.js). The history
// row (active_until NULL = not a grace-window row) permanently blocks the slug
// from ever being reused, even if the project is later deleted. lifecycle
// starts at 'provisioning'; the provisioning job flips it to 'active' or
// 'failed_provisioning'.
export function createProject({ name, description, parentDomainId, slug, customDomain, repoPathFor, containerNameFor, createdBy }) {
  const db = getMock2Db();
  const tx = db.transaction(() => {
    // repo_path is NOT NULL and set-once; seed empty, then fix up with the id.
    const r = db.prepare(`
      INSERT INTO mock2_projects
        (name, description, parent_domain_id, slug, custom_domain, lifecycle,
         repo_path, last_activity_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, 'provisioning', '', ?, ?, ?)
    `).run(
      name, description ?? null, parentDomainId ?? null, slug ?? null, customDomain ?? null,
      nowIso(), createdBy ?? null, nowIso(),
    );
    const id = r.lastInsertRowid;
    const repoPath = repoPathFor ? repoPathFor(id) : '';
    const containerName = containerNameFor ? containerNameFor(id) : null;
    db.prepare(`UPDATE mock2_projects SET repo_path = ?, container_name = ? WHERE id = ?`)
      .run(repoPath, containerName, id);
    if (slug != null && parentDomainId != null) {
      // Permanent reservation. active_until NULL: not a grace-window row, just
      // "this slug has lived" — the UNIQUE(parent_domain_id, slug) index makes
      // it un-reusable forever.
      db.prepare(`
        INSERT INTO mock2_slug_history (parent_domain_id, slug, project_id, active_until, rotated_by, created_at)
        VALUES (?, ?, ?, NULL, ?, ?)
      `).run(parentDomainId, slug, id, createdBy ?? null, nowIso());
    }
    return id;
  });
  const id = tx();
  return getProject(id);
}

const WRITABLE = new Set([
  'name', 'description', 'slug', 'custom_domain', 'container_name', 'bridge_name',
  'bridge_cidr', 'lifecycle', 'flagged', 'flagged_by', 'flagged_reason',
  'last_activity_at', 'web_port', 'container_ip', 'provision_error', 'archived_at',
  // M7 concept-stage exit (migration 507).
  'design_approved_at', 'design_inventory_seq', 'current_mockup_id',
  // M8 drift comparison input — the framework a build last pinned (ADR-003).
  'last_built_framework_version_id',
]);
export function updateProject(id, patch = {}) {
  const cols = Object.keys(patch).filter((k) => WRITABLE.has(k));
  if (cols.length === 0) return getProject(id);
  const set = cols.map((c) => `${c} = ?`).join(', ');
  const vals = cols.map((c) => patch[c]);
  getMock2Db().prepare(`UPDATE mock2_projects SET ${set} WHERE id = ?`).run(...vals, id);
  return getProject(id);
}

// Hard-delete a project and its membership + slug-history reservations are NOT
// removed: history rows must survive so the slug stays un-reusable (ADR-006).
// Only the project + its members go. (Archive, not delete, is the normal
// end-state — that's M3; M2 delete exists for failed/abandoned provisions.)
export function deleteProject(id) {
  const db = getMock2Db();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM mock2_project_members WHERE project_id = ?`).run(id);
    return db.prepare(`DELETE FROM mock2_projects WHERE id = ?`).run(id).changes > 0;
  });
  return tx();
}

// ---- slug rotation (ADR-009 grace) ----

// Rotate a project to a fresh slug. The OLD slug's history row gets a 1-hour
// active_until so old + new FQDN blocks coexist during grace; after it lapses
// the old slug 404s and (already in history) is never reusable. The NEW slug
// gets its own permanent history reservation. Returns { oldSlug, newSlug }.
export function rotateProjectSlug(id, rotatedBy, { graceMs = 60 * 60 * 1000, rand } = {}) {
  const db = getMock2Db();
  const project = getProject(id);
  if (!project) throw new Error('project not found');
  if (!project.parent_domain_id) throw new Error('project has no parent domain to rotate within');
  const oldSlug = project.slug;
  const newSlug = mintUniqueSlug(project.parent_domain_id, rand);
  const graceUntil = new Date(Date.now() + graceMs).toISOString();
  const tx = db.transaction(() => {
    // New slug: permanent reservation.
    db.prepare(`
      INSERT INTO mock2_slug_history (parent_domain_id, slug, project_id, active_until, rotated_by, created_at)
      VALUES (?, ?, ?, NULL, ?, ?)
    `).run(project.parent_domain_id, newSlug, id, rotatedBy ?? null, nowIso());
    // Old slug: enter the grace window (its history row already exists from
    // creation/last rotation — set active_until on it).
    if (oldSlug) {
      db.prepare(`
        UPDATE mock2_slug_history SET active_until = ?, rotated_by = ?
         WHERE parent_domain_id = ? AND slug = ?
      `).run(graceUntil, rotatedBy ?? null, project.parent_domain_id, oldSlug);
    }
    db.prepare(`UPDATE mock2_projects SET slug = ?, last_activity_at = ? WHERE id = ?`)
      .run(newSlug, nowIso(), id);
  });
  tx();
  return { oldSlug, newSlug, graceUntil };
}

// Grace-window history rows for a project (active_until in the future). Used to
// keep publishing the old slug's Caddy block during rotation grace.
export function listGraceSlugs(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_slug_history WHERE project_id = ? AND active_until IS NOT NULL`)
    .all(projectId);
}

// EVERY slug a project has ever held (current + any rotated-away ones), from the
// never-reuse history. Used on delete to purge each FQDN's Caddy cert. History
// rows survive deletion, so this is safe to call before or after deleteProject.
export function listProjectSlugs(projectId) {
  return getMock2Db()
    .prepare(`SELECT slug FROM mock2_slug_history WHERE project_id = ?`)
    .all(projectId)
    .map((r) => r.slug);
}

// ---- membership (ADR-007) ----

export function listMembers(projectId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_project_members WHERE project_id = ? ORDER BY role, user_id`)
    .all(projectId);
}

export function getMembership(projectId, userId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_project_members WHERE project_id = ? AND user_id = ?`)
    .get(projectId, userId);
}

// Count editors on a project (0 ⇒ derived 'orphaned', ADR-007).
export function countEditors(projectId) {
  return getMock2Db()
    .prepare(`SELECT COUNT(*) AS n FROM mock2_project_members WHERE project_id = ? AND role = 'editor'`)
    .get(projectId).n;
}

export function countMembersByRole(projectId) {
  const rows = getMock2Db()
    .prepare(`SELECT role, COUNT(*) AS n FROM mock2_project_members WHERE project_id = ? GROUP BY role`)
    .all(projectId);
  const out = { editor: 0, viewer: 0 };
  for (const r of rows) out[r.role] = r.n;
  return out;
}

// Add or change a member's role (UPSERT on the composite PK).
export function upsertMember({ projectId, userId, role, invitedBy }) {
  getMock2Db().prepare(`
    INSERT INTO mock2_project_members (project_id, user_id, role, invited_by, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role
  `).run(projectId, userId, role, invitedBy ?? null, nowIso());
  return getMembership(projectId, userId);
}

export function removeMember(projectId, userId) {
  return getMock2Db()
    .prepare(`DELETE FROM mock2_project_members WHERE project_id = ? AND user_id = ?`)
    .run(projectId, userId).changes > 0;
}

// Validate a user id against the MAIN DB (cross-DB FK can't be enforced by
// SQLite). Returns { id, username, role, is_superadmin } or null.
export function lookupUser(userId) {
  return getDb()
    .prepare(`SELECT id, username, role, is_superadmin FROM users WHERE id = ?`)
    .get(userId) || null;
}

// Is the request user a superadmin? The JWT does not carry is_superadmin
// (routes/user.js re-reads it), so membership/access checks that need it do
// the same one-row lookup.
export function isUserSuperadmin(userId) {
  const u = getDb().prepare(`SELECT is_superadmin FROM users WHERE id = ?`).get(userId);
  return u?.is_superadmin === 1;
}
