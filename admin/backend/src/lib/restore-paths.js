// Pure path-safety helpers for the restore engine.
//
// Lives in its own module so tests can exercise the path-traversal
// guard without dragging in db.js's better-sqlite3 dependency.
// lib/restore.js re-exports from here so call sites are unchanged.

// safeExtractName — refuse anything that could escape the sandbox
// dir during a Mode A restore.  Two patterns matter:
//
//   * Absolute paths.  The packer never emits them; an absolute
//     path in the archive is a tamper signal.
//   * '..' segments.  These would let a tar entry write outside
//     the sandbox via path.join's cooperation with relative
//     traversal.  Per-segment check, not a substring match —
//     filenames like 'foo..bar' are one legitimate segment and
//     must pass through.
//
// Returns the input unchanged on success, throws otherwise.
export function safeExtractName(name) {
  if (typeof name !== 'string') {
    throw new Error('safeExtractName: name must be a string');
  }
  if (name.startsWith('/')) {
    throw new Error(`absolute path in archive: ${name}`);
  }
  const parts = name.split('/');
  if (parts.includes('..')) {
    throw new Error(`path traversal in archive: ${name}`);
  }
  return name;
}
