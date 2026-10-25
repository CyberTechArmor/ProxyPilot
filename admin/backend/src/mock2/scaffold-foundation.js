// Mock2 application foundation — the APP SIDE (2026-10).
//
// Every new Dev Studio application ships a platform-owned `foundation/` module:
// the one place its code reaches the foundation stack (Postgres + pgvector,
// S3 storage, embeddings — docs/features/app-foundation.md). Feature code uses
// these adapters only; a direct S3 client or embedding HTTP call in feature
// code is a deviation.
//
// Shape of what is generated:
//   foundation/runtime/*.mjs   plain ESM, so `node foundation/bin/foundation.mjs`
//                              runs without a build, using the app's node_modules
//   foundation/runtime/*.d.mts type declarations, so the app's strict NodeNext
//                              TypeScript imports the same implementation
//   foundation/index.mjs       the barrel feature code imports ('#foundation')
//   foundation/bin/foundation.mjs  the CLI the host drives (FOUNDATION_CLI_COMMANDS)
//   foundation/compose.yaml    the portable copy of the stack (an INPUT here —
//                              foundation-stack-logic.js renders it)
//   foundation/README.md
//
// Why the bootstrap is loaded with `node --import` and not an import line at
// the top of src/server.ts: ESM evaluates the entry's sibling imports while an
// earlier sibling is still awaiting its top-level await, so an import line
// cannot guarantee that component secrets are in process.env before the
// modules that read them at load time run. `--import` finishes the bootstrap
// (top-level await included) before the entry module is loaded at all.
//
// PURE (stub-first, risk R9): returns [{ path, content, mode }]. No I/O. The
// shared names and formats come from foundation-contract.js; contract.mjs is
// rendered FROM it (values and the two pure helpers copied verbatim), so the
// app cannot drift from the host. seal.mjs is byte-compatible with
// sealForApp/openForApp — scaffold-foundation.test.js pins the two together.

import {
  FOUNDATION_VERSION, FEATURES, FEATURE_STATES, STORAGE_PROVIDERS, EMBEDDING_PROVIDERS,
  STORAGE_SWITCH_MODES, VECTOR_METRICS, HEALTH_STATUSES, STACK, FOUNDATION_DATABASE_URL,
  LOCAL_EMBEDDINGS_WARNING, DEPENDENT_CAPABILITIES, SECRET_NAMES, HOST_ONLY_SECRETS,
  VECTOR_INDEX_ID_RE, vectorTableName, vectorColumnPlan, componentSecretName, pendingSecretName,
  FOUNDATION_NOTIFY_CHANNEL, FOUNDATION_CLI, FOUNDATION_CLI_COMMANDS,
} from './foundation-contract.js';

// The runtime's npm dependencies (pg is already a scaffold dependency).
// Deliberately NOT part of scaffold.js SCAFFOLD_DEPENDENCIES: that set is the
// repair list the runner restores into EVERY project's package.json, and
// projects created before the foundation never get it (app-foundation.md
// "Existing projects").
export const FOUNDATION_DEPENDENCIES = Object.freeze({
  '@aws-sdk/client-s3': '^3.1156.0',
  '@aws-sdk/lib-storage': '^3.1156.0',
});
// Loaded only when asked for (storage.presignGet). Not a dependency by
// default; README says how to add it.
export const FOUNDATION_OPTIONAL_DEPENDENCIES = Object.freeze(['@aws-sdk/s3-request-presigner']);

export const FOUNDATION_DIR = 'foundation';
export const FOUNDATION_BOOTSTRAP = 'foundation/runtime/bootstrap.mjs';
// The node flag every app entry runs with (package.json start/dev).
export const FOUNDATION_NODE_IMPORT = `--import=./${FOUNDATION_BOOTSTRAP}`;
// package.json "imports": feature code writes `import { storage } from '#foundation'`.
export const FOUNDATION_PACKAGE_IMPORTS = Object.freeze({ '#foundation': './foundation/index.mjs' });

// The self-retrieval bar a re-embedded index must clear (jobs.mjs). Exported
// so the host and the docs quote the same number.
export const SELF_RETRIEVAL = Object.freeze({ sample: 50, k: 5, threshold: 0.9 });

const lit = (v) => JSON.stringify(v, null, 2);

const HEADER = '// Platform-owned (Mock2 application foundation). A base-app upgrade rewrites\n'
  + '// this file; extend the app in src/, never here.\n';

/* ---------------------------------------------------------------------------
   contract.mjs — rendered from foundation-contract.js.
   --------------------------------------------------------------------------- */
function contractMjs() {
  return `// GENERATED from ProxyPilot's foundation contract (${FOUNDATION_VERSION}).
${HEADER}// The names, shapes and formats this runtime shares with the host. The two
// helpers at the end are copied verbatim from the contract module.

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const FOUNDATION_VERSION = ${lit(FOUNDATION_VERSION)};
export const FEATURES = deepFreeze(${lit(FEATURES)});
export const FEATURE_STATES = deepFreeze(${lit(FEATURE_STATES)});
export const STORAGE_PROVIDERS = deepFreeze(${lit(STORAGE_PROVIDERS)});
export const EMBEDDING_PROVIDERS = deepFreeze(${lit(EMBEDDING_PROVIDERS)});
export const STORAGE_SWITCH_MODES = deepFreeze(${lit(STORAGE_SWITCH_MODES)});
export const VECTOR_METRICS = deepFreeze(${lit(VECTOR_METRICS)});
export const HEALTH_STATUSES = deepFreeze(${lit(HEALTH_STATUSES)});
export const STACK = deepFreeze(${lit(STACK)});
// No secret in it: peer authentication over the Unix socket.
export const FOUNDATION_DATABASE_URL = ${lit(FOUNDATION_DATABASE_URL)};
export const LOCAL_EMBEDDINGS_WARNING = ${lit(LOCAL_EMBEDDINGS_WARNING)};
export const DEPENDENT_CAPABILITIES = deepFreeze(${lit(DEPENDENT_CAPABILITIES)});
export const SECRET_NAMES = deepFreeze(${lit(SECRET_NAMES)});
export const HOST_ONLY_SECRETS = deepFreeze(${lit(HOST_ONLY_SECRETS)});
export const FOUNDATION_NOTIFY_CHANNEL = ${lit(FOUNDATION_NOTIFY_CHANNEL)};
export const FOUNDATION_CLI = ${lit(FOUNDATION_CLI)};
export const FOUNDATION_CLI_COMMANDS = deepFreeze(${lit(FOUNDATION_CLI_COMMANDS)});
export const VECTOR_INDEX_ID_RE = ${VECTOR_INDEX_ID_RE.toString()};

export ${componentSecretName.toString()}

export ${pendingSecretName.toString()}

export ${vectorTableName.toString()}

export ${vectorColumnPlan.toString()}
`;
}

function contractDts() {
  return `${HEADER}
export declare const FOUNDATION_VERSION: string;
export declare const FEATURES: readonly ('storage' | 'embeddings')[];
export declare const FEATURE_STATES: readonly ('on' | 'off')[];
export declare const STORAGE_PROVIDERS: readonly ('bundled' | 'external')[];
export declare const EMBEDDING_PROVIDERS: readonly ('local' | 'openai' | 'openai_compatible')[];
export declare const STORAGE_SWITCH_MODES: readonly ('copy' | 'fresh')[];
export declare const VECTOR_METRICS: readonly ('cosine' | 'l2' | 'ip')[];
export declare const HEALTH_STATUSES: readonly ('ready' | 'off' | 'starting' | 'degraded' | 'unavailable' | 'missing_credentials')[];
export declare const STACK: {
  readonly composeProject: string;
  readonly dir: string;
  readonly composeFile: string;
  readonly keyFile: string;
  readonly postgres: { readonly service: string; readonly image: string; readonly socketDir: string; readonly volume: string; readonly database: string; readonly role: string };
  readonly storage: { readonly service: string; readonly image: string; readonly listen: string; readonly port: number; readonly volume: string; readonly bucket: string; readonly region: string };
  readonly embeddings: { readonly service: string; readonly image: string; readonly listen: string; readonly port: number; readonly volume: string; readonly model: string; readonly dimensions: number };
};
export declare const FOUNDATION_DATABASE_URL: string;
export declare const LOCAL_EMBEDDINGS_WARNING: string;
export declare const DEPENDENT_CAPABILITIES: { readonly storage: readonly string[]; readonly embeddings: readonly string[] };
export declare const SECRET_NAMES: {
  readonly masterKey: string;
  readonly storageAdminAccessKeyId: string;
  readonly storageAdminSecretAccessKey: string;
  readonly storageAccessKeyId: string;
  readonly storageSecretAccessKey: string;
  readonly embeddingsApiKey: string;
};
export declare const HOST_ONLY_SECRETS: readonly string[];
export declare const FOUNDATION_NOTIFY_CHANNEL: string;
export declare const FOUNDATION_CLI: string;
export declare const FOUNDATION_CLI_COMMANDS: readonly string[];
export declare const VECTOR_INDEX_ID_RE: RegExp;
export declare function componentSecretName(envKey: string): string;
export declare function pendingSecretName(name: string): string;
export declare function vectorTableName(indexId: string): string;
export interface VectorColumnPlan {
  type: string;
  ann: 'hnsw' | 'none';
  ops: Partial<Record<'cosine' | 'l2' | 'ip', string>>;
}
export declare function vectorColumnPlan(dimensions: number): VectorColumnPlan;
`;
}

/* ---------------------------------------------------------------------------
   errors.mjs
   --------------------------------------------------------------------------- */
function errorsMjs() {
  return HEADER + String.raw`//
// Every failure the foundation reports carries a stable code. A feature that is
// switched off, unconfigured or missing its credentials is UNAVAILABLE: it is
// reported to the person (HTTP 503 from routes, exit code 2 from the CLI) and
// is never a crash and never hidden.

export class FoundationError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'FoundationError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export class FoundationUnavailableError extends FoundationError {
  constructor(code, message, detail) {
    super(code, message, detail);
    this.name = 'FoundationUnavailableError';
  }
}

// The database could not be reached within the retry window. Names the socket
// or host it tried; never a password.
export class FoundationDatabaseError extends FoundationError {
  constructor(message, detail) {
    super('DATABASE_UNREACHABLE', message, detail);
    this.name = 'FoundationDatabaseError';
  }
}

export const UNAVAILABLE_CODES = Object.freeze([
  'STORAGE_OFF',
  'EMBEDDINGS_OFF',
  'MISSING_CREDENTIALS',
  'MISSING_MASTER_KEY',
  'FOUNDATION_NOT_PROVISIONED',
  'NO_PENDING_PROVIDER',
  'INDEX_PROVIDER_MISMATCH',
]);

export function isFoundationUnavailable(err) {
  return err instanceof FoundationUnavailableError;
}

// For routes: map a foundation error to an HTTP answer, or null when the error
// is not the foundation's (let the app's own handler deal with it).
export function foundationHttpError(err) {
  if (err instanceof FoundationUnavailableError) {
    return { status: 503, body: { code: err.code, message: err.message } };
  }
  if (err instanceof FoundationError) {
    return { status: err.code === 'NOT_FOUND' ? 404 : 502, body: { code: err.code, message: err.message } };
  }
  return null;
}
`;
}

function errorsDts() {
  return `${HEADER}
export type FoundationUnavailableCode =
  | 'STORAGE_OFF'
  | 'EMBEDDINGS_OFF'
  | 'MISSING_CREDENTIALS'
  | 'MISSING_MASTER_KEY'
  | 'FOUNDATION_NOT_PROVISIONED'
  | 'NO_PENDING_PROVIDER'
  | 'INDEX_PROVIDER_MISMATCH';

export declare class FoundationError extends Error {
  constructor(code: string, message: string, detail?: Record<string, unknown>);
  readonly code: string;
  readonly detail?: Record<string, unknown>;
}
export declare class FoundationUnavailableError extends FoundationError {
  constructor(code: FoundationUnavailableCode, message: string, detail?: Record<string, unknown>);
  readonly code: FoundationUnavailableCode;
}
export declare class FoundationDatabaseError extends FoundationError {
  constructor(message: string, detail?: Record<string, unknown>);
}
export declare const UNAVAILABLE_CODES: readonly FoundationUnavailableCode[];
export declare function isFoundationUnavailable(err: unknown): err is FoundationUnavailableError;
export declare function foundationHttpError(err: unknown): { status: number; body: { code: string; message: string } } | null;
`;
}

/* ---------------------------------------------------------------------------
   seal.mjs — byte-compatible with sealForApp / openForApp.
   --------------------------------------------------------------------------- */
function sealMjs() {
  return HEADER + String.raw`//
// Secrets reach the app SEALED: AES-256-GCM under the deployment master key
// (32 random bytes, base64, in the key file), wire format
// mfs1:<iv>:<tag>:<ciphertext> (base64url parts), with the secret NAME as the
// additional authenticated data so a sealed value cannot be moved to another
// name. Byte-compatible with the host's sealForApp/openForApp.
import crypto from 'node:crypto';

const SEAL_PREFIX = 'mfs1:';
const SECRET_NAME_RE = /^(?:master_key|storage\.(?:admin_)?(?:access_key_id|secret_access_key)|embeddings\.api_key|pending\.(?:storage\.(?:access_key_id|secret_access_key)|embeddings\.api_key)|component\.[A-Z][A-Z0-9_]{0,63})$/;

export function isValidSecretName(name) {
  return SECRET_NAME_RE.test(String(name || ''));
}

function aad(name) {
  return Buffer.from('mock2-foundation:' + name, 'utf8');
}

function keyBytes(masterKeyB64) {
  const key = Buffer.from(String(masterKeyB64 || '').trim(), 'base64');
  if (key.length !== 32) throw new Error('foundation master key must be 32 bytes (base64)');
  return key;
}

// Accepts the key file's text; returns the trimmed base64 key or null.
export function parseMasterKey(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  return Buffer.from(t, 'base64').length === 32 ? t : null;
}

export function sealForApp(masterKeyB64, name, plaintext) {
  if (!isValidSecretName(name)) throw new Error('invalid foundation secret name: ' + name);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(masterKeyB64), iv);
  cipher.setAAD(aad(name));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return SEAL_PREFIX + iv.toString('base64url') + ':' + cipher.getAuthTag().toString('base64url') + ':' + ct.toString('base64url');
}

export function openForApp(masterKeyB64, name, sealed) {
  const s = String(sealed || '');
  if (!s.startsWith(SEAL_PREFIX)) throw new Error('not a sealed foundation secret');
  const parts = s.slice(SEAL_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('malformed sealed foundation secret');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(masterKeyB64), iv);
  decipher.setAAD(aad(name));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
`;
}

function sealDts() {
  return `${HEADER}
export declare function isValidSecretName(name: string): boolean;
export declare function parseMasterKey(text: string): string | null;
export declare function sealForApp(masterKeyB64: string, name: string, plaintext: string): string;
export declare function openForApp(masterKeyB64: string, name: string, sealed: string): string;
`;
}

/* ---------------------------------------------------------------------------
   config.mjs — database, master key, features + secrets, LISTEN/reload.
   --------------------------------------------------------------------------- */
