// Superadmin protection rules (ADR-007 / ADR-011).
//
// Mock2 adds `users.is_superadmin` as the local break-glass marker that
// survives the future LDAPS user-provisioning layer. ADR-011 generalises the
// one behavioural rule it started with into two:
//
//   1. A non-superadmin cannot TOUCH a superadmin account at all — no role
//      change, display-name edit, password reset, deactivate, or delete.
//   2. A non-superadmin cannot GRANT the superadmin role to anyone (including
//      themselves).
//
// Enforced in routes/user.js on every mutation path that targets a user.
//
// Kept as pure predicates here (no DB, no Express) so the rules are
// unit-testable at the module boundary without the native DB (risk R9).

// checkSuperadminProtection — a non-superadmin actor may not perform `action`
// on a superadmin target. `action` is a verb ('modify' | 'demote' |
// 'deactivate' | 'delete' | 'reset the password of' | …) folded into the error.
export function checkSuperadminProtection({ actorIsSuperadmin, targetIsSuperadmin, action }) {
  if (targetIsSuperadmin && !actorIsSuperadmin) {
    return {
      allowed: false,
      error: `Only a superadmin can ${action} a superadmin account`,
    };
  }
  return { allowed: true };
}

// checkSuperadminGrant — only a superadmin may grant (or, symmetrically, the
// caller intends to set is_superadmin=1 on) the superadmin role. A plain admin
// creating/promoting a user to superadmin is refused.
export function checkSuperadminGrant({ actorIsSuperadmin, grantingSuperadmin }) {
  if (grantingSuperadmin && !actorIsSuperadmin) {
    return {
      allowed: false,
      error: 'Only a superadmin can grant the superadmin role',
    };
  }
  return { allowed: true };
}
