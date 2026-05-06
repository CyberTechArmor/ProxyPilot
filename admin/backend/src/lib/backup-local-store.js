// Local on-disk store for backup artifacts.
//
// Operator-requested architecture (post-PR-2 feedback):
//
//   * Pack the artifact into RAM (existing packer).
//   * Write the artifact to a local file under
//     /var/lib/proxypilot/backups/<id>.ppbackup with mode 0600.
//     This is the canonical copy from the dashboard's POV —
//     restore + download read from local first when present.
//   * Optionally push to a configured S3-compatible destination
//     for off-host durability (handled by the route / scheduler;
//     this module only knows about local).
//   * Local retention pruning runs on a schedule's keep / days
//     gates.  S3 management is a separate UI surface — operators
//     choose when to drop S3 copies.
//
// Why one file per backup (rather than streaming into a single
// big container): each ppbackup carries its own header +
// AES-GCM tag, so a per-backup file is the natural unit and a
// corrupted single file doesn't affect siblings.

import fs from 'node:fs';
import path from 'node:path';

// Resolve the on-disk root.  Override via env so containerised
// installs can mount a host path; default matches the rest of the
// dashboard's `/var/lib/proxypilot` convention.
export function backupRoot() {
  return process.env.PROXYPILOT_BACKUP_DIR || '/var/lib/proxypilot/backups';
}

// Idempotent directory ensure.  0700 because every file inside
// is a 0600 ciphertext — directory perms have to match or `ls`
// will leak which IDs exist on the host.
export function ensureRoot() {
  const dir = backupRoot();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // Tolerate pre-existing dirs with looser perms — tighten on
    // the way through.  Fail-soft: we don't have a way to chmod a
    // path mounted from outside the container, so chmod errors
    // here are logged but non-fatal.
    try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
  return dir;
}

// Build the absolute path for a backup id.  Path traversal is
// guarded by the id format — uuid v4 is hex + dashes, so no '..'
// or '/' can sneak in — but we belt-and-braces here.
export function localPathFor(id) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id || '')) {
    throw new Error(`localPathFor: refusing unsafe id ${JSON.stringify(id)}`);
  }
  return path.join(backupRoot(), `${id}.ppbackup`);
}

// Atomic write: write to a tmp sibling + rename.  The renameSync
// is atomic within a single filesystem; readers never see a
// half-written file.
export function writeLocal(id, buffer) {
  ensureRoot();
  const finalPath = localPathFor(id);
  const tmp = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, buffer, { mode: 0o600, flag: 'wx' });
  // writeFileSync's mode arg respects umask on create; chmod
  // explicitly so we get exactly 0600 on every host.
  try { fs.chmodSync(tmp, 0o600); } catch { /* ignore */ }
  fs.renameSync(tmp, finalPath);
  return finalPath;
}

// Best-effort delete.  Returns true if the file was present and
// removed, false if it was already absent.  Throws only on
// permission errors / unreadable paths.
export function deleteLocal(absPath) {
  if (!absPath) return false;
  try {
    fs.unlinkSync(absPath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

// Disk usage across every artifact under backupRoot.  Used by the
// usage card so operators can see the on-disk footprint without
// guessing.  Soft-fails on individual stat errors; the worst case
// is a slightly under-reported total.
export function localDiskUsage() {
  const dir = backupRoot();
  if (!fs.existsSync(dir)) return { count: 0, bytes: 0, oldest: null, newest: null };
  let names;
  try { names = fs.readdirSync(dir); } catch { return { count: 0, bytes: 0, oldest: null, newest: null }; }
  let count = 0;
  let bytes = 0;
  let oldest = null;
  let newest = null;
  for (const n of names) {
    if (!n.endsWith('.ppbackup')) continue;
    try {
      const s = fs.statSync(path.join(dir, n));
      count += 1;
      bytes += s.size;
      const mt = s.mtimeMs;
      if (oldest == null || mt < oldest) oldest = mt;
      if (newest == null || mt > newest) newest = mt;
    } catch { /* ignore */ }
  }
  return {
    count,
    bytes,
    oldest: oldest ? new Date(oldest).toISOString() : null,
    newest: newest ? new Date(newest).toISOString() : null,
    dir,
  };
}

// Open a Readable stream at the artifact's bytes.  Caller is
// responsible for piping + closing.  Throws ENOENT if missing —
// the route layer translates that into a 404.
export function openLocalReadStream(id) {
  return fs.createReadStream(localPathFor(id));
}
