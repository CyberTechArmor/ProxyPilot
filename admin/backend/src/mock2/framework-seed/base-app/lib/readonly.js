'use strict';
/* ---------------------------------------------------------------------------
   Read-only SQL access.

   Why it exists: some questions are enormously cheaper in SQL than over the
   API. "Every provider whose insurance document expires in the next 60 days,
   with their manager" is one join and one index scan; over the API it is N+1
   requests and filtering in application code.

   Why it is READ-ONLY: every state change must go through the API, where the
   permission checks, validation, lifecycle rules and audit trail live. A
   consumer that could UPDATE would bypass all four. Writes are the API's job;
   reading is what this is for.

   ------------------------------------------------------------------------
   THE IMPORTANT PART: consumers get VIEWS, never base tables.

   The base tables hold credential material —

       users.data           → passwordHash
       sessions             → refresh_hash
       password_resets      → token_hash
       api_keys             → token_hash
       app_documents        → the LDAP bind password and SMTP password
                              (encrypted, but still secret-shaped)

   — so a plain `GRANT SELECT ON ALL TABLES` would hand every consumer the
   password hashes. Instead the role is granted SELECT on a set of curated
   views in a separate schema that project only non-secret columns, and is
   explicitly denied everything else. Adding a table later does NOT silently
   expose it: the grant is per-view, and DEFAULT PRIVILEGES are never widened
   to base tables.
   --------------------------------------------------------------------------- */
const crypto = require('crypto');
const db = require('./db');

const SCHEMA = 'api_read';
const ROLE = process.env.READONLY_DB_ROLE || 'app_readonly';

/* ---------------------------------------------------------------------------
   The published surface. Each view is the answer to "what may a consumer see
   about this thing", and is deliberately narrower than the table behind it.
   --------------------------------------------------------------------------- */
const VIEWS = `
CREATE SCHEMA IF NOT EXISTS ${SCHEMA};

-- Accounts. NO password hash, no MFA secret: the data column is never exposed
-- whole, only the specific non-secret keys worth querying.
CREATE OR REPLACE VIEW ${SCHEMA}.users AS
SELECT id, username, email, display_name, provider, active, deleted,
       must_set_password, last_login_at, created_at,
       (data ->> 'deactivatedAt') AS deactivated_at,
       (data ->> 'updatedAt')     AS updated_at
FROM public.users;

CREATE OR REPLACE VIEW ${SCHEMA}.roles AS
SELECT key, label, system, editable, deletable FROM public.roles;

CREATE OR REPLACE VIEW ${SCHEMA}.permissions AS
SELECT key, label, "group" FROM public.permissions;

CREATE OR REPLACE VIEW ${SCHEMA}.user_roles AS
SELECT user_id, role_key FROM public.user_roles;

-- The EFFECTIVE permission of every role: the override when one exists, else
-- the default. Computing this in application code is the single most common
-- reason a consumer would otherwise need three round-trips.
CREATE OR REPLACE VIEW ${SCHEMA}.role_permissions AS
SELECT d.role_key,
       d.perm_key,
       COALESCE(o.allowed, d.allowed) AS allowed,
       (o.role_key IS NOT NULL)       AS overridden
FROM public.default_role_perms d
LEFT JOIN public.perm_overrides o
  ON o.role_key = d.role_key AND o.perm_key = d.perm_key;

-- Documents. stored_as (the on-disk filename) is withheld: it is an
-- implementation detail and handing it out invites path guessing.
CREATE OR REPLACE VIEW ${SCHEMA}.files AS
SELECT id, owner_id, doc_key, name, mime, ext, size, status, note,
       expires_at, created_at
FROM public.files;

-- Sessions: activity, never the token. refresh_hash is omitted entirely.
CREATE OR REPLACE VIEW ${SCHEMA}.sessions AS
SELECT id, family_id, user_id, revoked, created_at, last_used_at,
       idle_expiry, absolute_expiry
FROM public.sessions;

CREATE OR REPLACE VIEW ${SCHEMA}.audit AS
SELECT id, action, actor_id, actor_label, target_id, target_label,
       provider, outcome, reason, ip, created_at
FROM public.audit;

-- Issued machine credentials: which exist and whether they are live. NEVER
-- token_hash.
CREATE OR REPLACE VIEW ${SCHEMA}.api_keys AS
SELECT id, name, prefix, user_id, permissions, active, expires_at,
       last_used_at, created_by, created_at, revoked_at
FROM public.api_keys;

-- A convenience join consumers would otherwise write every time.
CREATE OR REPLACE VIEW ${SCHEMA}.user_access AS
SELECT u.id AS user_id, u.username, u.email, u.active, r.key AS role_key, r.label AS role_label
FROM public.users u
JOIN public.user_roles ur ON ur.user_id = u.id
JOIN public.roles r       ON r.key = ur.role_key
WHERE u.deleted = false;
`;

