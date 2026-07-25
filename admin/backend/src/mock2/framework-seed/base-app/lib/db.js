'use strict';
/* ---------------------------------------------------------------------------
   PostgreSQL — the application's system of record.

   This replaces the single-JSON-file store. Two reasons, in order:

   1. **Read-only SQL access.** Consumers need to ask real questions ("every
      document still pending after 30 days, by provider") without pulling the
      whole dataset through the API and filtering in application code. That
      requires normalised, indexed, queryable tables — which a JSON blob is not.
   2. The JSON store rewrote the entire dataset on every mutation and held all
      of it in memory. That was documented as a scaling ceiling; this removes it
      for reads and bounds it for writes.

   SHAPE OF THE MIGRATION. Every lib/ module reads state synchronously
   (`store.get().users.find(...)`) and there are hundreds of such call sites.
   Rewriting them all to async SQL in one step would be a rewrite of the whole
   application with the acceptance suite as the only safety net. Instead:

     - `store.init()` loads the dataset into memory ONCE at boot (async).
     - `store.get()` stays synchronous and returns that in-memory model, so
       every existing module is unchanged.
     - `store.save(section)` writes through to Postgres asynchronously, on a
       serialised chain — exactly the fire-and-forget contract the JSON
       `persist()` already had (callers never awaited it).

   So Postgres is the durable source of truth and the SQL surface, the process
   keeps a read model in memory, and the diff stays reviewable. Sections let a
   hot path ("a file was uploaded") write one table instead of all of them.

   CONNECTIONS. Two roles, deliberately:
     - the app role (DATABASE_URL) — full DML, used by this process.
     - a read-only role (see readonly.js) — SELECT only, handed to consumers.
   --------------------------------------------------------------------------- */
const pg = require('pg');

// A JSON column round-trips objects; a JS Date round-trips as a timestamptz.
// Everything in this app stores ISO strings, so keep timestamps as text on the
// way out to avoid silently changing every date format the API returns.
pg.types.setTypeParser(1114, (v) => v);  // timestamp
pg.types.setTypeParser(1184, (v) => v);  // timestamptz

const DATABASE_URL = process.env.DATABASE_URL
  || 'postgres://app:app@127.0.0.1:5432/app';

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS || 10000),
  });
  // A pg Pool emits 'error' when an IDLE backend connection drops (a Postgres
  // restart, a network blip). With no listener Node treats that as an unhandled
  // 'error' event and kills the process — a transient database hiccup would
  // take the whole app down. Log and keep serving.
  pool.on('error', (err) => console.error('[db] idle client error (still serving):', err.message));
  return pool;
}

async function query(text, params) { return getPool().query(text, params); }

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* the connection is already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

