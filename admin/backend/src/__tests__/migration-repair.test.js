// The stray-912 migration-history repair, run against disposable POPULATED
// databases (node:sqlite, built into Node 22 — no native module needed). One
// case per state the repair must handle; each ends by asserting what a
// number-keyed runner would do next (would 912 lxc_exports run?).
import test from 'node:test';
import assert from 'node:assert/strict';

import { repairStrayMigration912, STRAY_MIGRATION } from '../lib/migration-repair.js';

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older Node: skipped below */ }

function fresh(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, run_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  for (const [v, n] of rows) db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(v, n);
  // The adapter runMigration would use: is `version` still unrecorded?
  db.wouldRun = (v) => !db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(v);
  db.rows = () => db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all().map((r) => [r.version, r.name]);
  return db;
}

const skip = DatabaseSync ? false : 'node:sqlite unavailable in this Node';

test('neither migration recorded: nothing changes, 912 will run', { skip }, () => {
  const db = fresh([[911, 'migration_capacity']]);
  assert.equal(repairStrayMigration912(db).action, 'none');
  assert.deepEqual(db.rows(), [[911, 'migration_capacity']]);
  assert.equal(db.wouldRun(912), true);
});

test('legitimate main 912 (lxc_exports): untouched, identified by name not number', { skip }, () => {
  const db = fresh([[911, 'migration_capacity'], [912, 'lxc_exports']]);
  const r = repairStrayMigration912(db);
  assert.equal(r.action, 'none');
  assert.match(r.reason, /lxc_exports, left alone/);
  assert.deepEqual(db.rows(), [[911, 'migration_capacity'], [912, 'lxc_exports']]);
  assert.equal(db.wouldRun(912), false);
  assert.equal(db.wouldRun(913), true);
});

test('former PR 912 (owner validity): moved to 913 so lxc_exports (912) runs and 913 does not re-run', { skip }, () => {
  const db = fresh([[911, 'migration_capacity'], [912, STRAY_MIGRATION.name]]);
  const logged = [];
  const r = repairStrayMigration912(db, { log: (m) => logged.push(m) });
  assert.equal(r.action, 'moved');
  assert.deepEqual(db.rows(), [[911, 'migration_capacity'], [913, STRAY_MIGRATION.name]]);
  assert.equal(db.wouldRun(912), true, 'lxc_exports is no longer shadowed');
  assert.equal(db.wouldRun(913), false, 'the owner migration is not re-run');
  assert.equal(logged.length, 1);
});

test('duplicate owner records (912 and 913 both owner validity): the 912 record is removed, nothing else', { skip }, () => {
  const db = fresh([[912, STRAY_MIGRATION.name], [913, STRAY_MIGRATION.name], [914, 'mcp_tokens_expiry']]);
  const r = repairStrayMigration912(db);
  assert.equal(r.action, 'deleted-duplicate');
  assert.deepEqual(db.rows(), [[913, STRAY_MIGRATION.name], [914, 'mcp_tokens_expiry']]);
  assert.equal(db.wouldRun(912), true);
});

test('913 recorded under another name: conflict, nothing changed, reported', { skip }, () => {
  const db = fresh([[912, STRAY_MIGRATION.name], [913, 'something_else']]);
  const logged = [];
  const r = repairStrayMigration912(db, { log: (m) => logged.push(m) });
  assert.equal(r.action, 'conflict');
  assert.deepEqual(db.rows(), [[912, STRAY_MIGRATION.name], [913, 'something_else']]);
  assert.match(logged[0], /nothing changed/);
});

test('interrupted retry: running the repair again is a no-op', { skip }, () => {
  const db = fresh([[912, STRAY_MIGRATION.name]]);
  assert.equal(repairStrayMigration912(db).action, 'moved');
  assert.equal(repairStrayMigration912(db).action, 'none');
  assert.deepEqual(db.rows(), [[913, STRAY_MIGRATION.name]]);
});

test('the repair is transactional: a failing write leaves the history as it was', { skip }, () => {
  const db = fresh([[912, STRAY_MIGRATION.name]]);
  // A trigger that vetoes the UPDATE stands in for a mid-repair failure.
  db.exec("CREATE TRIGGER veto BEFORE UPDATE ON schema_migrations BEGIN SELECT RAISE(ABORT, 'veto'); END");
  assert.throws(() => repairStrayMigration912(db), /veto/);
  assert.deepEqual(db.rows(), [[912, STRAY_MIGRATION.name]]);
  // Nothing is left open: a fresh transaction can begin.
  db.exec('BEGIN'); db.exec('COMMIT');
});
