// Non-destructive root recovery (cli/src/recovery/*, cli/src/commands/
// recover.js): restore ONE local administrator in the live users table and
// leave everything else alone. Driven against a REAL SQLite database
// (node:sqlite, the same engine better-sqlite3 wraps on a host) carrying the
// backend's current users / sessions / webauthn_credentials /
// authenticated_devices / mcp_tokens / audit_log shapes, plus an unrelated
// application table that must come through byte-identical.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from '../../../../cli/node_modules/bcryptjs/index.js';

import { parseEnvFile, databaseCandidates, resolveInstall } from '../../../../cli/src/recovery/install.js';
import { planRecovery, applyRecovery, accountInventory, inspectSchema, readAccount, ACTIONS, AUDIT_ACTION, RecoveryChangedError } from '../../../../cli/src/recovery/plan.js';
import { generatePassword, validatePassword, hashPassword, verifyPassword, readPasswordSource, MIN_PASSWORD_LENGTH } from '../../../../cli/src/recovery/password.js';
import { recoverAdminCommand, recoverStatusCommand, EXIT } from '../../../../cli/src/commands/recover.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

// The backend schema as migrations 600 (users), 6 (sessions), 8 (passkeys),
// 900+914 (mcp_tokens), 602 (permissions) and the base tables leave it.
const SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT,
  password_hash TEXT NOT NULL, totp_secret TEXT NOT NULL, totp_enabled INTEGER DEFAULT 1,
  role TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user', 'pending')),
  password_change_required INTEGER DEFAULT 0, failed_attempts INTEGER NOT NULL DEFAULT 0,
  last_failed_at TEXT, locked_until TEXT, webauthn_user_handle BLOB,
  is_superadmin INTEGER NOT NULL DEFAULT 0,
  auth_source TEXT NOT NULL DEFAULT 'local' CHECK(auth_source IN ('local', 'ldap')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT,
  sudo_until TEXT, ip TEXT, user_agent TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE webauthn_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE, public_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT, label TEXT, aaguid TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT
);
CREATE TABLE authenticated_devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_name TEXT NOT NULL, device_fingerprint TEXT NOT NULL,
  user_agent TEXT, ip_address TEXT, last_used_at TEXT DEFAULT CURRENT_TIMESTAMP, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, UNIQUE(user_id, device_fingerprint)
);
CREATE TABLE mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_by TEXT,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, scope_json TEXT, token_prefix TEXT, expires_at TEXT
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, resource_type TEXT, resource_id TEXT, details TEXT,
  ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE user_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, permission TEXT NOT NULL,
  granted_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, permission)
);
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE services (id TEXT PRIMARY KEY, name TEXT NOT NULL, upstream TEXT NOT NULL);
CREATE TABLE ldap_connections (id INTEGER PRIMARY KEY, name TEXT, bind_password TEXT NOT NULL);
`;

const OLD_HASH = '$2a$12$abcdefghijklmnopqrstuuXQ1qYbzE8oJ/4dQpM0R6Vg9Yq1YZg1a'; // shape only, never verified
const ENC_TOTP = 'enc:v1:0102030405060708090a0b0c:0102030405060708090a0b0c0d0e0f10:deadbeef';

function seed(db) {
  db.exec(SCHEMA);
  const ins = db.prepare(`INSERT INTO users (id, username, display_name, password_hash, totp_secret, totp_enabled, role, password_change_required, failed_attempts, locked_until, auth_source, is_superadmin, webauthn_user_handle) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run('u-alice', 'alice', 'Alice', OLD_HASH, ENC_TOTP, 1, 'admin', 0, 3, null, 'local', 1, Buffer.from('handle-a'));
  ins.run('u-bob', 'bob', 'Bob', OLD_HASH.replace('a', 'b'), ENC_TOTP.replace('dead', 'cafe'), 1, 'admin', 0, 0, null, 'local', 0, Buffer.from('handle-b'));
  ins.run('u-carol', 'carol', 'Carol', '', '', 0, 'admin', 0, 0, null, 'ldap', 0, null);
  ins.run('u-dave', 'dave', 'Dave', OLD_HASH.replace('a', 'd'), ENC_TOTP, 1, 'user', 0, 0, null, 'local', 0, null);
  ins.run('u-erin', 'erin', 'Erin', OLD_HASH.replace('a', 'e'), ENC_TOTP, 1, 'admin', 0, 9, '2999-01-01T00:00:00.000Z', 'local', 0, null);
  const ses = db.prepare(`INSERT INTO sessions (id, user_id, expires_at, revoked_at, sudo_until) VALUES (?, ?, ?, ?, ?)`);
  ses.run('s-a1', 'u-alice', '2999-01-01', null, '2999-01-01T00:00:00.000Z');
  ses.run('s-a2', 'u-alice', '2999-01-01', null, null);
  ses.run('s-a3', 'u-alice', '2999-01-01', '2020-01-01', null);
  ses.run('s-b1', 'u-bob', '2999-01-01', null, '2999-01-01T00:00:00.000Z');
  const pk = db.prepare(`INSERT INTO webauthn_credentials (user_id, credential_id, public_key, label) VALUES (?, ?, ?, ?)`);
  pk.run('u-alice', 'cred-a1', Buffer.from('pk-a1'), 'yubikey');
  pk.run('u-alice', 'cred-a2', Buffer.from('pk-a2'), 'phone');
  pk.run('u-bob', 'cred-b1', Buffer.from('pk-b1'), 'bob-key');
  const dev = db.prepare(`INSERT INTO authenticated_devices (id, user_id, device_name, device_fingerprint) VALUES (?, ?, ?, ?)`);
  dev.run('d-a1', 'u-alice', 'laptop', 'fp-a1');
  dev.run('d-b1', 'u-bob', 'laptop', 'fp-b1');
  const tok = db.prepare(`INSERT INTO mcp_tokens (name, token_hash, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?)`);
  tok.run('alice-ci', 'h-a1', 'u-alice', '2026-01-01', null);
  tok.run('alice-old', 'h-a2', 'u-alice', '2026-01-01', '2026-02-01');
  tok.run('bob-ci', 'h-b1', 'u-bob', '2026-01-01', null);
  db.prepare(`INSERT INTO user_permissions (user_id, permission) VALUES (?, ?)`).run('u-dave', 'proxy');
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('admin_domain', 'pp.example.com')`).run();
  db.prepare(`INSERT INTO services (id, name, upstream) VALUES ('svc-1', 'grafana', 'http://10.0.0.5:3000')`).run();
  db.prepare(`INSERT INTO ldap_connections (id, name, bind_password) VALUES (1, 'corp', 'enc:v1:aa:bb:cc')`).run();
  db.prepare(`INSERT INTO audit_log (id, user_id, action) VALUES ('a-0', 'u-alice', 'LOGIN_SUCCESS')`).run();
}

function memDb() {
  const db = new DatabaseSync(':memory:');
  seed(db);
  return db;
}

// Everything that is NOT the recovered account, as one comparable snapshot.
function snapshotOthers(db, except) {
  return {
    users: db.prepare(`SELECT * FROM users WHERE username <> ? ORDER BY username`).all(except).map((r) => ({ ...r, webauthn_user_handle: r.webauthn_user_handle ? Buffer.from(r.webauthn_user_handle).toString('hex') : null })),
    sessions: db.prepare(`SELECT s.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username <> ? ORDER BY s.id`).all(except),
    passkeys: db.prepare(`SELECT w.id, w.user_id, w.credential_id, hex(w.public_key) AS pk FROM webauthn_credentials w JOIN users u ON u.id = w.user_id WHERE u.username <> ? ORDER BY w.id`).all(except),
    devices: db.prepare(`SELECT d.* FROM authenticated_devices d JOIN users u ON u.id = d.user_id WHERE u.username <> ? ORDER BY d.id`).all(except),
    mcp: db.prepare(`SELECT t.* FROM mcp_tokens t JOIN users u ON u.id = t.created_by WHERE u.username <> ? ORDER BY t.id`).all(except),
    permissions: db.prepare(`SELECT * FROM user_permissions ORDER BY user_id`).all(),
    settings: db.prepare(`SELECT * FROM app_settings ORDER BY key`).all(),
    services: db.prepare(`SELECT * FROM services ORDER BY id`).all(),
    ldap: db.prepare(`SELECT * FROM ldap_connections ORDER BY id`).all(),
    priorAudit: db.prepare(`SELECT * FROM audit_log WHERE action <> ? ORDER BY id`).all(AUDIT_ACTION),
  };
}

function tmpTree() {
  const root = mkdtempSync(join(tmpdir(), 'pp-recover-'));
  mkdirSync(join(root, 'data', 'db'), { recursive: true });
  return root;
}

// ── install resolution ────────────────────────────────────────────────────

test('parseEnvFile reads the file install.sh writes: comments, quotes, export', () => {
  const env = parseEnvFile(`# ProxyPilot\nDOMAIN=pp.example.com\nexport ADMIN_USERNAME="alice"\nDATABASE_PATH=/data/db/proxypilot.db # container path\nTOTP_ENCRYPTION_KEY='abc'\nBROKEN LINE\n`);
  assert.equal(env.get('DOMAIN'), 'pp.example.com');
  assert.equal(env.get('ADMIN_USERNAME'), 'alice');
  assert.equal(env.get('DATABASE_PATH'), '/data/db/proxypilot.db');
  assert.equal(env.get('TOTP_ENCRYPTION_KEY'), 'abc');
  assert.equal(env.has('BROKEN'), false);
});