function configMjs() {
  return HEADER + String.raw`//
// Where the database is, the deployment master key, and the feature switches
// and sealed secrets ProxyPilot writes into the app database
// (mock2_foundation.features / .secrets). Loaded once at boot (bootstrap.mjs),
// reloaded whenever the host sends NOTIFY on the foundation channel (payload:
// the generation number it keeps in mock2_foundation.meta 'generation').
// features.<f>.pending is a staged switch, { provider, config, mode?, test? };
// its credentials are the pending.* secrets.
//
// Environment (all optional):
//   DATABASE_URL            the database; default FOUNDATION_DATABASE_URL (the
//                           stack's Unix socket, peer auth, no password). An
//                           explicit value always wins. There is NO fallback to
//                           any other database.
//   FOUNDATION_KEY_FILE     the master key path; default STACK.keyFile.
//   FOUNDATION_DB_RETRY_MS  how long to keep retrying the first connection
//                           (default 60000 for the app, 15000 for the CLI).
//
// A missing master key does not stop the app: the database works, and storage
// and embeddings report MISSING_MASTER_KEY until the key is back.
import fs from 'node:fs';
import pg from 'pg';
import {
  FOUNDATION_VERSION, STACK, FOUNDATION_DATABASE_URL, FOUNDATION_NOTIFY_CHANNEL, SECRET_NAMES,
  LOCAL_EMBEDDINGS_WARNING, pendingSecretName,
} from './contract.mjs';
import { openForApp, isValidSecretName, parseMasterKey } from './seal.mjs';
import { FoundationDatabaseError } from './errors.mjs';

const APP_RETRY_MS = 60000;
const MAX_BACKOFF_MS = 5000;
const COMPONENT_PREFIX = 'component.';
const SECRETISH_KEY = /(secret|password|passwd|api[_-]?key|token|access[_-]?key|credential|private)/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultLog = (msg) => { console.warn(msg); };

export function databaseUrl() {
  return process.env.DATABASE_URL || FOUNDATION_DATABASE_URL;
}

export function keyFilePath() {
  return process.env.FOUNDATION_KEY_FILE || STACK.keyFile;
}

export function retryWindowMs(fallback) {
  const raw = process.env.FOUNDATION_DB_RETRY_MS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback === undefined ? APP_RETRY_MS : fallback;
}

// Where a connection goes — socket or host, database, user — never a password.
export function describeDatabase(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return 'an unparseable DATABASE_URL'; }
  const q = u.searchParams;
  const db = decodeURIComponent(u.pathname.replace(/^\/+/, '')) || '(default database)';
  const user = q.get('user') || decodeURIComponent(u.username || '') || '(default user)';
  const host = q.get('host') || decodeURIComponent(u.hostname || '');
  if (host.startsWith('/')) return 'socket ' + host + ', database ' + db + ', user ' + user;
  return (host || 'localhost') + ':' + (q.get('port') || u.port || '5432') + ', database ' + db + ', user ' + user;
}

function stripUserinfo(s) {
  try {
    const u = new URL(s);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch (e) {
    return '[redacted]';
  }
}

// Config objects are never secret, but a person can paste a credential into
// one. Anything that looks like it is replaced before it is printed or served.
export function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRETISH_KEY.test(k)) { out[k] = '[redacted]'; continue; }
    if (typeof v === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(v)) { out[k] = stripUserinfo(v); continue; }
    out[k] = redactConfig(v);
  }
  return out;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// ---- connecting -----------------------------------------------------------

// One client, retried with backoff for up to the window, then an explicit
// error naming the socket/host. Used for the first connection (a guest restart
// brings Postgres up after the app) and for the change listener.
export async function connectWithRetry(options) {
  const opts = options || {};
  const url = opts.url || databaseUrl();
  const windowMs = opts.retryMs === undefined ? retryWindowMs() : opts.retryMs;
  const log = opts.log || defaultLog;
  const started = Date.now();
  let delay = 250;
  let attempt = 0;
  let lastErr = null;
  for (;;) {
    attempt += 1;
    const remaining = windowMs - (Date.now() - started);
    const client = new pg.Client({
      connectionString: url,
      application_name: 'mock2-foundation',
      connectionTimeoutMillis: Math.max(1000, Math.min(10000, remaining > 0 ? remaining : 1000)),
    });
    const swallow = () => {};
    client.on('error', swallow);
    try {
      await client.connect();
      client.removeListener('error', swallow);
      if (attempt > 1) log('[foundation] database reachable after ' + attempt + ' attempts (' + describeDatabase(url) + ')');
      return client;
    } catch (err) {
      lastErr = err;
      client.end().catch(() => {});
      if (Date.now() - started + delay > windowMs) break;
      if (attempt === 1) {
        log('[foundation] waiting for the database (' + describeDatabase(url) + '): ' + err.message
          + ' - retrying for up to ' + Math.round(windowMs / 1000) + ' s');
      }
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
    }
  }
  const secs = Math.round((Date.now() - started) / 100) / 10;
  throw new FoundationDatabaseError(
    'Could not connect to the application database (' + describeDatabase(url) + ') after ' + attempt
      + (attempt === 1 ? ' attempt' : ' attempts') + ' over ' + secs + ' s: '
      + (lastErr && lastErr.message ? lastErr.message : 'unknown error')
      + '. The foundation never falls back to another database. Check that the foundation stack is running'
      + ' (docker compose -f ' + STACK.composeFile + ' ps) or set DATABASE_URL.',
    { target: describeDatabase(url), attempts: attempt, cause_code: lastErr && lastErr.code ? lastErr.code : null },
  );
}

let pool = null;

// The shared pool the adapters query through (vector, health, jobs).
export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: databaseUrl(),
      max: 4,
      application_name: 'mock2-foundation',
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => defaultLog('[foundation] idle database connection error (kept serving): ' + err.message));
  }
  return pool;
}

// ---- state ----------------------------------------------------------------

let snapshot = null;
let secretValues = new Map();
const changeListeners = new Set();
const appliedEnv = new Map();
const envSource = {};
let listenClient = null;
let closing = false;
let reloadTimer = null;
let reconnectTimer = null;
let loading = null;

function readMasterKey() {
  const path = keyFilePath();
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    return { value: null, path, problem: err && err.code === 'ENOENT' ? 'missing' : 'unreadable (' + (err && err.code ? err.code : 'error') + ')' };
  }
  const value = parseMasterKey(text);
  return value ? { value, path, problem: null } : { value: null, path, problem: 'invalid (not 32 bytes of base64)' };
}

async function readState(db) {
  const key = readMasterKey();
  let schemaPresent = true;
  const features = {};
  let rows = [];
  let generation = 0;
  try {
    const f = await db.query('SELECT feature, state, provider, config, pending, generation FROM mock2_foundation.features ORDER BY feature');
    for (const r of f.rows) {
      features[r.feature] = {
        state: r.state,
        provider: r.provider,
        config: r.config || {},
        pending: r.pending || null,
        generation: Number(r.generation) || 0,
      };
      generation = Math.max(generation, Number(r.generation) || 0);
    }
    const s = await db.query('SELECT name, sealed, generation FROM mock2_foundation.secrets ORDER BY name');
    rows = s.rows;
    for (const r of rows) generation = Math.max(generation, Number(r.generation) || 0);
    // The host's own counter (the number it sends with NOTIFY) wins when present.
    const m = await db.query("SELECT value FROM mock2_foundation.meta WHERE key = 'generation'");
    if (m.rows[0] && Number.isFinite(Number(m.rows[0].value))) generation = Number(m.rows[0].value);
  } catch (err) {
    // 42P01 undefined_table, 3F000 invalid_schema_name: this database was not
    // provisioned with the foundation schema (an e2e scratch database, or an
    // app run outside the stack). The database itself still works.
    if (err && (err.code === '42P01' || err.code === '3F000')) schemaPresent = false;
    else throw err;
  }
  const values = new Map();
  const unreadable = [];
  if (key.value) {
    for (const r of rows) {
      if (!isValidSecretName(r.name)) { unreadable.push(r.name); continue; }
      try { values.set(r.name, openForApp(key.value, r.name, r.sealed)); } catch (e) { unreadable.push(r.name); }
    }
  }
  const state = deepFreeze({
    foundationVersion: FOUNDATION_VERSION,
    loadedAt: new Date().toISOString(),
    database: { target: describeDatabase(databaseUrl()), isDefault: !process.env.DATABASE_URL },
    schemaPresent,
    generation,
    features,
    secretNames: rows.map((r) => r.name),
    unreadableSecrets: unreadable,
    masterKey: { present: !!key.value, path: key.path, problem: key.problem },
  });
  return { state, values };
}

// component.<KEY> secrets become process.env.<KEY>, in memory only. An
// environment variable that was already set explicitly (a test, the e2e
// harness, an operator override) wins and is left alone.
function applyComponentEnv(canOpen) {
  const wanted = new Map();
  for (const [name, value] of secretValues) {
    if (name.startsWith(COMPONENT_PREFIX)) wanted.set(name.slice(COMPONENT_PREFIX.length), value);
  }
  for (const [key, value] of wanted) {
    if (appliedEnv.has(key) || process.env[key] === undefined) {
      process.env[key] = value;
      appliedEnv.set(key, value);
      envSource[key] = 'foundation';
    } else {
      envSource[key] = 'environment';
    }
  }
  // Only when the secrets could be opened at all: a key file that is briefly
  // unreadable must not strip a running app's component secrets.
  if (!canOpen) return;
  for (const key of Array.from(appliedEnv.keys())) {
    if (!wanted.has(key)) {
      if (process.env[key] === appliedEnv.get(key)) delete process.env[key];
      appliedEnv.delete(key);
      delete envSource[key];
    }
  }
}

function install(next) {
  const previous = snapshot;
  snapshot = next.state;
  secretValues = next.values;
  applyComponentEnv(next.state.masterKey.present);
  for (const fn of changeListeners) {
    try { fn(snapshot, previous); } catch (err) { defaultLog('[foundation] change listener failed: ' + err.message); }
  }
}

// ---- change listener (LISTEN / NOTIFY) ------------------------------------

function scheduleReload() {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    reloadFoundation()
      .then((s) => defaultLog('[foundation] configuration reloaded (generation ' + s.generation + ')'))
      .catch((err) => defaultLog('[foundation] reload failed, keeping the previous configuration: ' + err.message));
  }, 100);
}

async function startListening(client) {
  listenClient = client;
  client.on('notification', (msg) => {
    if (msg.channel === FOUNDATION_NOTIFY_CHANNEL) scheduleReload();
  });
  client.on('error', (err) => {
    if (listenClient !== client) return;
    defaultLog('[foundation] change listener lost (' + err.message + ') - reconnecting');
    dropListener(client);
  });
  client.on('end', () => {
    if (listenClient === client && !closing) dropListener(client);
  });
  await client.query('LISTEN ' + client.escapeIdentifier(FOUNDATION_NOTIFY_CHANNEL));
}

function dropListener(client) {
  if (listenClient !== client) return;
  listenClient = null;
  client.end().catch(() => {});
  scheduleReconnect(1000);
}

function scheduleReconnect(delay) {
  if (closing || reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    let c = null;
    try {
      c = await connectWithRetry({ retryMs: 0, log: () => {} });
      await startListening(c);
      await reloadFoundation(); // a change may have been missed while disconnected
      defaultLog('[foundation] change listener reconnected');
    } catch (err) {
      if (c && listenClient !== c) c.end().catch(() => {});
      scheduleReconnect(Math.min(delay * 2, 30000));
    }
  }, delay);
}

// ---- public API -----------------------------------------------------------

export async function loadFoundation(options) {
  const opts = options || {};
  const client = await connectWithRetry(opts);
  let keep = false;
  try {
    install(await readState(client));
    if (opts.listen) {
      await startListening(client);
      keep = true;
    }
  } finally {
    if (!keep) await client.end().catch(() => {});
  }
  return snapshot;
}

export async function ensureFoundation(options) {
  if (snapshot) return snapshot;
  if (!loading) loading = loadFoundation(options).finally(() => { loading = null; });
  return loading;
}

export function getFoundation() {
  return snapshot;
}

export async function reloadFoundation() {
  install(await readState(getPool()));
  return snapshot;
}

export function onFoundationChange(fn) {
  changeListeners.add(fn);
  return () => { changeListeners.delete(fn); };
}

// The plaintext of one synced secret, for the adapters. Feature code never
// needs this: component secrets are in process.env, provider credentials are
// used by the adapters.
export function getSecret(name) {
  return secretValues.has(name) ? secretValues.get(name) : null;
}

export function hasSecret(name) {
  return !!snapshot && snapshot.secretNames.includes(name);
}

export function componentEnvSources() {
  return Object.assign({}, envSource);
}

export async function closeFoundation() {
  closing = true;
  try {
    if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const c = listenClient;
    listenClient = null;
    if (c) await c.end().catch(() => {});
    const p = pool;
    pool = null;
    if (p) await p.end().catch(() => {});
    for (const [key, value] of appliedEnv) if (process.env[key] === value) delete process.env[key];
    appliedEnv.clear();
    for (const k of Object.keys(envSource)) delete envSource[k];
    snapshot = null;
    secretValues = new Map();
  } finally {
    closing = false;
  }
}

// The effective, non-secret configuration: what the CLI's config command and
// the admin health route show. has_secret flags only — never a value.
export function describeConfig(state) {
  const s = state || snapshot;
  if (!s) return null;
  const has = (n) => s.secretNames.includes(n);
  const feature = (name, secretNames) => {
    const f = s.features[name];
    if (!f) return null;
    const flags = {};
    for (const n of secretNames) flags[n] = has(n);
    return {
      state: f.state,
      provider: f.provider,
      config: redactConfig(f.config),
      pending: f.pending ? redactConfig(f.pending) : null,
      has_secret: flags,
      generation: f.generation,
    };
  };
  const storageSecrets = [SECRET_NAMES.storageAccessKeyId, SECRET_NAMES.storageSecretAccessKey];
  const embeddingSecrets = [SECRET_NAMES.embeddingsApiKey];
  const embeddings = feature('embeddings', embeddingSecrets.concat(embeddingSecrets.map(pendingSecretName)));
  return {
    foundation_version: s.foundationVersion,
    loaded_at: s.loadedAt,
    generation: s.generation,
    database: { target: s.database.target, default_url: s.database.isDefault },
    master_key: { present: s.masterKey.present, path: s.masterKey.path, problem: s.masterKey.problem },
    schema_present: s.schemaPresent,
    features: {
      storage: feature('storage', storageSecrets.concat(storageSecrets.map(pendingSecretName))),
      embeddings,
    },
    secrets: { names: s.secretNames.slice(), unreadable: s.unreadableSecrets.slice() },
    component_env: componentEnvSources(),
    warnings: embeddings && embeddings.provider === 'local' ? [LOCAL_EMBEDDINGS_WARNING] : [],
  };
}

// One line for the boot log.
export function describeFoundation(state) {
  const s = state || snapshot;
  if (!s) return 'not loaded';
  if (!s.schemaPresent) {
    return 'database reachable (' + s.database.target + ') but it has no mock2_foundation schema - storage and embeddings are unavailable (FOUNDATION_NOT_PROVISIONED)';
  }
  const f = (name) => {
    const row = s.features[name];
    return row ? name + ' ' + row.state + ' (' + row.provider + ')' : name + ' not configured';
  };
  const components = s.secretNames.filter((n) => n.startsWith(COMPONENT_PREFIX)).length;
  const parts = [
    'loaded generation ' + s.generation + ' from ' + s.database.target,
    f('storage'),
    f('embeddings'),
    components + ' component secret' + (components === 1 ? '' : 's') + ' in memory',
  ];
  if (!s.masterKey.present) {
    parts.push('MASTER KEY ' + String(s.masterKey.problem).toUpperCase() + ' at ' + s.masterKey.path
      + ' - storage and embeddings report MISSING_MASTER_KEY');
  }
  if (s.unreadableSecrets.length) parts.push(s.unreadableSecrets.length + ' secret(s) could not be opened');
  const emb = s.features.embeddings;
  if (emb && emb.provider === 'local') parts.push('local embeddings: development quality');
  return parts.join('; ');
}
`;
}

function configDts() {
  return `${HEADER}
export interface FeatureRow {
  readonly state: 'on' | 'off';
  readonly provider: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly pending: Readonly<Record<string, unknown>> | null;
  readonly generation: number;
}

export interface FoundationState {
  readonly foundationVersion: string;
  readonly loadedAt: string;
  readonly database: { readonly target: string; readonly isDefault: boolean };
  readonly schemaPresent: boolean;
  readonly generation: number;
  readonly features: { readonly storage?: FeatureRow; readonly embeddings?: FeatureRow };
  readonly secretNames: readonly string[];
  readonly unreadableSecrets: readonly string[];
  readonly masterKey: { readonly present: boolean; readonly path: string; readonly problem: string | null };
}

export interface FeatureDescription {
  state: 'on' | 'off';
  provider: string;
  config: Record<string, unknown>;
  pending: Record<string, unknown> | null;
  has_secret: Record<string, boolean>;
  generation: number;
}

export interface ConfigDescription {
  foundation_version: string;
  loaded_at: string;
  generation: number;
  database: { target: string; default_url: boolean };
  master_key: { present: boolean; path: string; problem: string | null };
  schema_present: boolean;
  features: { storage: FeatureDescription | null; embeddings: FeatureDescription | null };
  secrets: { names: string[]; unreadable: string[] };
  component_env: Record<string, 'foundation' | 'environment'>;
  warnings: string[];
}

export interface LoadOptions {
  /** Keep a connection open and LISTEN for host changes (the app does; the CLI does not). */
  listen?: boolean;
  /** Override the first-connection retry window (milliseconds). */
  retryMs?: number;
  url?: string;
  log?: (message: string) => void;
}

/** Minimal query surface of the shared pool. */
export interface FoundationQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export declare function databaseUrl(): string;
export declare function keyFilePath(): string;
export declare function retryWindowMs(fallback?: number): number;
export declare function describeDatabase(url: string): string;
export declare function redactConfig<T>(value: T): T;
export declare function connectWithRetry(options?: LoadOptions): Promise<unknown>;
export declare function getPool(): FoundationQueryable & { end(): Promise<void> };
export declare function loadFoundation(options?: LoadOptions): Promise<FoundationState>;
export declare function ensureFoundation(options?: LoadOptions): Promise<FoundationState>;
export declare function getFoundation(): FoundationState | null;
export declare function reloadFoundation(): Promise<FoundationState>;
export declare function onFoundationChange(fn: (next: FoundationState, previous: FoundationState | null) => void): () => void;
export declare function getSecret(name: string): string | null;
export declare function hasSecret(name: string): boolean;
export declare function componentEnvSources(): Record<string, 'foundation' | 'environment'>;
export declare function closeFoundation(): Promise<void>;
export declare function describeConfig(state?: FoundationState): ConfigDescription | null;
export declare function describeFoundation(state?: FoundationState): string;
`;
}

/* ---------------------------------------------------------------------------
   bootstrap.mjs
   --------------------------------------------------------------------------- */
function bootstrapMjs() {
  return HEADER + String.raw`//
// The foundation bootstrap. Loaded BEFORE any application module by Node's
// --import flag (package.json "start" and "dev"):
//
//   node --import=./foundation/runtime/bootstrap.mjs dist/server.js
//
// Why --import and not an import line at the top of src/server.ts: ESM
// evaluates the entry's sibling imports while an earlier one is still awaiting
// its top-level await, so an import line cannot guarantee that component
// secrets are in process.env before the modules that read them at load time
// run. --import finishes this module (the await below included) before the
// entry module is loaded at all.
//
// It connects to the database (retrying for up to 60 s after a guest restart,
// then failing loudly with the socket it tried), reads the feature switches and
// sealed secrets, opens them with the master key, puts component.<KEY> secrets
// into process.env in memory, and keeps listening for host changes.
import { loadFoundation, describeFoundation } from './config.mjs';

export const foundation = await loadFoundation({ listen: true });
console.log('[foundation] ' + describeFoundation(foundation));

export default foundation;
`;
}

