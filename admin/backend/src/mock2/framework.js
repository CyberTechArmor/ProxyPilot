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

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getMock2Db } from './db.js';
import { nextVersionNumber } from './framework-logic.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = resolve(__dir, 'framework-seed');

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

function readSeedFile(name) {
  return readFileSync(resolve(SEED_DIR, name), 'utf8');
}

// Insert framework version 1 from the vendored placeholder seed IF AND ONLY IF
// the versions table is empty. Idempotent — a second call is a no-op once any
// version exists (never re-inserts, never edits). Called from index.js boot on
// an enabled host only (ADR-001). Returns the seeded row or null if it already
// existed / the seed couldn't be read (non-fatal).
export function seedFrameworkV1(createdBy = null) {
  const db = getMock2Db();
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM mock2_framework_versions`).get();
  if (existing && existing.n > 0) return null;
  let content;
  try {
    content = {
      constitution_md: readSeedFile('constitution.md'),
      skills_json: readSeedFile('skills.json'),
      gates_json: readSeedFile('gates.json'),
      design_system_md: readSeedFile('design-system.md'),
      project_template_ref: readSeedFile('project-template.ref').trim(),
    };
  } catch (err) {
    console.error('[mock2] framework seed: could not read vendored seed:', err?.message);
    return null;
  }
  const row = insertFrameworkVersion({
    ...content,
    changelog: 'Seed v1 — Mock2 Framework v1.1 (constitution, four skills, deterministic gate battery, locked design system). Runtime scaffold still placeholder (R8).',
    source: 'in_app',
    createdBy,
  });
  console.log('[mock2] framework registry seeded with version 1 (Mock2 Framework v1.1 content; runtime scaffold still placeholder — R8)');
  return row;
}
