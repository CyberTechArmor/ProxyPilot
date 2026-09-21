// Non-destructive root recovery: restore access for ONE deliberately chosen
// local administrator in the live users table, and leave everything else —
// application data, encryption keys, unrelated accounts, the audit trail —
// exactly as it is. The replacement for reset.sh's "delete the database and
// let first-boot setup run again" (docs/known-issues.md).
//
// Two halves, both pure over a SQLite handle that offers prepare().get/all/
// run and exec — better-sqlite3 on a host, node:sqlite in the suite:
//
//   planRecovery(db, request)  reads, decides, refuses; writes nothing.
//   applyRecovery(db, plan, …) re-checks the row inside BEGIN IMMEDIATE,
//                              performs the plan's steps, writes the audit
//                              row, commits. Any throw rolls back.
//
// What a recovery may do, each only when asked for:
//   password   set a new bcrypt hash, require a change at next login, clear
//              the lockout
//   totp       clear the second factor so the next password login re-enrols
//              it (the login handler's "TOTP setup required" branch); never
//              disables TOTP for anyone else and never disables the check
//   unlock     clear failed_attempts / locked_until
//   passkeys   delete the account's WebAuthn credentials
//   revoke-mcp-keys  revoke MCP bearer tokens the account minted
//   promote    make a 'user' or 'pending' local account an administrator
//   create     create a NEW local administrator (for an installation whose
//              only administrators are directory-backed and the directory is
//              down)
//
// And what every recovery does, because the old credentials are presumed
// lost or exposed: revoke the account's live sessions, close its elevation
// (sudo) grants, and forget its trusted devices (which skip TOTP).
//
// What it refuses: an unknown account, a directory-backed (LDAP) account (it
// has no local password to restore — use create), a non-administrator
// without promote, a create for a name that exists, and a row that changed
// between plan and apply.
//
// Nothing here logs or returns a hash, a secret or a password. The audit
// details carry names, actions and counts.

import crypto from 'node:crypto';

export const ACTIONS = Object.freeze(['password', 'totp', 'unlock', 'passkeys', 'revoke-mcp-keys', 'promote', 'create']);
export const AUDIT_ACTION = 'ROOT_RECOVERY';
export const USERNAME_PATTERN = /^[A-Za-z0-9._@+-]{1,64}$/;

const REQUIRED_TABLES = {
  users: ['id', 'username', 'password_hash', 'totp_secret', 'totp_enabled', 'role', 'password_change_required', 'failed_attempts', 'locked_until', 'auth_source'],
  sessions: ['id', 'user_id', 'revoked_at', 'sudo_until'],
  audit_log: ['id', 'user_id', 'action', 'resource_type', 'resource_id', 'details', 'ip_address'],
};
// Present on a current install; tolerated missing on an old one (each is
// skipped with a note rather than failing the recovery).
const OPTIONAL_TABLES = ['webauthn_credentials', 'authenticated_devices', 'mcp_tokens'];

function tableColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } catch {
    return [];
  }
}

function hasTable(db, table) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  return !!row;
}