function bootstrapDts() {
  return `${HEADER}
import type { FoundationState } from './config.mjs';
export declare const foundation: FoundationState;
export default foundation;
`;
}

/* ---------------------------------------------------------------------------
   storage.mjs
   --------------------------------------------------------------------------- */
function storageMjs() {
  return HEADER + String.raw`//
// The storage adapter: any S3-compatible endpoint (the bundled SeaweedFS, R2,
// AWS S3, B2, MinIO, ...) through @aws-sdk/client-s3. Feature code uses this,
// never an S3 SDK directly. Configuration comes from mock2_foundation.features
// (storage: endpoint, region, bucket, prefix, force_path_style) and the synced
// credentials; keys are relative to the configured prefix.
import crypto from 'node:crypto';
import { ensureFoundation, getSecret, onFoundationChange } from './config.mjs';
import { SECRET_NAMES, pendingSecretName } from './contract.mjs';
import { FoundationError, FoundationUnavailableError } from './errors.mjs';

const MULTIPART_THRESHOLD = 16 * 1024 * 1024;
const PART_SIZE = 8 * 1024 * 1024;
const MAX_KEY_BYTES = 1024;

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/lib-storage')])
      .then(([s3, lib]) => ({ s3, lib }))
      .catch((err) => {
        sdkPromise = null;
        throw new FoundationError('STORAGE_SDK_MISSING', 'The storage adapter needs @aws-sdk/client-s3 and @aws-sdk/lib-storage (npm install): ' + err.message);
      });
  }
  return sdkPromise;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function validateKey(key) {
  if (typeof key !== 'string' || !key) throw new FoundationError('INVALID_KEY', 'A storage key must be a non-empty string.');
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) throw new FoundationError('INVALID_KEY', 'A storage key must be at most 1024 bytes.');
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new FoundationError('INVALID_KEY', 'A storage key must not contain control characters.');
  if (key.startsWith('/')) throw new FoundationError('INVALID_KEY', 'A storage key must not start with "/".');
}

function toBytes(body) {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return null;
}

function isStreamLike(body) {
  return !!body && (typeof body.pipe === 'function' || typeof body[Symbol.asyncIterator] === 'function' || typeof body.getReader === 'function');
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function statusOf(err) {
  return err && err.$metadata && err.$metadata.httpStatusCode ? err.$metadata.httpStatusCode : null;
}

function isNotFound(err) {
  const name = err && (err.name || err.Code);
  return name === 'NoSuchKey' || name === 'NotFound' || statusOf(err) === 404;
}

function wrapError(err, op, key) {
  if (err instanceof FoundationError) return err;
  const status = statusOf(err);
  const name = err && (err.name || err.Code) ? (err.name || err.Code) : 'Error';
  if (isNotFound(err)) return new FoundationError('NOT_FOUND', 'No stored object ' + key + '.', { status: 404 });
  if (status === 401 || status === 403 || name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch' || name === 'AccessDenied') {
    return new FoundationError('STORAGE_REJECTED_CREDENTIALS', 'The storage provider refused the request (' + name + (status ? ', HTTP ' + status : '') + '). Check the storage credentials.', { status, name });
  }
  const e = new FoundationError('STORAGE_ERROR', 'Storage ' + op + (key ? ' ' + key : '') + ' failed: ' + (err && err.message ? err.message : String(err)), { status, name });
  e.cause = err;
  return e;
}

// Resolve the active (or the pending) storage configuration and credentials.
// Throws FoundationUnavailableError with STORAGE_OFF, MISSING_MASTER_KEY,
// MISSING_CREDENTIALS, NO_PENDING_PROVIDER or FOUNDATION_NOT_PROVISIONED.
export async function resolveStorageConfig(options) {
  const pending = !!(options && options.pending);
  const f = await ensureFoundation();
  if (!f.schemaPresent || !f.features.storage) {
    throw new FoundationUnavailableError('FOUNDATION_NOT_PROVISIONED', 'Storage is not provisioned for this database (no mock2_foundation storage row).');
  }
  const row = f.features.storage;
  let provider;
  let config;
  if (pending) {
    if (!row.pending) throw new FoundationUnavailableError('NO_PENDING_PROVIDER', 'No storage provider switch is pending.');
    provider = row.pending.provider || 'external';
    config = row.pending.config || {};
  } else {
    if (row.state !== 'on') {
      throw new FoundationUnavailableError('STORAGE_OFF', 'Storage is switched off for this deployment, so file uploads and downloads are unavailable. Turn it on in ProxyPilot.');
    }
    provider = row.provider;
    config = row.config || {};
  }
  if (!f.masterKey.present) {
    throw new FoundationUnavailableError('MISSING_MASTER_KEY', 'The deployment master key is ' + f.masterKey.problem + ' (' + f.masterKey.path + '), so the storage credentials cannot be opened.');
  }
  const idName = pending ? pendingSecretName(SECRET_NAMES.storageAccessKeyId) : SECRET_NAMES.storageAccessKeyId;
  const secretName = pending ? pendingSecretName(SECRET_NAMES.storageSecretAccessKey) : SECRET_NAMES.storageSecretAccessKey;
  const accessKeyId = getSecret(idName);
  const secretAccessKey = getSecret(secretName);
  const missing = [];
  if (!accessKeyId) missing.push(idName);
  if (!secretAccessKey) missing.push(secretName);
  if (missing.length) {
    throw new FoundationUnavailableError('MISSING_CREDENTIALS', 'Storage credentials are missing (' + missing.join(', ') + ').', { missing });
  }
  if (!config.bucket) throw new FoundationError('STORAGE_CONFIG_INVALID', 'The storage configuration has no bucket.');
  return {
    pending,
    provider,
    endpoint: config.endpoint ? String(config.endpoint) : null,
    region: config.region ? String(config.region) : 'us-east-1',
    bucket: String(config.bucket),
    prefix: config.prefix ? String(config.prefix) : '',
    forcePathStyle: config.force_path_style === true,
    credentials: { accessKeyId, secretAccessKey },
  };
}

export class FoundationStorage {
  constructor(resolved, sdk) {
    this.sdk = sdk;
    this.pending = resolved.pending;
    this.provider = resolved.provider;
    this.endpoint = resolved.endpoint;
    this.region = resolved.region;
    this.bucket = resolved.bucket;
    this.prefix = resolved.prefix;
    this.forcePathStyle = resolved.forcePathStyle;
    const clientConfig = {
      region: resolved.region,
      forcePathStyle: resolved.forcePathStyle,
      credentials: resolved.credentials,
      maxAttempts: 3,
      // S3-compatible stores do not all speak the SDK's newer default
      // checksums; send and check them only where the API requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    if (resolved.endpoint) clientConfig.endpoint = resolved.endpoint;
    this.client = new sdk.s3.S3Client(clientConfig);
  }

  info() {
    return {
      pending: this.pending,
      provider: this.provider,
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      prefix: this.prefix,
      forcePathStyle: this.forcePathStyle,
    };
  }

  fullKey(key) {
    validateKey(key);
    return this.prefix + key;
  }

  relKey(full) {
    return this.prefix && full.startsWith(this.prefix) ? full.slice(this.prefix.length) : full;
  }

  async put(key, body, options) {
    const o = options || {};
    const full = this.fullKey(key);
    const s3 = this.sdk.s3;
    const params = { Bucket: this.bucket, Key: full };
    if (o.contentType) params.ContentType = o.contentType;
    if (o.metadata) params.Metadata = o.metadata;
    if (o.cacheControl) params.CacheControl = o.cacheControl;
    const bytes = toBytes(body);
    if (!bytes && !isStreamLike(body)) throw new FoundationError('INVALID_BODY', 'put() takes a Buffer, Uint8Array, string or readable stream.');
    try {
      if (bytes && bytes.length <= MULTIPART_THRESHOLD) {
        const res = await this.client.send(new s3.PutObjectCommand(Object.assign({}, params, { Body: bytes, ContentLength: bytes.length })));
        return { key, etag: res.ETag || null, size: bytes.length };
      }
      const upload = new this.sdk.lib.Upload({
        client: this.client,
        params: Object.assign({}, params, { Body: bytes || body }),
        partSize: PART_SIZE,
        queueSize: 4,
        leavePartsOnError: false,
      });
      const res = await upload.done();
      return { key, etag: res.ETag || null, size: bytes ? bytes.length : null };
    } catch (err) {
      throw wrapError(err, 'put', key);
    }
  }

  async get(key) {
    const full = this.fullKey(key);
    try {
      const res = await this.client.send(new this.sdk.s3.GetObjectCommand({ Bucket: this.bucket, Key: full }));
      return {
        key,
        body: res.Body,
        size: res.ContentLength === undefined ? null : Number(res.ContentLength),
        contentType: res.ContentType || null,
        etag: res.ETag || null,
        lastModified: res.LastModified ? new Date(res.LastModified).toISOString() : null,
        metadata: res.Metadata || {},
      };
    } catch (err) {
      throw wrapError(err, 'get', key);
    }
  }

  async getBuffer(key) {
    const obj = await this.get(key);
    try {
      return await readAll(obj.body);
    } catch (err) {
      throw wrapError(err, 'get', key);
    }
  }

  async sha256(key) {
    const obj = await this.get(key);
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of obj.body) {
        hash.update(chunk);
        size += chunk.length;
      }
    } catch (err) {
      throw wrapError(err, 'get', key);
    }
    return { sha256: hash.digest('hex'), size };
  }

  async head(key) {
    const full = this.fullKey(key);
    try {
      const res = await this.client.send(new this.sdk.s3.HeadObjectCommand({ Bucket: this.bucket, Key: full }));
      return {
        key,
        size: Number(res.ContentLength || 0),
        contentType: res.ContentType || null,
        etag: res.ETag || null,
        lastModified: res.LastModified ? new Date(res.LastModified).toISOString() : null,
        metadata: res.Metadata || {},
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw wrapError(err, 'head', key);
    }
  }

  async delete(key) {
    const full = this.fullKey(key);
    try {
      await this.client.send(new this.sdk.s3.DeleteObjectCommand({ Bucket: this.bucket, Key: full }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw wrapError(err, 'delete', key);
    }
  }

  async list(options) {
    const o = options || {};
    const limit = clampInt(o.limit, 1, 1000, 1000);
    const input = { Bucket: this.bucket, Prefix: this.prefix + (o.prefix || ''), MaxKeys: limit };
    if (o.cursor) input.ContinuationToken = o.cursor;
    let res;
    try {
      res = await this.client.send(new this.sdk.s3.ListObjectsV2Command(input));
    } catch (err) {
      throw wrapError(err, 'list', o.prefix || '');
    }
    return {
      items: (res.Contents || []).map((c) => ({
        key: this.relKey(c.Key),
        size: Number(c.Size || 0),
        etag: c.ETag || null,
        lastModified: c.LastModified ? new Date(c.LastModified).toISOString() : null,
      })),
      cursor: res.IsTruncated ? (res.NextContinuationToken || null) : null,
    };
  }

  async *listAll(options) {
    const o = Object.assign({}, options || {});
    let cursor = null;
    do {
      const page = await this.list(Object.assign({}, o, { cursor }));
      for (const item of page.items) yield item;
      cursor = page.cursor;
    } while (cursor);
  }

  // A time-limited GET URL. Needs the optional @aws-sdk/s3-request-presigner.
  async presignGet(key, options) {
    const o = options || {};
    const full = this.fullKey(key);
    let presigner;
    try {
      presigner = await import('@aws-sdk/s3-request-presigner');
    } catch (err) {
      throw new FoundationError('PRESIGNER_MISSING', 'Presigned URLs need the @aws-sdk/s3-request-presigner package (npm install @aws-sdk/s3-request-presigner).');
    }
    const expiresIn = clampInt(o.expiresIn, 1, 604800, 900);
    return presigner.getSignedUrl(this.client, new this.sdk.s3.GetObjectCommand({ Bucket: this.bucket, Key: full }), { expiresIn });
  }

  // The unauthenticated URL of an object, for the anonymous-access probe.
  objectUrl(key) {
    const full = this.fullKey(key);
    const encKey = full.split('/').map(encodeURIComponent).join('/');
    if (this.endpoint) {
      const u = new URL(this.endpoint);
      const base = u.pathname.replace(/\/+$/, '');
      if (this.forcePathStyle) return u.protocol + '//' + u.host + base + '/' + encodeURIComponent(this.bucket) + '/' + encKey;
      return u.protocol + '//' + this.bucket + '.' + u.host + base + '/' + encKey;
    }
    return 'https://' + this.bucket + '.s3.' + this.region + '.amazonaws.com/' + encKey;
  }

  // true when an anonymous GET is refused, false when it is ALLOWED (a public
  // bucket), null when the endpoint could not be asked.
  async anonymousReadRefused(key) {
    try {
      const res = await fetch(this.objectUrl(key), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      try { await res.arrayBuffer(); } catch (e) { /* drained */ }
      return !(res.status >= 200 && res.status < 300);
    } catch (err) {
      return null;
    }
  }

  destroy() {
    try { this.client.destroy(); } catch (e) { /* already closed */ }
  }
}

const cache = new Map();
onFoundationChange(() => {
  for (const entry of cache.values()) entry.instance.destroy();
  cache.clear();
});

function fingerprint(r) {
  const cred = crypto.createHash('sha256').update(r.credentials.accessKeyId + '\n' + r.credentials.secretAccessKey).digest('hex');
  return JSON.stringify([r.provider, r.endpoint, r.region, r.bucket, r.prefix, r.forcePathStyle, cred]);
}

// The adapter for the active storage, or for the pending provider of a switch.
export async function openStorage(options) {
  const pending = !!(options && options.pending);
  const resolved = await resolveStorageConfig({ pending });
  const slot = pending ? 'pending' : 'active';
  const fp = fingerprint(resolved);
  const hit = cache.get(slot);
  if (hit && hit.fp === fp) return hit.instance;
  if (hit) hit.instance.destroy();
  const sdk = await loadSdk();
  const instance = new FoundationStorage(resolved, sdk);
  cache.set(slot, { fp, instance });
  return instance;
}

// The active storage, ready to use: storage.put('reports/1.pdf', buffer).
export const storage = Object.freeze({
  async put(key, body, options) { return (await openStorage()).put(key, body, options); },
  async get(key) { return (await openStorage()).get(key); },
  async getBuffer(key) { return (await openStorage()).getBuffer(key); },
  async head(key) { return (await openStorage()).head(key); },
  async delete(key) { return (await openStorage()).delete(key); },
  async list(options) { return (await openStorage()).list(options); },
  async *listAll(options) { yield* (await openStorage()).listAll(options); },
  async presignGet(key, options) { return (await openStorage()).presignGet(key, options); },
  async info() { return (await openStorage()).info(); },
});
`;
}

function storageDts() {
  return `${HEADER}
import type { Readable } from 'node:stream';

export type StorageBody = Buffer | Uint8Array | string | Readable | AsyncIterable<Uint8Array>;
export interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
}
export interface PutResult { key: string; etag: string | null; size: number | null }
export interface StoredObject {
  key: string;
  body: Readable;
  size: number | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  metadata: Record<string, string>;
}
export interface ObjectInfo {
  key: string;
  size: number;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  metadata: Record<string, string>;
}
export interface ListItem { key: string; size: number; etag: string | null; lastModified: string | null }
export interface ListPage { items: ListItem[]; cursor: string | null }
export interface ListOptions { prefix?: string; cursor?: string | null; limit?: number }
export interface StorageDescription {
  pending: boolean;
  provider: string;
  endpoint: string | null;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
}

export declare class FoundationStorage {
  readonly pending: boolean;
  readonly provider: string;
  readonly endpoint: string | null;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly forcePathStyle: boolean;
  info(): StorageDescription;
  put(key: string, body: StorageBody, options?: PutOptions): Promise<PutResult>;
  get(key: string): Promise<StoredObject>;
  getBuffer(key: string): Promise<Buffer>;
  sha256(key: string): Promise<{ sha256: string; size: number }>;
  head(key: string): Promise<ObjectInfo | null>;
  delete(key: string): Promise<void>;
  list(options?: ListOptions): Promise<ListPage>;
  listAll(options?: Omit<ListOptions, 'cursor'>): AsyncGenerator<ListItem, void, undefined>;
  presignGet(key: string, options?: { expiresIn?: number }): Promise<string>;
  objectUrl(key: string): string;
  anonymousReadRefused(key: string): Promise<boolean | null>;
  destroy(): void;
}

export declare function resolveStorageConfig(options?: { pending?: boolean }): Promise<StorageDescription & { credentials: { accessKeyId: string; secretAccessKey: string } }>;
export declare function openStorage(options?: { pending?: boolean }): Promise<FoundationStorage>;

export declare const storage: {
  put(key: string, body: StorageBody, options?: PutOptions): Promise<PutResult>;
  get(key: string): Promise<StoredObject>;
  getBuffer(key: string): Promise<Buffer>;
  head(key: string): Promise<ObjectInfo | null>;
  delete(key: string): Promise<void>;
  list(options?: ListOptions): Promise<ListPage>;
  listAll(options?: Omit<ListOptions, 'cursor'>): AsyncGenerator<ListItem, void, undefined>;
  presignGet(key: string, options?: { expiresIn?: number }): Promise<string>;
  info(): Promise<StorageDescription>;
};
`;
}

