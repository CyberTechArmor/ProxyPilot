// Where an installed ProxyPilot keeps what root recovery needs: the backend's
// SQLite database and the .env that holds the keys its rows are encrypted
// with. Recovery reads the .env only to LOCATE things (DATABASE_PATH, DOMAIN,
// ADMIN_USERNAME) — it never prints, copies or rewrites a key, and it never
// edits the file. The database and the .env are one recovery set; this
// command changes rows in the first and leaves the second alone.
//
// Pure: every function takes its inputs and an optional fs implementation, so
// the suite drives it against a temp tree.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_INSTALL_DIR = '/opt/proxypilot';
export const DEFAULT_ENV_FILE = '.env';
// The backend's own default (admin/backend/src/db.js) when DATABASE_PATH is
// unset: relative to the backend's working directory.
export const BACKEND_DEFAULT_DB = 'data/db/proxypilot.db';
// The path install.sh writes into .env: a CONTAINER path. The compose file
// bind-mounts <install>/data at /data, so this is <install>/data/… on the host.
export const CONTAINER_DATA_PREFIX = '/data';

// parseEnvFile(text) → Map. Enough of dotenv's grammar for the file install.sh
// writes: KEY=value, optional `export `, quotes stripped, comments ignored.
export function parseEnvFile(text) {
  const out = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim();
    }
    out.set(m[1], value);
  }
  return out;
}

// databaseCandidates({ installDir, databasePath }) → host paths to try, in
// order. A container path under /data maps onto the bind mount; another
// absolute path is taken as a host path; a relative path is tried from the
// install root and from the backend directory (a repo checkout's default).
export function databaseCandidates({ installDir, databasePath }) {
  const root = installDir || DEFAULT_INSTALL_DIR;
  const p = String(databasePath || '').trim() || BACKEND_DEFAULT_DB;
  const out = [];
  if (p === CONTAINER_DATA_PREFIX || p.startsWith(CONTAINER_DATA_PREFIX + '/')) {
    out.push(path.join(root, 'data', p.slice(CONTAINER_DATA_PREFIX.length)));
  }
  if (path.isAbsolute(p)) {
    out.push(p);
  } else {
    out.push(path.join(root, p));
    out.push(path.join(root, 'admin', 'backend', p));
  }
  // The pre-2026 layout update.sh migrates away from; listed last so an
  // install that still carries an empty legacy file is not mistaken for the
  // live one when the current path exists.
  out.push(path.join(root, 'data', 'proxypilot.db'));
  return [...new Set(out)];
}

// resolveInstall({ installDir, envPath, dbPath }, fsImpl) → what the command
// works on, or { ok: false, reason }. `dbPath` overrides the search. Nothing
// secret is carried in the result: keys are reported as present or absent.
export function resolveInstall({ installDir, envPath, dbPath } = {}, fsImpl = fs) {
  const root = path.resolve(installDir || DEFAULT_INSTALL_DIR);
  const envFile = envPath ? path.resolve(envPath) : path.join(root, DEFAULT_ENV_FILE);
  let env = new Map();
  let envPresent = false;
  try {
    env = parseEnvFile(fsImpl.readFileSync(envFile, 'utf8'));
    envPresent = true;
  } catch {
    envPresent = false;
  }
  const candidates = dbPath
    ? [path.resolve(dbPath)]
    : databaseCandidates({ installDir: root, databasePath: env.get('DATABASE_PATH') });
  const found = candidates.find((c) => {
    try { return fsImpl.statSync(c).isFile(); } catch { return false; }
  });
  const info = {
    installDir: root,
    envPath: envFile,
    envPresent,
    dbPath: found || null,
    dbCandidates: candidates,
    domain: env.get('DOMAIN') || null,
    adminUsername: env.get('ADMIN_USERNAME') || null,
    hasTotpKey: !!env.get('TOTP_ENCRYPTION_KEY') && env.get('TOTP_ENCRYPTION_KEY') !== 'CHANGE_ME_64_HEX_CHARS',
    hasJwtSecret: !!env.get('JWT_SECRET'),
  };
  if (!found) {
    return {
      ok: false,
      reason: 'database_not_found',
      message: `No ProxyPilot database at ${candidates.join(', ')}${envPresent ? '' : ` (and no ${envFile} to read DATABASE_PATH from)`}. Pass --db <path> or --install-dir <dir>.`,
      ...info,
    };
  }
  return { ok: true, ...info };
}
