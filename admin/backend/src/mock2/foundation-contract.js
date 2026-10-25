// Mock2 application foundation — the SHARED CONTRACT (2026-10).
//
// Every new Dev Studio application is provisioned with the same foundation, as
// one Docker Compose stack inside its own guest:
//
//   postgres    PostgreSQL 18 + pgvector — the system of record. Always on.
//   storage     SeaweedFS S3 (bundled) — or any S3-compatible provider (R2, AWS,
//               B2, MinIO, …) through the same storage adapter.
//   embeddings  a local embedding server (bundled, development quality — the
//               dashboard and the app warn to switch) — or OpenAI / any
//               OpenAI-compatible provider through the same embeddings adapter.
//
// storage and embeddings each have a per-deployment switch. Turning one off
// stops its container and NEVER deletes its volume; turning it back on starts
// the same container on the same data. Bundled storage that still holds
// objects cannot be turned off until the person chooses a replacement S3 and
// either copies everything over (verified) or deliberately starts fresh.
// Changing the embedding provider/model/dimensions re-embeds into a NEW index,
// validates it, and only then switches; vector spaces are never mixed.
//
// Secrets are never written to an env file. ProxyPilot keeps every secret
// encrypted in mock2.db (lib/secrets.js, TOTP_ENCRYPTION_KEY) and syncs it
// SEALED into the app database (mock2_foundation.secrets) under a per-deployment
// master key (STACK.keyFile, 0600 root). The app connects to Postgres over a
// Unix socket with peer authentication — no database password exists.
//
// This module is the one place the host side (provisioning, routes, jobs) and
// the generated app side (scaffold-foundation.js) agree on names, shapes and
// formats. PURE: no I/O. docs/features/app-foundation.md is the narrative.

import crypto from 'node:crypto';

export const FOUNDATION_VERSION = 'mock2-foundation-v1';

export const FEATURES = Object.freeze(['storage', 'embeddings']);
export const FEATURE_STATES = Object.freeze(['on', 'off']);
export const STORAGE_PROVIDERS = Object.freeze(['bundled', 'external']);
export const EMBEDDING_PROVIDERS = Object.freeze(['local', 'openai', 'openai_compatible']);
export const STORAGE_SWITCH_MODES = Object.freeze(['copy', 'fresh']);
export const VECTOR_METRICS = Object.freeze(['cosine', 'l2', 'ip']);

// Health statuses. `ready` is reported only after a REAL operation succeeded
// (database: a query plus a vector operation; storage: put → get → delete of a
// probe object; embeddings: one embedding of a probe text with the configured
// dimensions). A filled-in setting is never readiness.
export const HEALTH_STATUSES = Object.freeze([
  'ready', 'off', 'starting', 'degraded', 'unavailable', 'missing_credentials',
]);

// The guest-side stack. Image pins follow the standard's stack pins
// (PostgreSQL 18.6 + pgvector 0.8.7); foundation-stack-logic.js may pin by
// digest but must keep these tags as the human-readable version.
export const STACK = Object.freeze({
  composeProject: 'mock2-foundation',
  dir: '/opt/mock2-foundation',
  composeFile: '/opt/mock2-foundation/compose.yaml',
  keyFile: '/etc/mock2-foundation/master.key',
  postgres: Object.freeze({
    service: 'postgres',
    image: 'pgvector/pgvector:0.8.7-pg18',
    socketDir: '/run/mock2-foundation/postgres',
    volume: 'mock2_pg_data',
    database: 'app',
    role: 'app',
  }),
  storage: Object.freeze({
    service: 'storage',
    image: 'chrislusf/seaweedfs:4.48',
    listen: '127.0.0.1',
    port: 8333,
    volume: 'mock2_s3_data',
    bucket: 'app',
    region: 'us-east-1',
  }),
  embeddings: Object.freeze({
    service: 'embeddings',
    image: 'ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4',
    listen: '127.0.0.1',
    port: 8088,
    volume: 'mock2_embed_cache',
    model: 'BAAI/bge-small-en-v1.5',
    dimensions: 384,
  }),
});

// No secret in it, so it may live in the unit file and the scaffold defaults.
export const FOUNDATION_DATABASE_URL = `postgres:///${STACK.postgres.database}?host=${STACK.postgres.socketDir}&user=${STACK.postgres.role}`;