/* ---------------------------------------------------------------------------
   embeddings.mjs
   --------------------------------------------------------------------------- */
function embeddingsMjs() {
  return HEADER + String.raw`//
// The embeddings adapter: OpenAI-compatible POST {base_url}/embeddings.
//   local              the bundled text-embeddings-inference server, no key
//                      (development quality - LOCAL_EMBEDDINGS_WARNING)
//   openai             https://api.openai.com/v1 + key, sends "dimensions"
//   openai_compatible  config.base_url, + key when one is stored (a server
//                      may take none; the host allows that, and a server
//                      that wants one answers 401 -> missing_credentials)
// Every vector it returns is checked against the configured dimensions; a
// mismatch is refused (DIMENSIONS_MISMATCH), so vector spaces are never mixed.
import { ensureFoundation, getFoundation, getSecret, onFoundationChange } from './config.mjs';
import { STACK, SECRET_NAMES, EMBEDDING_PROVIDERS, VECTOR_METRICS, LOCAL_EMBEDDINGS_WARNING, pendingSecretName } from './contract.mjs';
import { FoundationError, FoundationUnavailableError } from './errors.mjs';

export { LOCAL_EMBEDDINGS_WARNING };

const LOCAL_BASE_URL = 'http://' + STACK.embeddings.listen + ':' + STACK.embeddings.port + '/v1';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const RETRIES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function resolveEmbeddingsConfig(options) {
  const pending = !!(options && options.pending);
  const f = await ensureFoundation();
  if (!f.schemaPresent || !f.features.embeddings) {
    throw new FoundationUnavailableError('FOUNDATION_NOT_PROVISIONED', 'Embeddings are not provisioned for this database (no mock2_foundation embeddings row).');
  }
  const row = f.features.embeddings;
  let provider;
  let config;
  if (pending) {
    if (!row.pending) throw new FoundationUnavailableError('NO_PENDING_PROVIDER', 'No embedding provider switch is pending.');
    provider = row.pending.provider;
    config = row.pending.config || {};
  } else {
    if (row.state !== 'on') {
      throw new FoundationUnavailableError('EMBEDDINGS_OFF', 'Embeddings are switched off for this deployment, so semantic search is unavailable. The stored vectors are kept.');
    }
    provider = row.provider;
    config = row.config || {};
  }
  if (!EMBEDDING_PROVIDERS.includes(provider)) throw new FoundationError('EMBEDDINGS_CONFIG_INVALID', 'Unknown embedding provider "' + provider + '".');
  const dimensions = Number(config.dimensions);
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000) throw new FoundationError('EMBEDDINGS_CONFIG_INVALID', 'The embedding configuration has no valid dimensions.');
  if (!config.model) throw new FoundationError('EMBEDDINGS_CONFIG_INVALID', 'The embedding configuration has no model.');
  const metric = config.metric || 'cosine';
  if (!VECTOR_METRICS.includes(metric)) throw new FoundationError('EMBEDDINGS_CONFIG_INVALID', 'Unknown vector metric "' + metric + '".');
  let baseUrl = config.base_url ? String(config.base_url) : '';
  if (!baseUrl && provider === 'local') baseUrl = LOCAL_BASE_URL;
  if (!baseUrl && provider === 'openai') baseUrl = OPENAI_BASE_URL;
  if (!baseUrl) throw new FoundationError('EMBEDDINGS_CONFIG_INVALID', 'An OpenAI-compatible provider needs a base_url.');
  let apiKey = null;
  const keyName = pending ? pendingSecretName(SECRET_NAMES.embeddingsApiKey) : SECRET_NAMES.embeddingsApiKey;
  // OpenAI always needs a key. An OpenAI-compatible server may take none: the
  // host stores a key only when the person gave one, so one is sent if stored.
  if (provider === 'openai' || (provider === 'openai_compatible' && f.secretNames.includes(keyName))) {
    if (!f.masterKey.present) {
      throw new FoundationUnavailableError('MISSING_MASTER_KEY', 'The deployment master key is ' + f.masterKey.problem + ' (' + f.masterKey.path + '), so the embedding API key cannot be opened.');
    }
    apiKey = getSecret(keyName);
    if (!apiKey) throw new FoundationUnavailableError('MISSING_CREDENTIALS', 'The ' + provider + ' embedding provider has no API key (' + keyName + ').', { missing: [keyName] });
  }
  return {
    pending,
    provider,
    model: String(config.model),
    dimensions,
    metric,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    batchSize: clampInt(config.batch_size, 1, 2048, 64),
    timeoutMs: clampInt(config.timeout_ms, 1000, 600000, 30000),
  };
}

export class FoundationEmbeddings {
  constructor(resolved) {
    this.pending = resolved.pending;
    this.provider = resolved.provider;
    this.model = resolved.model;
    this.dimensions = resolved.dimensions;
    this.metric = resolved.metric;
    this.baseUrl = resolved.baseUrl;
    this.isLocal = resolved.provider === 'local';
    this.warning = this.isLocal ? LOCAL_EMBEDDINGS_WARNING : null;
    this.batchSize = resolved.batchSize;
    this.timeoutMs = resolved.timeoutMs;
    Object.defineProperty(this, 'apiKey', { value: resolved.apiKey, enumerable: false });
  }

  info() {
    return {
      pending: this.pending,
      provider: this.provider,
      model: this.model,
      dimensions: this.dimensions,
      metric: this.metric,
      baseUrl: this.baseUrl,
      isLocal: this.isLocal,
      warning: this.warning,
    };
  }

  async embed(texts) {
    if (!Array.isArray(texts)) throw new FoundationError('INVALID_INPUT', 'embed() takes an array of strings.');
    for (const t of texts) {
      if (typeof t !== 'string' || !t.length) throw new FoundationError('INVALID_INPUT', 'Every text to embed must be a non-empty string.');
    }
    const out = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.request(batch);
      for (const v of vectors) out.push(v);
    }
    return out;
  }

  async embedOne(text) {
    const [v] = await this.embed([text]);
    return v;
  }

  async request(batch) {
    const body = { model: this.model, input: batch };
    if (this.provider === 'openai') body.dimensions = this.dimensions;
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.apiKey) headers.authorization = 'Bearer ' + this.apiKey;
    let lastErr = null;
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      let res;
      try {
        res = await fetch(this.baseUrl + '/embeddings', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastErr = new FoundationError('PROVIDER_UNREACHABLE', 'The embedding provider at ' + this.baseUrl + ' could not be reached: ' + (err && err.cause && err.cause.code ? err.cause.code : (err && err.message ? err.message : String(err))) + '.');
        if (attempt < RETRIES) { await sleep(500 * (attempt + 1)); continue; }
        throw lastErr;
      }
      if (res.ok) return this.parse(await res.json(), batch.length);
      const text = await res.text().catch(() => '');
      let message = text.slice(0, 300);
      try { const j = JSON.parse(text); if (j && j.error) message = String(j.error.message || j.error).slice(0, 300); } catch (e) { /* not json */ }
      if (res.status === 401 || res.status === 403) {
        throw new FoundationError('PROVIDER_REJECTED_CREDENTIALS', 'The embedding provider refused the API key (HTTP ' + res.status + ').', { status: res.status });
      }
      lastErr = new FoundationError('PROVIDER_ERROR', 'The embedding provider answered HTTP ' + res.status + (message ? ': ' + message : '') + '.', { status: res.status });
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 500 * (attempt + 1));
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }

  parse(json, count) {
    const data = json && Array.isArray(json.data) ? json.data.slice() : null;
    if (!data || data.length !== count) {
      throw new FoundationError('PROVIDER_ERROR', 'The embedding provider returned ' + (data ? data.length : 'no') + ' embeddings for ' + count + ' inputs.');
    }
    data.sort((a, b) => (a.index || 0) - (b.index || 0));
    return data.map((d) => {
      const v = d && d.embedding;
      if (!Array.isArray(v)) throw new FoundationError('PROVIDER_ERROR', 'The embedding provider returned an embedding that is not an array of numbers.');
      if (v.length !== this.dimensions) {
        throw new FoundationError('DIMENSIONS_MISMATCH', 'The embedding provider returned ' + v.length + ' dimensions but this deployment is configured for ' + this.dimensions
          + ' (' + this.provider + ' ' + this.model + '). Refusing it: vectors of different spaces are never mixed.', { returned: v.length, configured: this.dimensions });
      }
      for (const n of v) {
        if (typeof n !== 'number' || !Number.isFinite(n)) throw new FoundationError('PROVIDER_ERROR', 'The embedding provider returned a non-numeric value.');
      }
      return v;
    });
  }
}

const cache = new Map();
onFoundationChange(() => { cache.clear(); });

export async function openEmbeddings(options) {
  const pending = !!(options && options.pending);
  const resolved = await resolveEmbeddingsConfig({ pending });
  const slot = pending ? 'pending' : 'active';
  const fp = JSON.stringify([resolved.provider, resolved.model, resolved.dimensions, resolved.metric, resolved.baseUrl, resolved.apiKey ? resolved.apiKey.length : 0, resolved.batchSize, resolved.timeoutMs]);
  const hit = cache.get(slot);
  if (hit && hit.fp === fp && hit.instance.apiKey === resolved.apiKey) return hit.instance;
  const instance = new FoundationEmbeddings(resolved);
  cache.set(slot, { fp, instance });
  return instance;
}

// Whether the ACTIVE provider is the bundled local model (on or off). Show
// LOCAL_EMBEDDINGS_WARNING wherever an administrator sees the setting.
export function isLocalEmbeddings() {
  const f = getFoundation();
  return !!(f && f.features.embeddings && f.features.embeddings.provider === 'local');
}

export const embeddings = Object.freeze({
  async embed(texts) { return (await openEmbeddings()).embed(texts); },
  async embedOne(text) { return (await openEmbeddings()).embedOne(text); },
  async info() { return (await openEmbeddings()).info(); },
});
`;
}

function embeddingsDts() {
  return `${HEADER}
export type EmbeddingProvider = 'local' | 'openai' | 'openai_compatible';
export type VectorMetric = 'cosine' | 'l2' | 'ip';

export interface EmbeddingsDescription {
  pending: boolean;
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  metric: VectorMetric;
  baseUrl: string;
  isLocal: boolean;
  warning: string | null;
}

export declare class FoundationEmbeddings {
  readonly pending: boolean;
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly dimensions: number;
  readonly metric: VectorMetric;
  readonly baseUrl: string;
  readonly isLocal: boolean;
  readonly warning: string | null;
  info(): EmbeddingsDescription;
  embed(texts: readonly string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
}

export declare const LOCAL_EMBEDDINGS_WARNING: string;
export declare function resolveEmbeddingsConfig(options?: { pending?: boolean }): Promise<Omit<EmbeddingsDescription, 'isLocal' | 'warning'> & { apiKey: string | null; batchSize: number; timeoutMs: number }>;
export declare function openEmbeddings(options?: { pending?: boolean }): Promise<FoundationEmbeddings>;
export declare function isLocalEmbeddings(): boolean;
export declare const embeddings: {
  embed(texts: readonly string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
  info(): Promise<EmbeddingsDescription>;
};
`;
}

/* ---------------------------------------------------------------------------
   vector.mjs
   --------------------------------------------------------------------------- */
