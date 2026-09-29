import { randomUUID } from 'node:crypto';

// Operations activation (user decision, 2026-09-29): dashboard toggles, not
// environment variables. Three switches, each requiring the one before it:
//   operations       Operations itself (guides, review, manual work records)
//   agents_metadata  project discovery, site and agent profiles (A2)
//   agent_runs       the supervision UI for agent runs (A6)
// All are OFF until an administrator turns them on. The only writer is
// setOperationsToggle(): an administrator (role re-read from the database),
// behind sudo on the route, audited in the same transaction. The rows live
// under their own `operations_toggle:` keys, outside the MCP `set_setting`
// allowlist and the MCP feature-flag policy, so no MCP client can change them.
// Turning agent runs on does not configure execution: without the supervisor
// socket, key and VM (A8) every execution control still refuses.
export const TOGGLE_AUDIT_ACTION = 'OPERATIONS_TOGGLE_CHANGED';
export const OPERATIONS_TOGGLES = Object.freeze({
  operations: Object.freeze({ requires: [], label: 'Operations',
    description: 'Private guides, independent review and manual work records.' }),
  agents_metadata: Object.freeze({ requires: ['operations'], label: 'Agent metadata',
    description: 'Project discovery, the project site and agent profiles. Configuration only.' }),
  agent_runs: Object.freeze({ requires: ['operations', 'agents_metadata'], label: 'Agent runs',
    description: 'The supervision UI: start, watch, approve and stop agent runs. Execution also needs the worker supervisor configured.' }),
});
const NAMES = Object.keys(OPERATIONS_TOGGLES);
const key = name => `operations_toggle:${name}`;
const has = (db, table) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Stored values, before dependencies. Anything but an explicit on is off.
export function storedToggles(db) {
  const out = Object.fromEntries(NAMES.map(name => [name, false]));
  if (!has(db, 'app_settings')) return out;
  for (const name of NAMES) {
    const value = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key(name))?.value;
    out[name] = value === '1';
  }
  return out;
}

// What is actually on: a toggle counts only while every toggle it requires is on.
export function effectiveToggles(db) {
  const stored = storedToggles(db);
  return Object.fromEntries(NAMES.map(name => [name,
    stored[name] && OPERATIONS_TOGGLES[name].requires.every(required => stored[required])]));
}

function lastChange(db, name) {
  if (!has(db, 'audit_log')) return null;
  const row = db.prepare(`SELECT a.user_id, a.details, a.created_at, u.username FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
    WHERE a.action=? AND a.resource_type='operations_toggle' AND a.resource_id=? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`)
    .get(TOGGLE_AUDIT_ACTION, name);
  if (!row) return null;
  let details = {};
  try { details = JSON.parse(row.details || '{}'); } catch { details = {}; }
  return { by: { id: row.user_id, username: row.username ?? null }, at: row.created_at, enabled: details.enabled ?? null };
}

export function toggleState(db) {
  const stored = storedToggles(db), effective = effectiveToggles(db);
  return { toggles: NAMES.map(name => ({ name, ...OPERATIONS_TOGGLES[name], requires: [...OPERATIONS_TOGGLES[name].requires],
    stored: stored[name], effective: effective[name],
    blocked_by: OPERATIONS_TOGGLES[name].requires.filter(required => !stored[required]),
    last_change: lastChange(db, name) })) };
}

// The ONLY writer. Turning a toggle on needs the ones it requires on first;
// turning one off leaves the others as stored (they stop counting while it is off).
export function setOperationsToggle(db, name, enabled, user, ip = null) {
  if (!NAMES.includes(name)) fail(404, 'Unknown Operations toggle.');
  if (typeof enabled !== 'boolean') fail(400, 'enabled must be true or false.');
  const role = user?.id ? db.prepare('SELECT role FROM users WHERE id=?').get(user.id)?.role : null;
  if (role !== 'admin') fail(403, 'Only an administrator can change Operations settings.');
  const stored = storedToggles(db);
  const missing = OPERATIONS_TOGGLES[name].requires.filter(required => !stored[required]);
  if (enabled && missing.length)
    fail(409, `Turn on ${missing.map(required => OPERATIONS_TOGGLES[required].label).join(' and ')} first.`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key(name), enabled ? '1' : '0');
    db.prepare('INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), user.id, TOGGLE_AUDIT_ACTION, 'operations_toggle', name,
        JSON.stringify({ toggle: name, previous: stored[name], enabled, via: 'dashboard' }), ip);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return toggleState(db);
}