// inspectSchema(db) → { ok, missing: ['users.auth_source', …], optional: { table: bool } }
export function inspectSchema(db) {
  const missing = [];
  for (const [table, cols] of Object.entries(REQUIRED_TABLES)) {
    if (!hasTable(db, table)) { missing.push(table); continue; }
    const have = new Set(tableColumns(db, table));
    for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  const optional = {};
  for (const t of OPTIONAL_TABLES) optional[t] = hasTable(db, t);
  return { ok: missing.length === 0, missing, optional };
}

// readAccount(db, username) → the row's non-secret facts, or null. The hash
// and the TOTP secret are reduced to "present" flags before they leave SQL.
export function readAccount(db, username) {
  return db.prepare(`
    SELECT id, username, display_name, role, auth_source,
           CASE WHEN password_hash IS NULL OR password_hash = '' THEN 0 ELSE 1 END AS has_password,
           CASE WHEN totp_enabled = 1 AND totp_secret IS NOT NULL AND totp_secret <> '' THEN 1 ELSE 0 END AS has_totp,
           password_change_required, failed_attempts, locked_until, is_superadmin, created_at
      FROM users WHERE username = ?
  `).get(username) || null;
}

function countWhere(db, present, sql, ...params) {
  if (!present) return null;
  try {
    return db.prepare(sql).get(...params).n;
  } catch {
    return null;
  }
}

// accountFootprint(db, userId, optional) → what the account can still use.
export function accountFootprint(db, userId, optional) {
  return {
    activeSessions: countWhere(db, true, `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL`, userId),
    sudoGrants: countWhere(db, true, `SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND sudo_until IS NOT NULL`, userId),
    trustedDevices: countWhere(db, optional.authenticated_devices, `SELECT COUNT(*) AS n FROM authenticated_devices WHERE user_id = ?`, userId),
    passkeys: countWhere(db, optional.webauthn_credentials, `SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?`, userId),
    mcpKeys: countWhere(db, optional.mcp_tokens, `SELECT COUNT(*) AS n FROM mcp_tokens WHERE created_by = ? AND revoked_at IS NULL`, String(userId)),
  };
}

// accountInventory(db) → every account's non-secret standing, for `recover
// status`: who could be recovered, who is directory-backed, who is locked,
// and — the one dangerous state — an administrator with no password, whom
// the public initial-setup endpoint would let anyone claim.
export function accountInventory(db) {
  const schema = inspectSchema(db);
  if (!schema.ok) return { ok: false, schema, accounts: [] };
  const rows = db.prepare(`
    SELECT id, username, role, auth_source,
           CASE WHEN password_hash IS NULL OR password_hash = '' THEN 0 ELSE 1 END AS has_password,
           CASE WHEN totp_enabled = 1 AND totp_secret IS NOT NULL AND totp_secret <> '' THEN 1 ELSE 0 END AS has_totp,
           password_change_required, failed_attempts, locked_until, is_superadmin
      FROM users ORDER BY role = 'admin' DESC, username
  `).all();
  const accounts = rows.map((r) => ({
    username: r.username,
    role: r.role,
    authSource: r.auth_source || 'local',
    hasPassword: !!r.has_password,
    hasTotp: !!r.has_totp,
    passwordChangeRequired: !!r.password_change_required,
    locked: !!r.locked_until && Date.parse(r.locked_until) > Date.now(),
    lockedUntil: r.locked_until || null,
    superadmin: !!r.is_superadmin,
    recoverable: (r.auth_source || 'local') === 'local',
    // A LOCAL administrator with no password is claimable through the public
    // initial-setup endpoint (routes/auth.js filters directory accounts out).
    setupExposed: r.role === 'admin' && !r.has_password && (r.auth_source || 'local') === 'local',
    ...accountFootprint(db, r.id, schema.optional),
  }));
  return {
    ok: true,
    schema,
    accounts,
    localAdmins: accounts.filter((a) => a.role === 'admin' && a.recoverable).map((a) => a.username),
    directoryAdmins: accounts.filter((a) => a.role === 'admin' && !a.recoverable).map((a) => a.username),
    setupExposed: accounts.filter((a) => a.setupExposed).map((a) => a.username),
  };
}

function normalizeActions(actions) {
  const set = new Set();
  for (const a of actions || []) {
    if (!ACTIONS.includes(a)) throw new Error(`unknown recovery action '${a}' (one of ${ACTIONS.join(', ')})`);
    set.add(a);
  }
  return set;
}

// planRecovery(db, { username, actions }) → plan. `ok: false` carries
// refusals; `ok: true` carries the ordered steps applyRecovery will perform,
// each with what it touches and how many rows, plus warnings the operator
// should read before confirming. Reads only.
export function planRecovery(db, { username, actions } = {}) {
  const name = String(username || '').trim();
  const wanted = normalizeActions(actions);
  const refusals = [];
  const warnings = [];
  const steps = [];
  const schema = inspectSchema(db);
  if (!schema.ok) {
    return { ok: false, username: name, actions: [...wanted], refusals: [{ code: 'schema', message: `this database is missing ${schema.missing.join(', ')}; it is not a ProxyPilot backend database at the current schema` }], warnings, steps, schema };
  }
  if (!name) refusals.push({ code: 'username_required', message: 'name the administrator to recover' });
  if (wanted.size === 0) refusals.push({ code: 'nothing_to_do', message: `nothing requested; pass one or more of ${ACTIONS.join(', ')}` });

  const account = name ? readAccount(db, name) : null;
  const create = wanted.has('create');

  if (create) {
    if (!USERNAME_PATTERN.test(name)) refusals.push({ code: 'username_invalid', message: 'a new username is 1–64 characters of letters, digits, . _ @ + -' });
    if (account) refusals.push({ code: 'exists', message: `'${name}' already exists (${account.auth_source || 'local'} ${account.role}); recover it instead of creating it` });
    for (const a of ['promote', 'unlock', 'totp', 'passkeys', 'revoke-mcp-keys']) {
      if (wanted.has(a)) refusals.push({ code: 'create_conflict', message: `--${a} has no meaning with --create: a new account has nothing to ${a === 'promote' ? 'promote' : 'reset'}` });
    }
    if (refusals.length) return { ok: false, username: name, actions: [...wanted], refusals, warnings, steps, schema };
    steps.push({ step: 'create-local-admin', username: name, details: 'role admin, auth_source local, password change required at first login, TOTP enrolled at first login' });
    steps.push({ step: 'set-password', username: name });
    return { ok: true, mode: 'create', username: name, actions: [...wanted], account: null, refusals, warnings, steps, schema };
  }

  if (name && !account) {
    const admins = db.prepare(`SELECT username FROM users WHERE role = 'admin' AND (auth_source IS NULL OR auth_source = 'local') ORDER BY username`).all().map((r) => r.username);
    refusals.push({ code: 'unknown_account', message: `no account named '${name}'` + (admins.length ? ` (local administrators: ${admins.join(', ')})` : ' (this installation has no local administrator; --create makes one)') });
  }
  if (account && (account.auth_source || 'local') !== 'local') {
    refusals.push({ code: 'directory_account', message: `'${name}' is a directory-backed (${account.auth_source}) account with no local password to restore; recover a local administrator, or create one with --create` });
  }
  if (account && account.role !== 'admin' && !wanted.has('promote')) {
    refusals.push({ code: 'not_admin', message: `'${name}' has role '${account.role}'; recovery restores an administrator — add --promote to make it one` });
  }
  if (refusals.length) return { ok: false, username: name, actions: [...wanted], account, refusals, warnings, steps, schema };

  const footprint = accountFootprint(db, account.id, schema.optional);

  if (wanted.has('promote') && account.role !== 'admin') {
    steps.push({ step: 'promote', from: account.role, to: 'admin' });
  } else if (wanted.has('promote')) {
    warnings.push(`'${name}' is already an administrator; --promote changes nothing`);
  }
  if (wanted.has('password')) {
    steps.push({ step: 'set-password', details: account.has_password ? 'replaces the current password; a change is required at next login; the lockout is cleared' : 'sets a password on an account that has none; a change is required at next login' });
  } else if (!account.has_password) {
    warnings.push(`'${name}' has NO password: the public initial-setup endpoint lets anyone who reaches the login page claim it. Add --password.`);
  }
  if (wanted.has('totp')) {
    steps.push({ step: 'clear-totp', details: account.has_totp ? 'the next password login enrols a new authenticator' : 'no second factor is enrolled; the next password login enrols one' });
  }
  if (wanted.has('unlock')) {
    steps.push({ step: 'unlock', failedAttempts: account.failed_attempts || 0, lockedUntil: account.locked_until || null });
  } else if (account.locked_until && Date.parse(account.locked_until) > Date.now() && !wanted.has('password')) {
    warnings.push(`'${name}' is locked until ${account.locked_until}; add --unlock (or --password, which clears the lockout too)`);
  }
  if (wanted.has('passkeys')) {
    if (!schema.optional.webauthn_credentials) warnings.push('this database has no webauthn_credentials table; --passkeys skipped');
    else steps.push({ step: 'delete-passkeys', count: footprint.passkeys });
  } else if (footprint.passkeys) {
    warnings.push(`${footprint.passkeys} passkey(s) stay enrolled (add --passkeys to remove them)`);
  }
  if (wanted.has('revoke-mcp-keys')) {
    if (!schema.optional.mcp_tokens) warnings.push('this database has no mcp_tokens table; --revoke-mcp-keys skipped');
    else steps.push({ step: 'revoke-mcp-keys', count: footprint.mcpKeys });
  } else if (footprint.mcpKeys) {
    warnings.push(`${footprint.mcpKeys} MCP key(s) minted by this account stay valid (add --revoke-mcp-keys to revoke them)`);
  }
  steps.push({ step: 'revoke-sessions', count: footprint.activeSessions, sudoGrants: footprint.sudoGrants });
  if (schema.optional.authenticated_devices) steps.push({ step: 'forget-trusted-devices', count: footprint.trustedDevices });

  return { ok: true, mode: 'recover', username: name, actions: [...wanted], account, footprint, refusals, warnings, steps, schema };
}

function needsPassword(plan) {
  return plan.steps.some((s) => s.step === 'set-password');
}

// applyRecovery(db, plan, { passwordHash, now, invokedBy, newUserId }) →
// { ok, applied: [{ step, changes }], audit } — or throws, having rolled
// back. The row is re-read under BEGIN IMMEDIATE and must still be the row
// the plan was made for.
export function applyRecovery(db, plan, { passwordHash, now = new Date().toISOString(), invokedBy = {}, newUserId } = {}) {
  if (!plan || !plan.ok) throw new Error('applyRecovery needs a plan that was accepted');
  if (needsPassword(plan) && (typeof passwordHash !== 'string' || !passwordHash.startsWith('$2'))) {
    throw new Error('applyRecovery needs a bcrypt hash for set-password');
  }
  const applied = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    let userId;
    if (plan.mode === 'create') {
      const clash = db.prepare(`SELECT id FROM users WHERE username = ?`).get(plan.username);
      if (clash) throw new RecoveryChangedError(`'${plan.username}' was created by someone else since the plan was made`);
      userId = newUserId || crypto.randomUUID();
      const r = db.prepare(`
        INSERT INTO users (id, username, display_name, password_hash, totp_secret, totp_enabled, role,
                           password_change_required, failed_attempts, last_failed_at, locked_until, auth_source,
                           created_at, updated_at)
        VALUES (?, ?, ?, ?, '', 0, 'admin', 1, 0, NULL, NULL, 'local', ?, ?)
      `).run(userId, plan.username, plan.username, passwordHash, now, now);
      applied.push({ step: 'create-local-admin', changes: r.changes });
      applied.push({ step: 'set-password', changes: r.changes });
    } else {
      const current = db.prepare(`SELECT id, username, role, auth_source FROM users WHERE username = ?`).get(plan.username);
      if (!current || current.id !== plan.account.id) throw new RecoveryChangedError(`'${plan.username}' is not the account the plan was made for any more`);
      if ((current.auth_source || 'local') !== 'local') throw new RecoveryChangedError(`'${plan.username}' became a directory-backed account since the plan was made`);
      userId = current.id;
      for (const s of plan.steps) {
        let r;
        switch (s.step) {
          case 'promote':
            r = db.prepare(`UPDATE users SET role = 'admin', updated_at = ? WHERE id = ?`).run(now, userId);
            break;
          case 'set-password':
            r = db.prepare(`UPDATE users SET password_hash = ?, password_change_required = 1, failed_attempts = 0, last_failed_at = NULL, locked_until = NULL, updated_at = ? WHERE id = ?`).run(passwordHash, now, userId);
            break;
          case 'clear-totp':
            r = db.prepare(`UPDATE users SET totp_secret = '', totp_enabled = 0, updated_at = ? WHERE id = ?`).run(now, userId);
            break;
          case 'unlock':
            r = db.prepare(`UPDATE users SET failed_attempts = 0, last_failed_at = NULL, locked_until = NULL, updated_at = ? WHERE id = ?`).run(now, userId);
            break;
          case 'delete-passkeys':
            r = db.prepare(`DELETE FROM webauthn_credentials WHERE user_id = ?`).run(userId);
            break;
          case 'revoke-mcp-keys':
            r = db.prepare(`UPDATE mcp_tokens SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL`).run(now, String(userId));
            break;
          case 'revoke-sessions':
            r = db.prepare(`UPDATE sessions SET revoked_at = ?, sudo_until = NULL WHERE user_id = ? AND revoked_at IS NULL`).run(now, userId);
            break;
          case 'forget-trusted-devices':
            r = db.prepare(`DELETE FROM authenticated_devices WHERE user_id = ?`).run(userId);
            break;
          default:
            throw new Error(`unknown plan step '${s.step}'`);
        }
        applied.push({ step: s.step, changes: r.changes });
      }
    }
    const auditId = crypto.randomUUID();
    const details = {
      username: plan.username,
      mode: plan.mode,
      actions: plan.actions,
      applied,
      invoked_by: 'host-root',
      tool: 'proxypilot recover',
      uid: invokedBy.uid ?? null,
      host: invokedBy.host ?? null,
      tty: invokedBy.tty ?? null,
    };
    db.prepare(`
      INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address, created_at)
      VALUES (?, NULL, ?, 'user', ?, ?, 'console', ?)
    `).run(auditId, AUDIT_ACTION, userId, JSON.stringify(details), now);
    db.exec('COMMIT');
    return { ok: true, userId, applied, audit: { id: auditId, action: AUDIT_ACTION, details } };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

export class RecoveryChangedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecoveryChangedError';
    this.code = 'changed_underneath';
  }
}