function vectorMjs() {
  return HEADER + String.raw`//
// Vector helpers over the ACTIVE index (mock2_foundation.vector_indexes, state
// 'active'). Each index is its own table, mock2_foundation.vec_<id>, with one
// row per (source, item_id, chunk). The active index is only ever written with
// the provider/model/dimensions it was built with: when the embedding provider
// changes, ProxyPilot re-embeds into a NEW index (jobs.mjs reembed), validates
// it, and only then switches. Upserting with a different provider is refused
// (INDEX_PROVIDER_MISMATCH) rather than mixing vector spaces.
import crypto from 'node:crypto';
import { getPool } from './config.mjs';
import { vectorTableName, vectorColumnPlan } from './contract.mjs';
import { openEmbeddings } from './embeddings.mjs';
import { FoundationError, FoundationUnavailableError } from './errors.mjs';

const SCHEMA = 'mock2_foundation';
const OPERATORS = Object.freeze({ cosine: '<=>', l2: '<->', ip: '<#>' });

export function qualifiedTable(indexId) {
  return SCHEMA + '.' + vectorTableName(indexId);
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function distanceOperator(metric) {
  const op = OPERATORS[metric];
  if (!op) throw new FoundationError('INVALID_METRIC', 'Unknown vector metric "' + metric + '".');
  return op;
}

// '[0.1,0.2,...]' — pgvector's text form. Rejects non-finite values.
export function toVectorLiteral(values) {
  if (!Array.isArray(values) || !values.length) throw new FoundationError('INVALID_VECTOR', 'A vector must be a non-empty array of numbers.');
  for (const n of values) {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new FoundationError('INVALID_VECTOR', 'A vector must contain only finite numbers.');
  }
  return '[' + values.join(',') + ']';
}

// Score: higher is closer. cosine 1 - distance; ip the inner product; l2
// 1 / (1 + distance).
export function scoreFor(metric, distance) {
  if (metric === 'cosine') return 1 - distance;
  if (metric === 'ip') return -distance;
  return 1 / (1 + distance);
}

function normalizeIndex(row) {
  if (!row) return null;
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    dimensions: Number(row.dimensions),
    metric: row.metric,
    state: row.state,
    table_name: row.table_name,
    item_count: Number(row.item_count || 0),
    validation: row.validation || null,
    created_at: iso(row.created_at),
    activated_at: iso(row.activated_at),
    retired_at: iso(row.retired_at),
  };
}

export async function getActiveIndex(db) {
  const r = await (db || getPool()).query("SELECT * FROM mock2_foundation.vector_indexes WHERE state = 'active'");
  return normalizeIndex(r.rows[0]);
}

export async function listIndexes(db) {
  const r = await (db || getPool()).query('SELECT * FROM mock2_foundation.vector_indexes ORDER BY created_at, id');
  return r.rows.map(normalizeIndex);
}

// Create an index's table (and its HNSW index where pgvector supports one for
// these dimensions). Idempotent.
export async function ensureIndexTable(index, db) {
  const q = db || getPool();
  const plan = vectorColumnPlan(index.dimensions);
  const name = vectorTableName(index.id);
  const table = SCHEMA + '.' + name;
  await q.query('CREATE TABLE IF NOT EXISTS ' + table + ' ('
    + 'source text NOT NULL, '
    + 'item_id text NOT NULL, '
    + 'chunk integer NOT NULL DEFAULT 0, '
    + 'content text NOT NULL, '
    + 'content_sha256 text NOT NULL, '
    + 'embedding ' + plan.type + ' NOT NULL, '
    + "metadata jsonb NOT NULL DEFAULT '{}'::jsonb, "
    + 'updated_at timestamptz NOT NULL DEFAULT now(), '
    + 'PRIMARY KEY (source, item_id, chunk))');
  const metric = index.metric || 'cosine';
  if (plan.ann === 'hnsw') {
    const ops = plan.ops[metric];
    if (!ops) throw new FoundationError('INVALID_METRIC', 'Unknown vector metric "' + metric + '".');
    await q.query('CREATE INDEX IF NOT EXISTS ' + name + '_ann ON ' + table + ' USING hnsw (embedding ' + ops + ')');
  }
  return { table, plan };
}

function newIndexId() {
  return 'ix_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// The active index, creating the first one (empty, from the ACTIVE embedding
// provider) when none exists yet.
export async function ensureActiveIndex(options) {
  const existing = await getActiveIndex();
  if (existing) return existing;
  const emb = (options && options.embedder) || await openEmbeddings();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('mock2_foundation.vector_indexes'))");
    const again = await client.query("SELECT * FROM mock2_foundation.vector_indexes WHERE state = 'active'");
    if (again.rows[0]) {
      await client.query('COMMIT');
      return normalizeIndex(again.rows[0]);
    }
    const id = newIndexId();
    const row = { id, provider: emb.provider, model: emb.model, dimensions: emb.dimensions, metric: emb.metric };
    await ensureIndexTable(row, client);
    const ins = await client.query(
      'INSERT INTO mock2_foundation.vector_indexes (id, provider, model, dimensions, metric, state, table_name, item_count, validation, activated_at) '
      + "VALUES ($1, $2, $3, $4, $5, 'active', $6, 0, $7::jsonb, now()) RETURNING *",
      [id, row.provider, row.model, row.dimensions, row.metric, vectorTableName(id), JSON.stringify({ initial: true, note: 'created empty on first use from the active embedding provider' })],
    );
    await client.query('COMMIT');
    return normalizeIndex(ins.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function assertMatches(index, emb) {
  if (index.provider !== emb.provider || index.model !== emb.model || index.dimensions !== emb.dimensions) {
    throw new FoundationUnavailableError('INDEX_PROVIDER_MISMATCH',
      'The active vector index (' + index.id + ') was built with ' + index.provider + ' ' + index.model + ' (' + index.dimensions + ' dimensions), '
      + 'but the active embedding provider is ' + emb.provider + ' ' + emb.model + ' (' + emb.dimensions + ' dimensions). '
      + 'Vector spaces are never mixed: the index must be re-embedded first (ProxyPilot does this when the provider changes).',
      { index: index.id });
  }
}

function validateItem(item) {
  if (!item || typeof item !== 'object') throw new FoundationError('INVALID_INPUT', 'An item must be an object.');
  const source = item.source;
  const itemId = item.itemId === undefined || item.itemId === null ? '' : String(item.itemId);
  const chunk = item.chunk === undefined ? 0 : item.chunk;
  if (typeof source !== 'string' || !source || source.length > 200) throw new FoundationError('INVALID_INPUT', 'source must be a non-empty string (at most 200 characters).');
  if (!itemId || itemId.length > 500) throw new FoundationError('INVALID_INPUT', 'itemId must be a non-empty string (at most 500 characters).');
  if (!Number.isInteger(chunk) || chunk < 0) throw new FoundationError('INVALID_INPUT', 'chunk must be a non-negative integer.');
  if (typeof item.content !== 'string' || !item.content) throw new FoundationError('INVALID_INPUT', 'content must be a non-empty string.');
  const metadata = item.metadata === undefined || item.metadata === null ? {} : item.metadata;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new FoundationError('INVALID_INPUT', 'metadata must be a plain object.');
  return { source, itemId, chunk, content: item.content, metadata };
}

// Insert or update items in the active index. An item whose content is
// unchanged (same sha256) is NOT re-embedded; only its metadata is updated.
export async function upsertMany(items) {
  if (!Array.isArray(items)) throw new FoundationError('INVALID_INPUT', 'upsertMany() takes an array of items.');
  const list = items.map(validateItem);
  if (!list.length) return [];
  const emb = await openEmbeddings();
  const index = await ensureActiveIndex({ embedder: emb });
  assertMatches(index, emb);
  const plan = vectorColumnPlan(index.dimensions);
  const table = qualifiedTable(index.id);
  const pool = getPool();
  const shas = list.map((it) => sha256Hex(it.content));
  const existing = await pool.query(
    'SELECT t.source, t.item_id, t.chunk, t.content_sha256 FROM ' + table + ' t '
    + 'JOIN unnest($1::text[], $2::text[], $3::int[]) AS k(source, item_id, chunk) '
    + 'ON t.source = k.source AND t.item_id = k.item_id AND t.chunk = k.chunk',
    [list.map((i) => i.source), list.map((i) => i.itemId), list.map((i) => i.chunk)],
  );
  const known = new Map(existing.rows.map((r) => [r.source + '\u0000' + r.item_id + '\u0000' + r.chunk, r.content_sha256]));
  const toEmbed = [];
  list.forEach((it, i) => {
    if (known.get(it.source + '\u0000' + it.itemId + '\u0000' + it.chunk) !== shas[i]) toEmbed.push(i);
  });
  const vectors = toEmbed.length ? await emb.embed(toEmbed.map((i) => list[i].content)) : [];
  const vectorFor = new Map(toEmbed.map((i, n) => [i, vectors[n]]));
  const client = await pool.connect();
  const results = [];
  let added = 0;
  try {
    await client.query('BEGIN');
    for (let i = 0; i < list.length; i += 1) {
      const it = list[i];
      const meta = JSON.stringify(it.metadata);
      if (!vectorFor.has(i)) {
        await client.query('UPDATE ' + table + ' SET metadata = $4::jsonb, updated_at = now() WHERE source = $1 AND item_id = $2 AND chunk = $3 AND metadata IS DISTINCT FROM $4::jsonb',
          [it.source, it.itemId, it.chunk, meta]);
        results.push({ indexId: index.id, embedded: false, inserted: false });
        continue;
      }
      const r = await client.query(
        'INSERT INTO ' + table + ' (source, item_id, chunk, content, content_sha256, embedding, metadata, updated_at) '
        + 'VALUES ($1, $2, $3, $4, $5, $6::' + plan.type + ', $7::jsonb, now()) '
        + 'ON CONFLICT (source, item_id, chunk) DO UPDATE SET content = EXCLUDED.content, content_sha256 = EXCLUDED.content_sha256, '
        + 'embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = now() '
        + 'RETURNING (xmax = 0) AS inserted',
        [it.source, it.itemId, it.chunk, it.content, shas[i], toVectorLiteral(vectorFor.get(i)), meta],
      );
      const inserted = !!r.rows[0].inserted;
      if (inserted) added += 1;
      results.push({ indexId: index.id, embedded: true, inserted });
    }
    if (added) await client.query('UPDATE mock2_foundation.vector_indexes SET item_count = item_count + $2 WHERE id = $1', [index.id, added]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return results;
}

export async function upsert(item) {
  const [r] = await upsertMany([item]);
  return r;
}

// Nearest items to a query text in the active index.
export async function search(options) {
  const o = options || {};
  if (typeof o.query !== 'string' || !o.query) throw new FoundationError('INVALID_INPUT', 'search() needs a non-empty query string.');
  const k = o.k === undefined ? 10 : o.k;
  if (!Number.isInteger(k) || k < 1 || k > 200) throw new FoundationError('INVALID_INPUT', 'k must be an integer from 1 to 200.');
  if (o.source !== undefined && (typeof o.source !== 'string' || !o.source)) throw new FoundationError('INVALID_INPUT', 'source must be a non-empty string.');
  const emb = await openEmbeddings();
  const index = await ensureActiveIndex({ embedder: emb });
  assertMatches(index, emb);
  const [qv] = await emb.embed([o.query]);
  return searchIndex(index, qv, { k, source: o.source });
}

// Search one index by a query vector (also used by the re-embed validation).
export async function searchIndex(index, queryVector, options) {
  const o = options || {};
  const k = o.k || 10;
  const plan = vectorColumnPlan(index.dimensions);
  const table = qualifiedTable(index.id);
  const op = distanceOperator(index.metric || 'cosine');
  const params = [toVectorLiteral(queryVector), k];
  let where = '';
  if (o.source) { params.push(o.source); where = ' WHERE source = $3'; }
  const client = await (o.db || getPool()).connect();
  try {
    await client.query('BEGIN');
    // Filtered HNSW scans keep looking until k rows pass the filter.
    await client.query("SELECT set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'relaxed_order', true)", [String(Math.max(40, k * 2))]);
    const r = await client.query(
      'SELECT source, item_id, chunk, content, content_sha256, metadata, updated_at, (embedding ' + op + ' $1::' + plan.type + ') AS distance FROM ' + table + where
      + ' ORDER BY embedding ' + op + ' $1::' + plan.type + ' LIMIT $2',
      params,
    );
    await client.query('COMMIT');
    return r.rows
      .map((row) => ({
        source: row.source,
        itemId: row.item_id,
        chunk: Number(row.chunk),
        content: row.content,
        contentSha256: row.content_sha256,
        metadata: row.metadata || {},
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        distance: Number(row.distance),
        score: scoreFor(index.metric, Number(row.distance)),
      }))
      .sort((a, b) => a.distance - b.distance);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Remove every chunk of an item from the active index. Needs no embedding
// provider, so it works with embeddings switched off.
export async function remove(options) {
  const o = options || {};
  if (typeof o.source !== 'string' || !o.source) throw new FoundationError('INVALID_INPUT', 'remove() needs a source.');
  const itemId = o.itemId === undefined || o.itemId === null ? '' : String(o.itemId);
  if (!itemId) throw new FoundationError('INVALID_INPUT', 'remove() needs an itemId.');
  const index = await getActiveIndex();
  if (!index) return { removed: 0 };
  const pool = getPool();
  const r = await pool.query('DELETE FROM ' + qualifiedTable(index.id) + ' WHERE source = $1 AND item_id = $2', [o.source, itemId]);
  if (r.rowCount) await pool.query('UPDATE mock2_foundation.vector_indexes SET item_count = GREATEST(item_count - $2, 0) WHERE id = $1', [index.id, r.rowCount]);
  return { removed: r.rowCount || 0 };
}

export const vector = Object.freeze({
  upsert,
  upsertMany,
  search,
  remove,
  activeIndex: () => getActiveIndex(),
  listIndexes: () => listIndexes(),
});
`;
}

function vectorDts() {
  return `${HEADER}
import type { VectorMetric } from './embeddings.mjs';
import type { VectorColumnPlan } from './contract.mjs';

export interface VectorItemInput {
  source: string;
  itemId: string;
  chunk?: number;
  content: string;
  metadata?: Record<string, unknown>;
}
export interface UpsertResult { indexId: string; embedded: boolean; inserted: boolean }
export interface SearchOptions { query: string; k?: number; source?: string }
export interface SearchHit {
  source: string;
  itemId: string;
  chunk: number;
  content: string;
  contentSha256: string;
  metadata: Record<string, unknown>;
  updatedAt: string | null;
  distance: number;
  /** Higher is closer: cosine 1 - distance; ip the inner product; l2 1 / (1 + distance). */
  score: number;
}
export interface VectorIndex {
  id: string;
  provider: string;
  model: string;
  dimensions: number;
  metric: VectorMetric;
  state: 'building' | 'ready' | 'active' | 'retired' | 'failed';
  table_name: string;
  item_count: number;
  validation: unknown;
  created_at: string | null;
  activated_at: string | null;
  retired_at: string | null;
}

export declare function qualifiedTable(indexId: string): string;
export declare function sha256Hex(text: string): string;
export declare function distanceOperator(metric: VectorMetric): string;
export declare function toVectorLiteral(values: readonly number[]): string;
export declare function scoreFor(metric: VectorMetric, distance: number): number;
export declare function getActiveIndex(): Promise<VectorIndex | null>;
export declare function listIndexes(): Promise<VectorIndex[]>;
export declare function ensureIndexTable(index: Pick<VectorIndex, 'id' | 'dimensions' | 'metric'>): Promise<{ table: string; plan: VectorColumnPlan }>;
export declare function ensureActiveIndex(): Promise<VectorIndex>;
export declare function upsert(item: VectorItemInput): Promise<UpsertResult>;
export declare function upsertMany(items: readonly VectorItemInput[]): Promise<UpsertResult[]>;
export declare function search(options: SearchOptions): Promise<SearchHit[]>;
export declare function searchIndex(index: VectorIndex, queryVector: readonly number[], options?: { k?: number; source?: string }): Promise<SearchHit[]>;
export declare function remove(options: { source: string; itemId: string }): Promise<{ removed: number }>;
export declare const vector: {
  upsert(item: VectorItemInput): Promise<UpsertResult>;
  upsertMany(items: readonly VectorItemInput[]): Promise<UpsertResult[]>;
  search(options: SearchOptions): Promise<SearchHit[]>;
  remove(options: { source: string; itemId: string }): Promise<{ removed: number }>;
  activeIndex(): Promise<VectorIndex | null>;
  listIndexes(): Promise<VectorIndex[]>;
};
`;
}

/* ---------------------------------------------------------------------------
   health.mjs
   --------------------------------------------------------------------------- */
function healthMjs() {
  return HEADER + String.raw`//
// Health from REAL operations only — a filled-in setting is never readiness:
//   database    a query plus a vector operation ('[1,2,3]' <-> '[1,2,4]' = 1)
//   storage     put -> get -> delete of .mock2-health/<uuid>, plus an
//               unauthenticated GET that must be refused
//   embeddings  one embedding of a probe text, dimensions checked
// Statuses are HEALTH_STATUSES; results are written to mock2_foundation.health.
import crypto from 'node:crypto';
import { ensureFoundation, getPool, describeDatabase, databaseUrl } from './config.mjs';
import { FOUNDATION_VERSION, LOCAL_EMBEDDINGS_WARNING } from './contract.mjs';
import { openStorage } from './storage.mjs';
import { openEmbeddings, isLocalEmbeddings } from './embeddings.mjs';

const PROBE_TEXT = 'mock2 foundation health probe';
const OFF_CODES = new Set(['STORAGE_OFF', 'EMBEDDINGS_OFF']);
const CREDENTIAL_CODES = new Set(['MISSING_CREDENTIALS', 'MISSING_MASTER_KEY', 'PROVIDER_REJECTED_CREDENTIALS', 'STORAGE_REJECTED_CREDENTIALS']);

function statusForError(err) {
  const code = err && err.code ? err.code : null;
  if (OFF_CODES.has(code)) return 'off';
  if (CREDENTIAL_CODES.has(code)) return 'missing_credentials';
  return 'unavailable';
}

function failure(component, err, extra) {
  return {
    component,
    status: statusForError(err),
    detail: Object.assign({ reason: err && err.code ? err.code : 'ERROR', message: err && err.message ? err.message : String(err) }, extra || {}),
  };
}

function safeEndpoint(endpoint) {
  if (!endpoint) return null;
  try {
    const u = new URL(endpoint);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch (e) {
    return null;
  }
}

export async function probeDatabase() {
  const started = Date.now();
  const target = describeDatabase(databaseUrl());
  const pool = getPool();
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    return {
      component: 'database',
      status: err && err.code === '57P03' ? 'starting' : 'unavailable',
      detail: { reason: 'DATABASE_UNREACHABLE', message: err.message, target },
    };
  }
  try {
    const r = await pool.query("SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS d");
    const d = Number(r.rows[0].d);
    if (Math.abs(d - 1) > 1e-9) {
      return { component: 'database', status: 'degraded', detail: { reason: 'VECTOR_WRONG_RESULT', message: 'The vector probe returned ' + d + ', expected 1.', target } };
    }
  } catch (err) {
    return { component: 'database', status: 'degraded', detail: { reason: 'VECTOR_UNAVAILABLE', message: 'Queries work but the vector extension does not: ' + err.message, target } };
  }
  return { component: 'database', status: 'ready', detail: { target, vector: true, latency_ms: Date.now() - started } };
}

export async function probeStorage(options) {
  const pending = !!(options && options.pending);
  let st;
  try {
    st = await openStorage({ pending });
  } catch (err) {
    return failure('storage', err, { pending });
  }
  const started = Date.now();
  const info = { pending, provider: st.provider, bucket: st.bucket, endpoint: safeEndpoint(st.endpoint) };
  const key = '.mock2-health/' + crypto.randomUUID();
  const payload = crypto.randomBytes(64);
  let wrote = false;
  try {
    await st.put(key, payload, { contentType: 'application/octet-stream' });
    wrote = true;
    const back = await st.getBuffer(key);
    if (!back.equals(payload)) {
      return { component: 'storage', status: 'degraded', detail: Object.assign({ reason: 'READBACK_MISMATCH', message: 'The probe object read back different bytes.' }, info) };
    }
    const anonymousRefused = await st.anonymousReadRefused(key);
    await st.delete(key);
    wrote = false;
    if (await st.head(key)) {
      return { component: 'storage', status: 'degraded', detail: Object.assign({ reason: 'DELETE_NOT_EFFECTIVE', message: 'The probe object is still there after delete.' }, info) };
    }
    if (anonymousRefused === false) {
      return { component: 'storage', status: 'degraded', detail: Object.assign({ reason: 'ANONYMOUS_READ_ALLOWED', message: 'The bucket answers unauthenticated reads; it must be private.' }, info) };
    }
    return { component: 'storage', status: 'ready', detail: Object.assign({ anonymous_refused: anonymousRefused, latency_ms: Date.now() - started }, info) };
  } catch (err) {
    if (wrote) await st.delete(key).catch(() => {});
    return failure('storage', err, info);
  }
}

export async function probeEmbeddings(options) {
  const pending = !!(options && options.pending);
  let emb;
  try {
    emb = await openEmbeddings({ pending });
  } catch (err) {
    return failure('embeddings', err, { pending });
  }
  const started = Date.now();
  const info = { pending, provider: emb.provider, model: emb.model, dimensions: emb.dimensions, is_local: emb.isLocal };
  if (emb.isLocal) info.warning = LOCAL_EMBEDDINGS_WARNING;
  try {
    const v = await emb.embedOne(PROBE_TEXT);
    return { component: 'embeddings', status: 'ready', detail: Object.assign({ returned_dimensions: v.length, latency_ms: Date.now() - started }, info) };
  } catch (err) {
    return failure('embeddings', err, info);
  }
}

async function writeHealth(results) {
  const pool = getPool();
  for (const r of results) {
    await pool.query(
      'INSERT INTO mock2_foundation.health (component, status, detail, checked_at) VALUES ($1, $2, $3::jsonb, now()) '
      + 'ON CONFLICT (component) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at',
      [r.component, r.status, JSON.stringify(r.detail || {})],
    );
  }
}

// What health reports when the database itself cannot be reached: storage and
// embeddings are configured IN the database, so they are unknown too.
export function databaseUnreachableResults(err) {
  const dependent = (component) => ({ component, status: 'unavailable', detail: { reason: 'DATABASE_UNREACHABLE', message: 'The foundation configuration lives in the database, which is unreachable.' } });
  return [
    { component: 'database', status: 'unavailable', detail: { reason: err && err.code ? err.code : 'DATABASE_UNREACHABLE', message: err && err.message ? err.message : String(err) } },
    dependent('storage'),
    dependent('embeddings'),
  ];
}

// All three probes; writes mock2_foundation.health unless write is false.
export async function runHealth(options) {
  const write = !(options && options.write === false);
  let state;
  try {
    state = await ensureFoundation();
  } catch (err) {
    return databaseUnreachableResults(err);
  }
  const results = await Promise.all([probeDatabase(), probeStorage(), probeEmbeddings()]);
  if (write && state.schemaPresent && results[0].status !== 'unavailable') {
    try {
      await writeHealth(results);
    } catch (err) {
      results[0].detail.health_write_error = err.message;
    }
  }
  return results;
}

let cached = null;
let inflight = null;

// What the admin health route returns. Probes are real, so they are cached
// for maxAgeMs (30 s) unless refresh is asked for.
export async function healthReport(options) {
  const o = options || {};
  const maxAge = o.maxAgeMs === undefined ? 30000 : o.maxAgeMs;
  if (!o.refresh && cached && Date.now() - cached.at < maxAge) return cached.report;
  if (!inflight) {
    inflight = (async () => {
      const components = await runHealth({ write: true });
      const local = isLocalEmbeddings();
      const report = {
        foundation_version: FOUNDATION_VERSION,
        checked_at: new Date().toISOString(),
        components,
        local_embeddings: local,
        warnings: local ? [LOCAL_EMBEDDINGS_WARNING] : [],
      };
      cached = { at: Date.now(), report };
      return report;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}
`;
}

