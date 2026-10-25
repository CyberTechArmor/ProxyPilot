// Mock2 application foundation — the HOST STORE (docs/features/app-foundation.md
// § "Secrets"). mock2.db is the source of truth for every deployment's feature
// switches, jobs and secrets; the app database is only the delivery path.
//
//   mock2_foundation_features  one row per (project, feature): state, provider,
//                              non-secret config, the staged `pending` switch
//   mock2_foundation_secrets   one row per (project, name): the value encrypted
//                              with lib/secrets.js (TOTP_ENCRYPTION_KEY). A
//                              plaintext value is never written to a row.
//   mock2_foundation_jobs      storage_migrate / reembed jobs, mirrored from
//                              the app database's mock2_foundation.jobs
//
// syncFoundationToApp seals every app secret under the deployment master key
// (sealForApp, the secret name as AAD) and upserts features + secrets into the
// app database as the superuser over the guest's socket — one transaction that
// bumps the generation and NOTIFYs mock2_foundation_changed. The SQL travels on
// stdin (foundationPsql), never on a command line. Host-only secrets (the
// master key, the bundled S3 admin identity, the retained bundled app
// identity) are never synced.
//
// The guest-side stack (foundationPsql and friends) is foundation-stack.js,
// imported lazily so this module loads where that one is absent.
//
// Terminology (risk R7): nothing here is named "agent".

import { randomBytes } from 'node:crypto';
import { getMock2Db } from './db.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';
import {
  FEATURES, SECRET_NAMES, generateMasterKey, sealForApp, componentSecretName, defaultFeatures,
} from './foundation-contract.js';
import {
  BUNDLED_APP_IDENTITY, isStorableSecretName, appSecretNames, featureRowsFrom, buildSyncSql, parseGeneration,
  buildGuardProbeSql, buildGuardRowsSql, parseJsonRows, planFoundationComponentMint, redactSecrets, parseJsonObject,
  isValidJobId,
} from './foundation-logic.js';

const nowIso = () => new Date().toISOString();
const stack = () => import('./foundation-stack.js');
const PROJECT_ORIGIN_KEY_PREFIX = 'project_origin.';

// ---- project ----------------------------------------------------------------

// The fields the foundation needs, read straight from mock2_projects (this
// module does not import projects.js and its main-DB dependencies).
export function getFoundationProject(projectId) {
  return getMock2Db().prepare('SELECT id, name, container_name, lifecycle, foundation_version FROM mock2_projects WHERE id = ?').get(Number(projectId)) || null;
}

// ---- features ----------------------------------------------------------------

export function readFeatureRows(projectId) {
  const rows = getMock2Db().prepare('SELECT feature, state, provider, config_json, pending_json, updated_at FROM mock2_foundation_features WHERE project_id = ?').all(Number(projectId));
  return featureRowsFrom(rows);
}

export function writeFeature(projectId, feature, { state, provider, config, pending }) {
  if (!FEATURES.includes(feature)) throw new Error(`unknown foundation feature ${feature}`);
  getMock2Db().prepare(`
    INSERT INTO mock2_foundation_features (project_id, feature, state, provider, config_json, pending_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, feature) DO UPDATE SET state = excluded.state, provider = excluded.provider,
      config_json = excluded.config_json, pending_json = excluded.pending_json, updated_at = excluded.updated_at
  `).run(Number(projectId), feature, state, provider, JSON.stringify(config || {}), pending ? JSON.stringify(pending) : null, nowIso());
}

// The defaults for a NEW deployment (defaultFeatures), written once.
export function ensureDefaultFeatures(projectId) {
  const db = getMock2Db();
  const defaults = defaultFeatures();
  const insert = db.prepare(`INSERT OR IGNORE INTO mock2_foundation_features (project_id, feature, state, provider, config_json, pending_json, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?)`);
  for (const feature of FEATURES) {
    const f = defaults[feature];
    insert.run(Number(projectId), feature, f.state, f.provider, JSON.stringify(f.config), nowIso());
  }
}

// ---- secrets ----------------------------------------------------------------
// Values pass through here in memory only; every row holds ciphertext.

export function listSecretNames(projectId) {
  return getMock2Db().prepare('SELECT name FROM mock2_foundation_secrets WHERE project_id = ? ORDER BY name').all(Number(projectId)).map((r) => r.name);
}

export function hasSecret(projectId, name) {
  return !!getMock2Db().prepare('SELECT 1 FROM mock2_foundation_secrets WHERE project_id = ? AND name = ?').get(Number(projectId), name);
}

