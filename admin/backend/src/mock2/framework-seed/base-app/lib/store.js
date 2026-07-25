'use strict';
/* ---------------------------------------------------------------------------
   The application's read model, backed by PostgreSQL.

   Contract (unchanged from the JSON store, on purpose):
     store.get()          → the whole dataset, SYNCHRONOUSLY, as plain objects.
     store.save(section?) → persist; returns a promise callers may ignore.

   Keeping `get()` synchronous is what makes this migration reviewable: every
   lib/ module still does `store.get().users.find(...)` and none of them changed.
   The dataset is loaded once, at boot, by `init()`.

   `save(section)` names the slice that changed ('users', 'files', 'audit', …)
   so a file upload rewrites one table instead of all of them. Omitting it
   rewrites everything, which is always correct and is what the JSON store did
   on every single mutation — so an un-migrated call site is slow, never wrong.

   Writes are serialised through one chain, as before, so two mutations in the
   same tick cannot interleave into a torn state.
   --------------------------------------------------------------------------- */
const db = require('./db');

const DEFAULT_DB = {
  meta: { version: 2, initialized: false },
  users: [],
  roles: [],
  permissions: [],          // catalog: [{key,label,group}]
  defaultRolePerms: [],      // [{roleKey, permKey, allowed}]
  permOverrides: [],         // [{roleKey, permKey, allowed}]
  ldapConfig: null,          // {host,port,baseDN,bindDN,bindPassword(enc),userFilter,useTLS,tlsVerify,enabled}
  smtpConfig: null,          // {enabled,provider,host,port,secure,username,password(enc),fromEmail,fromName,tlsVerify}
  catalog: null,             // provider documents: {sections:[{id,title,order,items:[...]}]}
  internalCatalog: null,     // employee/team documents; same shape, managed separately
  branding: null,            // identity, legal pages, app context, asset index (lib/branding.js)
  passwordResets: [],        // [{tokenHash, userId, expiresAt, usedAt}]
  sessions: [],              // refresh session records
  files: [],                 // uploaded document index (lib/files.js)
  apiKeys: [],               // machine credentials (lib/api-keys.js)
  audit: [],
};

// Which top-level keys live in which table. Anything not listed is a singleton
// document in app_documents.
const DOCUMENT_KEYS = ['ldapConfig', 'smtpConfig', 'catalog', 'internalCatalog', 'branding'];

let data = null;
let writeChain = Promise.resolve();
let ready = false;

/* -------------------------------- helpers -------------------------------- */

// Split a record into its promoted columns and the leftover `data` jsonb, so a
// field added by a module later is preserved instead of silently dropped.
function rest(row, promoted) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) if (!promoted.includes(k)) out[k] = v;
  return out;
}
function merge(cols, jsonb) { return { ...(jsonb || {}), ...cols }; }
const bool = (v) => !!v;
const num = (v) => (v == null ? null : Number(v));

/* --------------------------------- load ---------------------------------- */

