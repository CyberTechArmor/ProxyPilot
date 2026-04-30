import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../../db/index.js';

export const STATE_DIR = '/var/lib/proxypilot';
export const STATE_FILE = path.join(STATE_DIR, 'firewall.json');
export const STATE_BAK = path.join(STATE_DIR, 'firewall.json.bak');

export const STATE_VERSION = 1;

/**
 * The base allowlist that every fresh install starts with. Per the spec,
 * port 22/tcp is unconditionally enabled so a fresh `init` cannot lock
 * the operator out. The two profile-gated entries (caddy-http3 udp/443,
 * wireguard udp/51820) are present but disabled so they show up in the
 * dashboard as toggleable without being open by default.
 */
export const DEFAULT_BASE = [
  { id: 'base-ssh',          source: 'base', port_start: 22,    port_end: null, proto: 'tcp', scope: 'public', enabled: true,  reason: 'ssh' },
  { id: 'base-caddy-http',   source: 'base', port_start: 80,    port_end: null, proto: 'tcp', scope: 'public', enabled: true,  reason: 'caddy-http' },
  { id: 'base-caddy-https',  source: 'base', port_start: 443,   port_end: null, proto: 'tcp', scope: 'public', enabled: true,  reason: 'caddy-https' },
  { id: 'base-caddy-http3',  source: 'base', port_start: 443,   port_end: null, proto: 'udp', scope: 'public', enabled: false, reason: 'caddy-http3' },
  { id: 'base-wireguard',    source: 'base', port_start: 51820, port_end: null, proto: 'udp', scope: 'public', enabled: false, reason: 'wireguard' },
];

function nowIso() {
  return new Date().toISOString();
}

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

/**
 * Default state: base allowlist, no discovered rules, no egress rules,
 * panic-close off.
 */
export function defaultState() {
  const ts = nowIso();
  const base = DEFAULT_BASE.map(r => ({ ...r, first_seen: ts, last_seen: ts }));
  return {
    version: STATE_VERSION,
    default_policy: 'deny',
    base,
    discovered: [],
    container_egress: [],
    panic_close: false,
  };
}

/**
 * Read state from disk. Returns the default state (and writes it) if no
 * state file exists yet. Throws on parse error so reconcile refuses to
 * apply a corrupt file rather than silently rewriting it.
 */
export function readState() {
  ensureStateDir();
  if (!fs.existsSync(STATE_FILE)) {
    const fresh = defaultState();
    writeState(fresh);
    return fresh;
  }
  const raw = fs.readFileSync(STATE_FILE, 'utf-8');
  const parsed = JSON.parse(raw);
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`firewall.json version ${parsed.version} not supported (expected ${STATE_VERSION})`);
  }
  return parsed;
}

/**
 * Atomic write: tmp file + rename(2). The previous state file (if any)
 * is rotated to firewall.json.bak so reconcile rollback is one rename
 * away. Caller is responsible for invoking this only after the new
 * state has been validated.
 */
export function writeState(state) {
  ensureStateDir();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  if (fs.existsSync(STATE_FILE)) {
    fs.copyFileSync(STATE_FILE, STATE_BAK);
  }
  fs.renameSync(tmp, STATE_FILE);
  mirrorToSqlite(state);
}

/**
 * The JSON file is the source of truth for reconcile. SQLite mirrors it
 * for queryability (admin dashboard, reporting). We rebuild the mirror
 * on every write to keep the two stores trivially consistent.
 */
function mirrorToSqlite(state) {
  const db = getDb();
  const wipe = db.prepare('DELETE FROM firewall_rules');
  const insert = db.prepare(`
    INSERT INTO firewall_rules (
      id, source, container, process,
      port_start, port_end, proto, scope, source_cidrs_json,
      enabled, reason, first_seen, last_seen, service
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    wipe.run();
    const rows = [...state.base, ...state.discovered];
    for (const r of rows) {
      insert.run(
        r.id,
        r.source,
        r.container ?? null,
        r.process ?? null,
        r.port_start,
        r.port_end ?? null,
        r.proto,
        r.scope,
        r.source_cidrs ? JSON.stringify(r.source_cidrs) : null,
        r.enabled ? 1 : 0,
        r.reason ?? null,
        r.first_seen,
        r.last_seen,
        r.service ?? null,
      );
    }
  });
  tx();
}