// The plaintext of one secret — host-side use only (sealing, the stack's
// provisioning inputs, the bundled admin identity). Never returned by a route.
export function readSecret(projectId, name) {
  const row = getMock2Db().prepare('SELECT ciphertext FROM mock2_foundation_secrets WHERE project_id = ? AND name = ?').get(Number(projectId), name);
  if (!row) return null;
  return decryptSecret(row.ciphertext);
}

export function writeSecret(projectId, name, plaintext) {
  if (!isStorableSecretName(name)) throw new Error(`invalid foundation secret name: ${name}`);
  const value = String(plaintext ?? '');
  if (!value) throw new Error(`refusing to store an empty value for ${name}`);
  const db = getMock2Db();
  const existing = db.prepare('SELECT ciphertext FROM mock2_foundation_secrets WHERE project_id = ? AND name = ?').get(Number(projectId), name);
  const ciphertext = encryptSecret(value);
  if (!existing) {
    db.prepare('INSERT INTO mock2_foundation_secrets (project_id, name, ciphertext, created_at, rotated_at) VALUES (?, ?, ?, ?, NULL)').run(Number(projectId), name, ciphertext, nowIso());
    return { created: true, rotated: false };
  }
  let same = false;
  try { same = decryptSecret(existing.ciphertext) === value; } catch { same = false; }
  if (same) return { created: false, rotated: false };
  db.prepare('UPDATE mock2_foundation_secrets SET ciphertext = ?, rotated_at = ? WHERE project_id = ? AND name = ?').run(ciphertext, nowIso(), Number(projectId), name);
  return { created: false, rotated: true };
}

// Write only when absent — never overwrites (minted keys, generated identities).
export function insertSecretIfAbsent(projectId, name, plaintext) {
  if (!isStorableSecretName(name)) throw new Error(`invalid foundation secret name: ${name}`);
  const value = String(plaintext ?? '');
  if (!value) throw new Error(`refusing to store an empty value for ${name}`);
  const r = getMock2Db().prepare('INSERT OR IGNORE INTO mock2_foundation_secrets (project_id, name, ciphertext, created_at, rotated_at) VALUES (?, ?, ?, ?, NULL)')
    .run(Number(projectId), name, encryptSecret(value), nowIso());
  return r.changes > 0;
}

export function deleteSecrets(projectId, names = []) {
  const del = getMock2Db().prepare('DELETE FROM mock2_foundation_secrets WHERE project_id = ? AND name = ?');
  let n = 0;
  for (const name of names) n += del.run(Number(projectId), name).changes;
  return n;
}

// Copy one stored value to another name (re-encrypted; no plaintext leaves).
export function copySecret(projectId, from, to) {
  const v = readSecret(projectId, from);
  if (v == null) return false;
  writeSecret(projectId, to, v);
  return true;
}

// ---- the stack's provisioning inputs (called by provision.js) ----------------

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function accessKeyId() {
  const bytes = randomBytes(20);
  return Array.from(bytes, (b) => ID_ALPHABET[b % 32]).join('');
}
const secretAccessKey = () => randomBytes(30).toString('base64url');

// A clone of a foundation project brings its source's component secrets (a
// full clone's database carries data encrypted under them); never the master
// key or any storage identity — the clone is its own deployment.
function inheritComponentSecrets(db, projectId) {
  const raw = db.prepare('SELECT value FROM mock2_settings WHERE key = ?').get(`${PROJECT_ORIGIN_KEY_PREFIX}${projectId}`)?.value;
  const origin = parseJsonObject(raw, null);
  if (origin?.kind !== 'clone' || !Number.isInteger(Number(origin.sourceProjectId))) return 0;
  const src = Number(origin.sourceProjectId);
  const rows = db.prepare("SELECT name, ciphertext FROM mock2_foundation_secrets WHERE project_id = ? AND name LIKE 'component.%'").all(src);
  const insert = db.prepare('INSERT OR IGNORE INTO mock2_foundation_secrets (project_id, name, ciphertext, created_at, rotated_at) VALUES (?, ?, ?, ?, NULL)');
  let n = 0;
  for (const r of rows) n += insert.run(Number(projectId), r.name, r.ciphertext, nowIso()).changes;
  return n;
}