async function loadAll() {
  const next = JSON.parse(JSON.stringify(DEFAULT_DB));

  const [meta, users, userRoles, roles, perms, defPerms, overrides, files, sessions, resets, audit, docs, apiKeys] =
    await Promise.all([
      db.query('SELECT key, value FROM app_meta'),
      db.query('SELECT * FROM users'),
      db.query('SELECT user_id, role_key FROM user_roles'),
      db.query('SELECT * FROM roles'),
      db.query('SELECT * FROM permissions'),
      db.query('SELECT * FROM default_role_perms'),
      db.query('SELECT * FROM perm_overrides'),
      db.query('SELECT * FROM files'),
      db.query('SELECT * FROM sessions'),
      db.query('SELECT * FROM password_resets'),
      db.query('SELECT * FROM audit ORDER BY id'),
      db.query('SELECT key, doc FROM app_documents'),
      db.query('SELECT * FROM api_keys'),
    ]);

  for (const r of meta.rows) next.meta[r.key] = r.value;
  // meta is stored per-key; `initialized` is the one the setup gate reads.
  if (typeof next.meta.initialized !== 'boolean') next.meta.initialized = false;

  const rolesByUser = new Map();
  for (const r of userRoles.rows) {
    if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, []);
    rolesByUser.get(r.user_id).push(r.role_key);
  }
  next.users = users.rows.map((r) => merge({
    id: r.id, username: r.username, email: r.email, displayName: r.display_name,
    provider: r.provider, active: bool(r.active), deleted: bool(r.deleted),
    mustSetPassword: bool(r.must_set_password), lastLoginAt: r.last_login_at,
    createdAt: r.created_at, roles: rolesByUser.get(r.id) || [],
  }, r.data));

  next.roles = roles.rows.map((r) => merge({
    key: r.key, label: r.label, system: bool(r.system), editable: bool(r.editable), deletable: bool(r.deletable),
  }, r.data));
  next.permissions = perms.rows.map((r) => ({ key: r.key, label: r.label, group: r.group }));
  next.defaultRolePerms = defPerms.rows.map((r) => ({ roleKey: r.role_key, permKey: r.perm_key, allowed: bool(r.allowed) }));
  next.permOverrides = overrides.rows.map((r) => ({ roleKey: r.role_key, permKey: r.perm_key, allowed: bool(r.allowed) }));

  next.files = files.rows.map((r) => merge({
    id: r.id, ownerId: r.owner_id, docKey: r.doc_key, name: r.name, mime: r.mime, ext: r.ext,
    size: num(r.size), status: r.status, note: r.note, expiresAt: r.expires_at,
    storedAs: r.stored_as, createdAt: r.created_at,
  }, r.data));

  next.sessions = sessions.rows.map((r) => merge({
    id: r.id, familyId: r.family_id, userId: r.user_id, refreshHash: r.refresh_hash,
    revoked: bool(r.revoked), revokedAt: num(r.revoked_at), createdAt: num(r.created_at),
    lastUsedAt: num(r.last_used_at), idleExpiry: num(r.idle_expiry), absoluteExpiry: num(r.absolute_expiry),
  }, r.data));

  next.passwordResets = resets.rows.map((r) => merge({
    tokenHash: r.token_hash, userId: r.user_id, expiresAt: r.expires_at, usedAt: r.used_at,
  }, r.data));

  next.audit = audit.rows.map((r) => merge({
    action: r.action, actorId: r.actor_id, actorLabel: r.actor_label, targetId: r.target_id,
    targetLabel: r.target_label, provider: r.provider, outcome: r.outcome, reason: r.reason,
    ip: r.ip, userAgent: r.user_agent, ts: r.created_at,
  }, r.data));

  next.apiKeys = apiKeys.rows.map((r) => merge({
    id: r.id, name: r.name, prefix: r.prefix, tokenHash: r.token_hash, userId: r.user_id,
    permissions: r.permissions || [], active: bool(r.active), expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at, createdBy: r.created_by, createdAt: r.created_at, revokedAt: r.revoked_at,
  }, r.data));

  for (const r of docs.rows) if (DOCUMENT_KEYS.includes(r.key)) next[r.key] = r.doc;

  data = next;
  return data;
}

/* --------------------------------- write --------------------------------- */
// Each writer replaces its whole table inside the caller's transaction. That is
// the same all-or-nothing semantics the JSON file had (write temp, rename), and
// at this app's scale a few hundred rows per section is cheap. Sectioning keeps
// an audit append from rewriting the users table.