// Views are owned by the app role, which can read the base tables; the
// read-only role is granted SELECT on the VIEWS only. Postgres runs a view with
// its owner's privileges, so the consumer reads through it without ever holding
// a privilege on public.*
function grants(role) {
  return `
REVOKE ALL ON SCHEMA public FROM ${role};
GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role};
GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${role};
-- New VIEWS in this schema are readable automatically; base tables in public
-- are deliberately NOT covered, so adding a table never leaks it.
ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA} GRANT SELECT ON TABLES TO ${role};
`;
}

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(name))) throw new Error('INVALID_ROLE_NAME');
  return `"${name}"`;
}

// A long random password. Shown to the operator EXACTLY once, at creation, and
// never stored by the app: Postgres holds it, and we hold only metadata.
function newPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

async function ensureViews() {
  await db.query(VIEWS);
}

// listViews — what the read-only credential can actually see, with the columns.
// Handed back with the credential so a consumer does not have to guess.
async function describe() {
  const r = await db.query(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [SCHEMA],
  );
  const out = {};
  for (const row of r.rows) {
    if (!out[row.table_name]) out[row.table_name] = [];
    out[row.table_name].push({ column: row.column_name, type: row.data_type });
  }
  return out;
}

async function roleExists(role) {
  const r = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  return r.rowCount > 0;
}

async function status() {
  const exists = await roleExists(ROLE);
  let canLogin = false;
  let validUntil = null;
  if (exists) {
    const r = await db.query('SELECT rolcanlogin, rolvaliduntil FROM pg_roles WHERE rolname = $1', [ROLE]);
    canLogin = !!r.rows[0]?.rolcanlogin;
    validUntil = r.rows[0]?.rolvaliduntil || null;
  }
  return { enabled: exists && canLogin, role: ROLE, schema: SCHEMA, validUntil };
}

/* enable — create (or rotate) the read-only role and return a connection
   string ONCE. Idempotent: calling it again rotates the password, which is the
   revocation story too (an old credential stops working immediately). */
async function enable({ host = null, port = null, database = null } = {}) {
  const role = quoteIdent(ROLE);
  const password = newPassword();

  await ensureViews();
  try {
    if (await roleExists(ROLE)) {
      await db.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${literal(password)}`);
    } else {
      // NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT are the defaults, but
      // state them: this role must never be able to grow its own privileges.
      await db.query(`CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${literal(password)}`);
    }
    await db.query(grants(role));
  } catch (e) {
    // The application role is deliberately NOT a superuser, so on a locked-down
    // deployment it may not be allowed to create roles. That is a legitimate
    // configuration, not a bug — answer with the exact statement a DBA must run
    // rather than a bare "permission denied" that reads like a broken feature.
    if (/permission denied to create role|must be superuser|permission denied for/i.test(e.message)) {
      const err = new Error(
        `This application's database role is not allowed to create roles, so it cannot issue the read-only credential itself. `
        + `Ask a database administrator to run:\n\n  ALTER ROLE <app_role> CREATEROLE;\n\n`
        + `or to provision it directly with scripts/provision-readonly.sql. `
        + `Granting CREATEROLE is the minimum; the app never needs superuser.`,
      );
      err.code = 'DB_PRIVILEGE';
      throw err;
    }
    throw e;
  }

  return { role: ROLE, schema: SCHEMA, password, url: connectionUrl({ role: ROLE, password, host, port, database }) };
}

async function disable() {
  if (!(await roleExists(ROLE))) return { enabled: false, role: ROLE };
  // NOLOGIN rather than DROP: dropping fails while the role owns or is granted
  // anything, and an operator disabling access wants it to stop NOW, not to
  // debug a dependency error.
  await db.query(`ALTER ROLE ${quoteIdent(ROLE)} WITH NOLOGIN`);
  return { enabled: false, role: ROLE };
}

// Postgres has no parameter binding for DDL, so the password is escaped as a
// literal. It is generated by us from crypto.randomBytes and base64url-encoded,
// so it contains no quotes — the escape is belt-and-braces, not the only guard.
function literal(v) { return `'${String(v).replace(/'/g, "''")}'`; }

// The connection string a consumer pastes into psql / an ODBC DSN / a BI tool.
// Derived from DATABASE_URL so it names the same server the app is using, with
// the app's own credentials swapped out.
function connectionUrl({ role, password, host, port, database }) {
  let u;
  try { u = new URL(db.DATABASE_URL); } catch { u = null; }
  const h = host || u?.hostname || '127.0.0.1';
  const p = port || u?.port || '5432';
  const d = database || (u?.pathname || '/app').replace(/^\//, '');
  return `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${h}:${p}/${d}`;
}

// ODBC needs a DSN string, not a URL — the whole point of the request was
// "let a BI tool connect", and those take a DSN.
function odbcDsn({ role, password, host, port, database }) {
  let u;
  try { u = new URL(db.DATABASE_URL); } catch { u = null; }
  const h = host || u?.hostname || '127.0.0.1';
  const p = port || u?.port || '5432';
  const d = database || (u?.pathname || '/app').replace(/^\//, '');
  return `Driver={PostgreSQL Unicode};Server=${h};Port=${p};Database=${d};Uid=${role};Pwd=${password};sslmode=prefer;`;
}

module.exports = { enable, disable, status, describe, ensureViews, connectionUrl, odbcDsn, SCHEMA, ROLE, VIEWS };