test('databaseCandidates maps the container path onto the bind mount and tries the backend default', () => {
  assert.deepEqual(databaseCandidates({ installDir: '/opt/proxypilot', databasePath: '/data/db/proxypilot.db' }), [
    '/opt/proxypilot/data/db/proxypilot.db', '/data/db/proxypilot.db', '/opt/proxypilot/data/proxypilot.db',
  ]);
  assert.deepEqual(databaseCandidates({ installDir: '/srv/pp', databasePath: '' }), [
    '/srv/pp/data/db/proxypilot.db', '/srv/pp/admin/backend/data/db/proxypilot.db', '/srv/pp/data/proxypilot.db',
  ]);
  assert.deepEqual(databaseCandidates({ installDir: '/srv/pp', databasePath: '/var/lib/pp/x.db' }), ['/var/lib/pp/x.db', '/srv/pp/data/proxypilot.db']);
});

test('resolveInstall finds the live database through .env, prefers it over the legacy file, and never carries a key value', () => {
  const root = tmpTree();
  try {
    writeFileSync(join(root, '.env'), 'DOMAIN=pp.example.com\nDATABASE_PATH=/data/db/proxypilot.db\nTOTP_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nJWT_SECRET=sekrit\n');
    writeFileSync(join(root, 'data', 'proxypilot.db'), 'legacy');
    const miss = resolveInstall({ installDir: root });
    // Only the legacy file exists: it is found, last.
    assert.equal(miss.ok, true);
    assert.equal(miss.dbPath, join(root, 'data', 'proxypilot.db'));
    writeFileSync(join(root, 'data', 'db', 'proxypilot.db'), 'live');
    const hit = resolveInstall({ installDir: root });
    assert.equal(hit.ok, true);
    assert.equal(hit.dbPath, join(root, 'data', 'db', 'proxypilot.db'));
    assert.equal(hit.domain, 'pp.example.com');
    assert.equal(hit.hasTotpKey, true);
    assert.equal(hit.hasJwtSecret, true);
    assert.equal(JSON.stringify(hit).includes('sekrit'), false);
    assert.equal(JSON.stringify(hit).includes('0123456789abcdef'), false);
    const none = resolveInstall({ installDir: join(root, 'nowhere') });
    assert.equal(none.ok, false);
    assert.equal(none.reason, 'database_not_found');
    assert.match(none.message, /--db <path>/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── password ─────────────────────────────────────────────────────────────

test('generated passwords meet the login minimum, are unique, and hash the way routes/auth.js verifies', async () => {
  const a = generatePassword();
  const b = generatePassword();
  assert.equal(a.length, 24);
  assert.notEqual(a, b);
  assert.equal(validatePassword(a).ok, true);
  assert.equal(validatePassword('short').ok, false);
  assert.equal(validatePassword('has\nnewline-xxxx').ok, false);
  assert.equal(MIN_PASSWORD_LENGTH, 12);
  const hash = await hashPassword(a);
  assert.match(hash, /^\$2[ab]\$12\$/);
  assert.equal(await verifyPassword(a, hash), true);
  assert.equal(await verifyPassword(b, hash), false);
  assert.equal(await bcrypt.compare(a, hash), true); // what the login handler runs
});

test('the password source is a file or stdin, trailing newline dropped; never argv', async () => {
  const root = tmpTree();
  try {
    writeFileSync(join(root, 'pw'), 'from-a-file-123\n');
    assert.deepEqual(await readPasswordSource({ file: join(root, 'pw') }), { password: 'from-a-file-123', source: 'file' });
    assert.deepEqual(await readPasswordSource({ stdin: true }, { readStdin: async () => 'from-stdin-1234\r\n' }), { password: 'from-stdin-1234', source: 'stdin' });
    assert.deepEqual(await readPasswordSource({}), { password: null, source: 'generated' });
    await assert.rejects(readPasswordSource({ file: 'x', stdin: true }), /mutually exclusive/);
    const bin = readFileSync(join(REPO, 'cli/bin/proxypilot.js'), 'utf8');
    assert.equal(/--password <|--new-password <|--totp-secret </.test(bin), false, 'no option takes a secret value on the command line');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── plan ─────────────────────────────────────────────────────────────────

test('inspectSchema accepts the current backend shape and names what an old one lacks', () => {
  const db = memDb();
  const ok = inspectSchema(db);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.optional, { webauthn_credentials: true, authenticated_devices: true, mcp_tokens: true });
  const old = new DatabaseSync(':memory:');
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password_hash TEXT, totp_secret TEXT, totp_enabled INTEGER, role TEXT)`);
  const bad = inspectSchema(old);
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes('users.auth_source'));
  assert.ok(bad.missing.includes('sessions'));
  assert.ok(bad.missing.includes('audit_log'));
  const plan = planRecovery(old, { username: 'alice', actions: ['password'] });
  assert.equal(plan.ok, false);
  assert.equal(plan.refusals[0].code, 'schema');
});

test('readAccount never returns the hash or the TOTP secret', () => {
  const db = memDb();
  const a = readAccount(db, 'alice');
  assert.equal(a.has_password, 1);
  assert.equal(a.has_totp, 1);
  assert.equal('password_hash' in a, false);
  assert.equal('totp_secret' in a, false);
  assert.equal(readAccount(db, 'nobody'), null);
});

test('planRecovery refuses an unknown account, a directory account, a non-admin without --promote, and an empty request', () => {
  const db = memDb();
  const unknown = planRecovery(db, { username: 'zed', actions: ['password'] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.refusals[0].code, 'unknown_account');
  assert.match(unknown.refusals[0].message, /local administrators: alice, bob, erin/);
  const ldap = planRecovery(db, { username: 'carol', actions: ['password'] });
  assert.equal(ldap.ok, false);
  assert.equal(ldap.refusals[0].code, 'directory_account');
  assert.match(ldap.refusals[0].message, /--create/);
  const user = planRecovery(db, { username: 'dave', actions: ['password'] });
  assert.equal(user.ok, false);
  assert.equal(user.refusals[0].code, 'not_admin');
  const nothing = planRecovery(db, { username: 'alice', actions: [] });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.refusals[0].code, 'nothing_to_do');
  assert.throws(() => planRecovery(db, { username: 'alice', actions: ['drop-everything'] }), /unknown recovery action/);
  assert.deepEqual([...ACTIONS], ['password', 'totp', 'unlock', 'passkeys', 'revoke-mcp-keys', 'promote', 'create']);
});

test('planRecovery for an administrator lists exactly the requested steps plus the always-on revocations, and warns about what it leaves', () => {
  const db = memDb();
  const plan = planRecovery(db, { username: 'alice', actions: ['password', 'totp'] });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'recover');
  assert.deepEqual(plan.steps.map((s) => s.step), ['set-password', 'clear-totp', 'revoke-sessions', 'forget-trusted-devices']);
  const rs = plan.steps.find((s) => s.step === 'revoke-sessions');
  assert.equal(rs.count, 2, 'the two live sessions; the already-revoked one is not counted');
  assert.equal(rs.sudoGrants, 1);
  assert.equal(plan.steps.find((s) => s.step === 'forget-trusted-devices').count, 1);
  assert.ok(plan.warnings.some((w) => /2 passkey\(s\) stay enrolled/.test(w)));
  assert.ok(plan.warnings.some((w) => /1 MCP key\(s\) minted by this account stay valid/.test(w)));
  assert.equal(JSON.stringify(plan).includes(OLD_HASH), false);
  assert.equal(JSON.stringify(plan).includes('enc:v1'), false);

  const full = planRecovery(db, { username: 'alice', actions: ['password', 'totp', 'unlock', 'passkeys', 'revoke-mcp-keys'] });
  assert.deepEqual(full.steps.map((s) => s.step), ['set-password', 'clear-totp', 'unlock', 'delete-passkeys', 'revoke-mcp-keys', 'revoke-sessions', 'forget-trusted-devices']);
  assert.equal(full.steps.find((s) => s.step === 'delete-passkeys').count, 2);
  assert.equal(full.steps.find((s) => s.step === 'revoke-mcp-keys').count, 1);
  assert.equal(full.warnings.length, 0);
});

test('planRecovery warns about a locked account and a passwordless administrator, and --promote on a user', () => {
  const db = memDb();
  const locked = planRecovery(db, { username: 'erin', actions: ['totp'] });
  assert.ok(locked.warnings.some((w) => /locked until 2999/.test(w)));
  assert.equal(planRecovery(db, { username: 'erin', actions: ['password'] }).warnings.some((w) => /locked/.test(w)), false, '--password clears the lockout');
  db.prepare(`UPDATE users SET password_hash = '' WHERE username = 'bob'`).run();
  const exposed = planRecovery(db, { username: 'bob', actions: ['totp'] });
  assert.ok(exposed.warnings.some((w) => /NO password.*initial-setup/.test(w)));
  const promote = planRecovery(db, { username: 'dave', actions: ['promote', 'password'] });
  assert.equal(promote.ok, true);
  assert.deepEqual(promote.steps.map((s) => s.step), ['promote', 'set-password', 'revoke-sessions', 'forget-trusted-devices']);
  assert.ok(planRecovery(db, { username: 'alice', actions: ['promote', 'unlock'] }).warnings.some((w) => /already an administrator/.test(w)));
});

test('planRecovery --create refuses an existing name, a bad name and meaningless companions', () => {
  const db = memDb();
  assert.equal(planRecovery(db, { username: 'alice', actions: ['create', 'password'] }).refusals[0].code, 'exists');
  assert.equal(planRecovery(db, { username: 'carol', actions: ['create', 'password'] }).refusals[0].code, 'exists', 'the LDAP name is taken too');
  assert.equal(planRecovery(db, { username: 'bad name!', actions: ['create', 'password'] }).refusals[0].code, 'username_invalid');
  const conflict = planRecovery(db, { username: 'root2', actions: ['create', 'totp'] });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.refusals[0].code, 'create_conflict');
  const ok = planRecovery(db, { username: 'breakglass', actions: ['create'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'create');
  assert.deepEqual(ok.steps.map((s) => s.step), ['create-local-admin', 'set-password']);
});

test('planRecovery on an old database without the optional tables skips them with a note', () => {
  const db = memDb();
  db.exec(`DROP TABLE webauthn_credentials; DROP TABLE authenticated_devices; DROP TABLE mcp_tokens`);
  const plan = planRecovery(db, { username: 'alice', actions: ['password', 'passkeys', 'revoke-mcp-keys'] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.steps.map((s) => s.step), ['set-password', 'revoke-sessions']);
  assert.ok(plan.warnings.some((w) => /no webauthn_credentials table/.test(w)));
  assert.ok(plan.warnings.some((w) => /no mcp_tokens table/.test(w)));
  const hash = '$2a$12$' + 'x'.repeat(53);
  const r = applyRecovery(db, plan, { passwordHash: hash });
  assert.equal(r.ok, true);
});

// ── apply ────────────────────────────────────────────────────────────────

test('applyRecovery restores the one account and leaves every other row byte-identical', async () => {
  const db = memDb();
  const before = snapshotOthers(db, 'alice');
  const plan = planRecovery(db, { username: 'alice', actions: ['password', 'totp', 'unlock', 'passkeys', 'revoke-mcp-keys'] });
  const pw = generatePassword();
  const hash = await hashPassword(pw);
  const r = applyRecovery(db, plan, { passwordHash: hash, now: '2026-09-21T10:00:00.000Z', invokedBy: { uid: 0, host: 'pp-host', tty: '/dev/pts/0' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, [
    { step: 'set-password', changes: 1 }, { step: 'clear-totp', changes: 1 }, { step: 'unlock', changes: 1 },
    { step: 'delete-passkeys', changes: 2 }, { step: 'revoke-mcp-keys', changes: 1 },
    { step: 'revoke-sessions', changes: 2 }, { step: 'forget-trusted-devices', changes: 1 },
  ]);

  const alice = db.prepare(`SELECT * FROM users WHERE username = 'alice'`).get();
  assert.equal(await bcrypt.compare(pw, alice.password_hash), true, 'the login handler verifies the new password');
  assert.equal(alice.password_change_required, 1);
  assert.equal(alice.totp_enabled, 0);
  assert.equal(alice.totp_secret, '');
  assert.equal(alice.failed_attempts, 0);
  assert.equal(alice.locked_until, null);
  assert.equal(alice.role, 'admin');
  assert.equal(alice.is_superadmin, 1, 'superadmin standing untouched');
  assert.equal(alice.display_name, 'Alice');
  assert.equal(Buffer.from(alice.webauthn_user_handle).toString(), 'handle-a', 'the passkey user handle stays');
  assert.equal(alice.updated_at, '2026-09-21T10:00:00.000Z');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u-alice' AND revoked_at IS NULL`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u-alice' AND sudo_until IS NOT NULL`).get().n, 0);
  assert.equal(db.prepare(`SELECT revoked_at FROM sessions WHERE id = 's-a3'`).get().revoked_at, '2020-01-01', 'an already-revoked session keeps its timestamp');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = 'u-alice'`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM authenticated_devices WHERE user_id = 'u-alice'`).get().n, 0);
  assert.equal(db.prepare(`SELECT revoked_at FROM mcp_tokens WHERE name = 'alice-ci'`).get().revoked_at, '2026-09-21T10:00:00.000Z');
  assert.equal(db.prepare(`SELECT revoked_at FROM mcp_tokens WHERE name = 'alice-old'`).get().revoked_at, '2026-02-01');

  assert.deepEqual(snapshotOthers(db, 'alice'), before, 'bob, carol, dave, erin, their sessions, passkeys, devices, keys, the settings, services and the LDAP secret are untouched');

  const audit = db.prepare(`SELECT * FROM audit_log WHERE action = ?`).all(AUDIT_ACTION);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user_id, null, 'host root is not a dashboard user');
  assert.equal(audit[0].resource_type, 'user');
  assert.equal(audit[0].resource_id, 'u-alice');
  assert.equal(audit[0].ip_address, 'console');
  const details = JSON.parse(audit[0].details);
  assert.equal(details.username, 'alice');
  assert.equal(details.invoked_by, 'host-root');
  assert.equal(details.uid, 0);
  assert.deepEqual(details.actions, ['password', 'totp', 'unlock', 'passkeys', 'revoke-mcp-keys']);
  const raw = audit[0].details;
  assert.equal(raw.includes(pw), false, 'no password in the audit row');
  assert.equal(raw.includes(hash), false, 'no hash in the audit row');
  assert.equal(raw.includes('enc:v1'), false, 'no TOTP material in the audit row');
});

test('applyRecovery with only --password keeps the second factor and the passkeys, but still revokes sessions and trusted devices', async () => {
  const db = memDb();
  const plan = planRecovery(db, { username: 'bob', actions: ['password'] });
  applyRecovery(db, plan, { passwordHash: await hashPassword('a-new-password-1'), now: '2026-09-21T10:00:00.000Z' });
  const bob = db.prepare(`SELECT * FROM users WHERE username = 'bob'`).get();
  assert.equal(bob.totp_enabled, 1);
  assert.equal(bob.totp_secret, ENC_TOTP.replace('dead', 'cafe'));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = 'u-bob'`).get().n, 1);
  assert.equal(db.prepare(`SELECT revoked_at FROM mcp_tokens WHERE name = 'bob-ci'`).get().revoked_at, null);
  assert.equal(db.prepare(`SELECT revoked_at, sudo_until FROM sessions WHERE id = 's-b1'`).get().revoked_at, '2026-09-21T10:00:00.000Z');
  assert.equal(db.prepare(`SELECT sudo_until FROM sessions WHERE id = 's-b1'`).get().sudo_until, null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM authenticated_devices WHERE user_id = 'u-bob'`).get().n, 0);
});

