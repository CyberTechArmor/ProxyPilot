// Mock2 framework registry — data access + first-boot seed (Phase M5, ADR-003).
// Table: mock2_framework_versions (migration 501). One monotonic version integer
// across the bundle; content rows are IMMUTABLE (no UPDATE path); a revert is a
// NEW version carrying the old content. A cycle pins a version id at start (M6).
//
// The versioning/validation RULES are pure (framework-logic.js, unit-tested
// stub-first, risk R9). This module is the thin better-sqlite3 half plus the
// vendored-seed reader (framework-seed/, inserted once on first enabled boot).
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { getDb } from '../db.js';
import { nextVersionNumber } from './framework-logic.js';
import { createSeedUpgrader, readSeedContent } from './framework-upgrade.js';

const nowIso = () => new Date().toISOString();

// ---- reads ----

export function listFrameworkVersions() {
  // Metadata order (no content columns) — the list view doesn't need the bodies.
  return getMock2Db()
    .prepare(
      `SELECT id, version, changelog, reverted_from_version, source, source_git_commit, created_by, created_at
         FROM mock2_framework_versions ORDER BY version DESC`,
    )
    .all();
}

export function getFrameworkVersion(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_framework_versions WHERE id = ?`).get(Number(id));
}

export function getFrameworkVersionByNumber(version) {
  return getMock2Db().prepare(`SELECT * FROM mock2_framework_versions WHERE version = ?`).get(Number(version));
}

// The current (highest) version — what a new cycle would pin (ADR-003).
export function getCurrentFrameworkVersion() {
  return getMock2Db().prepare(`SELECT * FROM mock2_framework_versions ORDER BY version DESC LIMIT 1`).get();
}

function allVersionNumbers() {
  return getMock2Db().prepare(`SELECT version FROM mock2_framework_versions`).all();
}

// ---- writes (append-only) ----

// Insert a new version. The version number is assigned monotonically from the
// existing rows inside a transaction so concurrent publishes can't collide.
export function insertFrameworkVersion({
  constitution_md,
  skills_json,
  gates_json,
  design_system_md,
  project_template_ref,
  changelog = null,
  revertedFromVersion = null,
  source = 'in_app',
  sourceGitCommit = null,
  createdBy,
}) {
  const db = getMock2Db();
  let row;
  const tx = db.transaction(() => {
    const version = nextVersionNumber(allVersionNumbers());
    const info = db
      .prepare(
        `INSERT INTO mock2_framework_versions
           (version, constitution_md, skills_json, gates_json, design_system_md, project_template_ref,
            changelog, reverted_from_version, source, source_git_commit, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version,
        constitution_md,
        skills_json,
        gates_json,
        design_system_md,
        project_template_ref,
        changelog,
        revertedFromVersion,
        source,
        sourceGitCommit,
        createdBy,
        nowIso(),
      );
    row = db.prepare(`SELECT * FROM mock2_framework_versions WHERE id = ?`).get(info.lastInsertRowid);
  });
  tx();
  return row;
}

// ---- first-boot seed (ADR-003 / risk R8) ----

// Insert framework version 1 from the vendored placeholder seed IF AND ONLY IF
// the versions table is empty. Idempotent — a second call is a no-op once any
// version exists (never re-inserts, never edits). Called from index.js boot on
// an enabled host only (ADR-001). Returns the seeded row or null if it already
// existed / the seed couldn't be read (non-fatal).
export function seedFrameworkV1(createdBy = null) {
  const db = getMock2Db();
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM mock2_framework_versions`).get();
  if (existing && existing.n > 0) return null;
  // created_by is NOT NULL (migration 501) — resolve a real author (the boot call
  // passes null) so the insert can never fail the constraint.
  const author = resolveSeedAuthor(createdBy);
  const content = readSeedContent();
  if (!content) return null;
  const row = insertFrameworkVersion({
    ...content,
    changelog: 'Seed v1 — Mock2 Framework v1.1 (constitution, four skills, deterministic gate battery, locked design system). Runtime scaffold still placeholder (R8).',
    source: 'in_app',
    createdBy: author,
  });
  console.log('[mock2] framework registry seeded with version 1 (Mock2 Framework v1.1 content; runtime scaffold still placeholder — R8)');
  return row;
}

// Resolve a non-null author id (created_by is NOT NULL) — the caller's id, else
// the platform's first admin, else 1.
function resolveSeedAuthor(createdBy = null) {
  if (createdBy != null) return createdBy;
  try {
    const admin = getDb().prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC, id ASC LIMIT 1`).get();
    return admin?.id ?? 1;
  } catch { return 1; }
}

// Publish a NEW framework version from the vendored seed when its content differs
// from the latest published version — the "framework repo → published version"
// flow. Seed-side fixes (e.g. a corrected gate script) otherwise stay inert: a
// project builds against its PINNED version, and seedFrameworkV1 only runs on an
// empty registry, so an edited seed would never reach an existing install. This
// makes the fix a real new version; projects then adopt it automatically (the
// auto-adopt sweep starts the update cycle when they are idle and online —
// ADR-003 amendment; framework_auto_adopt 'off' restores the manual
// explicit-consent path). Idempotent: a no-op when the seed matches the latest
// version. Called on boot after seedFrameworkV1.
//
// Live guidance (mock2/live-guidance.js) publishes through this same function,
// and it never republishes OLDER guidance than the latest version carries
// (framework-upgrade.js: the guidance floor). Implementation: framework-upgrade.js.
export const upgradeFrameworkFromSeed = createSeedUpgrader({
  getCurrent: () => getCurrentFrameworkVersion(),
  insert: (fields) => insertFrameworkVersion(fields),
  resolveAuthor: (id) => resolveSeedAuthor(id),
});
