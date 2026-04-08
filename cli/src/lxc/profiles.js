/**
 * ProxyPilot resource profile management.
 *
 * Resource profiles define default CPU, memory, and disk limits that can be
 * applied to containers at creation time.  They are stored in the local
 * SQLite database (not Incus profiles).
 */

/**
 * List all resource profiles.
 * @param {import('better-sqlite3').Database} db
 * @returns {object[]}
 */
export function listProfiles(db) {
  return db.prepare('SELECT * FROM profiles ORDER BY name').all();
}

/**
 * Get a single resource profile by name.
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @returns {object|null}
 */
export function getProfile(db, name) {
  return db.prepare('SELECT * FROM profiles WHERE name = ?').get(name) || null;
}

/**
 * Create a new resource profile.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.name - Unique profile name
 * @param {number} opts.cpu_limit - CPU core limit
 * @param {number} opts.memory_limit_mb - Memory limit in megabytes
 * @param {number} opts.disk_limit_mb - Disk limit in megabytes
 * @param {string} [opts.description] - Human-readable description
 * @returns {object} The created profile row
 */
export function createProfile(
  db,
  { name, cpu_limit, memory_limit_mb, disk_limit_mb, description },
) {
  const stmt = db.prepare(
    `INSERT INTO profiles (name, cpu_limit, memory_limit_mb, disk_limit_mb, description)
     VALUES (?, ?, ?, ?, ?)`,
  );
  stmt.run(name, cpu_limit, memory_limit_mb, disk_limit_mb, description || null);
  return getProfile(db, name);
}

/**
 * Delete a resource profile.
 *
 * Refuses to delete profiles marked as default (`is_default = 1`).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @throws {Error} If the profile is a default profile or does not exist
 */
export function deleteProfile(db, name) {
  const profile = getProfile(db, name);
  if (!profile) {
    throw new Error(`Profile "${name}" not found.`);
  }
  if (profile.is_default) {
    throw new Error(
      `Cannot delete default profile "${name}". Default profiles are protected.`,
    );
  }
  db.prepare('DELETE FROM profiles WHERE name = ?').run(name);
}

/**
 * Resolve resource limits by merging a named profile's defaults with any
 * CLI overrides (--cpu, --memory, --disk).
 *
 * If no profile name is given the function returns only the overrides that
 * were explicitly provided, letting the caller decide on fallback behaviour.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string|null} profileName - Profile to look up (may be null)
 * @param {object} overrides - CLI flag overrides
 * @param {number} [overrides.cpu] - CPU core override
 * @param {number} [overrides.memory] - Memory MB override
 * @param {number} [overrides.disk] - Disk MB override
 * @returns {{ cpu_limit: number, memory_limit_mb: number, disk_limit_mb: number }}
 * @throws {Error} If a profile name is given but not found
 */
export function getResourceLimits(db, profileName, overrides = {}) {
  let base = { cpu_limit: undefined, memory_limit_mb: undefined, disk_limit_mb: undefined };

  if (profileName) {
    const profile = getProfile(db, profileName);
    if (!profile) {
      throw new Error(`Resource profile "${profileName}" not found.`);
    }
    base = {
      cpu_limit: profile.cpu_limit,
      memory_limit_mb: profile.memory_limit_mb,
      disk_limit_mb: profile.disk_limit_mb,
    };
  }

  return {
    cpu_limit: overrides.cpu ?? base.cpu_limit,
    memory_limit_mb: overrides.memory ?? base.memory_limit_mb,
    disk_limit_mb: overrides.disk ?? base.disk_limit_mb,
  };
}