// getFoundationProvisionInputs(projectId) → { features, masterKey,
// storageCredentials: { app, admin } }. Generates and stores (encrypted) on the
// first call; stable afterwards. `app` is the bundled S3's app identity — the
// same values whichever provider is active, so the stack's configuration never
// changes under a switch.
export function getFoundationProvisionInputs(projectId) {
  const pid = Number(projectId);
  const db = getMock2Db();
  const project = getFoundationProject(pid);
  if (!project) throw new Error(`project ${pid} not found`);
  if (!project.foundation_version) throw new Error(`project ${pid} is not a foundation deployment`);
  const tx = db.transaction(() => {
    const first = !hasSecret(pid, SECRET_NAMES.masterKey);
    ensureDefaultFeatures(pid);
    insertSecretIfAbsent(pid, SECRET_NAMES.masterKey, generateMasterKey());
    insertSecretIfAbsent(pid, BUNDLED_APP_IDENTITY.accessKeyId, accessKeyId());
    insertSecretIfAbsent(pid, BUNDLED_APP_IDENTITY.secretAccessKey, secretAccessKey());
    insertSecretIfAbsent(pid, SECRET_NAMES.storageAdminAccessKeyId, accessKeyId());
    insertSecretIfAbsent(pid, SECRET_NAMES.storageAdminSecretAccessKey, secretAccessKey());
    // The active app credentials start as the bundled identity.
    const rows = readFeatureRows(pid);
    if (rows.storage.provider === 'bundled') {
      if (!hasSecret(pid, SECRET_NAMES.storageAccessKeyId)) writeSecret(pid, SECRET_NAMES.storageAccessKeyId, readSecret(pid, BUNDLED_APP_IDENTITY.accessKeyId));
      if (!hasSecret(pid, SECRET_NAMES.storageSecretAccessKey)) writeSecret(pid, SECRET_NAMES.storageSecretAccessKey, readSecret(pid, BUNDLED_APP_IDENTITY.secretAccessKey));
    }
    if (first) inheritComponentSecrets(db, pid);
  });
  tx();
  const rows = readFeatureRows(pid);
  const features = {};
  for (const f of FEATURES) features[f] = { state: rows[f].state, provider: rows[f].provider, config: rows[f].config };
  return {
    features,
    masterKey: readSecret(pid, SECRET_NAMES.masterKey),
    storageCredentials: {
      app: { accessKeyId: readSecret(pid, BUNDLED_APP_IDENTITY.accessKeyId), secretAccessKey: readSecret(pid, BUNDLED_APP_IDENTITY.secretAccessKey) },
      admin: { accessKeyId: readSecret(pid, SECRET_NAMES.storageAdminAccessKeyId), secretAccessKey: readSecret(pid, SECRET_NAMES.storageAdminSecretAccessKey) },
    },
  };
}

// The bundled S3 admin identity (host-only) for bundledStorageObjectCount.
export function bundledAdminCredentials(projectId) {
  const accessKey = readSecret(projectId, SECRET_NAMES.storageAdminAccessKeyId);
  const secret = readSecret(projectId, SECRET_NAMES.storageAdminSecretAccessKey);
  return accessKey && secret ? { accessKeyId: accessKey, secretAccessKey: secret } : null;
}