/* ---------------------------------------------------------------------------
   Schema.

   Tables mirror the store's top-level sections. The columns that consumers will
   actually filter and join on are real columns; the remainder of each record
   rides in a `data` jsonb column. That is a deliberate middle path: it keeps
   this migration honest (no silent data loss when a module adds a field) while
   giving SQL users indexed access to everything that matters. A later change
   can promote more fields out of `data` without breaking either side.
   --------------------------------------------------------------------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_meta (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                text PRIMARY KEY,
  username          text NOT NULL,
  email             text,
  display_name      text,
  provider          text,
  active            boolean NOT NULL DEFAULT true,
  deleted           boolean NOT NULL DEFAULT false,
  must_set_password boolean NOT NULL DEFAULT false,
  last_login_at     text,
  created_at        text,
  data              jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username));
CREATE INDEX IF NOT EXISTS users_email_idx  ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_active_idx ON users (active) WHERE deleted = false;

CREATE TABLE IF NOT EXISTS roles (
  key       text PRIMARY KEY,
  label     text NOT NULL,
  system    boolean NOT NULL DEFAULT false,
  editable  boolean NOT NULL DEFAULT true,
  deletable boolean NOT NULL DEFAULT true,
  data      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS permissions (
  key    text PRIMARY KEY,
  label  text NOT NULL,
  "group" text
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id  text NOT NULL,
  role_key text NOT NULL,
  PRIMARY KEY (user_id, role_key)
);
CREATE INDEX IF NOT EXISTS user_roles_role_idx ON user_roles (role_key);

CREATE TABLE IF NOT EXISTS default_role_perms (
  role_key text NOT NULL,
  perm_key text NOT NULL,
  allowed  boolean NOT NULL,
  PRIMARY KEY (role_key, perm_key)
);

CREATE TABLE IF NOT EXISTS perm_overrides (
  role_key text NOT NULL,
  perm_key text NOT NULL,
  allowed  boolean NOT NULL,
  PRIMARY KEY (role_key, perm_key)
);

CREATE TABLE IF NOT EXISTS files (
  id         text PRIMARY KEY,
  owner_id   text,
  doc_key    text,
  name       text NOT NULL,
  mime       text,
  ext        text,
  size       bigint,
  status     text,
  note       text,
  expires_at text,
  stored_as  text,
  created_at text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS files_owner_idx  ON files (owner_id);
CREATE INDEX IF NOT EXISTS files_status_idx ON files (status);
CREATE INDEX IF NOT EXISTS files_doc_idx    ON files (doc_key);

CREATE TABLE IF NOT EXISTS sessions (
  id           text PRIMARY KEY,
  family_id    text,
  user_id      text,
  refresh_hash text,
  revoked      boolean NOT NULL DEFAULT false,
  revoked_at   bigint,
  created_at   bigint,
  last_used_at bigint,
  idle_expiry  bigint,
  absolute_expiry bigint,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS sessions_user_idx   ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_family_idx ON sessions (family_id);

-- expires_at / used_at are ISO STRINGS here, unlike sessions (epoch millis).
-- lib/reset.js stores an ISO timestamp; typing these as bigint made every
-- reset-token write fail, and because the app serves from its in-memory model
-- the tests still passed while nothing persisted.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  user_id    text,
  expires_at text,
  used_at    text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);

CREATE TABLE IF NOT EXISTS audit (
  id           bigserial PRIMARY KEY,
  action       text NOT NULL,
  actor_id     text,
  actor_label  text,
  target_id    text,
  target_label text,
  provider     text,
  outcome      text,
  reason       text,
  ip           text,
  user_agent   text,
  created_at   text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx   ON audit (actor_id);
CREATE INDEX IF NOT EXISTS audit_action_idx  ON audit (action);

-- Config-ish singletons stay whole documents: they are read as a unit, written
-- as a unit, and nobody queries inside them.
CREATE TABLE IF NOT EXISTS app_documents (
  key  text PRIMARY KEY,
  doc  jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  prefix        text NOT NULL,
  -- Nullable: revoking a key CLEARS the hash, so a revoked row carries no
  -- material that could be re-activated by flipping a boolean.
  token_hash    text,
  user_id       text,
  permissions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  active        boolean NOT NULL DEFAULT true,
  expires_at    text,
  last_used_at  text,
  created_by    text,
  created_at    text,
  revoked_at    text,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_prefix_key ON api_keys (prefix);
CREATE INDEX IF NOT EXISTS api_keys_active_idx ON api_keys (active) WHERE active = true;
`;

async function ensureSchema() {
  await query(SCHEMA);
}

async function close() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end().catch(() => {});
}

// Fail fast and CLEARLY. "ECONNREFUSED 127.0.0.1:5432" in a stack trace sends an
// operator hunting through application code; the database being unreachable is
// a deployment fact and the message should say so.
async function assertReachable() {
  try {
    await query('SELECT 1');
  } catch (e) {
    const err = new Error(
      `Cannot reach PostgreSQL at ${String(DATABASE_URL).replace(/:[^:@/]*@/, ':***@')} — ${e.message}. `
      + 'Set DATABASE_URL, and make sure the database exists and the app role can connect.',
    );
    err.code = 'DB_UNREACHABLE';
    throw err;
  }
}

module.exports = { getPool, query, withTransaction, ensureSchema, assertReachable, close, DATABASE_URL, SCHEMA };
