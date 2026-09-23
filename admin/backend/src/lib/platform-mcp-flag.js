// The mcp.platform master flag (Part 1).
//
// It gates EVERY Platform MCP tool, the readers included; mcp.destructive and
// mcp.platform.purge only take effect behind it. It is HUMAN-ONLY: the MCP
// tool set_feature_flag refuses to change it in either direction (an MCP
// client can never re-enable its own access), and the only writer is the
// admin-only dashboard toggle through setPlatformFlag() below, which writes
// the audit entry (who, old, new, when) that the Platform section and
// export_grc_evidence read back. Turning it off never touches queued or
// running platform jobs; it only stops new MCP calls. Dashboard actions are
// not gated by it.
//
// Storage is the same app_settings row every feature flag uses
// (feature_flag:<name>), read with the policy default when absent.

import { readFileSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

export const PLATFORM_FLAG = 'mcp.platform';
export const PURGE_FLAG = 'mcp.platform.purge';
export const DESTRUCTIVE_FLAG = 'mcp.destructive';
export const FLAG_AUDIT_ACTION = 'FEATURE_FLAG_CHANGED';
export const PLATFORM_JOB_APPS = Object.freeze(['pp-full-platform', 'pp-platform-keycloak', 'pp-platform-pomerium', 'pp-platform-infisical', 'pp-platform-openbao', 'pp-platform-vaultwarden', 'proxypilot-sso', 'pp-platform-networks', 'pp-platform-reset-routes']);
export const WHERE_TO_ENABLE = 'An administrator turns it on in the dashboard: Platform Setup → the Platform MCP access switch at the top of the Platform section. It cannot be changed over MCP.';

let policyCache = null;
export function flagPolicy() {
  if (!policyCache) policyCache = JSON.parse(readFileSync(new URL('./mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8')).feature_flags;
  return policyCache;
}
export const isHumanOnlyFlag = (name) => flagPolicy()[name]?.human_only === true;

const has = (db, t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);

export function readFlag(db, name) {
  const v = has(db, 'app_settings') ? db.prepare('SELECT value FROM app_settings WHERE key=?').get(`feature_flag:${name}`)?.value : null;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return flagPolicy()[name]?.default !== false;
}

/** The refusal text every gated platform tool returns when the master flag is off. */
export function platformFlagRefusal() {
  return `The feature flag ${PLATFORM_FLAG} is off on this install, so every Platform MCP tool refuses before doing any work. ${WHERE_TO_ENABLE}`;
}

/** Last recorded change of one flag, from the audit log. */
export function lastFlagChange(db, name) {
  if (!has(db, 'audit_log')) return null;
  const row = db.prepare(`SELECT a.user_id, a.details, a.created_at, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.resource_type='feature_flag' AND a.resource_id=? AND a.action IN (?, 'MCP_SET_FEATURE_FLAG') ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`).get(name, FLAG_AUDIT_ACTION);
  if (!row) return null;
  let d = {}; try { d = JSON.parse(row.details || '{}'); } catch { d = {}; }
  return { by: row.user_id ? { id: row.user_id, username: row.username || null } : { id: null, username: d.via || 'system' }, at: row.created_at, previous: d.previous ?? null, enabled: d.enabled ?? null, via: d.via || null };
}

/** Platform jobs queued or running on the host runner right now. */
export function activePlatformJobs(db) {
  if (!has(db, 'setup_jobs')) return [];
  return db.prepare(`SELECT id, app, kind, status, phase, created_at FROM setup_jobs WHERE app IN (${PLATFORM_JOB_APPS.map(() => '?').join(',')}) AND status IN ('queued','running') ORDER BY created_at DESC`).all(...PLATFORM_JOB_APPS);
}

export function platformFlagState(db) {
  const jobs = activePlatformJobs(db);
  return {
    name: PLATFORM_FLAG, enabled: readFlag(db, PLATFORM_FLAG), default: flagPolicy()[PLATFORM_FLAG]?.default !== false, human_only: true,
    last_change: lastFlagChange(db, PLATFORM_FLAG),
    active_jobs: { count: jobs.length, jobs },
    note: 'Turning this off stops new Platform MCP calls only. Jobs already queued or running on the host runner continue; dashboard actions are not affected.',
  };
}

/** The ONLY writer of mcp.platform: an administrator in the dashboard. Audited. */
export function setPlatformFlag(db, enabled, user, ip = null) {
  if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be true or false.'), { status: 400 });
  if (user?.role !== 'admin') throw Object.assign(new Error('Only an administrator can change Platform MCP access.'), { status: 403 });
  const previous = readFlag(db, PLATFORM_FLAG);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`feature_flag:${PLATFORM_FLAG}`, enabled ? '1' : '0');
    db.prepare('INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuidv4(), user.id, FLAG_AUDIT_ACTION, 'feature_flag', PLATFORM_FLAG, JSON.stringify({ flag: PLATFORM_FLAG, previous, enabled, via: 'dashboard', active_platform_jobs: activePlatformJobs(db).length }), ip);
  });
  tx();
  return platformFlagState(db);
}

/**
 * What an MCP client can call right now for one service (or the section):
 * the effective result of mcp.platform, mcp.destructive and mcp.platform.purge.
 */
export function mcpAccess(db, { service = null } = {}) {
  const platform = readFlag(db, PLATFORM_FLAG), destructive = readFlag(db, DESTRUCTIVE_FLAG), purge = readFlag(db, PURGE_FLAG);
  const reads = ['get_platform_setup', 'get_platform_service', 'list_platform_jobs', 'get_platform_job', 'platform_preflight', 'verify_platform_service', 'get_platform_service_logs'];
  const writes = ['save_platform_setup', 'apply_platform_setup', 'continue_platform_setup'];
  const destructiveTools = ['manage_platform_service', 'control_platform_container', 'set_platform_restricted_networks', 'resync_platform_plan', 'reset_platform_setup', ...(service === 'keycloak' || !service ? ['recover_keycloak_bootstrap'] : [])];
  const callable = platform ? [...reads, ...writes, ...(destructive ? destructiveTools : [])] : [];
  return {
    flags: { [PLATFORM_FLAG]: platform, [DESTRUCTIVE_FLAG]: destructive, [PURGE_FLAG]: purge },
    effective: { platform, destructive: platform && destructive, purge: platform && destructive && purge },
    callable, refused: [...reads, ...writes, ...destructiveTools].filter((t) => !callable.includes(t)),
    reset_purge_callable: platform && destructive && purge,
    summary: !platform ? `${PLATFORM_FLAG} is off: no Platform MCP tool is callable.` : !destructive ? `Reads and plan/apply/continue are callable; runtime actions are refused (${DESTRUCTIVE_FLAG} is off).` : `All Platform MCP tools are callable${purge ? ', including reset with purge_data' : '; reset with purge_data is refused (mcp.platform.purge is off)'}.`,
  };
}
