// ProxyPilot's own administration over MCP: users, scoped MCP keys, settings
// and feature flags, the audit log and the MCP ledger, security scans and GRC
// evidence, the dashboard database's own backup/restore, host snapshots, host
// services / packages / reboot, and outbound webhooks.
//
// Nothing here reuses an Express handler (they read req.user off a cookie
// session); every verb calls the lib layer or the DB directly and carries the
// same guards the UI has (last-admin, superadmin protection, sudo-class
// actions behind a confirmation token).

import bcrypt from 'bcryptjs';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { checkSuperadminProtection } from '../../lib/superadmin.js';
import { encryptSecret, decryptSecret } from '../../lib/secrets.js';
import { hasHostBinary } from '../../lib/host-exec.js';
import { mcpTokenOwnerStatus } from '../../lib/mcp-logic.js';
import {
  validateTokenScope, parseTokenScope, intIn, stamp, sha256Hex, UNIT_NAME_RE, parseSystemctlUnits, parseDpkgList, parseAptUpgradable, pathUnder,
} from '../../lib/mcp-ext/logic.js';

const REPORTS_DIR = process.env.PROXYPILOT_SECURITY_REPORTS_DIR || '/var/lib/proxypilot/security-reports';
const GRC_DIR = process.env.PROXYPILOT_GRC_DIR || '/var/lib/proxypilot/grc';