function healthDts() {
  return `${HEADER}
export type HealthStatus = 'ready' | 'off' | 'starting' | 'degraded' | 'unavailable' | 'missing_credentials';
export type HealthComponent = 'database' | 'storage' | 'embeddings';
export interface HealthResult {
  component: HealthComponent;
  status: HealthStatus;
  detail: Record<string, unknown>;
}
export interface HealthReport {
  foundation_version: string;
  checked_at: string;
  components: HealthResult[];
  local_embeddings: boolean;
  warnings: string[];
}
export declare function probeDatabase(): Promise<HealthResult>;
export declare function probeStorage(options?: { pending?: boolean }): Promise<HealthResult>;
export declare function probeEmbeddings(options?: { pending?: boolean }): Promise<HealthResult>;
export declare function databaseUnreachableResults(err: unknown): HealthResult[];
export declare function runHealth(options?: { write?: boolean }): Promise<HealthResult[]>;
export declare function healthReport(options?: { refresh?: boolean; maxAgeMs?: number }): Promise<HealthReport>;
`;
}

/* ---------------------------------------------------------------------------
   jobs.mjs — storage_migrate (copy, verified, resumable) and reembed.
   --------------------------------------------------------------------------- */
function jobsMjs() {
  return HEADER + String.raw`//
// Runs ONE mock2_foundation.jobs row. The host inserts the row and drives this
// through the CLI (job-run <id>); it may set jobs.state to 'cancelled' at any
// time, which the job notices within a fraction of a second. Every job is
// resumable: running it again skips work that is already verified.
//
//   storage_migrate  params { from, to, verify: ['size','sha256'] }: copy
//                    every object from the ACTIVE storage (features.storage
//                    + its secrets) to the PENDING one (features.storage
//                    .pending + the pending.* secrets). from/to are the
//                    host's record of what it planned; the job refuses to run
//                    when they disagree with the app database. Each object is
//                    streamed (sha256 computed on the way), uploaded, checked
//                    by size (HEAD) and re-read from the target to compare the
//                    sha256. One storage_migration_items row per key. The job
//                    succeeds only when EVERY object is verified.
//   reembed          params { from, to, source_index, target_index }: the
//                    host inserted the target vector_indexes row (state
//                    'building', the PENDING provider/model/dimensions). Build
//                    its table from the active index's stored content with the
//                    pending provider, validate (item count, dimensions,
//                    self-retrieval sample) and end with the target 'ready'
//                    (validation json) or 'failed' (the reason). The host
//                    promotes only from 'ready'; this job never changes the
//                    active index or the features.
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { ensureFoundation, getPool } from './config.mjs';
import { vectorTableName, vectorColumnPlan } from './contract.mjs';
import { openStorage } from './storage.mjs';
import { openEmbeddings } from './embeddings.mjs';
import { ensureIndexTable, qualifiedTable, getActiveIndex, searchIndex } from './vector.mjs';
import { FoundationError, FoundationUnavailableError } from './errors.mjs';

// The re-embed validation bar: re-embed a sample of the stored content with
// the NEW provider and expect each item (or an item with identical content) in
// the new index's top K. A broken index (rows paired with the wrong vectors, a
// wrong dimension order) scores near 0; provider noise does not move a correct
// one below 0.9.
export const SELF_RETRIEVAL = Object.freeze(${JSON.stringify(SELF_RETRIEVAL)});

const PROGRESS_INTERVAL_MS = 100;
// storage_migrate lists the source again after every copy pass and copies what
// appeared or changed meanwhile, until a listing finds nothing new (converged),
// at most MAX_LIST_PASSES listings. A source still changing after that fails the
// job (SOURCE_STILL_CHANGING) instead of promoting a copy that misses objects.
const MAX_LIST_PASSES = 5;
const MAX_REEMBED_PASSES = 5;

export class JobCancelled extends Error {
  constructor() {
    super('cancelled by the host');
    this.name = 'JobCancelled';
  }
}

export class JobInterrupted extends Error {
  constructor(reason) {
    super('interrupted (' + reason + ')');
    this.name = 'JobInterrupted';
  }
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function checkSignal(signal) {
  if (signal && signal.aborted) {
    const r = signal.reason;
    throw new JobInterrupted(r && r.message ? r.message : String(r || 'aborted'));
  }
}

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    params: row.params || {},
    progress: row.progress || {},
    error: row.error || null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    finished_at: iso(row.finished_at),
  };
}

async function loadJob(db, id) {
  const r = await db.query('SELECT * FROM mock2_foundation.jobs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// Run up to "limit" tasks at once; on the first failure stop starting new
// ones, let the running ones settle, then throw that failure.
async function mapLimit(items, limit, fn) {
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await fn(item);
      } catch (err) {
        if (!failed) failed = err;
      }
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  if (failed) throw failed;
}

function makeContext(pool, job, opts) {
  const ctx = {
    pool,
    id: job.id,
    params: job.params || {},
    signal: opts.signal || null,
    progress: Object.assign({}, job.progress || {}),
    stats: {},
    lastFlush: 0,
    async flush(force) {
      const now = Date.now();
      if (!force && now - ctx.lastFlush < PROGRESS_INTERVAL_MS) return;
      ctx.lastFlush = now;
      const r = await pool.query('UPDATE mock2_foundation.jobs SET progress = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING state', [ctx.id, JSON.stringify(ctx.progress)]);
      if (r.rows[0] && r.rows[0].state === 'cancelled') throw new JobCancelled();
    },
    async checkpoint() {
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress(Object.assign({}, ctx.progress), Object.assign({}, ctx.stats)); } catch (e) { /* observer only */ }
      }
      checkSignal(ctx.signal);
      await ctx.flush(false);
    },
  };
  return ctx;
}

async function finish(pool, id, state, error) {
  if (state === 'cancelled') {
    await pool.query("UPDATE mock2_foundation.jobs SET finished_at = COALESCE(finished_at, now()), updated_at = now() WHERE id = $1 AND state = 'cancelled'", [id]);
    return;
  }
  await pool.query("UPDATE mock2_foundation.jobs SET state = $2, error = $3, finished_at = now(), updated_at = now() WHERE id = $1 AND state <> 'cancelled'", [id, state, error]);
}

// Run one job to its end. Resolves { job, ran, stats, error?, cancelled? };
// rejects only on a JobInterrupted (signal) — the row is then 'queued' and the
// next run resumes — or when the job cannot be started at all.
export async function runJob(jobId, options) {
  const opts = options || {};
  const id = String(jobId || '');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new FoundationError('INVALID_JOB_ID', 'A job id is 1-128 letters, digits or _.:-');
  await ensureFoundation();
  const pool = getPool();
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const l = await lockClient.query("SELECT pg_try_advisory_lock(hashtext('mock2_foundation.job'), hashtext($1)) AS ok", [id]);
    locked = !!l.rows[0].ok;
    if (!locked) throw new FoundationError('JOB_BUSY', 'Job ' + id + ' is already running in another process.');
    const job = await loadJob(pool, id);
    if (!job) throw new FoundationError('JOB_NOT_FOUND', 'There is no foundation job ' + id + '.');
    if (job.state === 'succeeded' || job.state === 'cancelled') return { job: publicJob(job), ran: false, stats: {} };
    await pool.query("UPDATE mock2_foundation.jobs SET state = 'running', error = NULL, finished_at = NULL, updated_at = now() WHERE id = $1 AND state <> 'cancelled'", [id]);
    const ctx = makeContext(pool, job, opts);
    let outcome;
    try {
      if (job.kind === 'storage_migrate') outcome = await runStorageMigrate(ctx);
      else if (job.kind === 'reembed') outcome = await runReembed(ctx);
      else throw new FoundationError('JOB_KIND_UNKNOWN', 'Unknown job kind ' + job.kind + '.');
      await ctx.flush(true);
    } catch (err) {
      if (err instanceof JobInterrupted) {
        await ctx.flush(true).catch(() => {});
        await pool.query("UPDATE mock2_foundation.jobs SET state = 'queued', error = $2, updated_at = now() WHERE id = $1 AND state = 'running'",
          [id, err.message + ' - run job-run again to resume; verified work is kept']);
        throw err;
      }
      if (err instanceof JobCancelled) {
        await finish(pool, id, 'cancelled', null);
        return { job: publicJob(await loadJob(pool, id)), ran: true, stats: ctx.stats, cancelled: true };
      }
      await ctx.flush(true).catch(() => {});
      const code = err && err.code ? err.code : 'JOB_FAILED';
      await finish(pool, id, 'failed', code + ': ' + (err && err.message ? err.message : String(err)));
      return {
        job: publicJob(await loadJob(pool, id)),
        ran: true,
        stats: ctx.stats,
        error: { code, message: err && err.message ? err.message : String(err), unavailable: err instanceof FoundationUnavailableError },
      };
    }
    await finish(pool, id, outcome.ok ? 'succeeded' : 'failed', outcome.ok ? null : outcome.code + ': ' + outcome.error);
    return {
      job: publicJob(await loadJob(pool, id)),
      ran: true,
      stats: ctx.stats,
      error: outcome.ok ? null : { code: outcome.code, message: outcome.error, unavailable: false },
    };
  } finally {
    if (locked) await lockClient.query("SELECT pg_advisory_unlock(hashtext('mock2_foundation.job'), hashtext($1))", [id]).catch(() => {});
    lockClient.release();
  }
}

/* ------------------------------ storage_migrate --------------------------- */

async function syncListing(ctx, source) {
  let changed = 0;
  let cursor = null;
  do {
    checkSignal(ctx.signal);
    const page = await source.list({ cursor, limit: 1000 });
    if (page.items.length) {
      const r = await ctx.pool.query(
        "INSERT INTO mock2_foundation.storage_migration_items (job_id, key, size, state) "
        + "SELECT $1, k, s, 'pending' FROM unnest($2::text[], $3::bigint[]) AS t(k, s) "
        + "ON CONFLICT (job_id, key) DO UPDATE SET size = EXCLUDED.size, state = 'pending', sha256 = NULL, error = NULL, updated_at = now() "
        + 'WHERE storage_migration_items.size IS DISTINCT FROM EXCLUDED.size '
        + 'RETURNING key',
        [ctx.id, page.items.map((i) => i.key), page.items.map((i) => i.size)],
      );
      changed += r.rowCount || 0;
    }
    cursor = page.cursor;
    await ctx.checkpoint();
  } while (cursor);
  return changed;
}

async function refreshTotals(ctx) {
  const r = await ctx.pool.query(
    "SELECT count(*)::bigint AS total, count(*) FILTER (WHERE state = 'verified')::bigint AS done, "
    + "COALESCE(sum(size) FILTER (WHERE state = 'verified'), 0)::bigint AS bytes, COALESCE(sum(size), 0)::bigint AS bytes_total, "
    + "count(*) FILTER (WHERE state = 'failed')::bigint AS failed "
    + 'FROM mock2_foundation.storage_migration_items WHERE job_id = $1',
    [ctx.id],
  );
  const row = r.rows[0];
  ctx.progress.objects_total = Number(row.total);
  ctx.progress.objects_done = Number(row.done);
  ctx.progress.bytes_done = Number(row.bytes);
  ctx.progress.bytes_total = Number(row.bytes_total);
  ctx.progress.failed = Number(row.failed);
}

async function setItem(ctx, key, fields) {
  await ctx.pool.query(
    'UPDATE mock2_foundation.storage_migration_items SET state = $3, size = COALESCE($4, size), sha256 = COALESCE($5, sha256), error = $6, updated_at = now() WHERE job_id = $1 AND key = $2',
    [ctx.id, key, fields.state, fields.size === undefined ? null : fields.size, fields.sha256 === undefined ? null : fields.sha256, fields.error || null],
  );
}

async function copyOne(ctx, source, target, item) {
  const p = ctx.progress;
  const s = ctx.stats;
  try {
    let got;
    try {
      got = await source.get(item.key);
    } catch (err) {
      if (err && err.code === 'NOT_FOUND') {
        // Deleted from the source since it was listed: nothing to copy.
        await ctx.pool.query('DELETE FROM mock2_foundation.storage_migration_items WHERE job_id = $1 AND key = $2', [ctx.id, item.key]);
        s.vanished += 1;
        p.objects_total -= 1;
        if (item.state === 'failed') p.failed -= 1;
        return;
      }
      throw err;
    }
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    });
    got.body.on('error', (e) => tap.destroy(e));
    got.body.pipe(tap);
    const putOptions = {};
    if (got.contentType) putOptions.contentType = got.contentType;
    if (got.metadata && Object.keys(got.metadata).length) putOptions.metadata = got.metadata;
    await target.put(item.key, tap, putOptions);
    const sha = hash.digest('hex');
    if (got.size !== null && bytes !== got.size) throw new Error('read ' + bytes + ' bytes from the source, which reported ' + got.size);
    await setItem(ctx, item.key, { state: 'copied', size: bytes, sha256: sha });
    const head = await target.head(item.key);
    if (!head) throw new Error('the object is not on the target after the upload');
    if (head.size !== bytes) throw new Error('the target holds ' + head.size + ' bytes, expected ' + bytes);
    const again = await target.sha256(item.key);
    if (again.sha256 !== sha) throw new Error('the sha256 read back from the target does not match the source');
    await setItem(ctx, item.key, { state: 'verified' });
    s.copied += 1;
    p.objects_done += 1;
    p.bytes_done += bytes;
    if (item.state === 'failed') p.failed -= 1;
  } catch (err) {
    if (err instanceof JobInterrupted || err instanceof JobCancelled) throw err;
    await setItem(ctx, item.key, { state: 'failed', error: String(err && err.message ? err.message : err).slice(0, 500) });
    s.failed += 1;
    if (item.state !== 'failed') p.failed += 1;
    // A credentials or availability problem fails every object: stop now.
    if (err instanceof FoundationUnavailableError || (err && err.code === 'STORAGE_REJECTED_CREDENTIALS')) throw err;
  }
}

async function copyPending(ctx, source, target, states, concurrency) {
  let lastKey = '';
  for (;;) {
    checkSignal(ctx.signal);
    const r = await ctx.pool.query(
      'SELECT key, size, state FROM mock2_foundation.storage_migration_items WHERE job_id = $1 AND state = ANY($2::text[]) AND key > $3 ORDER BY key LIMIT 200',
      [ctx.id, states, lastKey],
    );
    if (!r.rows.length) return;
    lastKey = r.rows[r.rows.length - 1].key;
    await mapLimit(r.rows, concurrency, async (item) => {
      checkSignal(ctx.signal);
      await copyOne(ctx, source, target, item);
      await ctx.checkpoint();
    });
  }
}

function sameLocation(a, b) {
  return a.endpoint === b.endpoint && a.bucket === b.bucket && a.prefix === b.prefix && a.region === b.region;
}

// The fields of a planned location (params.from / params.to) that disagree
// with the storage the app database holds now. Absent fields are not compared.
function locationMismatches(planned, st) {
  if (planned === undefined || planned === null) return [];
  if (typeof planned !== 'object') return ['not an object'];
  const actual = { provider: st.provider, endpoint: st.endpoint, bucket: st.bucket, region: st.region, prefix: st.prefix };
  const norm = (k, v) => {
    const t = v === undefined || v === null ? '' : String(v);
    return k === 'endpoint' ? t.replace(/\/+$/, '') : t;
  };
  const out = [];
  for (const k of ['provider', 'endpoint', 'bucket', 'region', 'prefix']) {
    if (planned[k] === undefined || planned[k] === null) continue;
    if (norm(k, planned[k]) !== norm(k, actual[k])) out.push(k + ' ' + JSON.stringify(planned[k]) + ' vs ' + JSON.stringify(actual[k]));
  }
  return out;
}

async function runStorageMigrate(ctx) {
  const params = ctx.params;
  if (params.mode !== undefined && params.mode !== 'copy') throw new FoundationError('JOB_PARAMS_INVALID', 'storage_migrate only copies; starting fresh needs no job.');
  if (params.verify !== undefined && (!Array.isArray(params.verify) || params.verify.some((v) => v !== 'size' && v !== 'sha256'))) {
    throw new FoundationError('JOB_PARAMS_INVALID', 'params.verify may name only "size" and "sha256" (both are always checked).');
  }
  const concurrency = clampInt(params.concurrency, 1, 16, 4);
  const source = await openStorage();
  const target = await openStorage({ pending: true });
  const disagree = locationMismatches(params.from, source).map((m) => 'from ' + m)
    .concat(locationMismatches(params.to, target).map((m) => 'to ' + m));
  if (disagree.length) {
    throw new FoundationError('JOB_PARAMS_MISMATCH', 'The job was planned for other storage than the app database now holds (' + disagree.join('; ') + '); nothing was copied.');
  }
  if (sameLocation(source, target)) throw new FoundationError('JOB_PARAMS_INVALID', 'The pending storage is the same bucket and prefix as the active one.');
  Object.assign(ctx.stats, { copied: 0, skipped_verified: 0, failed: 0, vanished: 0 });
  ctx.progress.phase = 'listing';
  // The app keeps writing to the ACTIVE storage while this runs, so one
  // listing is not enough: after each copy pass the source is listed again and
  // the delta copied, until a listing finds nothing new or changed (progress:
  // pass, passes, converged). The window that remains is the time between that
  // last quiet listing and the host's promotion (it polls a running job every
  // few seconds) plus the app's reload on the NOTIFY: an object written to the
  // old provider inside it is not copied. It is not lost — it stays on the old
  // provider (bundled: in the preserved volume) — but the app does not see it
  // after the switch until it is copied again.
  let converged = false;
  for (let pass = 1; pass <= MAX_LIST_PASSES; pass += 1) {
    ctx.progress.pass = pass;
    ctx.progress.passes = pass;
    const changed = await syncListing(ctx, source);
    await refreshTotals(ctx);
    if (pass === 1) ctx.stats.skipped_verified = ctx.progress.objects_done;
    else if (changed === 0) { converged = true; break; } // nothing new or changed since the last pass
    ctx.progress.phase = 'copying';
    // The first pass also retries what an earlier run left copied or failed;
    // later passes only what appeared or changed meanwhile.
    await copyPending(ctx, source, target, pass === 1 ? ['pending', 'copied', 'failed'] : ['pending'], concurrency);
    ctx.progress.phase = 'listing';
  }
  await refreshTotals(ctx);
  ctx.progress.converged = converged;
  ctx.progress.phase = 'done';
  const p = ctx.progress;
  if (!converged) {
    return {
      ok: false,
      code: 'SOURCE_STILL_CHANGING',
      error: 'objects were still being added or changed in the current storage after ' + MAX_LIST_PASSES + ' listing passes, so the copy is not complete; '
        + 'run the job again at a quieter moment (verified objects are skipped), or switch with mode "fresh".',
    };
  }
  if (p.failed > 0 || p.objects_done !== p.objects_total) {
    return {
      ok: false,
      code: 'VERIFICATION_FAILED',
      error: (p.objects_total - p.objects_done) + ' of ' + p.objects_total + ' objects are not verified on the target (' + p.failed
        + ' failed); run the job again to retry them - verified objects are skipped.',
    };
  }
  return { ok: true };
}

/* ---------------------------------- reembed ------------------------------- */

async function embedPass(ctx, src, dst, emb, plan) {
  const batch = clampInt(ctx.params.batch_size, 1, 512, 64);
  let last = null;
  let embedded = 0;
  for (;;) {
    checkSignal(ctx.signal);
    const params = [batch];
    let after = '';
    if (last) {
      params.push(last.source, last.item_id, last.chunk);
      after = ' AND (s.source, s.item_id, s.chunk) > ($2, $3, $4)';
    }
    const r = await ctx.pool.query(
      'SELECT s.source, s.item_id, s.chunk, s.content, s.content_sha256, s.metadata, s.updated_at FROM ' + src + ' s '
      + 'LEFT JOIN ' + dst + ' d ON d.source = s.source AND d.item_id = s.item_id AND d.chunk = s.chunk '
      + 'WHERE d.content_sha256 IS DISTINCT FROM s.content_sha256' + after
      + ' ORDER BY s.source, s.item_id, s.chunk LIMIT $1',
      params,
    );
    if (!r.rows.length) return embedded;
    last = r.rows[r.rows.length - 1];
    const vectors = await emb.embed(r.rows.map((row) => row.content));
    await ctx.pool.query(
      'INSERT INTO ' + dst + ' (source, item_id, chunk, content, content_sha256, embedding, metadata, updated_at) '
      + 'SELECT u.source, u.item_id, u.chunk, u.content, u.sha, u.embedding::' + plan.type + ', u.metadata::jsonb, u.updated_at::timestamptz '
      + 'FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) '
      + 'AS u(source, item_id, chunk, content, sha, embedding, metadata, updated_at) '
      + 'ON CONFLICT (source, item_id, chunk) DO UPDATE SET content = EXCLUDED.content, content_sha256 = EXCLUDED.content_sha256, '
      + 'embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at',
      [
        r.rows.map((row) => row.source),
        r.rows.map((row) => row.item_id),
        r.rows.map((row) => row.chunk),
        r.rows.map((row) => row.content),
        r.rows.map((row) => row.content_sha256),
        vectors.map((v) => '[' + v.join(',') + ']'),
        r.rows.map((row) => JSON.stringify(row.metadata || {})),
        r.rows.map((row) => new Date(row.updated_at || Date.now()).toISOString()),
      ],
    );
    embedded += r.rows.length;
    ctx.stats.embedded += r.rows.length;
    ctx.progress.items_done = Math.min(ctx.progress.items_total, ctx.progress.items_done + r.rows.length);
    await ctx.checkpoint();
  }
}

async function count(pool, table, where, params) {
  const r = await pool.query('SELECT count(*)::bigint AS n FROM ' + table + (where || ''), params || []);
  return Number(r.rows[0].n);
}

async function validateIndex(ctx, args) {
  const { src, dst, target, emb, sourceIndexId } = args;
  const pool = ctx.pool;
  const reasons = [];
  const nSrc = src ? await count(pool, src) : 0;
  const nDst = await count(pool, dst);
  if (nSrc !== nDst) reasons.push('item count ' + nDst + ' does not match the active index (' + nSrc + ')');
  const badDims = await count(pool, dst, ' WHERE vector_dims(embedding) <> $1', [target.dimensions]);
  if (badDims) reasons.push(badDims + ' vectors do not have ' + target.dimensions + ' dimensions');
  const sample = (await pool.query(
    "SELECT source, item_id, chunk, content, content_sha256 FROM " + dst + " ORDER BY md5(source || ':' || item_id || ':' || chunk::text) LIMIT $1",
    [SELF_RETRIEVAL.sample],
  )).rows;
  let hits = 0;
  if (sample.length) {
    const queries = await emb.embed(sample.map((s) => s.content));
    const index = { id: target.id, dimensions: Number(target.dimensions), metric: target.metric };
    for (let i = 0; i < sample.length; i += 1) {
      checkSignal(ctx.signal);
      const found = await searchIndex(index, queries[i], { k: SELF_RETRIEVAL.k });
      const s = sample[i];
      if (found.some((h) => (h.source === s.source && h.itemId === s.item_id && h.chunk === Number(s.chunk)) || h.contentSha256 === s.content_sha256)) hits += 1;
    }
  }
  const hitRate = sample.length ? hits / sample.length : null;
  if (hitRate !== null && hitRate < SELF_RETRIEVAL.threshold) {
    reasons.push('self-retrieval ' + Math.round(hitRate * 1000) / 10 + '% is below ' + SELF_RETRIEVAL.threshold * 100 + '%');
  }
  return {
    passed: reasons.length === 0,
    reasons,
    source_index_id: sourceIndexId,
    item_count_source: nSrc,
    item_count_target: nDst,
    dimensions: Number(target.dimensions),
    dimension_mismatches: badDims,
    provider: target.provider,
    model: target.model,
    metric: target.metric,
    self_retrieval: {
      sample_size: sample.length,
      k: SELF_RETRIEVAL.k,
      hits,
      hit_rate: hitRate,
      threshold: SELF_RETRIEVAL.threshold,
      method: 're-embed sampled stored content with the new provider; a hit is the item (or identical content) in the top k of the new index',
    },
    validated_at: new Date().toISOString(),
  };
}

// Mark the target failed (with the reason) if it is still building. Not for an
// interruption: that build resumes on the next run.
async function failTarget(pool, targetId, err) {
  const validation = {
    passed: false,
    code: err && err.code ? err.code : (err instanceof JobCancelled ? 'CANCELLED' : 'JOB_FAILED'),
    reasons: [err && err.message ? err.message : String(err)],
    failed_at: new Date().toISOString(),
  };
  await pool.query("UPDATE mock2_foundation.vector_indexes SET state = 'failed', validation = $2::jsonb WHERE id = $1 AND state = 'building'", [targetId, JSON.stringify(validation)]).catch(() => {});
}

function indexMismatches(planned, row) {
  if (planned === undefined || planned === null) return [];
  if (typeof planned !== 'object') return ['not an object'];
  const actual = row ? { provider: row.provider, model: row.model, dimensions: Number(row.dimensions), metric: row.metric, index: row.id } : {};
  const out = [];
  for (const k of ['provider', 'model', 'dimensions', 'metric', 'index']) {
    if (planned[k] === undefined || planned[k] === null) continue;
    if (String(planned[k]) !== String(actual[k] === undefined ? '' : actual[k])) out.push(k + ' ' + JSON.stringify(planned[k]) + ' vs ' + JSON.stringify(actual[k] === undefined ? null : actual[k]));
  }
  return out;
}

async function runReembed(ctx) {
  const p = ctx.params;
  const targetId = String(p.target_index || p.target_index_id || '');
  try { vectorTableName(targetId); } catch (err) { throw new FoundationError('JOB_PARAMS_INVALID', 'params.target_index is not a valid vector index id.'); }
  const pool = ctx.pool;
  const t = await pool.query('SELECT * FROM mock2_foundation.vector_indexes WHERE id = $1', [targetId]);
  const target = t.rows[0];
  if (!target) throw new FoundationError('JOB_PARAMS_INVALID', 'There is no vector index ' + targetId + ' to build.');
  if (target.state === 'ready') return { ok: true };
  if (target.state !== 'building') throw new FoundationError('JOB_PARAMS_INVALID', 'Vector index ' + targetId + ' is ' + target.state + ', not building.');
  try {
    return await buildIndex(ctx, target, targetId);
  } catch (err) {
    if (!(err instanceof JobInterrupted)) await failTarget(pool, targetId, err);
    throw err;
  }
}

async function buildIndex(ctx, target, targetId) {
  const p = ctx.params;
  const pool = ctx.pool;
  if (target.table_name !== vectorTableName(targetId)) throw new FoundationError('JOB_PARAMS_INVALID', 'Vector index ' + targetId + ' names table ' + target.table_name + ', expected ' + vectorTableName(targetId) + '.');
  const emb = await openEmbeddings({ pending: true });
  if (emb.provider !== target.provider || emb.model !== target.model || emb.dimensions !== Number(target.dimensions)) {
    throw new FoundationError('PENDING_MISMATCH', 'The pending embedding provider (' + emb.provider + ' ' + emb.model + ', ' + emb.dimensions
      + ' dimensions) does not match index ' + targetId + ' (' + target.provider + ' ' + target.model + ', ' + target.dimensions + ' dimensions).');
  }
  const active = await getActiveIndex(pool);
  if (active && active.id === targetId) throw new FoundationError('JOB_PARAMS_INVALID', 'The target index is the active index.');
  // The host's plan must still describe this database: the index it read from
  // and the one it asked for.
  const sourceIndex = p.source_index === undefined ? undefined : p.source_index;
  const disagree = indexMismatches(p.to, target).map((m) => 'to ' + m)
    .concat(active ? indexMismatches(p.from, active).map((m) => 'from ' + m) : [])
    .concat(sourceIndex !== undefined && String(sourceIndex || '') !== String(active ? active.id : '') ? ['source_index ' + JSON.stringify(sourceIndex) + ' vs ' + JSON.stringify(active ? active.id : null)] : []);
  if (disagree.length) {
    throw new FoundationError('JOB_PARAMS_MISMATCH', 'The job was planned for other indexes than the app database now holds (' + disagree.join('; ') + ').');
  }
  const plan = vectorColumnPlan(Number(target.dimensions));
  const { table: dst } = await ensureIndexTable({ id: targetId, dimensions: Number(target.dimensions), metric: target.metric }, pool);
  const src = active ? qualifiedTable(active.id) : null;
  Object.assign(ctx.stats, { embedded: 0, already_present: 0, removed: 0 });
  ctx.progress.phase = 'embedding';
  ctx.progress.items_total = src ? await count(pool, src) : 0;
  if (src) {
    const present = await pool.query(
      'SELECT count(*)::bigint AS n FROM ' + src + ' s JOIN ' + dst + ' d ON d.source = s.source AND d.item_id = s.item_id AND d.chunk = s.chunk AND d.content_sha256 = s.content_sha256',
    );
    ctx.stats.already_present = Number(present.rows[0].n);
    ctx.progress.items_done = ctx.stats.already_present;
    await ctx.checkpoint();
    // Repeat until the new index has caught up with writes made meanwhile.
    for (let pass = 1; pass <= MAX_REEMBED_PASSES; pass += 1) {
      ctx.progress.pass = pass;
      const embedded = await embedPass(ctx, src, dst, emb, plan);
      const removed = await pool.query('DELETE FROM ' + dst + ' d WHERE NOT EXISTS (SELECT 1 FROM ' + src + ' s WHERE s.source = d.source AND s.item_id = d.item_id AND s.chunk = d.chunk)');
      ctx.stats.removed += removed.rowCount || 0;
      if (embedded === 0 && !removed.rowCount) break;
      ctx.progress.items_total = await count(pool, src);
    }
  }
  ctx.progress.phase = 'validating';
  await ctx.checkpoint();
  await ctx.flush(true); // a cancel that arrived meanwhile stops us before validating
  const validation = await validateIndex(ctx, { src, dst, target, emb, sourceIndexId: active ? active.id : null });
  // 'ready' is what the host promotes from, so it is written only if the job
  // is not cancelled at that very moment (one statement, no race).
  const done = await pool.query(
    "UPDATE mock2_foundation.vector_indexes SET state = $2, item_count = $3, validation = $4::jsonb WHERE id = $1 AND state = 'building' "
    + "AND NOT EXISTS (SELECT 1 FROM mock2_foundation.jobs WHERE id = $5 AND state = 'cancelled') RETURNING id",
    [targetId, validation.passed ? 'ready' : 'failed', validation.item_count_target, JSON.stringify(validation), ctx.id],
  );
  if (!done.rowCount) {
    const j = await pool.query('SELECT state FROM mock2_foundation.jobs WHERE id = $1', [ctx.id]);
    if (j.rows[0] && j.rows[0].state === 'cancelled') throw new JobCancelled();
    throw new FoundationError('TARGET_CHANGED', 'Vector index ' + targetId + ' stopped being "building" while it was built; its result was not recorded.');
  }
  ctx.progress.phase = 'done';
  ctx.progress.validation = { passed: validation.passed, reasons: validation.reasons };
  if (!validation.passed) return { ok: false, code: 'VALIDATION_FAILED', error: 'The new index failed validation: ' + validation.reasons.join('; ') + '.' };
  return { ok: true };
}
`;
}

