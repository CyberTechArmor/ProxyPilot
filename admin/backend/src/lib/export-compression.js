// How ProxyPilot compresses the tarballs it makes.
//
// One decision, one place. Before this module every export site made its own
// choice and they had all drifted to gzip — the browser download and the MCP
// verbs by taking Incus's default, the S3 push and the backup pack by naming
// it outright. gzip is single-threaded at roughly 50 MB/s, which is slower
// than a gigabit link: on a LAN it makes the compressed download arrive LATER
// than an uncompressed one would, while 31 of this host's 32 cores sit idle.
//
// zstd compresses several times faster at a similar ratio, which moves the
// break-even past any link an operator is likely to have, so it is the
// default. The choice is a setting because the right answer does depend on
// where the bytes are going:
//
//   zstd   the default: fast enough that compression is effectively free,
//          small enough that a slow link still benefits.
//   gzip   maximum compatibility, and the automatic fallback when the host
//          has no zstd binary (Incus shells out to it).
//   none   only worth it above ~10 Gb, where even zstd is the bottleneck.
//
// Nothing here decompresses: `incus import`, `tar` and `zstd -d` all detect
// the format, and decompression is 5-10x cheaper than compression anyway, so
// the restore path never has to know what was chosen.

export const COMPRESSIONS = Object.freeze(['zstd', 'gzip', 'none']);
export const DEFAULT_COMPRESSION = 'zstd';
/** The app_settings key. Absent or invalid → DEFAULT_COMPRESSION. */
export const COMPRESSION_SETTING = 'exports.compression';

/** A caller's string, or null when it is not one of ours. */
export function normalizeCompression(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'zst') return 'zstd';
  return COMPRESSIONS.includes(v) ? v : null;
}

/** What the file is called. Incus and tar both pick the format from content, but humans and `ls` do not. */
export function extensionFor(compression) {
  switch (normalizeCompression(compression)) {
    case 'gzip': return '.tar.gz';
    case 'none': return '.tar';
    default: return '.tar.zst';
  }
}

/** What an S3 object of this shape should be served as. */
export function contentTypeFor(compression) {
  switch (normalizeCompression(compression)) {
    case 'gzip': return 'application/gzip';
    case 'none': return 'application/x-tar';
    default: return 'application/zstd';
  }
}

/** The `incus export` flag pair, or [] for the server default (never used — we are always explicit). */
export function incusCompressionArgs(compression) {
  const c = normalizeCompression(compression) || DEFAULT_COMPRESSION;
  return ['--compression', c];
}

/** The `tar` flag the migration agent's source host would use. */
export function tarCompressionFlag(compression) {
  switch (normalizeCompression(compression)) {
    case 'gzip': return '-z';
    case 'none': return null;
    default: return '--zstd';
  }
}

/** Every tarball name ProxyPilot has ever written, for listing and cleanup. */
export const TARBALL_SUFFIX_RE = /\.tar(\.gz|\.zst|\.xz|\.zstd)?$/;

/**
 * resolveCompression({ requested, setting, hasBinary })
 *
 * The order is: what this call asked for → what the operator configured →
 * the default. Then reality: zstd is a separate binary that Incus shells out
 * to, and a host without it fails the export with an unhelpful message. So an
 * unavailable compressor FALLS BACK to gzip and says so, rather than failing
 * a backup over a missing package.
 *
 * `hasBinary(name)` is injected (sync or async) so this is testable and so a
 * caller that already knows can skip the probe.
 */
export async function resolveCompression({ requested = null, setting = null, hasBinary = null } = {}) {
  const asked = normalizeCompression(requested);
  const configured = normalizeCompression(setting);
  const wanted = asked || configured || DEFAULT_COMPRESSION;
  const source = asked ? 'request' : configured ? 'setting' : 'default';
  if (wanted !== 'zstd' || typeof hasBinary !== 'function') {
    return { compression: wanted, source, fell_back_from: null, extension: extensionFor(wanted) };
  }
  const present = await hasBinary('zstd');
  if (present) return { compression: 'zstd', source, fell_back_from: null, extension: extensionFor('zstd') };
  return {
    compression: 'gzip',
    source,
    fell_back_from: 'zstd',
    extension: extensionFor('gzip'),
    note: 'zstd is not installed on this host, so this tarball is gzip. `apt install zstd` and the next one is zstd.',
  };
}