export function createAdminHandlers(kit) {
  const { ctx, ok, err, mutation, reader, confirmToken, confirmFlag, dry, hostSh, tail, policy, readLedger, flag, setFlag } = kit;
  // lib/webauthn.js imports the native DB module; load it on first use.
  const listCredentialsForUI = async (userId) => (await import('../../lib/webauthn.js')).listCredentialsForUI(userId);
  const {
    getDb, getSetting, setSetting, runHostCapture, uuidv4, mintMcpToken, hashMcpToken, MCP_TOOL_NAMES, dbPath,
    selfUpdateStatus, mock2Modules, mock2Enabled, listBackupsRunning,
  } = ctx;

  /* -------------------------------- users -------------------------------- */

  const userShape = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, auth_source: u.auth_source, is_superadmin: !!u.is_superadmin, totp_enabled: !!u.totp_enabled, password_change_required: !!u.password_change_required, locked_until: u.locked_until || null, created_at: u.created_at, updated_at: u.updated_at });

  function actorIsSuperadmin(auth) {
    try { return getDb().prepare('SELECT is_superadmin FROM users WHERE id = ?').get(String(auth.created_by))?.is_superadmin === 1; } catch { return false; }
  }

  const list_users = reader('list_users', async (args) => {
    const rows = getDb().prepare(`SELECT * FROM users ORDER BY created_at`).all();
    const role = args.role ? String(args.role) : null;
    const out = [];
    for (const u of rows.filter((u) => !role || u.role === role)) out.push({ ...userShape(u), passkeys: (await listCredentialsForUI(u.id)).length });
    return ok({ count: out.length, users: out });
  });

  const create_user = mutation('create_user', { subjectType: 'user' }, async (args, auth, req, note) => {
    const username = String(args.username || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(username)) return err('username: 2–64 chars, lowercase letters, digits, . _ -');
    const role = args.role === 'admin' ? 'admin' : 'user';
    const display = args.display_name != null ? String(args.display_name).slice(0, 100) : null;
    const db = getDb();
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return err('Username already exists');
    note.subject_id = username;
    const d = dry(args, { username, role, display_name: display, password: 'generated, shown once' }); if (d) return d;
    const gate = confirmFlag(args, note, `Create ${role} user ${username}.`); if (gate) return gate;
    const password = randomBytes(18).toString('base64url').slice(0, 24);
    const hash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    db.prepare(`INSERT INTO users (id, username, display_name, password_hash, totp_secret, totp_enabled, role, password_change_required) VALUES (?, ?, ?, ?, '', 0, ?, 1)`).run(id, username, display, hash, role);
    note.subject_id = id;
    note.summary = `created ${role} user ${username}`;
    note.detail = { username, role };
    return ok({ created: true, user: { id, username, display_name: display, role }, password, note: 'Save the password now — it is shown once and must be changed at first sign-in.' });
  });

  const set_role = mutation('set_role', { subjectType: 'user' }, async (args, auth, req, note) => {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ? OR username = ?').get(String(args.user_id || ''), String(args.user_id || ''));
    if (!user) return err('User not found');
    note.subject_id = user.id;
    const role = String(args.role || '');
    if (!['admin', 'user', 'pending'].includes(role)) return err('role must be admin, user or pending');
    if (user.role === role) return ok({ applied: false, user: userShape(user), note: 'Already that role.' });
    const demotion = user.role === 'admin';
    if (demotion) {
      const guard = checkSuperadminProtection({ actorIsSuperadmin: actorIsSuperadmin(auth), targetIsSuperadmin: user.is_superadmin === 1, action: 'demote' });
      if (!guard.allowed) { note.refused = true; return err(guard.error); }
      if (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c <= 1) { note.refused = true; return err('Cannot demote the last admin'); }
    }
    const d = dry(args, { user: user.username, from: user.role, to: role }); if (d) return d;
    const gate = confirmFlag(args, note, `Change ${user.username} from ${user.role} to ${role}.`); if (gate) return gate;
    db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(role, user.id);
    note.summary = `${user.username}: ${user.role} → ${role}`;
    note.detail = { from: user.role, to: role };
    return ok({ applied: true, user: { ...userShape(user), role }, previous_role: user.role });
  });

  const disable_user = mutation('disable_user', { subjectType: 'user' }, async (args, auth, req, note) => {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ? OR username = ?').get(String(args.user_id || ''), String(args.user_id || ''));
    if (!user) return err('User not found');
    note.subject_id = user.id;
    const disable = args.disabled !== false;
    if (String(user.id) === String(auth.created_by) && disable) { note.refused = true; return err('Refusing to disable the account that owns this MCP key'); }
    if (disable && user.role === 'pending') return ok({ applied: false, user: userShape(user), note: 'Already disabled (role pending).' });
    if (!disable && user.role !== 'pending') return ok({ applied: false, user: userShape(user), note: 'Already enabled.' });
    if (disable && user.role === 'admin') {
      const guard = checkSuperadminProtection({ actorIsSuperadmin: actorIsSuperadmin(auth), targetIsSuperadmin: user.is_superadmin === 1, action: 'disable' });
      if (!guard.allowed) { note.refused = true; return err(guard.error); }
      if (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c <= 1) { note.refused = true; return err('Cannot disable the last admin'); }
    }
    const restoreRole = disable ? null : (['admin', 'user'].includes(args.role) ? args.role : (getSetting(`user_disabled_role:${user.id}`) || 'user'));
    const d = dry(args, { user: user.username, action: disable ? 'disable (role → pending, sessions revoked, MCP keys revoked)' : `enable (role → ${restoreRole}; revoked MCP keys stay revoked)` }); if (d) return d;
    const gate = confirmFlag(args, note, `${disable ? 'Disable' : 'Enable'} ${user.username}.`); if (gate) return gate;
    let mcpKeysRevoked = 0;
    if (disable) {
      setSetting(`user_disabled_role:${user.id}`, user.role);
      db.prepare("UPDATE users SET role = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
      try { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); } catch { /* table shape may differ */ }
      // Disabling revokes the account's MCP keys outright (not just "the
      // owner check will refuse them"): re-enabling must never silently
      // revive a key that was dead while the account was off.
      try { mcpKeysRevoked = db.prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL').run(new Date().toISOString(), String(user.id)).changes; } catch { /* pre-migration */ }
    } else {
      db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(restoreRole, user.id);
    }
    note.summary = `${disable ? 'disabled' : 'enabled'} ${user.username}`;
    note.detail = { disabled: disable, previous_role: user.role, role: disable ? 'pending' : restoreRole, mcp_keys_revoked: mcpKeysRevoked };
    return ok({ applied: true, user: { ...userShape(user), role: disable ? 'pending' : restoreRole }, previous_role: user.role, mcp_keys_revoked: mcpKeysRevoked, note: disable ? 'A pending account cannot reach any feature router; its MCP keys are revoked. Re-enable with disabled: false (revoked keys stay revoked — mint new ones).' : undefined });
  });

  const reset_passkey = mutation('reset_passkey', { subjectType: 'user', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ? OR username = ?').get(String(args.user_id || ''), String(args.user_id || ''));
    if (!user) return err('User not found');
    note.subject_id = user.id;
    const guard = checkSuperadminProtection({ actorIsSuperadmin: actorIsSuperadmin(auth), targetIsSuperadmin: user.is_superadmin === 1, action: 'reset passkeys of' });
    if (!guard.allowed) { note.refused = true; return err(guard.error); }
    const creds = await listCredentialsForUI(user.id);
    const resetPassword = args.reset_password === true;
    if (!creds.length && !resetPassword) return ok({ applied: false, user: user.username, note: 'This user has no passkeys registered. Pass reset_password: true to issue a temporary password instead.' });
    if (resetPassword && user.auth_source === 'ldap') return err('This account authenticates via LDAP — its password lives in the directory');
    const plan = { user: user.username, passkeys_removed: creds.map((c) => ({ id: c.id, label: c.label })), password_reset: resetPassword, totp_kept: !!user.totp_enabled };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'reset_passkey', subject: user.id, action: `remove ${creds.length} passkey(s) from ${user.username}${resetPassword ? ' and issue a temporary password' : ''}`, preview: plan });
    if (gate) return gate;
    const removed = db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(user.id).changes;
    let password = null;
    if (resetPassword) {
      password = randomBytes(18).toString('base64url').slice(0, 24);
      db.prepare('UPDATE users SET password_hash = ?, password_change_required = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(await bcrypt.hash(password, 12), user.id);
    }
    try { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); } catch { /* best effort */ }
    note.summary = `reset passkeys for ${user.username}`;
    note.detail = { passkeys_removed: removed, password_reset: resetPassword };
    return ok({ applied: true, user: user.username, passkeys_removed: removed, ...(password ? { temporary_password: password, note: 'Shown once; must be changed at first sign-in.' } : {}) });
  });

  /* ------------------------------ MCP keys ------------------------------- */

  const keyShape = (r) => ({ id: r.id, name: r.name, prefix: r.token_prefix || null, created_by: r.created_by, created_at: r.created_at, last_used_at: r.last_used_at, revoked_at: r.revoked_at, scope: parseTokenScope(r.scope_json), scoped: !!r.scope_json });

  const list_mcp_keys = reader('list_mcp_keys', async (args, auth) => {
    const db = getDb();
    const users = new Map(db.prepare('SELECT id, username, role FROM users').all().map((u) => [String(u.id), u]));
    // owner_status other than 'active' means the key no longer authenticates
    // even though it is not revoked (routes/mcp.js findToken).
    const withOwner = (r) => {
      const owner = users.get(String(r.created_by || '')) || null;
      return { ...keyShape(r), owner_username: owner?.username || null, owner_status: mcpTokenOwnerStatus({ ownerId: r.created_by, owner }) };
    };
    const rows = db.prepare('SELECT * FROM mcp_tokens ORDER BY id DESC').all();
    const includeRevoked = args.include_revoked === true;
    const mine = rows.find((r) => r.id === auth?.id) || null;
    return ok({ keys: rows.filter((r) => includeRevoked || !r.revoked_at).map(withOwner), this_key: mine ? withOwner(mine) : null });
  });

  const create_scoped_key = mutation('create_scoped_key', { subjectType: 'mcp_token' }, async (args, auth, req, note) => {
    const name = String(args.name || '').trim().slice(0, 100);
    if (!name) return err('name is required');
    const v = validateTokenScope(args.scope ?? null, { knownTools: MCP_TOOL_NAMES() });
    if (v.error) return err(v.error);
    const scope = v.scope;
    const mine = parseTokenScope(auth.scope_json);
    if (scope?.self_edit && !mine.self_edit && !actorIsSuperadmin(auth)) {
      // A key can only hand out what its owner could grant from the dashboard;
      // self-edit is the exception that needs an explicit human grant.
      const owner = getDb().prepare('SELECT role FROM users WHERE id = ?').get(String(auth.created_by));
      if (owner?.role !== 'admin') { note.refused = true; return err('Only an admin-owned key can mint a self_edit key'); }
    }
    const plan = { name, scope: scope || 'unscoped (full admin surface, no self-editing)' };
    const d = dry(args, plan); if (d) return d;
    // A key inherits its owner from the key that mints it, and an ownerless
    // key never authenticates (routes/mcp.js findToken) — so refuse to mint
    // one at all rather than mint a dead key.
    const ownerId = String(auth.created_by || '').trim();
    if (!ownerId) { note.refused = true; return err('This key has no recorded owner, so it cannot mint another; mint from a key owned by a live admin (MCP Access page)'); }
    const gate = confirmFlag(args, note, `Mint MCP key "${name}" with scope ${JSON.stringify(scope || 'unscoped')}.`); if (gate) return gate;
    const token = mintMcpToken();
    const prefix = token.slice(0, 13);
    const info = getDb().prepare('INSERT INTO mcp_tokens (name, token_hash, created_by, created_at, scope_json, token_prefix) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, hashMcpToken(token), ownerId, new Date().toISOString(), scope ? JSON.stringify(scope) : null, prefix);
    note.subject_id = String(info.lastInsertRowid);
    note.summary = `minted MCP key ${name}`;
    note.detail = { scope: scope || null, prefix };
    const base = req ? ctx.publicBaseUrl(req) : '';
    return ok({ created: true, id: Number(info.lastInsertRowid), name, prefix, scope: scope || null, token, ...(base ? { endpoint: `${base}/api/mcp`, connector_url: `${base}/api/mcp/t/${token}` } : {}), note: 'Store the token now — it is shown once. A scoped key sees only the tools its scope allows in tools/list.' });
  });

  const revoke_mcp_key = mutation('revoke_mcp_key', { subjectType: 'mcp_token' }, async (args, auth, req, note) => {
    const id = intIn(args.id, 1, 1e9);
    if (!id) return err('id is required');
    note.subject_id = String(id);
    const row = getDb().prepare('SELECT * FROM mcp_tokens WHERE id = ?').get(id);
    if (!row) return err('No such key');
    if (row.revoked_at) return ok({ applied: false, key: keyShape(row), note: 'Already revoked.' });
    if (row.id === auth.id && args.allow_self !== true) { note.refused = true; return err('That is the key making this call — pass allow_self: true to revoke it anyway (this conversation loses access immediately).'); }
    const d = dry(args, { revoke: keyShape(row) }); if (d) return d;
    const gate = confirmFlag(args, note, `Revoke MCP key "${row.name}" (id ${id}); its clients are cut off immediately.`); if (gate) return gate;
    getDb().prepare('UPDATE mcp_tokens SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    note.summary = `revoked MCP key ${row.name}`;
    note.detail = { name: row.name };
    return ok({ revoked: true, key: { ...keyShape(row), revoked_at: new Date().toISOString() } });
  });

  /* ------------------------- settings / feature flags -------------------- */

  const get_settings = reader('get_settings', async (args) => {
    const keys = Array.isArray(args.keys) && args.keys.length ? args.keys.map(String) : [...policy.settings.writable, ...policy.settings.readable_extra, ...policy.settings.secret];
    const out = {};
    for (const k of keys) {
      if (policy.settings.secret.includes(k)) { out[k] = getSetting(k) ? '[set]' : '[unset]'; continue; }
      if (!policy.settings.writable.includes(k) && !policy.settings.readable_extra.includes(k)) { out[k] = '[not readable over MCP]'; continue; }
      out[k] = getSetting(k);
    }
    return ok({ settings: out, writable: policy.settings.writable });
  });

  const set_setting = mutation('set_setting', { subjectType: 'setting' }, async (args, auth, req, note) => {
    const key = String(args.key || '');
    note.subject_id = key;
    if (!policy.settings.writable.includes(key)) { note.refused = true; return err(`${key} is not writable over MCP. Writable: ${policy.settings.writable.join(', ')} (policy: mcp-extended-policy.json settings.writable)`); }
    if (args.value == null) return err('value is required (a string)');
    const value = String(args.value);
    if (value.length > 8192) return err('value is too long');
    if (key === 'tls_mode' && !['acme', 'manual'].includes(value)) return err("tls_mode must be 'acme' or 'manual'");
    if (key === 'github_repo' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return err('github_repo must be owner/name');
    if (key === 'dns01_domains') { try { if (!Array.isArray(JSON.parse(value))) throw new Error(); } catch { return err('dns01_domains must be a JSON array of domains'); } }
    if (key === 'mcp.standards_source_url' && !/^https:\/\/[^\s]+$/.test(value)) return err('mcp.standards_source_url must be an https URL');
    const current = getSetting(key);
    const d = dry(args, { key, current, value }); if (d) return d;
    const gate = confirmFlag(args, note, `Set ${key} = ${JSON.stringify(value)} (currently ${JSON.stringify(current)}).`); if (gate) return gate;
    setSetting(key, value);
    note.summary = `setting ${key} changed`;
    note.detail = { key, previous: current, value };
    return ok({ applied: true, key, previous: current, value, ...(key === 'tls_mode' ? { note: 'Apply it to Caddy with upload_cert / the TLS page — the mode alone does not re-render sites.' } : {}) });
  });

  const list_feature_flags = reader('list_feature_flags', async () => {
    const flags = Object.entries(policy.feature_flags).filter(([k]) => !k.startsWith('$')).map(([name, def]) => ({ name, enabled: flag(name), default: def.default !== false, description: def.description }));
    return ok({ flags });
  });

  const set_feature_flag = mutation('set_feature_flag', { subjectType: 'feature_flag' }, async (args, auth, req, note) => {
    const name = String(args.name || '');
    note.subject_id = name;
    if (!policy.feature_flags[name] || name.startsWith('$')) return err(`Unknown flag ${name}. list_feature_flags shows them.`);
    if (typeof args.enabled !== 'boolean') return err('enabled must be a boolean');
    const current = flag(name);
    const d = dry(args, { name, current, enabled: args.enabled }); if (d) return d;
    const gate = confirmFlag(args, note, `Turn ${name} ${args.enabled ? 'on' : 'off'} (currently ${current ? 'on' : 'off'}).`); if (gate) return gate;
    setFlag(name, args.enabled);
    note.summary = `flag ${name} ${args.enabled ? 'on' : 'off'}`;
    note.detail = { previous: current, enabled: args.enabled };
    return ok({ applied: true, name, previous: current, enabled: args.enabled });
  });

  /* ----------------------------- audit & ledger --------------------------- */

  const query_audit_log = reader('query_audit_log', async (args) => {
    const where = []; const params = [];
    if (args.action) { where.push('a.action LIKE ?'); params.push(String(args.action).replace(/\*/g, '%')); }
    if (args.resource_type) { where.push('a.resource_type = ?'); params.push(String(args.resource_type)); }
    if (args.resource_id != null) { where.push('a.resource_id = ?'); params.push(String(args.resource_id)); }
    if (args.user_id) { where.push('(a.user_id = ? OR u.username = ?)'); params.push(String(args.user_id), String(args.user_id)); }
    if (args.since) { where.push('a.created_at >= ?'); params.push(String(args.since)); }
    if (args.until) { where.push('a.created_at <= ?'); params.push(String(args.until)); }
    if (args.via === 'mcp') where.push("a.details LIKE '%\"via\":\"mcp\"%'");
    const limit = intIn(args.limit, 1, 500) || 100;
    const rows = getDb().prepare(`SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.created_at DESC LIMIT ?`).all(...params, limit);
    const entries = rows.map((r) => { let details = null; try { details = r.details ? JSON.parse(r.details) : null; } catch { details = r.details; } return { id: r.id, at: r.created_at, user_id: r.user_id, username: r.username, action: r.action, resource_type: r.resource_type, resource_id: r.resource_id, ip: r.ip_address, details }; });
    const ledger = args.include_ledger === true ? readLedger({ since: args.since || null, limit }) : undefined;
    return ok({ count: entries.length, entries, ...(ledger ? { mcp_ledger: ledger } : {}) });
  });

  /* ---------------------------- security scans --------------------------- */

  async function storeReport(kind, body, ext = 'txt') {
    await mkdir(REPORTS_DIR, { recursive: true });
    const id = `${kind}-${stamp()}`;
    const file = join(REPORTS_DIR, `${id}.${ext}`);
    await writeFile(file, body);
    return { id, file, sha256: sha256Hex(Buffer.from(body)) };
  }

  const run_lynis = mutation('run_lynis', { subjectType: 'host', flag: 'mcp.security_scans' }, async (args, auth, req, note) => {
    note.subject_id = 'lynis';
    if (!hasHostBinary('lynis')) { const probe = await runHostCapture('sh', ['-c', 'command -v lynis'], { timeoutMs: 5000 }); if (probe.status !== 0) return err('lynis is not installed on the host (apt-get install lynis). Nothing was run.'); }
    const d = dry(args, { run: 'lynis audit system --quick --no-colors', report: `${REPORTS_DIR}/lynis-<timestamp>.txt` }); if (d) return d;
    const gate = confirmFlag(args, note, 'Run a lynis system audit on the host (read-only, a few minutes).'); if (gate) return gate;
    const r = await runHostCapture('lynis', ['audit', 'system', '--quick', '--no-colors', '--nolog'], { timeoutMs: 20 * 60 * 1000, maxCapture: 8 * 1024 * 1024 });
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    const hardening = Number((text.match(/Hardening index\s*:\s*(\d+)/) || [])[1]) || null;
    const warnings = (text.match(/Warning:.*$/gm) || []).length;
    const suggestions = (text.match(/Suggestion:.*$/gm) || []).length;
    const stored = await storeReport('lynis', text);
    note.summary = `lynis audit: hardening ${hardening ?? '?'}, ${warnings} warnings`;
    note.detail = { report: stored.id, hardening_index: hardening, warnings, suggestions, exit: r.status };
    return ok({ ran: true, exit_code: r.status, hardening_index: hardening, warnings, suggestions, report: stored, tail: tail(text, 3000), next: `get_audit_report({ id: "${stored.id}" }) returns the full text.` });
  });

  const run_trivy = mutation('run_trivy', { subjectType: 'host', flag: 'mcp.security_scans' }, async (args, auth, req, note) => {
    note.subject_id = 'trivy';
    const probe = await runHostCapture('sh', ['-c', 'command -v trivy'], { timeoutMs: 5000 });
    if (probe.status !== 0) return err('trivy is not installed on the host (https://aquasecurity.github.io/trivy). Nothing was run.');
    const target = args.target === 'image' ? 'image' : args.target === 'fs' ? 'fs' : 'rootfs';
    const subject = target === 'image' ? String(args.image || 'proxypilot-proxypilot:latest') : String(args.path || '/');
    if (target !== 'image' && (!subject.startsWith('/') || subject.includes('..'))) return err('path must be an absolute host path');
    if (target === 'image' && !/^[A-Za-z0-9._\/:@-]+$/.test(subject)) return err('image must be an image reference');
    const severity = String(args.severity || 'HIGH,CRITICAL').toUpperCase();
    if (!/^(UNKNOWN|LOW|MEDIUM|HIGH|CRITICAL)(,(UNKNOWN|LOW|MEDIUM|HIGH|CRITICAL))*$/.test(severity)) return err('severity must be a comma list of LOW, MEDIUM, HIGH, CRITICAL');
    const d = dry(args, { run: `trivy ${target} --format json --severity ${severity} ${subject}` }); if (d) return d;
    const gate = confirmFlag(args, note, `Run trivy ${target} on ${subject} (severity ${severity}).`); if (gate) return gate;
    const r = await runHostCapture('trivy', [target, '--format', 'json', '--severity', severity, '--quiet', subject], { timeoutMs: 30 * 60 * 1000, maxCapture: 32 * 1024 * 1024 });
    if (r.status !== 0 && !r.stdout) return err(`trivy failed: ${tail(r.stderr, 800)}`);
    let parsed = null; try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
    const counts = {};
    let total = 0;
    for (const res of parsed?.Results || []) for (const v of res.Vulnerabilities || []) { counts[v.Severity] = (counts[v.Severity] || 0) + 1; total += 1; }
    const stored = await storeReport('trivy', r.stdout || '', 'json');
    note.summary = `trivy ${target} ${subject}: ${total} findings`;
    note.detail = { report: stored.id, counts, target, subject };
    return ok({ ran: true, target, subject, severity, findings: total, by_severity: counts, report: stored, top: (parsed?.Results || []).flatMap((res) => (res.Vulnerabilities || []).slice(0, 5).map((v) => ({ id: v.VulnerabilityID, pkg: v.PkgName, installed: v.InstalledVersion, fixed: v.FixedVersion || null, severity: v.Severity, title: (v.Title || '').slice(0, 120) }))).slice(0, 25), ...(parsed ? {} : { warning: 'trivy output was not JSON; the raw report was stored.' }) });
  });

  const get_audit_report = reader('get_audit_report', async (args) => {
    let files = [];
    try { files = (await readdir(REPORTS_DIR)).filter((f) => /^(lynis|trivy)-\d{8}T\d{6}Z\.(txt|json)$/.test(f)).sort().reverse(); } catch { files = []; }
    if (args.list === true || (!args.id && !files.length)) return ok({ reports: files.map((f) => ({ id: f.replace(/\.(txt|json)$/, ''), file: join(REPORTS_DIR, f) })), ...(files.length ? {} : { note: 'No reports yet — run_lynis or run_trivy produces one.' }) });
    const id = args.id ? String(args.id) : files[0].replace(/\.(txt|json)$/, '');
    const file = files.find((f) => f.startsWith(`${id}.`));
    if (!file || !/^(lynis|trivy)-\d{8}T\d{6}Z$/.test(id)) return err('Unknown report id (get_audit_report({ list: true }))');
    const body = await readFile(join(REPORTS_DIR, file), 'utf8');
    const max = intIn(args.max_bytes, 1024, 4 * 1024 * 1024) || 256 * 1024;
    return ok({ id, file: join(REPORTS_DIR, file), bytes: Buffer.byteLength(body), sha256: sha256Hex(Buffer.from(body)), truncated: body.length > max, content: body.slice(-max) });
  });

  const export_grc_evidence = mutation('export_grc_evidence', { subjectType: 'host' }, async (args, auth, req, note) => {
    note.subject_id = 'grc';
    const since = args.since ? String(args.since) : new Date(Date.now() - 90 * 86400 * 1000).toISOString();
    const db = getDb();
    const q = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch { return []; } };
    const evidence = {
      generated_at: new Date().toISOString(), since, generated_by: `mcp:${auth.created_by}`, host: process.env.HOSTNAME || null,
      version: getSetting('installed_version') || null,
      users: q('SELECT id, username, role, auth_source, is_superadmin, totp_enabled, created_at, updated_at FROM users'),
      passkeys: q('SELECT user_id, COUNT(*) AS count FROM webauthn_credentials GROUP BY user_id'),
      mcp_keys: q('SELECT id, name, created_by, created_at, last_used_at, revoked_at, scope_json FROM mcp_tokens'),
      audit_log: q('SELECT id, user_id, action, resource_type, resource_id, details, ip_address, created_at FROM audit_log WHERE created_at >= ? ORDER BY created_at', since),
      mcp_ledger: readLedger({ since, limit: 1000 }),
      backups: q('SELECT id, tier, status, created_at, size_bytes FROM backups WHERE created_at >= ? ORDER BY created_at', since),
      backup_schedules: q('SELECT id, name, tier, cron_expr, enabled FROM backup_schedules'),
      certificates: q('SELECT id, label, covered_names, not_before, not_after, created_at FROM tls_certificates'),
      routes: q('SELECT r.domain, r.path_prefix, r.ssl_enabled, r.force_https, s.name AS service FROM service_http_routes r JOIN services s ON s.id = r.service_id'),
      notification_channels: q('SELECT kind, enabled, test_status, test_at FROM notification_channels'),
      feature_flags: Object.keys(policy.feature_flags).filter((k) => !k.startsWith('$')).map((name) => ({ name, enabled: flag(name) })),
      security_reports: [],
    };
    try { evidence.security_reports = (await readdir(REPORTS_DIR)).filter((f) => /^(lynis|trivy)-/.test(f)).sort().slice(-20); } catch { /* none */ }
    let update = null; try { update = await selfUpdateStatus({ logTailBytes: 0 }); } catch { update = null; }
    evidence.last_update = update ? { status: update.status, id: update.id || null, finished_at: update.finished_at || null } : null;
    // Storage freshness: pool health + last scrub, per-guest snapshot age, replication, SMART, the storage ops ledger.
    const ms = managedStorage();
    evidence.storage = ms ? await ms.svc.evidence() : null;
    const body = JSON.stringify(evidence, null, 2);
    const plan = { since, sections: Object.keys(evidence), bytes: Buffer.byteLength(body), into: `${GRC_DIR}/evidence-<timestamp>.json` };
    const d = dry(args, plan); if (d) return d;
    await mkdir(GRC_DIR, { recursive: true });
    const file = join(GRC_DIR, `evidence-${stamp()}.json`);
    await writeFile(file, body);
    const sha = sha256Hex(Buffer.from(body));
    note.summary = `GRC evidence bundle ${basename(file)}`;
    note.detail = { file, sha256: sha, since, audit_rows: evidence.audit_log.length, ledger_rows: evidence.mcp_ledger.length };
    return ok({ exported: true, file, sha256: sha, bytes: plan.bytes, since, counts: { users: evidence.users.length, audit_log: evidence.audit_log.length, mcp_ledger: evidence.mcp_ledger.length, backups: evidence.backups.length, certificates: evidence.certificates.length, routes: evidence.routes.length }, ...(args.inline === true ? { evidence } : { note: 'Pass inline: true to receive the bundle in the response as well.' }) });
  });

  /* --------------------------- proxypilot DB backups --------------------- */

  const DB_BACKUP_DIR = () => join(dbPath.replace(/\/[^/]+$/, ''), 'backups');

  const backup_proxypilot_db = mutation('backup_proxypilot_db', { subjectType: 'host' }, async (args, auth, req, note) => {
    note.subject_id = 'proxypilot.db';
    const dir = DB_BACKUP_DIR();
    const label = args.label ? String(args.label).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40) : 'mcp';
    const file = join(dir, `proxypilot-${label}-${stamp()}.db`);
    const d = dry(args, { file, method: 'sqlite VACUUM INTO (consistent snapshot of the live database)' }); if (d) return d;
    await mkdir(dir, { recursive: true });
    getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const st = await stat(file);
    const sha = sha256Hex(await readFile(file));
    note.snapshot = file;
    note.summary = `backed up proxypilot.db to ${basename(file)}`;
    note.detail = { file, bytes: st.size, sha256: sha };
    return ok({ backed_up: true, file, bytes: st.size, sha256: sha, note: 'This is the dashboard database only (the same directory update.sh uses for pre-update backups). Full-install backups with S3 fan-out are the Backups page / config tier.' });
  });

  const restore_proxypilot_db = mutation('restore_proxypilot_db', { subjectType: 'host', flag: 'mcp.host_control' }, async (args, auth, req, note) => {
    note.subject_id = 'proxypilot.db';
    const dir = DB_BACKUP_DIR();
    const file = pathUnder(dir, basename(String(args.file || '')));
    if (!file || !/\.(db|bak|sqlite)$/.test(file)) return err(`file must name a backup inside ${dir} (backup_proxypilot_db or update.sh wrote it)`);
    let st; try { st = await stat(file); } catch { return err(`No such backup: ${file}`); }
    const db = getDb();
    let check;
    try {
      db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS pp_restore_src`);
      check = db.prepare('PRAGMA pp_restore_src.integrity_check').get();
    } catch (e) { return err(`Could not open the backup: ${e?.message || e}`); }
    const integrity = check ? Object.values(check)[0] : 'unknown';
    if (integrity !== 'ok') { db.exec('DETACH DATABASE pp_restore_src'); return err(`Backup fails integrity_check: ${integrity}`); }
    const srcTables = db.prepare("SELECT name FROM pp_restore_src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    const dstTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name));
    const common = srcTables.filter((t) => dstTables.has(t) && t !== 'schema_migrations');
    const plan = { file, bytes: st.size, tables_restored: common, tables_skipped: srcTables.filter((t) => !dstTables.has(t)), pre_restore_backup: `${dir}/proxypilot-pre-restore-<timestamp>.db`, method: 'per-table replace inside one transaction (common columns only); schema_migrations untouched' };
    if (args.dry_run === true) { db.exec('DETACH DATABASE pp_restore_src'); return dry(args, plan); }
    const gate = confirmToken(args, auth, note, { tool: 'restore_proxypilot_db', subject: basename(file), action: `replace the live dashboard database contents with ${basename(file)} (${common.length} tables)`, preview: plan });
    if (gate) { db.exec('DETACH DATABASE pp_restore_src'); return gate; }
    const pre = join(dir, `proxypilot-pre-restore-${stamp()}.db`);
    db.exec(`VACUUM INTO '${pre.replace(/'/g, "''")}'`);
    note.snapshot = pre;
    const restored = [];
    try {
      db.pragma('foreign_keys = OFF');
      const tx = db.transaction(() => {
        for (const t of common) {
          const dstCols = db.prepare(`PRAGMA main.table_info("${t}")`).all().map((c) => c.name);
          const srcCols = new Set(db.prepare(`PRAGMA pp_restore_src.table_info("${t}")`).all().map((c) => c.name));
          const cols = dstCols.filter((c) => srcCols.has(c));
          if (!cols.length) continue;
          const list = cols.map((c) => `"${c}"`).join(', ');
          db.prepare(`DELETE FROM main."${t}"`).run();
          const n = db.prepare(`INSERT INTO main."${t}" (${list}) SELECT ${list} FROM pp_restore_src."${t}"`).run().changes;
          restored.push({ table: t, rows: n });
        }
      });
      tx();
    } catch (e) {
      db.pragma('foreign_keys = ON');
      db.exec('DETACH DATABASE pp_restore_src');
      return err(`Restore failed and was rolled back: ${e?.message || e}. Pre-restore backup at ${pre}.`);
    }
    db.pragma('foreign_keys = ON');
    db.exec('DETACH DATABASE pp_restore_src');
    note.summary = `restored proxypilot.db from ${basename(file)}`;
    note.detail = { file, tables: restored.length, pre_restore_backup: pre };
    return ok({ restored: true, file, pre_restore_backup: pre, tables: restored, note: 'Sessions and caches may now be stale — expect to sign in again. Reverse with restore_proxypilot_db on the pre-restore backup.' });
  });

  /* ------------------------------ host snapshots -------------------------- */

  // The managed ZFS pool (Storage page / create_zpool), when one is recorded:
  // host snapshots then mean its datasets, not the root filesystem.
  function managedStorage() {
    try { const svc = typeof ctx.storage === 'function' ? ctx.storage() : ctx.storage; return svc ? { svc, managed: svc.managed() } : null; } catch { return null; }
  }

  async function hostFs() {
    const r = await hostSh('findmnt -no FSTYPE,SOURCE / ; findmnt -no FSTYPE,SOURCE /var/lib/proxypilot 2>/dev/null || true', [], { timeoutMs: 10000 });
    const [root, data] = (r.stdout || '').trim().split('\n');
    const parse = (l) => { const [fs, src] = (l || '').trim().split(/\s+/); return { fs: fs || null, source: src || null }; };
    return { root: parse(root), data: parse(data) };
  }

  const list_host_snapshots = reader('list_host_snapshots', async () => {
    const fs = await hostFs();
    const out = { filesystems: fs, snapshots: [] };
    const ms = managedStorage();
    if (ms?.managed) {
      const d = await ms.svc.host.datasets();
      const roots = Object.values(ms.managed.datasets);
      out.managed_pool = ms.managed;
      out.snapshots = d.snapshots.filter((s) => roots.some((r) => s.dataset === r || s.dataset.startsWith(`${r}/`))).map((s) => ({ kind: 'zfs', name: s.name, dataset: s.dataset, creation: s.created_at, used: s.used_bytes, made_by: s.kind }));
      out.note = `Snapshots of the managed pool ${ms.managed.pool} (incus, backups, exports datasets). list_zfs_snapshots filters by guest; create_host_snapshot snapshots the backups dataset.`;
      return ok(out);
    }
    if (fs.root.fs === 'btrfs' || fs.data.fs === 'btrfs') {
      const r = await hostSh('btrfs subvolume list -s / 2>/dev/null || true', [], { timeoutMs: 20000 });
      out.snapshots = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => ({ kind: 'btrfs', line: l, path: (l.match(/path (\S+)$/) || [])[1] || null }));
      out.btrfs_snapshot_root = '/.proxypilot-snapshots';
    } else if (fs.root.fs === 'zfs' || fs.data.fs === 'zfs') {
      const r = await hostSh('zfs list -H -t snapshot -o name,creation,used 2>/dev/null || true', [], { timeoutMs: 20000 });
      out.snapshots = (r.stdout || '').trim().split('\n').filter(Boolean).map((l) => { const [name, creation, used] = l.split('\t'); return { kind: 'zfs', name, creation, used }; });
    } else {
      out.note = `Host snapshots need btrfs or zfs; / is ${fs.root.fs || 'unknown'}. Use backup_proxypilot_db and the Backups page instead.`;
    }
    return ok(out);
  });

  const create_host_snapshot = mutation('create_host_snapshot', { subjectType: 'host', flag: 'mcp.host_control' }, async (args, auth, req, note) => {
    note.subject_id = 'host';
    const fs = await hostFs();
    const label = String(args.label || 'mcp').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
    const name = `pp-${label}-${stamp()}`;
    let plan;
    const ms = managedStorage();
    const target = args.dataset ? String(args.dataset) : null;
    if (ms?.managed && (!target || Object.values(ms.managed.datasets).some((r) => target === r || target.startsWith(`${r}/`)))) {
      const ds = target || ms.managed.datasets.backups;
      plan = { kind: 'zfs', command: `zfs snapshot -r ${ds}@${name}`, dataset: ds, recursive: true, managed_pool: ms.managed.pool };
    } else if (target) return err(`dataset ${target} is not under the managed pool — use zfs_snapshot for arbitrary datasets`);
    else if (fs.data.fs === 'zfs' && fs.data.source) plan = { kind: 'zfs', command: `zfs snapshot ${fs.data.source}@${name}`, dataset: fs.data.source };
    else if (fs.root.fs === 'zfs' && fs.root.source) plan = { kind: 'zfs', command: `zfs snapshot ${fs.root.source}@${name}`, dataset: fs.root.source };
    else if (fs.root.fs === 'btrfs' || fs.data.fs === 'btrfs') {
      const subvol = fs.data.fs === 'btrfs' ? '/var/lib/proxypilot' : '/';
      plan = { kind: 'btrfs', command: `btrfs subvolume snapshot -r ${subvol} /.proxypilot-snapshots/${name}`, subvolume: subvol };
    } else return err(`Host snapshots need btrfs or zfs; / is ${fs.root.fs || 'unknown'}. backup_proxypilot_db and the Backups page are the alternatives.`);
    const d = dry(args, { name, ...plan }); if (d) return d;
    const gate = confirmFlag(args, note, `Take a read-only ${plan.kind} snapshot ${name}.`); if (gate) return gate;
    const r = plan.kind === 'zfs'
      ? await runHostCapture('zfs', ['snapshot', ...(plan.recursive ? ['-r'] : []), `${plan.dataset}@${name}`], { timeoutMs: 60000 })
      : await hostSh('mkdir -p /.proxypilot-snapshots && btrfs subvolume snapshot -r "$1" "/.proxypilot-snapshots/$2"', [plan.subvolume, name], { timeoutMs: 120000 });
    if (r.status !== 0) return err(`${plan.kind} snapshot failed: ${tail(r.stderr)}`);
    note.snapshot = name;
    note.summary = `host snapshot ${name}`;
    note.detail = plan;
    return ok({ created: true, name, ...plan, note: plan.managed_pool ? 'Roll back with zfs_rollback (datasets) or rollback_guest_dataset (guests); restore_guest_from_snapshot clones a guest out of it.' : 'Restoring a host snapshot is a hands-on host operation (zfs rollback / btrfs subvolume swap) — deliberately not offered over MCP.' });
  });

  /* ------------------------------- host control --------------------------- */

  function hostUnitRule(unit) {
    for (const [pattern, actions] of Object.entries(policy.host_services)) {
      if (pattern.startsWith('$')) continue;
      const base = pattern.replace(/\.(service|timer|socket|path)$/, '');
      const u = unit.replace(/\.(service|timer|socket|path)$/, '');
      if (pattern.endsWith('@*') ? u.startsWith(base.slice(0, -1)) : (u === base || unit === pattern)) return actions;
    }
    return null;
  }

  const get_host_services = reader('get_host_services', async (args) => {
    const r = await runHostCapture('systemctl', ['list-units', '--type=service,timer', '--all', '--no-pager', '--plain', '--output=json'], { timeoutMs: 30000, maxCapture: 4 * 1024 * 1024 });
    let units = parseSystemctlUnits(r.stdout);
    if (!units.length) {
      const r2 = await runHostCapture('systemctl', ['list-units', '--type=service,timer', '--all', '--no-pager', '--plain', '--no-legend'], { timeoutMs: 30000, maxCapture: 4 * 1024 * 1024 });
      units = parseSystemctlUnits(r2.stdout);
    }
    const filter = args.filter ? String(args.filter).toLowerCase() : null;
    const onlyFailed = args.failed === true;
    const out = units.filter((u) => (!filter || u.unit.toLowerCase().includes(filter)) && (!onlyFailed || u.active === 'failed')).map((u) => ({ ...u, controllable: hostUnitRule(u.unit) || null }));
    return ok({ count: out.length, units: args.managed_only === true ? out.filter((u) => u.controllable) : out.slice(0, intIn(args.limit, 1, 1000) || 300), managed_units: Object.keys(policy.host_services).filter((k) => !k.startsWith('$')) });
  });

  const host_service_control = mutation('host_service_control', { subjectType: 'host', flag: 'mcp.host_control' }, async (args, auth, req, note) => {
    const unit = String(args.unit || '');
    if (!UNIT_NAME_RE.test(unit) || unit.length > 120) return err('unit is required');
    note.subject_id = unit;
    const action = String(args.action || 'status');
    const allowed = hostUnitRule(unit);
    if (!allowed) { note.refused = true; return err(`${unit} is not a host unit MCP may control. Managed units: ${Object.keys(policy.host_services).filter((k) => !k.startsWith('$')).join(', ')} (policy: mcp-extended-policy.json host_services)`); }
    if (!allowed.includes(action)) { note.refused = true; return err(`${action} is not allowed on ${unit} over MCP (allowed: ${allowed.join(', ')})`); }
    if (action !== 'status') {
      const d = dry(args, { unit, action }); if (d) return d;
      const gate = confirmFlag(args, note, `systemctl ${action} ${unit} on the HOST.${/^docker/.test(unit) ? ' Restarting docker restarts this backend — the call may not return.' : ''}`); if (gate) return gate;
    }
    const r = await runHostCapture('systemctl', ['--no-pager', '--full', action, unit], { timeoutMs: 120000 });
    const st = await runHostCapture('systemctl', ['is-active', unit], { timeoutMs: 15000 });
    if (action !== 'status') { note.summary = `systemctl ${action} ${unit} on host`; note.detail = { unit, action, active: (st.stdout || '').trim() }; }
    return ok({ unit, action, exit_code: r.status, ok: r.status === 0, active: (st.stdout || '').trim() || null, output: tail(`${r.stdout || ''}\n${r.stderr || ''}`, 6000) });
  });

  const list_host_packages = reader('list_host_packages', async (args) => {
    const upgradable = args.upgradable === true;
    const filter = args.filter ? String(args.filter).toLowerCase() : null;
    const limit = intIn(args.limit, 1, 5000) || 500;
    if (upgradable) {
      const r = await runHostCapture('apt', ['list', '--upgradable'], { timeoutMs: 60000, maxCapture: 4 * 1024 * 1024 });
      if (r.status !== 0 && !r.stdout) return err(`apt list failed: ${tail(r.stderr)}`);
      const rows = parseAptUpgradable(r.stdout).filter((p) => !filter || p.name.includes(filter));
      return ok({ upgradable: true, count: rows.length, packages: rows.slice(0, limit), note: 'Package upgrades stay a host operation (unattended-upgrades or a shell) — no MCP verb installs on the host.' });
    }
    const r = await runHostCapture('dpkg-query', ['-W', '-f', '${binary:Package}\\t${Version}\\t${Status}\\n'], { timeoutMs: 60000, maxCapture: 8 * 1024 * 1024 });
    if (r.status !== 0) return err(`dpkg-query failed: ${tail(r.stderr)} (not a Debian/Ubuntu host?)`);
    const rows = parseDpkgList(r.stdout).filter((p) => !filter || p.name.includes(filter));
    return ok({ upgradable: false, total: rows.length, packages: rows.slice(0, limit), truncated: rows.length > limit });
  });

  const reboot_host = mutation('reboot_host', { subjectType: 'host', flag: 'mcp.host_control' }, async (args, auth, req, note) => {
    note.subject_id = 'host';
    const blockers = [];
    try { const u = await selfUpdateStatus({ logTailBytes: 0 }); if (['queued', 'running'].includes(u?.status)) blockers.push(`an update is ${u.status}`); } catch { /* unreachable agent is not a blocker */ }
    if (mock2Enabled()) { try { const m = await mock2Modules(); const n = m.cycles.countRunningCycles(); if (n > 0) blockers.push(`${n} build(s) running`); } catch { /* ignore */ } }
    if (listBackupsRunning) { try { const n = listBackupsRunning(); if (n > 0) blockers.push(`${n} backup(s) running`); } catch { /* ignore */ } }
    if (blockers.length) { note.refused = true; return err(`Refusing to reboot: ${blockers.join(', ')}. Wait for them to finish.`); }
    const delay = intIn(args.delay_minutes, 0, 60) ?? policy.reboot.delay_minutes;
    const plan = { command: `shutdown -r +${delay} "${'ProxyPilot MCP reboot'}"`, delay_minutes: delay, guests: 'Incus autostart brings guests back; routes and certs are on disk' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'reboot_host', subject: 'host', action: `reboot the whole host in ${delay} minute(s)`, preview: plan });
    if (gate) return gate;
    const r = await runHostCapture('shutdown', ['-r', `+${delay}`, 'ProxyPilot MCP reboot'], { timeoutMs: 15000 });
    if (r.status !== 0) return err(`shutdown failed: ${tail(r.stderr)}`);
    note.summary = `host reboot scheduled in ${delay} min`;
    note.detail = plan;
    return ok({ scheduled: true, ...plan, cancel: 'shutdown -c on the host cancels it before the deadline', note: 'The API goes away at the deadline and returns once the host is back; poll check_proxypilot_update or list_lxc_containers.' });
  });

  /* -------------------------------- webhooks ------------------------------ */

  const hookShape = (r) => ({ id: r.id, name: r.name, url: r.url, events: JSON.parse(r.events_json || '["*"]'), enabled: !!r.enabled, has_secret: !!r.secret_enc, created_at: r.created_at, updated_at: r.updated_at, last_status: r.last_status, last_error: r.last_error, last_at: r.last_at });

  const list_webhooks = reader('list_webhooks', async () => {
    const rows = getDb().prepare('SELECT * FROM notification_webhooks ORDER BY id').all();
    return ok({ webhooks: rows.map(hookShape), events: ['*', 'build.finished', 'build.failed', 'cert.expiring', 'backup.finished', 'backup.failed', 'update.finished', 'security.finding', 'notification'], note: 'Deliveries are JSON POSTs signed with X-ProxyPilot-Signature (HMAC-SHA256 of the body with the secret) when a secret is set.' });
  });

  const set_webhook = mutation('set_webhook', { subjectType: 'webhook', flag: 'mcp.webhooks' }, async (args, auth, req, note) => {
    const name = String(args.name || '').trim().slice(0, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(name)) return err('name is required (letters, digits, space . _ -)');
    note.subject_id = name;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM notification_webhooks WHERE name = ?').get(name);
    const action = args.action === 'delete' ? 'delete' : args.action === 'test' ? 'test' : 'upsert';
    if (action === 'delete') {
      if (!existing) return err('No webhook with that name');
      const d = dry(args, { delete: hookShape(existing) }); if (d) return d;
      const gate = confirmFlag(args, note, `Delete webhook "${name}".`); if (gate) return gate;
      db.prepare('DELETE FROM notification_webhooks WHERE id = ?').run(existing.id);
      note.summary = `deleted webhook ${name}`;
      return ok({ deleted: true, webhook: hookShape(existing) });
    }
    if (action === 'test') {
      if (!existing) return err('No webhook with that name');
      const result = await deliverWebhook(existing, { event: 'test', title: 'ProxyPilot webhook test', body: `Sent from MCP by ${auth.created_by}`, at: new Date().toISOString() });
      db.prepare('UPDATE notification_webhooks SET last_status = ?, last_error = ?, last_at = ? WHERE id = ?').run(result.ok ? 'ok' : 'fail', result.error || null, new Date().toISOString(), existing.id);
      note.summary = `tested webhook ${name}`;
      note.detail = { ok: result.ok, status: result.status || null };
      return ok({ tested: true, ...result });
    }
    const url = args.url != null ? String(args.url).trim() : existing?.url;
    if (!url || !/^https:\/\/[^\s]+$/.test(url)) return err('url must be an https URL');
    let events = existing ? JSON.parse(existing.events_json || '["*"]') : ['*'];
    if (args.events !== undefined) {
      if (!Array.isArray(args.events) || !args.events.length || !args.events.every((e) => /^[a-z*][a-z0-9_.*-]{0,40}$/.test(String(e)))) return err('events must be a non-empty array of event names ("*" for all)');
      events = [...new Set(args.events.map(String))];
    }
    const enabled = args.enabled === undefined ? (existing ? !!existing.enabled : true) : !!args.enabled;
    const plan = { name, url, events, enabled, secret: args.secret !== undefined ? (args.secret ? 'set' : 'cleared') : (existing?.secret_enc ? 'kept' : 'none'), ...(existing ? { replaces: hookShape(existing) } : {}) };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `${existing ? 'Update' : 'Create'} webhook "${name}" → ${url} for ${events.join(', ')}.`); if (gate) return gate;
    const now = new Date().toISOString();
    const secretEnc = args.secret !== undefined ? (args.secret ? encryptSecret(String(args.secret)) : null) : (existing?.secret_enc ?? null);
    if (existing) {
      db.prepare('UPDATE notification_webhooks SET url = ?, secret_enc = ?, events_json = ?, enabled = ?, updated_at = ? WHERE id = ?').run(url, secretEnc, JSON.stringify(events), enabled ? 1 : 0, now, existing.id);
    } else {
      db.prepare('INSERT INTO notification_webhooks (name, url, secret_enc, events_json, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(name, url, secretEnc, JSON.stringify(events), enabled ? 1 : 0, String(auth.created_by || ''), now, now);
    }
    const row = db.prepare('SELECT * FROM notification_webhooks WHERE name = ?').get(name);
    note.subject_id = String(row.id);
    note.summary = `${existing ? 'updated' : 'created'} webhook ${name}`;
    note.detail = { url, events, enabled };
    return ok({ applied: true, webhook: hookShape(row), next: `set_webhook({ name: "${name}", action: "test" }) sends a signed test delivery.` });
  });

  return {
    list_users, create_user, set_role, disable_user, reset_passkey,
    list_mcp_keys, create_scoped_key, revoke_mcp_key,
    get_settings, set_setting, list_feature_flags, set_feature_flag,
    query_audit_log, run_lynis, run_trivy, get_audit_report, export_grc_evidence,
    backup_proxypilot_db, restore_proxypilot_db, list_host_snapshots, create_host_snapshot,
    get_host_services, host_service_control, list_host_packages, reboot_host,
    list_webhooks, set_webhook,
  };
}

/** POST one event to a webhook row. Exported so lib/notification-dispatch.js fans out through the same code. */
export async function deliverWebhook(row, payload) {
  const body = JSON.stringify({ ...payload, webhook: row.name, source: 'proxypilot' });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'ProxyPilot-Webhook', 'X-ProxyPilot-Event': String(payload.event || 'notification') };
  if (row.secret_enc) {
    try { headers['X-ProxyPilot-Signature'] = `sha256=${createHmac('sha256', decryptSecret(row.secret_enc)).update(body).digest('hex')}`; } catch { /* undecryptable secret: send unsigned, report it */ headers['X-ProxyPilot-Signature'] = 'unavailable'; }
  }
  try {
    const res = await fetch(row.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000), redirect: 'manual' });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status };
  } catch (e) { return { ok: false, error: e?.message || 'delivery failed' }; }
}