export const LOCAL_EMBEDDINGS_WARNING =
  'Local embeddings (bge-small, 384 dimensions) are for development and small data sets. '
  + 'Switch to OpenAI or another embedding provider for production-quality search.';

// What becomes unavailable when a feature is off — shown next to the switch.
export const DEPENDENT_CAPABILITIES = Object.freeze({
  storage: Object.freeze(['File uploads and downloads', 'Attachments and exports kept in object storage']),
  embeddings: Object.freeze(['Semantic search', 'Similar-item suggestions', 'AI retrieval over the app\'s content']),
});

// Default feature rows for a NEW deployment.
export function defaultFeatures() {
  return {
    storage: {
      state: 'on', provider: 'bundled',
      config: { endpoint: `http://${STACK.storage.listen}:${STACK.storage.port}`, region: STACK.storage.region, bucket: STACK.storage.bucket, prefix: '', force_path_style: true },
    },
    embeddings: {
      state: 'on', provider: 'local',
      config: { base_url: `http://${STACK.embeddings.listen}:${STACK.embeddings.port}/v1`, model: STACK.embeddings.model, dimensions: STACK.embeddings.dimensions, metric: 'cosine' },
    },
  };
}

// Secret names. `host` secrets stay in mock2.db and are never synced into the
// app database; `app` secrets are synced sealed. `pending.*` carries the
// credentials of a provider switch that has not been promoted yet. Component
// secrets (minted for installed components, e.g. a session signing key) are
// `component.<ENV_KEY>`; the app's foundation bootstrap exposes them as
// process.env.<ENV_KEY> in memory before anything else loads.
export const SECRET_NAMES = Object.freeze({
  masterKey: 'master_key',                                   // host
  storageAdminAccessKeyId: 'storage.admin_access_key_id',    // host (bundled admin identity)
  storageAdminSecretAccessKey: 'storage.admin_secret_access_key', // host
  // host: the bundled S3 app identity, kept while another provider is active
  // so switching back to bundled storage can reuse it.
  storageBundledAccessKeyId: 'storage.bundled_access_key_id',
  storageBundledSecretAccessKey: 'storage.bundled_secret_access_key',
  storageAccessKeyId: 'storage.access_key_id',               // app
  storageSecretAccessKey: 'storage.secret_access_key',       // app
  embeddingsApiKey: 'embeddings.api_key',                    // app
});
export const HOST_ONLY_SECRETS = Object.freeze([
  SECRET_NAMES.masterKey, SECRET_NAMES.storageAdminAccessKeyId, SECRET_NAMES.storageAdminSecretAccessKey,
  SECRET_NAMES.storageBundledAccessKeyId, SECRET_NAMES.storageBundledSecretAccessKey,
]);
const SECRET_NAME_RE = /^(?:master_key|storage\.(?:admin_|bundled_)?(?:access_key_id|secret_access_key)|embeddings\.api_key|pending\.(?:storage\.(?:access_key_id|secret_access_key)|embeddings\.api_key)|component\.[A-Z][A-Z0-9_]{0,63})$/;
export function isValidSecretName(name) { return SECRET_NAME_RE.test(String(name || '')); }
export function componentSecretName(envKey) { return `component.${envKey}`; }
export function pendingSecretName(name) { return `pending.${name}`; }

// ---------------------------------------------------------------------------
// Sealing: AES-256-GCM under the deployment master key (32 random bytes,
// base64 in STACK.keyFile). Wire format `mfs1:<iv>:<tag>:<ciphertext>`
// (base64url parts). The secret NAME is the additional authenticated data, so
// a sealed value cannot be moved to another name. The generated app carries a
// byte-compatible implementation (scaffold-foundation.js); the round-trip test
// in __tests__ pins the two together.
// ---------------------------------------------------------------------------
const SEAL_PREFIX = 'mfs1:';
const aad = (name) => Buffer.from(`mock2-foundation:${name}`, 'utf8');

export function generateMasterKey() {
  return crypto.randomBytes(32).toString('base64');
}

function keyBytes(masterKeyB64) {
  const key = Buffer.from(String(masterKeyB64 || '').trim(), 'base64');
  if (key.length !== 32) throw new Error('foundation master key must be 32 bytes (base64)');
  return key;
}

