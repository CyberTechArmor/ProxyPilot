import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createBrowserArtifactFiles } from './operational-browser-artifacts-files.js';
import { browserArtifactsConfiguration } from './operational-selected-browser-runtime.js';

// Separate explicit administrator review; never an automatic env fallback.
export const SOURCE_MEMORY_ROOT = '/var/lib/proxypilot/browser-private';
export const SOURCE_MEMORY_QUOTA = 268435456;
export const SOURCE_MEMORY_SETTING = 'operations_source_memory:local_review';
const refuse = message => { throw Object.assign(new Error(message), { status: 409 }); };
const reviewedLocalConfiguration = root => browserArtifactsConfiguration({ OPERATIONS_BROWSER_ARTIFACT_BOUNDARY_REVIEWED: 'true', OPERATIONS_BROWSER_ARTIFACT_DIR: root, OPERATIONS_BROWSER_ARTIFACT_QUOTA_BYTES: String(SOURCE_MEMORY_QUOTA) });
const configuredEnv = env => !!env.OPERATIONS_BROWSER_ARTIFACT_DIR || !!env.OPERATIONS_BROWSER_ARTIFACT_QUOTA_BYTES || env.OPERATIONS_BROWSER_ARTIFACT_BOUNDARY_REVIEWED === 'true';
const reviewHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = db => { try { return JSON.parse(db.prepare('SELECT value FROM app_settings WHERE key=?').get(SOURCE_MEMORY_SETTING)?.value || 'null'); } catch { return null; } };
function custody(root, prior = null, { missing = false, ancestors = null } = {}) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root === '/') refuse('Private storage path is invalid.');
  const pins = {};
  for (let current = root; ; current = path.dirname(current)) {
    let info;
    try { info = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT' && current === root && missing) continue; refuse('Private storage directory changed or is unavailable.'); }
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022 || ![0, process.getuid()].includes(info.uid)) refuse('Private storage custody requires owner review.');
    if (ancestors?.[current] && (String(info.dev) !== ancestors[current].dev || String(info.ino) !== ancestors[current].ino)) refuse('Private storage ancestor identity changed.');
    pins[current] = { dev: String(info.dev), ino: String(info.ino) };
    if (current === root && (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || prior && (String(info.dev) !== prior.dev || String(info.ino) !== prior.ino))) refuse('Private storage owner, permissions or identity changed.');
    if (current === path.dirname(current)) break;
  }
  return pins;
}
function approved(db, root) {
  const value = receipt(db);
  if (!value || Object.keys(value).sort().join(',') !== 'audit_id,dev,ino,quota,reviewed_by,root,schema,uid,verified_at' || value.schema !== 'operations-local-source-memory.v1' || value.root !== root || value.quota !== SOURCE_MEMORY_QUOTA || value.uid !== process.getuid() || !/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino) || !/^[0-9a-f-]{36}$/.test(value.reviewed_by) || !/^[0-9a-f-]{36}$/.test(value.audit_id) || typeof value.verified_at !== 'string') return null;
  try { if (new Date(value.verified_at).toISOString() !== value.verified_at) return null; } catch { return null; }
  const audit = db.prepare('SELECT user_id,action,resource_type,resource_id,details FROM audit_log WHERE id=?').get(value.audit_id);
  try { if (!audit || audit.user_id !== value.reviewed_by || audit.action !== 'OPERATIONS_SOURCE_MEMORY_REVIEWED' || audit.resource_type !== 'operations_storage' || audit.resource_id !== 'local' || JSON.parse(audit.details).review_sha256 !== reviewHash(value)) return null; } catch { return null; }

  return value;
}
export function localBrowserArtifactsConfiguration(db, env = process.env, { root = SOURCE_MEMORY_ROOT } = {}) {
  // Existing independent storage configuration and explicit disable always win.
  if (configuredEnv(env)) return browserArtifactsConfiguration(env);
  if (env.OPERATIONS_BROWSER_LOCAL_STORAGE_DISABLED === 'true') return { available: false };
  const config = reviewedLocalConfiguration(root);
  if (!config.available) return { available: false };
  const review = approved(db, root);
  if (!review) return { available: false };
  try { custody(root, review); } catch { return { available: false }; }
  // The existing runtime still opens/verifies its pinned service-owned adapter.
  // No optional decoder setting or capability is inferred from this review.
  return config;
}
export function createSourceMemorySetup({ db, env = process.env, root = SOURCE_MEMORY_ROOT, active = () => false, activationAttempted = () => false }) {
  const status = () => {
    if (configuredEnv(env)) return { managed: false, state: 'operator_configured', can_setup: false, message: 'Existing private storage settings are preserved. Its owner must review that configuration.' };
    if (env.OPERATIONS_BROWSER_LOCAL_STORAGE_DISABLED === 'true') return { managed: false, state: 'disabled', can_setup: false, message: 'Local Source Memory setup is explicitly disabled by the operator.' };
    if (!reviewedLocalConfiguration(root).available) return { managed: false, state: 'unavailable', can_setup: false, message: 'Private storage must be outside the application checkout. Owner review is required.' };
    const review = approved(db, root);
    if (!review && db.prepare('SELECT value FROM app_settings WHERE key=?').get(SOURCE_MEMORY_SETTING)) return { managed: true, state: 'unavailable', can_setup: false, message: 'The retained storage review is invalid. The owner must inspect it.' };
    if (!review) return { managed: true, state: 'not_configured', can_setup: true, quota_bytes: SOURCE_MEMORY_QUOTA };
    try { custody(root, review); const files = createBrowserArtifactFiles(root); try { files.verify(); } finally { files.close(); } }
    catch { return { managed: true, state: 'unavailable', can_setup: false, message: 'Private storage custody changed. The owner must inspect it; no fallback is used.' }; }
    if (!active() && activationAttempted()) return { managed: true, state: 'unavailable', can_setup: false, message: 'Private storage activation failed after backend startup. The owner must inspect it; no fallback is used.' };
    return { managed: true, state: active() ? 'available' : 'reload_required', can_setup: false, quota_bytes: SOURCE_MEMORY_QUOTA, verified_at: review.verified_at };
  };
  const enable = (user, ip = null) => {
    if (db.prepare('SELECT role FROM users WHERE id=?').get(user?.id)?.role !== 'admin') throw Object.assign(new Error('Only an administrator can set up Source Memory.'), { status: 403 });
    const current = status();
    if (!current.can_setup) { if (['available', 'reload_required'].includes(current.state)) return current; refuse(current.message || 'Private storage setup requires owner review.'); }
    // Create exactly one fixed directory. No recursive parent creation, chmod,
    // chown, migration of existing bytes or acceptance of caller paths.
    const ancestorPins = custody(root, null, { missing: true });
    let original;
    try { original = fs.lstatSync(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (original) {
      if (fs.readdirSync(root).length) refuse('Unreviewed private storage already contains data. The owner must inspect it.');
    } else {
      // Pin the reviewed parent before creation. /proc/self/fd stays on that
      // inode if an ancestor is replaced; never mkdir through a raced symlink.
      const parentPath = path.dirname(root), parent = fs.openSync(parentPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const actual = fs.fstatSync(parent), expected = ancestorPins[parentPath];
        if (!expected || String(actual.dev) !== expected.dev || String(actual.ino) !== expected.ino) refuse('Private storage parent identity changed.');
        custody(root, null, { missing: true, ancestors: ancestorPins });
        const pinnedPath = `/proc/self/fd/${parent}/${path.basename(root)}`;
        // A raced EEXIST is an unknown root, never an adoption opportunity.
        try { fs.mkdirSync(pinnedPath, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') refuse('Private storage appeared during setup. The owner must inspect it.'); throw error; }
        original = fs.lstatSync(pinnedPath); fs.fsyncSync(parent);
      } finally { fs.closeSync(parent); }
    }
    const pin = { dev: String(original.dev), ino: String(original.ino) };
    custody(root, pin, { ancestors: ancestorPins });
    if (fs.readdirSync(root).length) refuse('Unreviewed private storage changed during setup. The owner must inspect it.');
    const files = createBrowserArtifactFiles(root), id = randomUUID(), bytes = Buffer.from('ProxyPilot private source storage probe v1\n');
    let written = false;
    try {
      const pins = files.write(id, bytes); written = true;
      const read = files.read(id, pins); try { if (!read.equals(bytes)) refuse('Private storage verification failed.'); } finally { read.fill(0); }
      if (files.remove(id) !== 'deleted') refuse('Private storage cleanup verification failed.'); written = false; files.verify();
    } finally { try { if (written) files.remove(id); } finally { try { files.close(); } finally { bytes.fill(0); } } }
    custody(root, pin, { ancestors: ancestorPins });
    if (fs.readdirSync(root).length) refuse('Unreviewed private storage changed during verification. The owner must inspect it.');
    const value = { schema: 'operations-local-source-memory.v1', root, quota: SOURCE_MEMORY_QUOTA, uid: process.getuid(), dev: pin.dev, ino: pin.ino, verified_at: new Date().toISOString(), reviewed_by: user.id, audit_id: randomUUID() };
    db.exec('BEGIN IMMEDIATE');
    try {
      custody(root, pin, { ancestors: ancestorPins });
      if (fs.readdirSync(root).length) refuse('Private storage changed before review was committed.');
      // Re-read the actor inside the same transaction as review/audit.
      if (db.prepare('SELECT role FROM users WHERE id=?').get(user.id)?.role !== 'admin') throw Object.assign(new Error('Administrator access changed.'), { status: 403 });
      db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(SOURCE_MEMORY_SETTING, JSON.stringify(value));
      db.prepare('INSERT INTO audit_log(id,user_id,action,resource_type,resource_id,details,ip_address) VALUES(?,?,?,?,?,?,?)').run(value.audit_id, user.id, 'OPERATIONS_SOURCE_MEMORY_REVIEWED', 'operations_storage', 'local', JSON.stringify({ quota_bytes: SOURCE_MEMORY_QUOTA, storage_probe: 'write_read_hash_delete', owner_backend_restart_required: true, review_sha256: reviewHash(value) }), ip);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return status();
  };
  return { status, enable };
}
