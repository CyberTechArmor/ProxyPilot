// Pure path-key helpers for S3-compatible destinations.
//
// Lives in a standalone file (rather than inline in lib/s3.js) so
// callers and tests that don't need the AWS SDK client can pull it
// in without dragging in @aws-sdk/client-s3 + its transitive deps.
// Keeps the unit-test surface small and the path-prefix logic
// reachable from environments where the SDK isn't installed (e.g.
// dry-run tooling on a build host).

// Build the S3 key for a backup. Callers pass a destination row and
// a bare object name; this prepends the row's path_prefix (if any)
// after normalising trailing/leading slashes so we can't accidentally
// emit a double-slash key (legal in S3 but a UX disaster).
export function buildKey(dest, objectName) {
  const prefix = (dest?.path_prefix || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const name = String(objectName || '').replace(/^\/+/, '');
  return prefix ? `${prefix}/${name}` : name;
}
