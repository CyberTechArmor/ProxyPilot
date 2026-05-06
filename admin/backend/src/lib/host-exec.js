// Host-namespace exec for code that runs inside the dashboard
// Docker container.
//
// The admin container ships only Node + a handful of utility
// binaries (curl, python3, util-linux for nsenter, git).  It
// does NOT ship `incus` or `docker` clients.  Anything that
// wants to talk to the host's Incus or Docker daemons has to
// pivot into the host's mount + network namespaces via nsenter.
//
// routes/lxc.js has had its own `execOnHost` + `spawnOnHost`
// helpers since the LXC tab shipped.  Library code that needs
// the same pivot — backup-pack.js's docker/incus collectors,
// snapshot-s3-export.js's `incus export` shell-out — used bare
// spawnSync, which silently failed with ENOENT inside the
// container.  This module is the shared lib version of the
// same helpers so every host-side shell-out goes through one
// pivot.
//
// Why a separate module: keeping it out of routes/lxc.js avoids
// a circular require — backup-pack imports lib helpers, and we
// don't want lib helpers importing routes.

import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export const IS_IN_DOCKER =
  existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// spawnHostSync(bin, args, opts) — synchronous spawn that runs
// the given binary on the host when inside Docker, or directly
// on the host filesystem when running outside Docker (dev /
// non-containerised installs).
//
// Returns a regular spawnSync result so call-sites that already
// inspect r.status / r.stdout / r.stderr / r.error work without
// changes.
export function spawnHostSync(bin, args = [], opts = {}) {
  if (IS_IN_DOCKER) {
    return spawnSync(
      'nsenter',
      ['-t', '1', '-m', '-u', '-n', '-i', bin, ...args],
      opts,
    );
  }
  return spawnSync(bin, args, opts);
}

// spawnHost(bin, args, opts) — async equivalent for streaming
// long-running output.  Returns a ChildProcess whose stdout /
// stderr the caller can listen on.
export function spawnHost(bin, args = [], opts = {}) {
  if (IS_IN_DOCKER) {
    return spawn(
      'nsenter',
      ['-t', '1', '-m', '-u', '-n', '-i', bin, ...args],
      opts,
    );
  }
  return spawn(bin, args, opts);
}

// hasHostBinary(bin) — is the named binary available on the
// host?  Uses `command -v` on the host so a bare `which incus`
// inside the dashboard container can't fool the caller into
// thinking it's missing.
export function hasHostBinary(bin) {
  // `command -v` is a shell builtin — use sh on the host.
  const r = spawnHostSync('sh', ['-c', `command -v ${JSON.stringify(bin)}`], {
    encoding: 'utf-8',
  });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}