test('applyRecovery --totp alone clears exactly what the login handler keys its re-enrolment on', () => {
  const db = memDb();
  const plan = planRecovery(db, { username: 'alice', actions: ['totp'] });
  applyRecovery(db, plan, {});
  const alice = db.prepare(`SELECT totp_enabled, totp_secret, password_hash FROM users WHERE username = 'alice'`).get();
  assert.equal(alice.totp_enabled, 0);
  assert.equal(alice.totp_secret, '');
  assert.equal(alice.password_hash, OLD_HASH, 'the password is not touched');
  // routes/auth.js: `if (user.totp_enabled && user.totp_secret)` is the gate
  // between "verify TOTP" and "TOTP setup required" — pin that the column
  // pair the recovery clears is the pair the handler reads.
  const auth = readFileSync(join(REPO, 'admin/backend/src/routes/auth.js'), 'utf8');
  assert.ok(auth.includes('if (user.totp_enabled && user.totp_secret)'));
  assert.ok(auth.includes("error: 'TOTP setup required'"));
  // Nobody else's second factor moved.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE totp_enabled = 1`).get().n, 3);
});

test('applyRecovery --promote makes a local user an administrator; --create makes a new one', async () => {
  const db = memDb();
  const promote = planRecovery(db, { username: 'dave', actions: ['promote', 'password'] });
  applyRecovery(db, promote, { passwordHash: await hashPassword('dave-new-pass-1') });
  assert.equal(db.prepare(`SELECT role FROM users WHERE username = 'dave'`).get().role, 'admin');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM user_permissions WHERE user_id = 'u-dave'`).get().n, 1, 'permissions rows stay');

  const create = planRecovery(db, { username: 'breakglass', actions: ['create'] });
  const r = applyRecovery(db, create, { passwordHash: await hashPassword('break-glass-pass-1'), now: '2026-09-21T10:00:00.000Z', newUserId: 'u-bg' });
  assert.deepEqual(r.applied, [{ step: 'create-local-admin', changes: 1 }, { step: 'set-password', changes: 1 }]);
  const bg = db.prepare(`SELECT * FROM users WHERE username = 'breakglass'`).get();
  assert.equal(bg.id, 'u-bg');
  assert.equal(bg.role, 'admin');
  assert.equal(bg.auth_source, 'local');
  assert.equal(bg.totp_enabled, 0);
  assert.equal(bg.totp_secret, '');
  assert.equal(bg.password_change_required, 1);
  assert.equal(bg.is_superadmin, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n, 6);
  assert.equal(planRecovery(db, { username: 'breakglass', actions: ['create'] }).refusals[0].code, 'exists');
});

test('applyRecovery refuses a row that changed between plan and apply, and rolls back completely', async () => {
  const db = memDb();
  const plan = planRecovery(db, { username: 'alice', actions: ['password', 'totp'] });
  const before = { users: db.prepare(`SELECT * FROM users ORDER BY username`).all().map((r) => ({ ...r, webauthn_user_handle: null })), sessions: db.prepare(`SELECT * FROM sessions ORDER BY id`).all(), audit: db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get().n };
  // Someone re-created the account under a new id (or an LDAP link flipped it).
  db.exec(`UPDATE users SET auth_source = 'ldap' WHERE username = 'alice'`);
  const anotherHash = await hashPassword('another-password-1');
  assert.throws(() => applyRecovery(db, plan, { passwordHash: anotherHash }), (e) => e instanceof RecoveryChangedError && e.code === 'changed_underneath');
  assert.deepEqual(db.prepare(`SELECT * FROM users ORDER BY username`).all().map((r) => ({ ...r, webauthn_user_handle: null })), before.users.map((u) => (u.username === 'alice' ? { ...u, auth_source: 'ldap' } : u)));
  assert.deepEqual(db.prepare(`SELECT * FROM sessions ORDER BY id`).all(), before.sessions);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get().n, before.audit, 'no audit row for a refused apply');

  // A create that lost the race is refused the same way.
  const create = planRecovery(db, { username: 'newadmin', actions: ['create'] });
  db.prepare(`INSERT INTO users (id, username, password_hash, totp_secret, role) VALUES ('u-x', 'newadmin', 'h', '', 'user')`).run();
  assert.throws(() => applyRecovery(db, create, { passwordHash: '$2a$12$' + 'x'.repeat(53) }), RecoveryChangedError);
  assert.equal(db.prepare(`SELECT role FROM users WHERE username = 'newadmin'`).get().role, 'user');
});

test('applyRecovery refuses to run without a bcrypt hash when a password is to be set, and without an accepted plan', () => {
  const db = memDb();
  const plan = planRecovery(db, { username: 'alice', actions: ['password'] });
  assert.throws(() => applyRecovery(db, plan, {}), /bcrypt hash/);
  assert.throws(() => applyRecovery(db, plan, { passwordHash: 'plaintext-password' }), /bcrypt hash/);
  assert.throws(() => applyRecovery(db, planRecovery(db, { username: 'zed', actions: ['password'] }), {}), /accepted/);
  assert.equal(db.prepare(`SELECT password_hash FROM users WHERE username = 'alice'`).get().password_hash, OLD_HASH);
});

test('accountInventory reports standing without secrets and flags the passwordless administrator', () => {
  const db = memDb();
  db.prepare(`UPDATE users SET password_hash = '' WHERE username = 'bob'`).run();
  const inv = accountInventory(db);
  assert.equal(inv.ok, true);
  assert.deepEqual(inv.localAdmins, ['alice', 'bob', 'erin']);
  assert.deepEqual(inv.directoryAdmins, ['carol']);
  assert.deepEqual(inv.setupExposed, ['bob']);
  const alice = inv.accounts.find((a) => a.username === 'alice');
  assert.equal(alice.activeSessions, 2);
  assert.equal(alice.sudoGrants, 1);
  assert.equal(alice.passkeys, 2);
  assert.equal(alice.mcpKeys, 1);
  assert.equal(alice.trustedDevices, 1);
  assert.equal(inv.accounts.find((a) => a.username === 'erin').locked, true);
  assert.equal(inv.accounts.find((a) => a.username === 'carol').recoverable, false);
  assert.equal(JSON.stringify(inv).includes('$2a$'), false);
  assert.equal(JSON.stringify(inv).includes('enc:v1'), false);
});

// ── the command, end to end over a file-backed database ──────────────────

function fileDb(root) {
  const dbPath = join(root, 'data', 'db', 'proxypilot.db');
  const db = new DatabaseSync(dbPath);
  seed(db);
  db.close();
  writeFileSync(join(root, '.env'), 'DOMAIN=pp.example.com\nDATABASE_PATH=/data/db/proxypilot.db\nTOTP_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n');
  return dbPath;
}

function commandDeps(overrides = {}) {
  const out = [];
  return {
    out,
    deps: {
      openDb: async (p) => new DatabaseSync(p),
      getuid: () => 0,
      isTTY: () => false,
      hostname: () => 'pp-host',
      tty: () => '/dev/pts/9',
      now: () => '2026-09-21T10:00:00.000Z',
      confirm: async () => { throw new Error('confirm must not be called'); },
      stdout: (l) => out.push(l),
      ...overrides,
    },
  };
}

test('recover admin: refused unless root, and nothing is opened or changed', async () => {
  const root = tmpTree();
  try {
    const dbPath = fileDb(root);
    const before = readFileSync(dbPath);
    const { out, deps } = commandDeps({ getuid: () => 1000, openDb: async () => { throw new Error('must not open'); } });
    const code = await recoverAdminCommand('alice', { password: true, yes: true, installDir: root }, {}, deps);
    assert.equal(code, EXIT.NOT_ROOT);
    assert.equal(await recoverStatusCommand({ installDir: root }, {}, deps), EXIT.NOT_ROOT);
    assert.deepEqual(readFileSync(dbPath), before);
    assert.equal(out.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recover admin: a plan is printed and --dry-run changes nothing, writes no backup', async () => {
  const root = tmpTree();
  try {
    const dbPath = fileDb(root);
    const before = readFileSync(dbPath);
    const { out, deps } = commandDeps();
    const code = await recoverAdminCommand('alice', { password: true, totp: true, dryRun: true, installDir: root }, { json: true }, deps);
    assert.equal(code, EXIT.OK);
    const res = JSON.parse(out.join('\n'));
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.plan.steps.map((s) => s.step), ['set-password', 'clear-totp', 'revoke-sessions', 'forget-trusted-devices']);
    assert.equal(res.database, dbPath);
    assert.deepEqual(readFileSync(dbPath), before);
    assert.equal(readdirSync(join(root, 'data', 'db')).filter((f) => f.includes('recovery-')).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recover admin: without a terminal and without --yes it refuses before touching anything', async () => {
  const root = tmpTree();
  try {
    const dbPath = fileDb(root);
    const before = readFileSync(dbPath);
    const { out, deps } = commandDeps();
    const code = await recoverAdminCommand('alice', { password: true, installDir: root }, { json: true }, deps);
    assert.equal(code, EXIT.REFUSED);
    assert.match(JSON.parse(out.at(-1)).error, /--yes/);
    assert.deepEqual(readFileSync(dbPath), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recover admin: on a terminal the typed username is the confirmation; a mismatch changes nothing', async () => {
  const root = tmpTree();
  try {
    const dbPath = fileDb(root);
    const before = readFileSync(dbPath);
    const { deps } = commandDeps({ isTTY: () => true, confirm: async () => 'bob' });
    assert.equal(await recoverAdminCommand('alice', { password: true, installDir: root }, { json: true }, deps), EXIT.REFUSED);
    assert.deepEqual(readFileSync(dbPath), before);
    const ok = commandDeps({ isTTY: () => true, confirm: async (q) => { assert.match(q, /alice/); return 'alice'; } });
    assert.equal(await recoverAdminCommand('alice', { unlock: true, backup: false, installDir: root }, { json: true }, ok.deps), EXIT.OK);
    const res = JSON.parse(ok.out.join('\n'));
    assert.equal(res.ok, true);
    assert.equal(res.backup, null);
    assert.equal('password' in res, false, 'no password was set, so none is shown');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recover admin --password --yes: generates, hashes, backs up, applies, audits; the password is shown exactly once', async () => {
  const root = tmpTree();
  try {
    const dbPath = fileDb(root);
    const { out, deps } = commandDeps();
    const code = await recoverAdminCommand('alice', { password: true, totp: true, yes: true, installDir: root }, { json: true }, deps);
    assert.equal(code, EXIT.OK);
    const res = JSON.parse(out.join('\n'));
    assert.equal(res.ok, true);
    assert.equal(res.username, 'alice');
    assert.equal(res.passwordSource, 'generated');
    assert.equal(typeof res.password, 'string');
    assert.equal(res.password.length, 24);
    assert.equal(res.loginUrl, 'https://pp.example.com');
    assert.match(res.backup, /proxypilot\.db\.recovery-20260921T100000Z\.bak$/);
    assert.ok(existsSync(res.backup));
    assert.equal(statSync(res.backup).mode & 0o777, 0o600);
    const db = new DatabaseSync(dbPath);
    const alice = db.prepare(`SELECT * FROM users WHERE username = 'alice'`).get();
    assert.equal(await bcrypt.compare(res.password, alice.password_hash), true);
    assert.equal(alice.totp_enabled, 0);
    assert.equal(alice.password_change_required, 1);
    const audit = db.prepare(`SELECT details FROM audit_log WHERE action = ?`).get(AUDIT_ACTION);
    assert.equal(audit.details.includes(res.password), false);
    assert.equal(JSON.parse(audit.details).host, 'pp-host');
    // The backup is the pre-recovery database: alice still has her old hash there.
    const bak = new DatabaseSync(res.backup, { readOnly: true });
    assert.equal(bak.prepare(`SELECT password_hash FROM users WHERE username = 'alice'`).get().password_hash, OLD_HASH);
    assert.equal(bak.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = ?`).get(AUDIT_ACTION).n, 0);
    bak.close();
    db.close();
    // Shown once: the only line carrying the password is the JSON result.
    assert.equal(out.filter((l) => l.includes(res.password)).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recover admin --password-file / --password-stdin: the supplied password is used, validated before any write, never printed', async () => {
  const root = tmpTree();
  try {
    const dbPath = fileDb(root);
    writeFileSync(join(root, 'pw'), 'operator-chosen-pw-2026\n');
    const a = commandDeps();
    assert.equal(await recoverAdminCommand('bob', { passwordFile: join(root, 'pw'), yes: true, backup: false, installDir: root }, { json: true }, a.deps), EXIT.OK);
    const resA = JSON.parse(a.out.join('\n'));
    assert.equal(resA.passwordSource, 'file');
    assert.equal('password' in resA, false);
    assert.equal(a.out.join('\n').includes('operator-chosen-pw-2026'), false);
    let db = new DatabaseSync(dbPath);
    assert.equal(await bcrypt.compare('operator-chosen-pw-2026', db.prepare(`SELECT password_hash FROM users WHERE username = 'bob'`).get().password_hash), true);
    db.close();

    const b = commandDeps({ readStdin: async () => 'from-stdin-password-1\n' });
    assert.equal(await recoverAdminCommand('erin', { passwordStdin: true, yes: true, backup: false, installDir: root }, { json: true }, b.deps), EXIT.OK);
    db = new DatabaseSync(dbPath);
    const erin = db.prepare(`SELECT * FROM users WHERE username = 'erin'`).get();
    assert.equal(await bcrypt.compare('from-stdin-password-1', erin.password_hash), true);
    assert.equal(erin.locked_until, null, 'a password reset clears the lockout');
    db.close();

    // Too short: refused after the plan, before the backup and the write.
    writeFileSync(join(root, 'short'), 'short\n');
    const c = commandDeps();
    const before = readFileSync(dbPath);
    assert.equal(await recoverAdminCommand('alice', { passwordFile: join(root, 'short'), yes: true, installDir: root }, { json: true }, c.deps), EXIT.REFUSED);
    assert.match(JSON.parse(c.out.at(-1)).error, /at least 12/);
    assert.deepEqual(readFileSync(dbPath), before);
    assert.equal(readdirSync(join(root, 'data', 'db')).filter((f) => f.includes('recovery-')).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recover admin: refusals come back as exit 2 with the reason, and the human output never carries a hash', async () => {
  const root = tmpTree();
  try {
    fileDb(root);
    const { out, deps } = commandDeps();
    assert.equal(await recoverAdminCommand('carol', { password: true, yes: true, installDir: root }, { json: true }, deps), EXIT.REFUSED);
    assert.equal(JSON.parse(out.join('\n')).refused[0].code, 'directory_account');
    const h = commandDeps();
    assert.equal(await recoverAdminCommand('alice', { password: true, yes: true, backup: false, installDir: root }, {}, h.deps), EXIT.OK);
    const text = h.out.join('\n');
    assert.ok(/Recovered 'alice'/.test(text) || h.out.some((l) => /Password: /.test(l)));
    assert.equal(text.includes('$2a$'), false);
    assert.equal(text.includes('enc:v1'), false);
    assert.ok(h.out.some((l) => /Untouched: every other account/.test(l)));
    assert.equal(await recoverAdminCommand('alice', { password: true, yes: true, installDir: join(root, 'missing') }, { json: true }, commandDeps().deps), EXIT.REFUSED);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recover status: read-only inventory over the file, with the passwordless warning', async () => {
  const root = tmpTree();
  try {
    const dbPath = fileDb(root);
    const db0 = new DatabaseSync(dbPath);
    db0.prepare(`UPDATE users SET password_hash = '' WHERE username = 'bob'`).run();
    db0.close();
    const before = readFileSync(dbPath);
    const { out, deps } = commandDeps();
    assert.equal(await recoverStatusCommand({ installDir: root }, { json: true }, deps), EXIT.OK);
    const res = JSON.parse(out.join('\n'));
    assert.equal(res.ok, true);
    assert.deepEqual(res.setupExposed, ['bob']);
    assert.deepEqual(res.directoryAdmins, ['carol']);
    assert.equal(res.hasTotpKey, true);
    assert.deepEqual(readFileSync(dbPath), before);
    const human = commandDeps();
    assert.equal(await recoverStatusCommand({ installDir: root }, {}, human.deps), EXIT.OK);
    assert.ok(human.out.some((l) => /^Database: /.test(l)), 'the human form names the database it read (the table itself goes to console)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── the public initial-setup endpoint cannot claim a directory account ───

test('initial-setup and setup-status select LOCAL passwordless administrators only (the query from routes/auth.js, executed)', () => {
  // Found while building the inventory: an LDAP-provisioned account that an
  // admin promoted has an empty password_hash by design, and the public
  // initial-setup handler used to accept any admin with an empty hash — set
  // a password, receive a session. Pin the filter by running the handler's
  // own SQL against the fixture.
  const auth = readFileSync(join(REPO, 'admin/backend/src/routes/auth.js'), 'utf8');
  const claim = /"(SELECT \* FROM users WHERE username = \? AND role = 'admin' AND \(password_hash = '' OR password_hash IS NULL\)[^"]*)"/.exec(auth);
  const status = /"(SELECT id, username FROM users WHERE role = 'admin' AND \(password_hash = '' OR password_hash IS NULL\)[^"]*)"/.exec(auth);
  assert.ok(claim && status, 'the two initial-setup queries are where the suite expects them');
  const db = memDb();
  assert.equal(db.prepare(claim[1]).get('carol'), undefined, 'the LDAP administrator is not claimable');
  assert.equal(db.prepare(status[1]).get(), undefined, 'no setup is pending while only the LDAP admin lacks a hash');
  db.prepare(`UPDATE users SET password_hash = '' WHERE username = 'bob'`).run();
  assert.equal(db.prepare(claim[1]).get('bob').id, 'u-bob', 'a local administrator without a password still can');
  assert.equal(db.prepare(status[1]).get().username, 'bob');
  assert.equal(db.prepare(claim[1]).get('carol'), undefined);
});

// ── reset.sh no longer deletes anything ──────────────────────────────────

test('reset.sh delegates password/TOTP recovery to `proxypilot recover` and never removes the database', () => {
  const src = readFileSync(join(REPO, 'reset.sh'), 'utf8');
  assert.equal(/rm\s+-f\s+.*proxypilot\.db/.test(src), false, 'no database delete');
  assert.equal(/ADMIN_PASSWORD=/.test(src.replace(/^\s*#.*$/gm, '')), false, 'the .env is not rewritten');
  assert.ok(/recover admin/.test(src));
  assert.ok(/--password/.test(src) && /--totp/.test(src));
  const usage = readFileSync(join(REPO, 'cli/bin/proxypilot.js'), 'utf8');
  assert.ok(usage.includes("command('recover')"));
});
