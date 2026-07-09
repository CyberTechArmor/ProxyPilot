// Mock2 database — a SECOND SQLite file (data/db/mock2.db) opened ONLY
// when the module is enabled (ADR-001). On a disabled host this file is
// never created: "no Mock2 state file, credential store, or runner code
// path exists" becomes literally true, not merely "a toggle is off".
//
// This module imports better-sqlite3 (native) and is therefore reached
// exclusively through the dynamic import() in index.js behind the gate —
// never at top level, never from tests. Tests exercise the pure decision
// layer (gating.js) at the module boundary (risk R9 / docs/known-issues.md).
//
// Perms mirror the main DB (db.js:27-42): dir 0700, file (+wal/shm) 0600.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { runMigration } from '../db.js';
import { MOCK2_MIGRATIONS } from './migrations.js';

const __mock2Filename = fileURLToPath(import.meta.url);
const __mock2Dirname = dirname(__mock2Filename);
// src/mock2 -> src -> backend -> admin -> repo root (4 levels up).
const PROJECT_ROOT = resolve(__mock2Dirname, '..', '..', '..', '..');

// mock2.db lives alongside the main proxypilot.db in the DB directory
// (03-data-model.md pins it to data/db/mock2.db). Resolve it off the same
// DATABASE_PATH the main DB uses so the two files always sit together,
// whatever the deployment mounts DATABASE_PATH to.
export function mock2DbPath() {
  const rawMain = process.env.DATABASE_PATH || './data/db/proxypilot.db';
  const mainPath = rawMain.startsWith('/') ? rawMain : resolve(PROJECT_ROOT, rawMain);
  return join(dirname(mainPath), 'mock2.db');
}

let mock2Db = null;

export function getMock2Db() {
  if (mock2Db) return mock2Db;
  const path = mock2DbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
  mock2Db = new Database(path);
  mock2Db.pragma('journal_mode = WAL');
  // Short busy_timeout: a runner writing checkpoints while the UI polls
  // chat is new write pressure (risk R4). Keep it separate from the main
  // DB (already so) and let waiters retry briefly instead of erroring.
  mock2Db.pragma('busy_timeout = 5000');
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(f)) {
      try { chmodSync(f, 0o600); } catch { /* best effort */ }
    }
  }
  return mock2Db;
}

// Open (creating if needed) mock2.db and bring it up to the latest
// block-500 migration. Idempotent — runMigration()'s version guard skips
// already-applied migrations. Called from index.js only when enabled.
export function initMock2Db() {
  const db = getMock2Db();
  for (const m of MOCK2_MIGRATIONS) {
    runMigration(db, m.version, m.name, m.up);
  }
  return db;
}

// Boot sweep (index.js boot-sweep pattern). Any cycle a crash left mid-run
// is failed at startup so the UI never shows a phantom "building". No
// cycles exist until Phase M6, so this is a wired-but-quiet no-op today.
export function sweepMock2OnBoot(db = getMock2Db()) {
  try {
    const r = db
      .prepare(
        `UPDATE mock2_cycles
            SET status = 'failed',
                error = 'orphaned by restart',
                finished_at = COALESCE(finished_at, datetime('now'))
          WHERE status IN ('running', 'estimating')`
      )
      .run();
    if (r.changes > 0) {
      console.log(`[mock2] boot sweep failed ${r.changes} orphaned cycle(s)`);
    }
  } catch (err) {
    console.error('[mock2] boot sweep error:', err?.message || err);
  }
}

// Test/reset seam: drop the cached handle so a fresh open picks up a new
// DATABASE_PATH. Not used in production.
export function _resetMock2DbForTests() {
  try { mock2Db?.close(); } catch { /* ignore */ }
  mock2Db = null;
}
