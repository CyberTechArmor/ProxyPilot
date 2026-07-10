// Three-tier RBAC role vocabulary (ADR-011).
//
// The product speaks four role tokens — superadmin / admin / developer /
// pending — but the database stores only two orthogonal facts (ADR-007):
// `users.role` ('admin' | 'developer' | 'pending') and the durable local
// break-glass marker `users.is_superadmin`. Option B keeps `is_superadmin`
// a flag (never a literal role value) so a future LDAPS role-sync can never
// strip the last superadmin.
//
//   superadmin  = role='admin'      AND is_superadmin=1
//   admin       = role='admin'      AND is_superadmin=0
//   developer   = role='developer'
//   pending     = role='pending'    (authenticated, no access)
//
// Kept pure (no DB, no Express) so the mapping is unit-testable at the module
// boundary without the native DB (risk R9), and so both the API responses and
// the frontend can share one implementation and never drift.

export const EFFECTIVE_ROLES = ['superadmin', 'admin', 'developer', 'pending'];

// effectiveRole({ role, is_superadmin }) → one of the four tokens above.
// Tolerates the legacy 'user' value (pre-migration snapshots) as 'developer'
// and treats any unknown/missing role as 'pending' (inert — future LDAP safety).
export function effectiveRole({ role, is_superadmin } = {}) {
  const su = is_superadmin === 1 || is_superadmin === true;
  if (role === 'admin') return su ? 'superadmin' : 'admin';
  if (role === 'developer' || role === 'user') return 'developer';
  return 'pending';
}

// roleToColumns(effRole) → the { role, is_superadmin } column pair to persist
// for a chosen effective role. The single source of the Zod-token → DB-columns
// translation used by the create/update user paths. Returns null for an
// unknown token so the caller can 400.
export function roleToColumns(effRole) {
  switch (effRole) {
    case 'superadmin': return { role: 'admin', is_superadmin: 1 };
    case 'admin': return { role: 'admin', is_superadmin: 0 };
    case 'developer': return { role: 'developer', is_superadmin: 0 };
    case 'pending': return { role: 'pending', is_superadmin: 0 };
    default: return null;
  }
}

// A developer or above (superadmin/admin/developer) — i.e. any authenticated
// account that has been granted a real role. Pending is excluded.
export function isDeveloperOrAbove({ role } = {}) {
  return role === 'admin' || role === 'developer';
}
