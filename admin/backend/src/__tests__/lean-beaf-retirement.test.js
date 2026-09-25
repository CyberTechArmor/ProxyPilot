import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { retireLeanBeaf } from '../lib/lean-beaf-retirement.js';
import * as historical from '../lib/lean-beaf-schema.js';

function fixture() {
  const d = new DatabaseSync(':memory:');
  d.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE audit_log (id TEXT PRIMARY KEY, action TEXT);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE mock2_projects (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE lbp_unrelated (id INTEGER PRIMARY KEY);
    INSERT INTO users VALUES ('person');
    INSERT INTO audit_log VALUES ('audit', 'LBP_PROJECT_CREATE');
    INSERT INTO mock2_projects VALUES (8, 'Keep Flightdeck');
    INSERT INTO lbp_unrelated VALUES (1);`);
  for (const [version, fn] of [
    [700, historical.lbpMigration700], [701, historical.lbpMigration701Blockers],
    [702, historical.lbpMigration702BoardOrder], [703, historical.lbpMigration703Schedules],
    [704, historical.lbpMigration704BriefRuns], [705, historical.lbpMigration705BriefRunText],
  ]) {
    fn(d);
    d.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(version, fn.name);
  }
  for (const key of ['lbp_connections', 'lbp_brief_model', 'lbp_brief_api_key_enc', 'lbp_brief_base_url', 'branding_name', 'lbp_unrelated']) {
    d.prepare('INSERT INTO app_settings VALUES (?, ?)').run(key, 'synthetic fixture');
  }
  d.exec(`INSERT INTO lbp_projects (id, name, start_date, mock2_project_id) VALUES (1, 'Retire me', '2026-09-25', 8);
    INSERT INTO lbp_project_assignees VALUES (1, 'person');
    INSERT INTO lbp_rollout_scopes (project_id) VALUES (1);
    INSERT INTO lbp_tasks (project_id, title, created_at) VALUES (1, 'Parent task', '2026-09-25');
    INSERT INTO lbp_tasks (project_id, parent_id, title, created_at) VALUES (1, 1, 'Child task', '2026-09-25');`);
  return d;
}
function migrate(d) {
  if (d.prepare('SELECT 1 FROM schema_migrations WHERE version = 706').get()) return;
  d.exec('BEGIN');
  try {
    retireLeanBeaf(d);
    d.exec("INSERT INTO schema_migrations VALUES (706, 'lean_beaf_retirement'); COMMIT");
  } catch (e) { d.exec('ROLLBACK'); throw e; }
}
test('retirement removes all historical feature tables/settings and preserves unrelated records', () => {
  const d = fixture();
  try {
    migrate(d);
    const remaining = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'lbp_*'").all().map(r => r.name);
    assert.deepEqual(remaining, ['lbp_unrelated']);
    assert.deepEqual(d.prepare('SELECT key FROM app_settings ORDER BY key').all().map(r => r.key), ['branding_name', 'lbp_unrelated']);
    assert.equal(d.prepare('SELECT name FROM mock2_projects').get().name, 'Keep Flightdeck');
    assert.equal(d.prepare('SELECT count(*) n FROM users').get().n, 1);
    assert.equal(d.prepare('SELECT action FROM audit_log').get().action, 'LBP_PROJECT_CREATE');
    assert.equal(d.prepare('SELECT count(*) n FROM schema_migrations').get().n, 7);
    assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
    migrate(d);
    retireLeanBeaf(d); // idempotent even if the registry write must be retried
    assert.equal(d.prepare('SELECT count(*) n FROM schema_migrations').get().n, 7);
  } finally { d.close(); }
});
test('transaction failure restores all tables and data and does not record migration 706', () => {
  const d = fixture();
  try {
    d.exec("CREATE TRIGGER fail_retirement BEFORE DELETE ON app_settings BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END");
    assert.throws(() => migrate(d), /fixture refusal/);
    assert.equal(d.prepare('SELECT name FROM lbp_projects').get().name, 'Retire me');
    assert.equal(d.prepare('SELECT count(*) n FROM lbp_tasks').get().n, 2);
    assert.equal(d.prepare('SELECT count(*) n FROM app_settings').get().n, 6);
    assert.equal(d.prepare('SELECT count(*) n FROM schema_migrations').get().n, 6);
    assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { d.close(); }
});
test('fresh empty database retirement tolerates absent feature tables', () => {
  const d = new DatabaseSync(':memory:');
  try {
    d.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
    retireLeanBeaf(d);
    retireLeanBeaf(d);
    assert.deepEqual(d.prepare('SELECT * FROM app_settings').all(), []);
  } finally { d.close(); }
});
