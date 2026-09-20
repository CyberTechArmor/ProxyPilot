// The one export store the backend shares between the LXC routes (the
// container dialog's prepared downloads) and the MCP lxc-admin family
// (export_lxc, list_lxc_exports, delete_lxc_export), so both see one list of
// artifacts rather than two views of a directory that disagree.
//
// The exports directory is the managed ZFS dataset when there is one, exactly
// as export_lxc has always resolved it — the tarballs sit beside the ones the
// MCP verbs already write.

import { getDb, getSetting, logAudit } from '../db.js';
import { runHostCapture } from './lxc-zip.js';
import { hasHostBinary } from './host-exec.js';
import { createExportStore } from './lxc-exports.js';
import { COMPRESSION_SETTING, resolveCompression } from './export-compression.js';
import { storageService } from './storage/index.js';

const DEFAULT_EXPORTS_DIR = '/var/lib/proxypilot/mcp-exports';

/** The managed exports dataset's mountpoint, or the default directory. */
export async function resolveExportsDir() {
  try {
    const svc = storageService?.();
    const m = svc?.managed?.();
    if (m) {
      const d = await svc.host.datasets();
      const mp = d.datasets.find((x) => x.name === m.datasets.exports)?.mountpoint;
      if (mp && mp.startsWith('/')) return mp;
    }
  } catch { /* fall back */ }
  return DEFAULT_EXPORTS_DIR;
}

/**
 * The compressor for a tarball written outside the store (delete_project's
 * pre-delete export, and anything else that shells out to `incus export`
 * itself): the same setting, the same zstd default, the same gzip fallback.
 */
export function resolveExportCompression(requested = null) {
  let setting = null;
  try { setting = getSetting(COMPRESSION_SETTING); } catch { setting = null; }
  return resolveCompression({ requested, setting, hasBinary: (b) => hasHostBinary(b) });
}

const hostSh = (script, argv = [], opts = {}) =>
  runHostCapture('sh', ['-c', script, 'sh', ...argv], { timeoutMs: 60000, ...opts });

let instance = null;

export function exportStore() {
  if (!instance) {
    instance = createExportStore({
      getDb,
      runHost: (bin, args, opts) => runHostCapture(bin, args, opts),
      hostSh,
      exportsDir: resolveExportsDir,
      getSetting: (k) => { try { return getSetting(k); } catch { return null; } },
      logAudit,
      hasBinary: async (bin) => hasHostBinary(bin),
    });
  }
  return instance;
}

/** Tests install their own store. */
export function setExportStore(s) { instance = s; }
