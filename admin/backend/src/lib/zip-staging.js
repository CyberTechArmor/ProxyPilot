// Staged zip uploads — the bridge between the two-phase API
// (inspect → confirm → apply) and the uploaded bytes on disk.
//
// The confirmation round-trip must not force the browser to upload
// the archive twice, so the inspect endpoint parks the multer temp
// file here and hands back an opaque id. Apply/cancel look the id
// up (scoped to the same kind + owning resource so an id minted for
// one service can't be replayed against another), and expiry sweeps
// abandoned uploads so a closed tab doesn't leak temp files.
//
// In-memory registry (single-process backend, same as lxc.js's
// activeCreations map). Parsed entry metadata lives here; the zip
// bytes stay on disk until apply re-reads them.

import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const STAGED_TTL_MS = parseInt(process.env.PROXYPILOT_ZIP_STAGE_TTL_MS || String(30 * 60 * 1000), 10);

const staged = new Map();

function sweep(now = Date.now()) {
  for (const [id, rec] of staged) {
    if (now - rec.createdAt > STAGED_TTL_MS) {
      staged.delete(id);
      rm(rec.zipPath, { force: true }).catch(() => {});
    }
  }
}

// stageZipUpload({ kind, refId, zipPath, ...meta }) → record
//   kind:  'service' | 'lxc' — which flow minted it
//   refId: service id / container name it belongs to
//   zipPath: multer temp file (deleted on discard/expiry)
export function stageZipUpload({ kind, refId, zipPath, ...meta }) {
  sweep();
  const id = randomUUID();
  const rec = { id, kind, refId, zipPath, createdAt: Date.now(), ...meta };
  staged.set(id, rec);
  return rec;
}

// getZipUpload(id, kind, refId) → record or null. Scope mismatches
// return null rather than throwing so routes 404 uniformly.
export function getZipUpload(id, kind, refId) {
  sweep();
  const rec = staged.get(id);
  if (!rec || rec.kind !== kind || rec.refId !== refId) return null;
  return rec;
}

// discardZipUpload(id) — drop the record and its temp file. Safe to
// call for unknown ids (cancel after expiry).
export async function discardZipUpload(id) {
  const rec = staged.get(id);
  staged.delete(id);
  if (rec) await rm(rec.zipPath, { force: true }).catch(() => {});
  return Boolean(rec);
}

export function stagedUploadTtlMs() {
  return STAGED_TTL_MS;
}