function jobsDts() {
  return `${HEADER}
export interface FoundationJob {
  id: string;
  kind: 'storage_migrate' | 'reembed';
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  params: Record<string, unknown>;
  progress: Record<string, unknown>;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
}
export interface JobOutcome {
  job: FoundationJob | null;
  ran: boolean;
  stats: Record<string, number>;
  error?: { code: string; message: string; unavailable: boolean } | null;
  cancelled?: boolean;
}
export interface RunJobOptions {
  signal?: AbortSignal;
  onProgress?: (progress: Record<string, unknown>, stats: Record<string, number>) => void;
}
export declare const SELF_RETRIEVAL: { readonly sample: number; readonly k: number; readonly threshold: number };
export declare class JobCancelled extends Error {}
export declare class JobInterrupted extends Error {}
export declare function runJob(jobId: string, options?: RunJobOptions): Promise<JobOutcome>;
`;
}

/* ---------------------------------------------------------------------------
   index.mjs — the barrel feature code imports ('#foundation').
   --------------------------------------------------------------------------- */
function indexMjs() {
  return HEADER + String.raw`//
// What feature code imports:
//   import { storage, vector, embeddings, foundationHttpError } from '#foundation';
// (package.json "imports" maps #foundation here). Feature code uses these
// adapters only - never an S3 SDK or an embedding API directly.
export { storage, openStorage, FoundationStorage } from './runtime/storage.mjs';
export { embeddings, openEmbeddings, isLocalEmbeddings, FoundationEmbeddings, LOCAL_EMBEDDINGS_WARNING } from './runtime/embeddings.mjs';
export { vector } from './runtime/vector.mjs';
export { healthReport, runHealth } from './runtime/health.mjs';
export { getFoundation, ensureFoundation, onFoundationChange, describeConfig } from './runtime/config.mjs';
export {
  FoundationError, FoundationUnavailableError, FoundationDatabaseError, UNAVAILABLE_CODES,
  isFoundationUnavailable, foundationHttpError,
} from './runtime/errors.mjs';
export { DEPENDENT_CAPABILITIES, FOUNDATION_VERSION } from './runtime/contract.mjs';
`;
}

function indexDts() {
  return `${HEADER}
export { storage, openStorage, FoundationStorage } from './runtime/storage.mjs';
export type { StorageBody, PutOptions, PutResult, StoredObject, ObjectInfo, ListItem, ListPage, ListOptions, StorageDescription } from './runtime/storage.mjs';
export { embeddings, openEmbeddings, isLocalEmbeddings, FoundationEmbeddings, LOCAL_EMBEDDINGS_WARNING } from './runtime/embeddings.mjs';
export type { EmbeddingProvider, VectorMetric, EmbeddingsDescription } from './runtime/embeddings.mjs';
export { vector } from './runtime/vector.mjs';
export type { VectorItemInput, UpsertResult, SearchOptions, SearchHit, VectorIndex } from './runtime/vector.mjs';
export { healthReport, runHealth } from './runtime/health.mjs';
export type { HealthStatus, HealthComponent, HealthResult, HealthReport } from './runtime/health.mjs';
export { getFoundation, ensureFoundation, onFoundationChange, describeConfig } from './runtime/config.mjs';
export type { FoundationState, ConfigDescription } from './runtime/config.mjs';
export {
  FoundationError, FoundationUnavailableError, FoundationDatabaseError, UNAVAILABLE_CODES,
  isFoundationUnavailable, foundationHttpError,
} from './runtime/errors.mjs';
export type { FoundationUnavailableCode } from './runtime/errors.mjs';
export { DEPENDENT_CAPABILITIES, FOUNDATION_VERSION } from './runtime/contract.mjs';
`;
}

