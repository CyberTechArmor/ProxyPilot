// Migration-history repair for one specific accident, kept pure (no DB
// import) so it can be tested against disposable populated databases.
//
// A checkout of the immediate-repairs branch briefly numbered the MCP
// owner-validity migration 912 before main took that number for
// lxc_exports. A database that ran that branch carries a 912 row with the
// OTHER name, and runMigration — keyed by number — would then skip
// lxc_exports for good. The repair identifies the migration BY NAME, never by
// number alone: a legitimate 912 (lxc_exports) is untouched.
//
// States:
//   no 912 row                              → none
//   912 = lxc_exports (legitimate)          → none
//   912 = mcp_tokens_owner_validity, no 913 → moved to 913
//   912 = mcp_tokens_owner_validity, 913 = the same name → 912 deleted (a
//     duplicate record of one migration; nothing else is ever deleted)
//   912 = mcp_tokens_owner_validity, 913 = another name → conflict, untouched,
//     reported (cannot happen in this repository's history; refuse to guess)
// Runs in one transaction; re-running after an interruption is a no-op.

export const STRAY_MIGRATION = Object.freeze({ version: 912, name: 'mcp_tokens_owner_validity', to: 913 });

function inTransaction(db, fn) {
  if (typeof db.transaction === 'function') return db.transaction(fn)();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

export function repairStrayMigration912(db, { log = null } = {}) {
  const { version, name, to } = STRAY_MIGRATION;
  const result = inTransaction(db, () => {
    const row = db.prepare('SELECT name FROM schema_migrations WHERE version = ?').get(version);
    if (!row) return { action: 'none', reason: `no ${version} recorded` };
    if (row.name !== name) return { action: 'none', reason: `${version} is ${row.name}, left alone` };
    const target = db.prepare('SELECT name FROM schema_migrations WHERE version = ?').get(to);
    if (target && target.name === name) {
      db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(version);
      return { action: 'deleted-duplicate', reason: `${name} was recorded under both ${version} and ${to}; the ${version} record is removed` };
    }
    if (target) return { action: 'conflict', reason: `${version} is ${name} but ${to} is ${target.name}; nothing changed` };
    db.prepare('UPDATE schema_migrations SET version = ? WHERE version = ?').run(to, version);
    return { action: 'moved', reason: `${name} moved from ${version} to ${to}` };
  });
  if (log && result.action !== 'none') log(`[db] migration history: ${result.reason}`);
  return result;
}
