// A5 proof database: a standalone Operations database (node:sqlite) for the
// host proof harness. It applies the backend's own Operations migrations
// (1100-1102, 1106-1111) and only the stub tables they reference, so the
// coordinator and the Operations store run against the candidate's exact code
// without the live ProxyPilot database. Proof only; nothing here is imported by
// the backend.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'backend', 'src', 'lib');
const lib = name => import(pathToFileURL(path.join(LIB, name)).href);

export async function openProofDatabase(file) {
  const [projects, agents, worker, limits, binding, credentials, runs, store] = await Promise.all([
    lib('operational-projects-schema.js'), lib('operational-agents-schema.js'), lib('operational-worker-schema.js'),
    lib('operational-agent-limits-schema.js'), lib('operational-worker-binding-schema.js'),
    lib('operational-credential-binding-schema.js'), lib('operational-run-schema.js'),
    lib('operational-projects-store.js')]);
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE,role TEXT);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at TEXT,revoked_at TEXT,
      last_used_at TEXT,auth_level TEXT);
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE IF NOT EXISTS mock2_projects(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT);`);
  const transaction = fn => {
    const execute = () => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    };
    execute.immediate = execute;
    return execute;
  };
  const adapter = { prepare: sql => db.prepare(sql), exec: sql => db.exec(sql), transaction };
  const steps = [
    [1100, projects.operationalProjectsMigration1100], [1101, projects.operationalProjectsMigration1101],
    [1102, projects.operationalProjectsMigration1102], [1106, agents.operationalAgentsMigration1106],
    [1107, worker.operationalWorkerMigration1107], [1108, limits.operationalAgentLimitsMigration1108],
    [1109, binding.operationalWorkerBindingMigration1109],
    [1110, credentials.operationalCredentialBindingMigration1110], [1111, runs.operationalRunMigration1111]];
  for (const [version, migrate] of steps) {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version)) continue;
    if (version === 1108) db.exec('PRAGMA foreign_keys=OFF');
    transaction(() => {
      migrate(adapter);
      db.prepare('INSERT INTO schema_migrations(version,name) VALUES(?,?)').run(version, `a5_proof_${version}`);
    })();
    if (version === 1108) db.exec('PRAGMA foreign_keys=ON');
  }
  return { db, adapter, store: store.createOperationsStore(adapter), close: () => db.close() };
}