const WRITERS = {
  meta: async (c, d) => {
    for (const [k, v] of Object.entries(d.meta || {})) {
      await c.query(
        'INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [k, JSON.stringify(v)],
      );
    }
  },
  users: async (c, d) => {
    const promoted = ['id', 'username', 'email', 'displayName', 'provider', 'active', 'deleted', 'mustSetPassword', 'lastLoginAt', 'createdAt', 'roles'];
    await c.query('DELETE FROM users');
    await c.query('DELETE FROM user_roles');
    for (const u of d.users || []) {
      await c.query(
        `INSERT INTO users (id, username, email, display_name, provider, active, deleted, must_set_password, last_login_at, created_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [u.id, u.username, u.email ?? null, u.displayName ?? null, u.provider ?? null,
          !!u.active, !!u.deleted, !!u.mustSetPassword, u.lastLoginAt ?? null, u.createdAt ?? null,
          JSON.stringify(rest(u, promoted))],
      );
      for (const rk of u.roles || []) {
        await c.query('INSERT INTO user_roles (user_id, role_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, rk]);
      }
    }
  },
  roles: async (c, d) => {
    const promoted = ['key', 'label', 'system', 'editable', 'deletable'];
    await c.query('DELETE FROM roles');
    for (const r of d.roles || []) {
      await c.query(
        'INSERT INTO roles (key, label, system, editable, deletable, data) VALUES ($1,$2,$3,$4,$5,$6)',
        [r.key, r.label, !!r.system, r.editable !== false, r.deletable !== false, JSON.stringify(rest(r, promoted))],
      );
    }
  },
  permissions: async (c, d) => {
    await c.query('DELETE FROM permissions');
    for (const p of d.permissions || []) {
      await c.query('INSERT INTO permissions (key, label, "group") VALUES ($1,$2,$3)', [p.key, p.label, p.group ?? null]);
    }
  },
  defaultRolePerms: async (c, d) => {
    await c.query('DELETE FROM default_role_perms');
    for (const r of d.defaultRolePerms || []) {
      await c.query(
        'INSERT INTO default_role_perms (role_key, perm_key, allowed) VALUES ($1,$2,$3) ON CONFLICT (role_key, perm_key) DO UPDATE SET allowed = EXCLUDED.allowed',
        [r.roleKey, r.permKey, !!r.allowed],
      );
    }
  },
  permOverrides: async (c, d) => {
    await c.query('DELETE FROM perm_overrides');
    for (const r of d.permOverrides || []) {
      await c.query(
        'INSERT INTO perm_overrides (role_key, perm_key, allowed) VALUES ($1,$2,$3) ON CONFLICT (role_key, perm_key) DO UPDATE SET allowed = EXCLUDED.allowed',
        [r.roleKey, r.permKey, !!r.allowed],
      );
    }
  },
  files: async (c, d) => {
    const promoted = ['id', 'ownerId', 'docKey', 'name', 'mime', 'ext', 'size', 'status', 'note', 'expiresAt', 'storedAs', 'createdAt'];
    await c.query('DELETE FROM files');
    for (const f of d.files || []) {
      await c.query(
        `INSERT INTO files (id, owner_id, doc_key, name, mime, ext, size, status, note, expires_at, stored_as, created_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [f.id, f.ownerId ?? null, f.docKey ?? null, f.name, f.mime ?? null, f.ext ?? null,
          f.size ?? null, f.status ?? null, f.note ?? null, f.expiresAt ?? null, f.storedAs ?? null,
          f.createdAt ?? null, JSON.stringify(rest(f, promoted))],
      );
    }
  },
  sessions: async (c, d) => {
    const promoted = ['id', 'familyId', 'userId', 'refreshHash', 'revoked', 'revokedAt', 'createdAt', 'lastUsedAt', 'idleExpiry', 'absoluteExpiry'];
    await c.query('DELETE FROM sessions');
    for (const s of d.sessions || []) {
      await c.query(
        `INSERT INTO sessions (id, family_id, user_id, refresh_hash, revoked, revoked_at, created_at, last_used_at, idle_expiry, absolute_expiry, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [s.id, s.familyId ?? null, s.userId ?? null, s.refreshHash ?? null, !!s.revoked,
          s.revokedAt ?? null, s.createdAt ?? null, s.lastUsedAt ?? null, s.idleExpiry ?? null,
          s.absoluteExpiry ?? null, JSON.stringify(rest(s, promoted))],
      );
    }
  },
  passwordResets: async (c, d) => {
    const promoted = ['tokenHash', 'userId', 'expiresAt', 'usedAt'];
    await c.query('DELETE FROM password_resets');
    for (const r of d.passwordResets || []) {
      await c.query(
        'INSERT INTO password_resets (token_hash, user_id, expires_at, used_at, data) VALUES ($1,$2,$3,$4,$5)',
        [r.tokenHash, r.userId ?? null, r.expiresAt ?? null, r.usedAt ?? null, JSON.stringify(rest(r, promoted))],
      );
    }
  },
  apiKeys: async (c, d) => {
    const promoted = ['id', 'name', 'prefix', 'tokenHash', 'userId', 'permissions', 'active', 'expiresAt', 'lastUsedAt', 'createdBy', 'createdAt', 'revokedAt'];
    await c.query('DELETE FROM api_keys');
    for (const k of d.apiKeys || []) {
      await c.query(
        `INSERT INTO api_keys (id, name, prefix, token_hash, user_id, permissions, active, expires_at, last_used_at, created_by, created_at, revoked_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [k.id, k.name, k.prefix, k.tokenHash, k.userId ?? null, JSON.stringify(k.permissions || []),
          k.active !== false, k.expiresAt ?? null, k.lastUsedAt ?? null, k.createdBy ?? null,
          k.createdAt ?? null, k.revokedAt ?? null, JSON.stringify(rest(k, promoted))],
      );
    }
  },
  // Audit is APPEND-ONLY and is written by appendAudit(), one row at a time —
  // it is deliberately NOT a section rewrite. The in-memory list is a trimmed
  // recent window (audit.js caps it at 5000) while the table is the permanent
  // archive, so any "rewrite what's in memory" strategy would delete history,
  // and any "insert what's new" strategy that compares counts breaks the moment
  // trimming starts. A no-op writer keeps save('audit') from being a trap.
  audit: async () => {},
};
for (const key of DOCUMENT_KEYS) {
  WRITERS[key] = async (c, d) => {
    if (d[key] == null) { await c.query('DELETE FROM app_documents WHERE key = $1', [key]); return; }
    await c.query(
      'INSERT INTO app_documents (key, doc) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc',
      [key, JSON.stringify(d[key])],
    );
  };
}
const ALL_SECTIONS = Object.keys(WRITERS);

/* ---------------------------------- API ---------------------------------- */

// init — connect, create the schema, load the dataset. Call once, at boot,
// BEFORE the server listens: every route assumes get() returns real data.
async function init() {
  await db.assertReachable();
  await db.ensureSchema();
  await loadAll();
  ready = true;
  return data;
}

function get() {
  if (!data) {
    // A synchronous getter cannot load from Postgres. Reaching here means the
    // process started serving before init() resolved — say that plainly instead
    // of handing back an empty dataset that looks like "the database is empty".
    throw new Error('store.get() before store.init() — the database has not been loaded yet');
  }
  return data;
}

function isReady() { return ready; }

// save — persist. `section` may be a key, an array of keys, or omitted (all).
// Returns the write chain so a caller CAN await it; nothing is required to.
function save(section) {
  const sections = section == null
    ? ALL_SECTIONS
    : (Array.isArray(section) ? section : [section]).filter((s) => WRITERS[s]);
  if (!sections.length) return writeChain;
  // Snapshot ONLY the sections being written: a whole-dataset deep copy on
  // every mutation would make each write proportional to total data size,
  // which is the cost this migration exists to remove.
  const snapshot = {};
  for (const s2 of sections) snapshot[s2] = JSON.parse(JSON.stringify(data[s2] ?? null));
  writeChain = writeChain.then(() => db.withTransaction(async (c) => {
    for (const s of sections) await WRITERS[s](c, snapshot);
  })).catch((e) => {
    // Never let a failed write poison the chain — the next mutation must still
    // get a turn, and the in-memory model is still the truth this process serves.
    console.error('[store] persist failed:', e.message);
  });
  return writeChain;
}

// appendAudit — one INSERT for one event, on the same serialised chain. The
// caller has already pushed it onto the in-memory window.
function appendAudit(entry) {
  const promoted = ['action', 'actorId', 'actorLabel', 'targetId', 'targetLabel', 'provider', 'outcome', 'reason', 'ip', 'userAgent', 'ts'];
  const a = JSON.parse(JSON.stringify(entry));
  writeChain = writeChain.then(() => db.query(
    `INSERT INTO audit (action, actor_id, actor_label, target_id, target_label, provider, outcome, reason, ip, user_agent, created_at, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [a.action, a.actorId ?? null, a.actorLabel ?? null, a.targetId ?? null, a.targetLabel ?? null,
      a.provider ?? null, a.outcome ?? null, a.reason ?? null, a.ip ?? null, a.userAgent ?? null,
      a.ts ?? null, JSON.stringify(rest(a, promoted))],
  )).catch((e) => console.error('[store] audit append failed:', e.message));
  return writeChain;
}

// Wait for every queued write to land. Used by tests and by shutdown.
async function flush() { await writeChain; }

// Test/tooling helper: drop everything and start from the defaults.
async function reset() {
  await db.ensureSchema();
  await db.withTransaction(async (c) => {
    for (const t of ['app_meta', 'users', 'user_roles', 'roles', 'permissions', 'default_role_perms',
      'perm_overrides', 'files', 'sessions', 'password_resets', 'audit', 'app_documents', 'api_keys']) {
      await c.query(`DELETE FROM ${t}`);
    }
  });
  await loadAll();
  return data;
}

module.exports = { init, get, save, appendAudit, flush, reset, isReady, DEFAULT_DB, ALL_SECTIONS };