/* ---------------------------------------------------------------------------
   bin/foundation.mjs — the CLI the host drives.
   --------------------------------------------------------------------------- */
function cliMjs() {
  return '#!/usr/bin/env node\n' + HEADER + String.raw`//
// The application foundation's command line. Plain ESM: runs with node from the
// app directory, no build, using the app's node_modules. ProxyPilot drives
// jobs, probes and connection tests through it.
//
//   node foundation/bin/foundation.mjs health [--json]
//   node foundation/bin/foundation.mjs job-run <job_id> [--json]
//   node foundation/bin/foundation.mjs storage-test [--pending] [--json]
//   node foundation/bin/foundation.mjs embeddings-test [--pending] [--json]
//   node foundation/bin/foundation.mjs config [--json]
//
// Exit codes: 0 ok · 1 error · 2 unavailable / missing credentials (reported,
// not hidden). Nothing it prints ever contains a secret value.
import { loadFoundation, closeFoundation, describeConfig, retryWindowMs } from '../runtime/config.mjs';
import { runHealth, probeStorage, probeEmbeddings, databaseUnreachableResults } from '../runtime/health.mjs';
import { runJob } from '../runtime/jobs.mjs';
import { FoundationUnavailableError, FoundationDatabaseError } from '../runtime/errors.mjs';
import { FOUNDATION_CLI_COMMANDS, FOUNDATION_VERSION } from '../runtime/contract.mjs';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_UNAVAILABLE = 2;
// The host knows whether the stack is up; it does not need the app's 60 s.
const CLI_RETRY_MS = 15000;
const NOT_READY = new Set(['missing_credentials', 'unavailable', 'starting', 'degraded']);

const USAGE = 'usage: node foundation/bin/foundation.mjs <command> [options]\n'
  + '  health [--json]                    run the real probes, record them, print the statuses\n'
  + '  job-run <job_id> [--json]          run one foundation job (storage_migrate | reembed)\n'
  + '  storage-test [--pending] [--json]  put/get/delete probe against the active or pending storage\n'
  + '  embeddings-test [--pending] [--json]  one probe embedding against the active or pending provider\n'
  + '  config [--json]                    the effective configuration (never a secret)\n'
  + 'exit codes: 0 ok, 1 error, 2 unavailable or missing credentials';

class UsageError extends Error {}

function parse(argv) {
  const out = { cmd: argv[0] || '', args: [], json: false, pending: false, help: false };
  for (const a of argv.slice(1)) {
    if (a === '--json') out.json = true;
    else if (a === '--pending') out.pending = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new UsageError('unknown option ' + a);
    else out.args.push(a);
  }
  if (out.cmd === '--help' || out.cmd === '-h' || out.cmd === 'help') out.help = true;
  return out;
}

function write(stream, text) {
  return new Promise((resolve) => { stream.write(text, () => resolve()); });
}

async function emit(opts, value, human) {
  if (opts.json) await write(process.stdout, JSON.stringify(value, null, 2) + '\n');
  else await write(process.stdout, human + '\n');
}

function statusLines(results) {
  return results.map((r) => {
    const d = r.detail || {};
    const note = d.message || d.target || [d.provider, d.model || d.bucket].filter(Boolean).join(' ') || '';
    return r.component.padEnd(11) + ' ' + r.status.padEnd(20) + ' ' + note + (d.warning ? '\n' + ' '.repeat(33) + 'warning: ' + d.warning : '');
  }).join('\n');
}

async function load(opts) {
  return loadFoundation({ retryMs: retryWindowMs(CLI_RETRY_MS), listen: false, log: (m) => { process.stderr.write(m + '\n'); } });
}

async function cmdHealth(opts) {
  let results;
  try {
    await load(opts);
    results = await runHealth({ write: true });
  } catch (err) {
    if (!(err instanceof FoundationDatabaseError)) throw err;
    results = databaseUnreachableResults(err);
  }
  const notReady = results.some((r) => NOT_READY.has(r.status));
  await emit(opts, { ok: !notReady, foundation_version: FOUNDATION_VERSION, components: results }, statusLines(results));
  return notReady ? EXIT_UNAVAILABLE : EXIT_OK;
}

async function cmdProbe(opts, probe) {
  try {
    await load(opts);
  } catch (err) {
    if (err instanceof FoundationDatabaseError) {
      await emit(opts, { ok: false, code: err.code, message: err.message }, 'unavailable: ' + err.message);
      return EXIT_UNAVAILABLE;
    }
    throw err;
  }
  const result = await probe({ pending: opts.pending });
  const ok = result.status === 'ready';
  await emit(opts, Object.assign({ ok }, result), statusLines([result]));
  return ok ? EXIT_OK : EXIT_UNAVAILABLE;
}

async function cmdJobRun(opts) {
  const id = opts.args[0];
  if (!id) throw new UsageError('job-run needs a job id');
  await load(opts);
  const ac = new AbortController();
  const stop = (sig) => () => ac.abort(new Error(sig));
  process.once('SIGTERM', stop('SIGTERM'));
  process.once('SIGINT', stop('SIGINT'));
  let outcome;
  try {
    outcome = await runJob(id, { signal: ac.signal });
  } catch (err) {
    if (err && err.name === 'JobInterrupted') {
      await emit(opts, { ok: false, code: 'INTERRUPTED', message: err.message, resumable: true }, 'interrupted: ' + err.message + ' (resumable)');
      return EXIT_ERROR;
    }
    throw err;
  }
  const job = outcome.job || {};
  const ok = job.state === 'succeeded';
  const human = 'job ' + id + ' (' + job.kind + '): ' + job.state
    + (outcome.ran ? '' : ' (nothing to do)')
    + (outcome.error ? ' - ' + outcome.error.message : '')
    + '\nprogress ' + JSON.stringify(job.progress || {})
    + '\nstats ' + JSON.stringify(outcome.stats || {});
  await emit(opts, { ok, job, ran: outcome.ran, stats: outcome.stats, error: outcome.error || null }, human);
  if (ok) return EXIT_OK;
  return outcome.error && outcome.error.unavailable ? EXIT_UNAVAILABLE : EXIT_ERROR;
}

async function cmdConfig(opts) {
  const state = await load(opts);
  const desc = describeConfig(state);
  const f = desc.features;
  const line = (name, row) => (row ? name + ': ' + row.state + ' (' + row.provider + ')' + (row.pending ? ', switch pending' : '') : name + ': not configured');
  const human = [
    'foundation ' + desc.foundation_version + ', generation ' + desc.generation,
    'database: ' + desc.database.target + (desc.schema_present ? '' : ' (no mock2_foundation schema)'),
    'master key: ' + (desc.master_key.present ? 'present' : desc.master_key.problem) + ' (' + desc.master_key.path + ')',
    line('storage', f.storage),
    line('embeddings', f.embeddings),
    'secrets: ' + desc.secrets.names.length + ' synced' + (desc.secrets.unreadable.length ? ', ' + desc.secrets.unreadable.length + ' unreadable' : ''),
  ].concat(desc.warnings.map((w) => 'warning: ' + w)).join('\n');
  await emit(opts, desc, human);
  return EXIT_OK;
}

async function main(opts) {
  if (opts.help) { await write(process.stdout, USAGE + '\n'); return EXIT_OK; }
  if (!FOUNDATION_CLI_COMMANDS.includes(opts.cmd)) throw new UsageError(opts.cmd ? 'unknown command ' + opts.cmd : 'no command');
  if (opts.cmd === 'health') return cmdHealth(opts);
  if (opts.cmd === 'storage-test') return cmdProbe(opts, probeStorage);
  if (opts.cmd === 'embeddings-test') return cmdProbe(opts, probeEmbeddings);
  if (opts.cmd === 'job-run') return cmdJobRun(opts);
  return cmdConfig(opts);
}

let opts = { json: process.argv.includes('--json') };
let code = EXIT_ERROR;
try {
  opts = parse(process.argv.slice(2));
  code = await main(opts);
} catch (err) {
  const usage = err instanceof UsageError;
  code = err instanceof FoundationUnavailableError ? EXIT_UNAVAILABLE : EXIT_ERROR;
  const body = { ok: false, code: usage ? 'USAGE' : (err && err.code) || 'ERROR', message: err && err.message ? err.message : String(err) };
  if (opts.json) await write(process.stdout, JSON.stringify(body, null, 2) + '\n');
  await write(process.stderr, (usage ? body.message + '\n' + USAGE : 'error: ' + body.message) + '\n');
}
await closeFoundation().catch(() => {});
process.exit(code);
`;
}

/* ---------------------------------------------------------------------------
   README.md
   --------------------------------------------------------------------------- */
function readmeMd() {
  return `# foundation/

The application foundation: the one place this app reaches its stack —
PostgreSQL 18 + pgvector, S3 object storage and embeddings — which ProxyPilot
provisions in the app's guest as one Docker Compose stack (${FOUNDATION_VERSION}).
This directory is **platform-owned**: a base-app upgrade rewrites it. Build
features in \`src/\`, never here.

**Feature code uses these adapters only — never an S3 SDK or an embedding API
directly.** A direct S3 client or embedding HTTP call in feature code is a
deviation from the Mock2 standard.

\`\`\`ts
import { storage, vector, embeddings, foundationHttpError } from '#foundation';

await storage.put('invoices/42.pdf', pdfBuffer, { contentType: 'application/pdf' });
const file = await storage.get('invoices/42.pdf');           // { body: Readable, size, ... }

await vector.upsert({ source: 'notes', itemId: String(note.id), content: note.body });
const hits = await vector.search({ query: 'overdue invoices', k: 5, source: 'notes' });

// In a route: a switched-off or unconfigured feature is a 503, not a crash.
try { /* ... */ } catch (err) {
  const http = foundationHttpError(err);
  if (http) { res.status(http.status).json(http.body); return; }
  throw err;
}
\`\`\`

## What each part is

| File | What it does |
|---|---|
| \`runtime/bootstrap.mjs\` | Loaded first by \`node --import\` (package.json \`start\`/\`dev\`). Connects to the database (retries up to 60 s after a guest restart, then fails loudly naming the socket), reads the feature switches and the sealed secrets, opens them with the master key, puts \`component.<KEY>\` secrets into \`process.env\` in memory, and keeps listening for changes. |
| \`runtime/config.mjs\` | Database URL, master key, features and secrets, \`LISTEN ${FOUNDATION_NOTIFY_CHANNEL}\` + reload. |
| \`runtime/storage.mjs\` | S3 adapter (\`@aws-sdk/client-s3\`; \`@aws-sdk/lib-storage\` for streams and large files) for the bundled SeaweedFS or any S3-compatible provider: \`put\`, \`get\`, \`getBuffer\`, \`head\`, \`delete\`, \`list\` (paginated), \`listAll\`, \`presignGet\`. |
| \`runtime/embeddings.mjs\` | OpenAI-compatible \`POST {base_url}/embeddings\`: the local model, OpenAI, or any compatible provider. Batches, times out, retries, and refuses vectors whose dimensions differ from the configuration. |
| \`runtime/vector.mjs\` | \`upsert\` / \`upsertMany\` / \`search\` / \`remove\` in the active index (\`mock2_foundation.vec_<id>\`). Unchanged content is not re-embedded. Vector spaces are never mixed. |
| \`runtime/health.mjs\` | Real probes only: a query plus a vector operation; put → get → delete of a probe object (and an anonymous read that must be refused); one embedding with its dimensions checked. |
| \`runtime/jobs.mjs\` | Host-driven jobs: \`storage_migrate\` (verified, resumable copy to a new provider) and \`reembed\` (build and validate a new index for a new embedding model). |
| \`bin/foundation.mjs\` | The CLI: \`health\`, \`job-run <id>\`, \`storage-test\`, \`embeddings-test\`, \`config\` (all take \`--json\`). Exit codes: 0 ok, 1 error, 2 unavailable or missing credentials. |
| \`compose.yaml\` | The portable copy of the stack. The guest runs ProxyPilot's own copy at \`${STACK.composeFile}\` and never reads this one. |

## Errors you will see

\`FoundationUnavailableError\` (HTTP 503 via \`foundationHttpError\`, CLI exit 2):
\`STORAGE_OFF\`, \`EMBEDDINGS_OFF\`, \`MISSING_CREDENTIALS\`, \`MISSING_MASTER_KEY\`,
\`FOUNDATION_NOT_PROVISIONED\`, \`NO_PENDING_PROVIDER\`, \`INDEX_PROVIDER_MISMATCH\`.
Every other failure is a \`FoundationError\` with a stable \`code\`
(\`NOT_FOUND\`, \`DIMENSIONS_MISMATCH\`, \`STORAGE_REJECTED_CREDENTIALS\`, …).

## Secrets

There is no secret in any env file. ProxyPilot keeps every credential encrypted
and delivers it **sealed** (AES-256-GCM) into \`mock2_foundation.secrets\`; the
runtime opens it with the deployment master key at \`${STACK.keyFile}\`
(0600 root). Postgres is reached over its Unix socket with peer authentication,
so \`DATABASE_URL\` holds no password.

**If the master key file is missing** the app still starts and the database
works; storage and embeddings report \`MISSING_MASTER_KEY\` (health:
\`missing_credentials\`) until the key is back, and component secrets are not
placed in \`process.env\`.

## Local embeddings

The bundled model (${STACK.embeddings.model}, ${STACK.embeddings.dimensions} dimensions) is for
development: ${LOCAL_EMBEDDINGS_WARNING}

## Running outside ProxyPilot

1. Start the stack: \`docker compose -f foundation/compose.yaml up -d\`.
2. Point the app at it. Defaults: \`DATABASE_URL=${FOUNDATION_DATABASE_URL}\`
   and the key file \`${STACK.keyFile}\`. Override with \`DATABASE_URL\` (any
   PostgreSQL with pgvector and the \`mock2_foundation\` schema) and
   \`FOUNDATION_KEY_FILE\`. There is never a silent fallback to another
   database: after \`FOUNDATION_DB_RETRY_MS\` (default 60000) the app stops with
   an error naming what it tried.
3. Write the feature rows and sealed secrets into \`mock2_foundation\` the way
   ProxyPilot does (its \`foundation-contract.js\` is the reference), then
   \`NOTIFY ${FOUNDATION_NOTIFY_CHANNEL}\`.
4. Check it: \`node foundation/bin/foundation.mjs health\`.

\`storage.presignGet\` needs the optional \`@aws-sdk/s3-request-presigner\`
package (\`npm install @aws-sdk/s3-request-presigner\`).
`;
}

/* ---------------------------------------------------------------------------
   The file set.
   --------------------------------------------------------------------------- */

// buildFoundationFiles({ composeYaml }) → [{ path, content, mode? }]. PURE.
// composeYaml is the portable stack, rendered by foundation-stack-logic.js
// buildFoundationComposeYaml({ portable: true }); it is an explicit input so
// this module never decides what the stack looks like.
export function buildFoundationFiles({ composeYaml } = {}) {
  if (typeof composeYaml !== 'string' || !composeYaml.trim()) {
    throw new Error('buildFoundationFiles needs { composeYaml }: the portable stack from buildFoundationComposeYaml({ portable: true })');
  }
  return [
    { path: 'foundation/README.md', content: readmeMd() },
    { path: 'foundation/compose.yaml', content: composeYaml.endsWith('\n') ? composeYaml : `${composeYaml}\n` },
    { path: 'foundation/index.mjs', content: indexMjs() },
    { path: 'foundation/index.d.mts', content: indexDts() },
    { path: 'foundation/runtime/contract.mjs', content: contractMjs() },
    { path: 'foundation/runtime/contract.d.mts', content: contractDts() },
    { path: 'foundation/runtime/errors.mjs', content: errorsMjs() },
    { path: 'foundation/runtime/errors.d.mts', content: errorsDts() },
    { path: 'foundation/runtime/seal.mjs', content: sealMjs() },
    { path: 'foundation/runtime/seal.d.mts', content: sealDts() },
    { path: 'foundation/runtime/config.mjs', content: configMjs() },
    { path: 'foundation/runtime/config.d.mts', content: configDts() },
    { path: 'foundation/runtime/bootstrap.mjs', content: bootstrapMjs() },
    { path: 'foundation/runtime/bootstrap.d.mts', content: bootstrapDts() },
    { path: 'foundation/runtime/storage.mjs', content: storageMjs() },
    { path: 'foundation/runtime/storage.d.mts', content: storageDts() },
    { path: 'foundation/runtime/embeddings.mjs', content: embeddingsMjs() },
    { path: 'foundation/runtime/embeddings.d.mts', content: embeddingsDts() },
    { path: 'foundation/runtime/vector.mjs', content: vectorMjs() },
    { path: 'foundation/runtime/vector.d.mts', content: vectorDts() },
    { path: 'foundation/runtime/health.mjs', content: healthMjs() },
    { path: 'foundation/runtime/health.d.mts', content: healthDts() },
    { path: 'foundation/runtime/jobs.mjs', content: jobsMjs() },
    { path: 'foundation/runtime/jobs.d.mts', content: jobsDts() },
    { path: FOUNDATION_CLI, content: cliMjs(), mode: 0o755 },
  ];
}