// The bundled bucket's object count the host last took (it lists the bucket
// only when a switch needs to know), kept so GET /foundation can show it
// without a listing per request. A count, never a key or a value.
const OBJECT_COUNT_KEY_PREFIX = 'foundation_object_count.';
export function recordObjectCount(projectId, count) {
  if (!Number.isInteger(count) || count < 0) return;
  getMock2Db().prepare('INSERT INTO mock2_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(`${OBJECT_COUNT_KEY_PREFIX}${Number(projectId)}`, JSON.stringify({ count, at: nowIso() }), nowIso());
}
export function readObjectCount(projectId) {
  const raw = getMock2Db().prepare('SELECT value FROM mock2_settings WHERE key = ?').get(`${OBJECT_COUNT_KEY_PREFIX}${Number(projectId)}`)?.value;
  const v = parseJsonObject(raw, null);
  return v && Number.isInteger(v.count) && v.count >= 0 ? { count: v.count, at: v.at || null } : null;
}

// ---- the app database -------------------------------------------------------

// appPsql(containerName, sql) → { code, stdout, stderr } through the stack's
// superuser psql; SQL on stdin.
export async function appPsql(containerName, sql, { timeoutMs = 30_000 } = {}) {
  const { foundationPsql } = await stack();
  return foundationPsql(containerName, sql, { database: 'app', timeoutMs });
}

// One sync at a time per deployment, in the order requested: a slower, older
// sync must never land after a newer one.
const syncChains = new Map();
function serialized(projectId, fn) {
  const key = Number(projectId);
  const prev = syncChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  syncChains.set(key, next);
  next.finally(() => { if (syncChains.get(key) === next) syncChains.delete(key); }).catch(() => {});
  return next;
}

// syncFoundationToApp(projectId, { statements }) → { ok, generation } |
// { ok: false, error }. Never throws. `statements` run first inside the same
// transaction (the index promotion of a reembed).
export function syncFoundationToApp(projectId, { statements = [], timeoutMs = 30_000 } = {}) {
  return serialized(projectId, async () => {
    try {
      const pid = Number(projectId);
      const project = getFoundationProject(pid);
      if (!project?.foundation_version) return { ok: false, error: 'not a foundation deployment' };
      if (!project.container_name) return { ok: false, error: 'the project has no container yet' };
      const masterKey = readSecret(pid, SECRET_NAMES.masterKey);
      if (!masterKey) return { ok: false, error: 'the deployment has no master key yet (it is generated at provisioning)' };
      const rows = readFeatureRows(pid);
      const sealed = appSecretNames(listSecretNames(pid)).map((name) => ({ name, sealed: sealForApp(masterKey, name, readSecret(pid, name)) }));
      const sql = buildSyncSql({ features: rows, sealed, statements });
      const r = await appPsql(project.container_name, sql, { timeoutMs });
      const generation = parseGeneration(r?.stdout);
      if (Number(r?.code) !== 0 || generation == null) {
        return { ok: false, error: `the app database did not accept the update: ${redactSecrets(String(r?.stderr || r?.stdout || 'no output')).trim().slice(-300)}` };
      }
      return { ok: true, generation };
    } catch (e) {
      return { ok: false, error: redactSecrets(e?.message || String(e)).slice(0, 300) };
    }
  });
}

// ---- jobs -------------------------------------------------------------------

export function insertJob({ id, projectId, kind, params = {}, createdBy = null }) {
  if (!isValidJobId(id)) throw new Error('invalid job id');
  const now = nowIso();
  getMock2Db().prepare(`INSERT INTO mock2_foundation_jobs (id, project_id, kind, state, params_json, progress_json, error, created_by, created_at, updated_at, finished_at)
    VALUES (?, ?, ?, 'queued', ?, '{}', NULL, ?, ?, ?, NULL)`).run(id, Number(projectId), kind, JSON.stringify(params), createdBy == null ? null : Number(createdBy), now, now);
  return getJob(id);
}

export function getJob(id) {
  return getMock2Db().prepare('SELECT * FROM mock2_foundation_jobs WHERE id = ?').get(String(id)) || null;
}

export function listJobs(projectId, limit = 10) {
  return getMock2Db().prepare('SELECT * FROM mock2_foundation_jobs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(Number(projectId), Number(limit));
}

export function activeJobFor(projectId) {
  return getMock2Db().prepare("SELECT * FROM mock2_foundation_jobs WHERE project_id = ? AND state IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(Number(projectId)) || null;
}

export function listActiveJobs() {
  return getMock2Db().prepare("SELECT * FROM mock2_foundation_jobs WHERE state IN ('queued','running') ORDER BY created_at").all();
}

export function updateJob(id, { state, progress, error, finished } = {}) {
  const cur = getJob(id);
  if (!cur) return null;
  const nextProgress = progress === undefined ? cur.progress_json : JSON.stringify({ ...(parseJsonObject(cur.progress_json, {}) || {}), ...progress });
  getMock2Db().prepare('UPDATE mock2_foundation_jobs SET state = ?, progress_json = ?, error = ?, updated_at = ?, finished_at = ? WHERE id = ?').run(
    state || cur.state, nextProgress, error === undefined ? cur.error : (error == null ? null : redactSecrets(String(error)).slice(0, 1000)),
    nowIso(), finished ? nowIso() : cur.finished_at, id,
  );
  return getJob(id);
}

// ---- promotion snapshots ----------------------------------------------------
// A promotion changes mock2.db first, then the app database; if the app side
// refuses, the snapshot puts mock2.db back exactly (ciphertext copied as is).

export function snapshotFeature(projectId, feature, secretNames = []) {
  const db = getMock2Db();
  const row = db.prepare('SELECT * FROM mock2_foundation_features WHERE project_id = ? AND feature = ?').get(Number(projectId), feature) || null;
  const secrets = secretNames.map((name) => ({ name, row: db.prepare('SELECT * FROM mock2_foundation_secrets WHERE project_id = ? AND name = ?').get(Number(projectId), name) || null }));
  return { feature, row, secrets };
}

export function restoreFeature(projectId, snap) {
  const db = getMock2Db();
  db.transaction(() => {
    if (snap.row) {
      db.prepare(`INSERT INTO mock2_foundation_features (project_id, feature, state, provider, config_json, pending_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, feature) DO UPDATE SET state = excluded.state, provider = excluded.provider, config_json = excluded.config_json, pending_json = excluded.pending_json, updated_at = excluded.updated_at`)
        .run(snap.row.project_id, snap.row.feature, snap.row.state, snap.row.provider, snap.row.config_json, snap.row.pending_json, snap.row.updated_at);
    } else {
      db.prepare('DELETE FROM mock2_foundation_features WHERE project_id = ? AND feature = ?').run(Number(projectId), snap.feature);
    }
    for (const { name, row } of snap.secrets) {
      db.prepare('DELETE FROM mock2_foundation_secrets WHERE project_id = ? AND name = ?').run(Number(projectId), name);
      if (row) db.prepare('INSERT INTO mock2_foundation_secrets (project_id, name, ciphertext, created_at, rotated_at) VALUES (?, ?, ?, ?, ?)').run(row.project_id, row.name, row.ciphertext, row.created_at, row.rotated_at);
    }
  })();
}

// ---- component secrets on a foundation deployment ---------------------------

async function probeGuard(containerName, guard) {
  try {
    const exists = parseJsonRows((await appPsql(containerName, buildGuardProbeSql(guard), { timeoutMs: 20_000 }))?.stdout)[0];
    if (!exists) return 'unknown';
    if (exists.exists === false) return 'no_table';
    const rows = parseJsonRows((await appPsql(containerName, buildGuardRowsSql(guard), { timeoutMs: 20_000 }))?.stdout)[0];
    if (!rows) return 'unknown';
    return rows.rows ? 'rows' : 'empty';
  } catch { return 'unknown'; }
}

// mintFoundationComponentSecrets({ project, configs, newlyProvisioned, deliver })
// → { ok, minted, deferred, required, held, delivered, error } (key NAMES only).
// The foundation counterpart of the environment-file mint: values are stored
// encrypted as component.<KEY> and delivered sealed by a sync.
export async function mintFoundationComponentSecrets({ project, configs = [], newlyProvisioned = false, deliver = true } = {}) {
  const pid = Number(project?.id);
  const heldNames = listSecretNames(pid).filter((n) => n.startsWith('component.'));
  const probes = {};
  if (newlyProvisioned) {
    for (const c of configs || []) {
      if (!c?.protects?.table || heldNames.includes(componentSecretName(String(c.key || '')))) continue;
      probes[c.key] = project.container_name ? await probeGuard(project.container_name, c.protects) : 'unknown';
    }
  }
  const plan = planFoundationComponentMint({ configs, heldNames, newlyProvisioned, probes });
  const minted = [];
  for (const key of plan.mint) {
    if (insertSecretIfAbsent(pid, componentSecretName(key), randomBytes(32).toString('base64url'))) minted.push(key);
  }
  let delivered = [];
  let error = null;
  if (deliver) {
    const s = await syncFoundationToApp(pid);
    if (s.ok) delivered = [...plan.required];
    else error = s.error;
  }
  return { ok: error == null, minted, deferred: plan.deferred, required: plan.required, held: plan.held, delivered, error, store: 'foundation' };
}

// foundationDeployParams({ project, configs, newlyProvisioned, deliver }) → the
// deploy plan's foundation reference: { version, required, delivered, error? }
// — NAMES only. With deliver, absent keys are minted and everything is synced
// first; without it, the names held are reported and nothing is written.
export async function foundationDeployParams({ project, configs = [], newlyProvisioned = false, deliver = false } = {}) {
  const ref = { version: project.foundation_version, required: [], delivered: [] };
  if (!deliver) {
    const held = new Set(listSecretNames(project.id));
    ref.required = (configs || []).filter((c) => c?.secret === true && c?.generate === true && held.has(componentSecretName(String(c.key || '')))).map((c) => String(c.key));
    return ref;
  }
  const m = await mintFoundationComponentSecrets({ project, configs, newlyProvisioned, deliver: true });
  ref.required = m.required;
  ref.delivered = m.delivered;
  if (m.error) ref.error = m.error;
  return ref;
}
