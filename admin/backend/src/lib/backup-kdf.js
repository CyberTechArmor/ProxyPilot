// KDF abstraction for the Backups feature.
//
// Two algorithms ship today:
//
//   scrypt    — node:crypto stdlib.  v1 of the .ppbackup wire
//               format used this exclusively (PR 1 + PR 2).  Every
//               existing artifact in operator buckets / on-disk
//               local stores is encrypted with a scrypt-derived
//               key, so we will keep scrypt-decrypt support
//               permanently.
//   argon2id  — `argon2` package.  v2 default.  Preferred by
//               every modern KDF guideline (RFC 9106, OWASP) and
//               called out in the master-prompt spec; we deferred
//               to PR 1 because the package is a native module.
//
// Header carries a `kdf` field; this module dispatches by that
// value so a single decrypt path handles both formats.  Pack
// path writes argon2id by default; operators on hosts where the
// argon2 native module won't build can pin scrypt via
// PROXYPILOT_BACKUP_KDF=scrypt.
//
// argon2 is loaded via dynamic import so it's only required when
// actually used.  Hosts that pinned scrypt skip the module
// entirely; hosts that intend to use argon2id but the package
// failed to install get a clear runtime error pointing at the
// failure mode rather than a startup crash.

import crypto from 'node:crypto';

// Sane defaults tuned to ~50 ms on a modern x86 core, matching
// the existing scrypt timing.  Operators with strict performance
// requirements can override via env vars; mismatching params
// between pack + decrypt is fine because the header carries the
// values per artifact.
export const SCRYPT_PARAMS = Object.freeze({
  N: 32768, // 2^15 — ~32 MiB memory
  r: 8,
  p: 1,
  keyLen: 32,
});

export const ARGON2ID_PARAMS = Object.freeze({
  // m=64MiB, t=3, p=4 — RFC 9106 'second recommended option'
  // (memory-constrained settings).  Adjust upward in 4-byte
  // increments if hardware allows; the header carries these
  // values so a future bump is forward-compatible.
  memoryCost: 65536, // KiB
  timeCost: 3,
  parallelism: 4,
  keyLen: 32,
});

// Read at call time (not module load) so a test-time env
// mutation can pin scrypt without rebuilding the import graph.
function preferredKdf() {
  return process.env.PROXYPILOT_BACKUP_KDF || 'argon2id';
}

// Default KDF + params for new artifacts.  Pack writes these
// into the header alongside the salt + iv so the inverse path
// can reproduce the key from the operator's passphrase later.
export function defaultKdfSpec() {
  if (preferredKdf() === 'scrypt') {
    return { kdf: 'scrypt', kdf_params: { ...SCRYPT_PARAMS } };
  }
  return { kdf: 'argon2id', kdf_params: { ...ARGON2ID_PARAMS } };
}

// deriveKey({ kdf, kdf_params, passphrase, salt }) → 32-byte Buffer
//
// Dispatches by kdf name.  Returns a Promise so callers can
// `await` regardless of which algorithm fired.  Throws when the
// kdf is unknown OR when argon2 is requested but the package
// isn't installed (latter case carries a remediation hint).
export async function deriveKey({ kdf, kdf_params = {}, passphrase, salt }) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('deriveKey: passphrase is required');
  }
  if (!Buffer.isBuffer(salt) || salt.length === 0) {
    throw new Error('deriveKey: salt must be a non-empty Buffer');
  }
  if (kdf === 'scrypt') {
    const params = { ...SCRYPT_PARAMS, ...kdf_params };
    return new Promise((resolve, reject) => {
      crypto.scrypt(
        Buffer.from(passphrase, 'utf-8'),
        salt,
        params.keyLen,
        {
          N: params.N,
          r: params.r,
          p: params.p,
          maxmem: 256 * 1024 * 1024,
        },
        (err, key) => err ? reject(err) : resolve(key),
      );
    });
  }
  if (kdf === 'argon2id') {
    let argon2;
    try {
      argon2 = await import('argon2');
    } catch (err) {
      throw new Error(
        `deriveKey: argon2 package not available (${err?.message || err}). ` +
        `Install it with \`npm install argon2\` in admin/backend, or pin scrypt via ` +
        `PROXYPILOT_BACKUP_KDF=scrypt to keep using node:crypto's stdlib KDF.`
      );
    }
    const params = { ...ARGON2ID_PARAMS, ...kdf_params };
    // argon2.hash with `raw: true` returns the derived key bytes
    // directly (no encoded string).  type: argon2id is the
    // memory-hard variant we want — argon2.argon2id is the
    // exported constant in v0.41+.
    return argon2.hash(passphrase, {
      type: argon2.argon2id,
      raw: true,
      salt,
      memoryCost: params.memoryCost,
      timeCost: params.timeCost,
      parallelism: params.parallelism,
      hashLength: params.keyLen,
    });
  }
  throw new Error(`deriveKey: unsupported KDF ${JSON.stringify(kdf)}`);
}

// Convenience for callers that just want a fresh key + the spec
// they used so they can serialise both into the artifact header.
export async function freshKey(passphrase, saltBytes = 16) {
  const salt = crypto.randomBytes(saltBytes);
  const spec = defaultKdfSpec();
  const key = await deriveKey({
    kdf: spec.kdf,
    kdf_params: spec.kdf_params,
    passphrase,
    salt,
  });
  return { key, salt, ...spec };
}