export function sealForApp(masterKeyB64, name, plaintext) {
  if (!isValidSecretName(name)) throw new Error(`invalid foundation secret name: ${name}`);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(masterKeyB64), iv);
  cipher.setAAD(aad(name));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `${SEAL_PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
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

// Vector index ids double as table-name suffixes (mock2_foundation.vec_<id>).
export const VECTOR_INDEX_ID_RE = /^[a-z0-9_]{1,40}$/;
export function vectorTableName(indexId) {
  if (!VECTOR_INDEX_ID_RE.test(String(indexId || ''))) throw new Error(`invalid vector index id: ${indexId}`);
  return `vec_${indexId}`;
}
// pgvector's HNSW index covers `vector` up to 2000 dimensions and `halfvec` up
// to 4000; above that the index is exact scan only (reported, not hidden).
export function vectorColumnPlan(dimensions) {
  const d = Number(dimensions);
  if (!Number.isInteger(d) || d < 1 || d > 16000) throw new Error(`invalid embedding dimensions: ${dimensions}`);
  if (d <= 2000) return { type: `vector(${d})`, ann: 'hnsw', ops: { cosine: 'vector_cosine_ops', l2: 'vector_l2_ops', ip: 'vector_ip_ops' } };
  if (d <= 4000) return { type: `halfvec(${d})`, ann: 'hnsw', ops: { cosine: 'halfvec_cosine_ops', l2: 'halfvec_l2_ops', ip: 'halfvec_ip_ops' } };
  return { type: `vector(${d})`, ann: 'none', ops: {} };
}

// ---------------------------------------------------------------------------
// The platform-owned schema in the app database. Created by the stack's first
// start (foundation-stack.js) and owned by the app role so the app can create
// its index tables; the host writes features/secrets/jobs as the superuser.
// Idempotent. A later foundation version adds statements; it never edits these.
// ---------------------------------------------------------------------------
export const FOUNDATION_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS mock2_foundation AUTHORIZATION ${STACK.postgres.role};
SET search_path = mock2_foundation;
CREATE TABLE IF NOT EXISTS meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS features (
  feature text PRIMARY KEY CHECK (feature IN ('storage','embeddings')),
  state text NOT NULL CHECK (state IN ('on','off')),
  provider text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending jsonb,
  generation bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS secrets (
  name text PRIMARY KEY,
  sealed text NOT NULL,
  generation bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vector_indexes (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9_]{1,40}$'),
  provider text NOT NULL,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  metric text NOT NULL DEFAULT 'cosine' CHECK (metric IN ('cosine','l2','ip')),
  state text NOT NULL CHECK (state IN ('building','ready','active','retired','failed')),
  table_name text NOT NULL UNIQUE,
  item_count bigint NOT NULL DEFAULT 0,
  validation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  retired_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS vector_indexes_one_active ON vector_indexes ((true)) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('storage_migrate','reembed')),
  state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS storage_migration_items (
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  key text NOT NULL,
  size bigint,
  sha256 text,
  state text NOT NULL CHECK (state IN ('pending','copied','verified','failed')),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, key)
);
CREATE TABLE IF NOT EXISTS health (
  component text PRIMARY KEY CHECK (component IN ('database','storage','embeddings')),
  status text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON ALL TABLES IN SCHEMA mock2_foundation TO ${STACK.postgres.role};
RESET search_path;
`;

// The app is told about a host-side change with NOTIFY on this channel
// (payload: the new generation number); it reloads features + secrets.
export const FOUNDATION_NOTIFY_CHANNEL = 'mock2_foundation_changed';

// The generated app's CLI — plain ESM, runnable with `node` from the app dir
// without a build, using the app's node_modules. The host drives jobs, probes
// and connection tests through it.
export const FOUNDATION_CLI = 'foundation/bin/foundation.mjs';
export const FOUNDATION_CLI_COMMANDS = Object.freeze([
  'health',            // --json: run real probes, write mock2_foundation.health, print { ok, components: [{component,status,detail}] }
  'job-run',           // <job_id>: run one jobs row (storage_migrate | reembed); resumable, idempotent
  'storage-test',      // --pending --json: connectivity + put/get/delete probe against the pending provider
  'embeddings-test',   // --pending --json: one probe embedding against the pending provider; checks dimensions
  'config',            // --json: effective non-secret config + has_secret flags (never a secret value)
]);
// Exit codes: 0 ok · 1 error · 2 unavailable / missing credentials (reported, not hidden).
