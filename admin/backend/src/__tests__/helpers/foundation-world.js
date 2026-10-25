// A test world for the application foundation's host control plane:
//   * mock2.db: node:sqlite with EVERY mock2 migration applied (so the store
//     runs against the real schema, migration 564 included);
//   * the guest: a scripted foundation-stack.js — foundationPsql answers the
//     host's SQL from a small in-memory app database (jobs, vector indexes,
//     health, the last synced state), and records every script it was sent;
//     setFoundationService / foundationCli / bundledStorageObjectCount /
//     runFoundationJobDetached are recorded and answer from `world.guest`.
// ./db.js (mock2), ../db.js (main) and ./foundation-stack.js are replaced at
// the module boundary by resolve hooks that stay registered for the file (the
// store imports the stack lazily, at call time).

import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { MOCK2_MIGRATIONS } from '../../mock2/migrations.js';

const world = globalThis.__foundationWorld || (globalThis.__foundationWorld = { db: null, stack: null, mainDb: null });

const STUBS = {
  './db.js': 'export const getMock2Db = () => globalThis.__foundationWorld.db;',
  '../db.js': 'export const getDb = () => globalThis.__foundationWorld.mainDb; export const logAudit = () => {}; export const runMigration = () => {};',
  './foundation-stack.js': [
    'const s = () => globalThis.__foundationWorld.stack;',
    'export const foundationPsql = (...a) => s().foundationPsql(...a);',
    'export const setFoundationService = (...a) => s().setFoundationService(...a);',
    'export const foundationServiceStatus = (...a) => s().foundationServiceStatus(...a);',
    'export const bundledStorageObjectCount = (...a) => s().bundledStorageObjectCount(...a);',
    'export const foundationCli = (...a) => s().foundationCli(...a);',
    'export const runFoundationJobDetached = (...a) => s().runFoundationJobDetached(...a);',
  ].join('\n'),
};
const mock2Dir = new URL('../../mock2/', import.meta.url).href;
let hooked = false;
export function installFoundationHooks() {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL || '';
      if (parent.startsWith(mock2Dir) && !parent.slice(mock2Dir.length).includes('/') && Object.hasOwn(STUBS, specifier)) {
        if (specifier === '../db.js' && !parent.endsWith('/projects.js')) return next(specifier, context);
        return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}

export function freshMock2Db() {
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  const transaction = (fn) => (...args) => {
    if (depth > 0) return fn(...args);
    depth += 1;
    db.exec('BEGIN');
    try { const v = fn(...args); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth -= 1; }
  };
  const adapter = { prepare: (sql) => db.prepare(sql), exec: (sql) => db.exec(sql), transaction, pragma: (s) => db.prepare(`PRAGMA ${s}`).all(), raw: db };
  for (const m of MOCK2_MIGRATIONS) m.up(adapter);
  world.db = adapter;
  return adapter;
}

export function addProject(db, { id, name = `P${id}`, container = `m2-p${id}`, lifecycle = 'active', foundationVersion = 'mock2-foundation-v1' } = {}) {
  db.prepare(`INSERT INTO mock2_projects (id, name, repo_path, lifecycle, container_name, created_at, foundation_version) VALUES (?, ?, '', ?, ?, ?, ?)`)
    .run(id, name, lifecycle, container, new Date().toISOString(), foundationVersion);
  return { id, container };
}

// The scripted guest. `guest` holds what the tests set; `calls` what happened.
export function scriptedStack() {
  const guest = {
    objectCount: 0,
    failSync: false,
    cli: {},                 // { 'storage-test': { code, stdout }, 'embeddings-test': …, health: … }
    activeIndex: null,       // { id, provider, model, dimensions, metric }
    jobs: {},                // app-side jobs rows by id
    indexes: {},             // app-side vector_indexes by id
    health: [],
    guardTable: false, guardRows: false,
    generation: 0,
    serviceFails: null,      // 'start' | 'stop' to make that fail
  };
  const calls = { psql: [], services: [], cli: [], detached: [], counts: [] };
  const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
  const stack = {
    async foundationPsql(container, sql, opts = {}) {
      calls.psql.push({ container, sql, opts });
      if (sql.includes('MF_GENERATION:')) {
        if (guest.failSync) return { code: 3, stdout: '', stderr: 'ERROR:  relation "mock2_foundation.features" does not exist' };
        for (const m of sql.matchAll(/SET state = 'retired', retired_at = now\(\) WHERE state = 'active' AND id <> '([a-z0-9_]+)'/g)) {
          for (const ix of Object.values(guest.indexes)) if (ix.state === 'active' && ix.id !== m[1]) ix.state = 'retired';
          if (guest.activeIndex && guest.activeIndex.id !== m[1]) guest.activeIndex = null;
        }
        for (const m of sql.matchAll(/SET state = 'active', activated_at = now\(\) WHERE id = '([a-z0-9_]+)' AND state = 'ready'/g)) {
          const ix = guest.indexes[m[1]];
          if (!ix || ix.state !== 'ready') return { code: 3, stdout: '', stderr: `ERROR:  index ${m[1]} is not ready` };
          ix.state = 'active';
          guest.activeIndex = { ...ix };
        }
        guest.generation += 1;
        guest.lastSync = sql;
        return ok(`BEGIN\nINSERT 0 1\n MF_GENERATION:${guest.generation}\n`);
      }
      if (sql.includes('INSERT INTO mock2_foundation.jobs')) {
        const m = sql.match(/VALUES \('(fj_[a-z0-9]+)', '(storage_migrate|reembed)'/);
        guest.jobs[m[1]] = { id: m[1], kind: m[2], state: 'queued', progress: {}, error: null, updated_at: new Date().toISOString(), finished_at: null };
        const ix = sql.match(/INSERT INTO mock2_foundation\.vector_indexes \(id, provider, model, dimensions, metric, state, table_name\) VALUES \('([a-z0-9_]+)', '([^']*)', '([^']*)', (\d+), '([a-z]+)', 'building'/);
        if (ix) guest.indexes[ix[1]] = { id: ix[1], provider: ix[2], model: ix[3], dimensions: Number(ix[4]), metric: ix[5], state: 'building', item_count: 0 };
        return ok('BEGIN\nINSERT 0 1\nCOMMIT\nMF_OK:inserted\n');
      }
      if (sql.includes("SET state = 'cancelled'")) {
        const id = sql.match(/WHERE id = '(fj_[a-z0-9]+)'/)[1];
        if (guest.jobs[id] && ['queued', 'running'].includes(guest.jobs[id].state)) guest.jobs[id].state = 'cancelled';
        const ix = sql.match(/vector_indexes SET state = 'failed' WHERE id = '([a-z0-9_]+)'/);
        if (ix && guest.indexes[ix[1]]) guest.indexes[ix[1]].state = 'failed';
        return ok('MF_OK:cancelled\n');
      }
      if (sql.includes("'type', 'job'")) {
        const id = sql.match(/FROM mock2_foundation\.jobs WHERE id = '(fj_[a-z0-9]+)'/)[1];
        const lines = [];
        if (guest.jobs[id]) { const j = guest.jobs[id]; lines.push(`MF_JSON:${JSON.stringify({ type: 'job', state: j.state, progress: j.progress, error: j.error, updated_at: j.updated_at, finished_at: j.finished_at })}`); }
        const ixm = sql.match(/FROM mock2_foundation\.vector_indexes WHERE id = '([a-z0-9_]+)'/);
        if (ixm && guest.indexes[ixm[1]]) lines.push(`MF_JSON:${JSON.stringify({ type: 'index', ...guest.indexes[ixm[1]] })}`);
        lines.push('MF_OK:polled');
        return ok(`${lines.join('\n')}\n`);
      }
      if (sql.includes('FROM mock2_foundation.health')) {
        // The GET overview: probes, plus the active index when asked for.
        const ix = sql.includes("'type', 'index'") && guest.activeIndex ? [`MF_JSON:${JSON.stringify({ type: 'index', state: 'active', item_count: 0, ...guest.activeIndex })}`] : [];
        return ok(`${[...guest.health.map((h) => `MF_JSON:${JSON.stringify(h)}`), ...ix].join('\n')}\nMF_OK:read\n`);
      }
      if (sql.includes("WHERE state = 'active'") && sql.includes("'type', 'index'")) {
        return ok(`${guest.activeIndex ? `MF_JSON:${JSON.stringify({ type: 'index', ...guest.activeIndex })}\n` : ''}MF_OK:read\n`);
      }
      if (sql.includes('to_regclass')) return ok(`MF_JSON:${JSON.stringify({ exists: guest.guardTable })}\nMF_OK:probe\n`);
      if (sql.includes("'rows', EXISTS")) return ok(`MF_JSON:${JSON.stringify({ rows: guest.guardRows })}\nMF_OK:rows\n`);
      return { code: 1, stdout: '', stderr: 'unexpected SQL' };
    },
    async setFoundationService(container, service, action) {
      calls.services.push([service, action]);
      if (guest.serviceFails === action) throw new Error(`docker compose ${action} ${service} failed`);
    },
    async foundationServiceStatus() { return []; },
    async bundledStorageObjectCount(container, creds) { calls.counts.push(creds); return guest.objectCount; },
    async foundationCli(container, args, opts) {
      calls.cli.push({ args, opts });
      const r = guest.cli[args[0]];
      if (typeof r === 'function') return r(args);
      if (r) return r;
      if (args[0] === 'health') return ok(JSON.stringify([{ component: 'database', status: 'ready', detail: {} }, { component: 'storage', status: 'ready', detail: {} }, { component: 'embeddings', status: 'ready', detail: {} }]));
      return ok('{"status":"ready","detail":{}}');
    },
    async runFoundationJobDetached(container, jobId, opts) { calls.detached.push({ jobId, opts }); },
  };
  world.stack = stack;
  return { stack, guest, calls };
}

export { world };
