import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { operationalProjectsMigration1100, operationalProjectsMigration1101, operationalProjectsMigration1102 } from '../../lib/operational-projects-schema.js';
import { operationalAgentsMigration1106 } from '../../lib/operational-agents-schema.js';
import { operationalWorkerMigration1107 } from '../../lib/operational-worker-schema.js';
import { operationalAgentLimitsMigration1108 } from '../../lib/operational-agent-limits-schema.js';
import { createOperationsStore } from '../../lib/operational-projects-store.js';

export function operationsFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,role TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at TEXT,revoked_at TEXT,last_used_at TEXT,auth_level TEXT);
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE mock2_projects(id INTEGER PRIMARY KEY,name TEXT);
    INSERT INTO mock2_projects VALUES(1,'Existing Dev Studio');
    CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO app_settings VALUES('branding_name','Existing custom name');`);
  const transaction = fn => {
    const execute = () => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = fn(); db.exec('COMMIT'); return value; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    };
    execute.immediate = execute;
    return execute;
  };
  const adapter = { prepare: sql => db.prepare(sql), exec: sql => db.exec(sql), transaction };
  const migrate = () => transaction(() => {
    if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=1100').get()) {
      operationalProjectsMigration1100(adapter);
      db.exec("INSERT INTO schema_migrations VALUES(1100,'operational_projects_foundation')");
    }
  })();
  migrate();
  operationalProjectsMigration1101(adapter);
  operationalProjectsMigration1102(adapter);
  operationalAgentsMigration1106(adapter);
  operationalWorkerMigration1107(adapter);
  db.exec('PRAGMA foreign_keys=OFF');
  operationalAgentLimitsMigration1108(adapter);
  db.exec('PRAGMA foreign_keys=ON');
  let time = Date.now();
  const store = createOperationsStore(adapter, { now: () => new Date(time).toISOString() });
  const addUser = (role = 'user') => {
    const id = randomUUID();
    db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, `person-${id}`, role);
    return { id, role };
  };
  return { db, adapter, store, migrate, addUser, advance: ms => { time += ms; }, close: () => db.close() };
}

// Handler fixture, NOT an Express replacement for production. Runs the actual
// registered middleware/handlers with request/response doubles, no HTTP server.
export function fixtureRouter() {
  const entries = [];
  const router = { use: (...handlers) => entries.push({ handlers }) };
  for (const method of ['get','post','patch','put','delete']) {
    router[method] = (path, ...handlers) => entries.push({ method: method.toUpperCase(), path, handlers });
  }
  router.dispatch = async (req, before = []) => {
    const res = { statusCode: 200, headers: {}, done: false,
      status(code) { this.statusCode = code; return this; },
      set(k,v) { this.headers[k.toLowerCase()] = v; return this; },
      json(body) { this.body = body; this.done = true; return this; },
    };
    req.query ??= {}; req.headers ??= {}; req.cookies ??= {};
    req.get = name => req.headers[name.toLowerCase()];
    const run = async handlers => {
      for (const handler of handlers) {
        let next = false;
        await handler(req, res, () => { next = true; });
        if (res.done || !next) return false;
      }
      return true;
    };
    if (!(await run(before))) return res;
    for (const e of entries) {
      if (e.method) {
        if (e.method !== req.method) continue;
        const names = [];
        const pattern = e.path.replace(/:([^/]+)/g, (_, name) => { names.push(name); return '([^/]+)'; });
        const match = req.path.match(new RegExp(`^${pattern}/?$`));
        if (!match) continue;
        req.params = Object.fromEntries(names.map((n,i) => [n,match[i+1]]));
      }
      if (!(await run(e.handlers))) return res;
    }
    return res.status(404).json({error:'Not found'});
  };
  return router;
}
