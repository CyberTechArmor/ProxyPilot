// Superadmin protection rule (ADR-007).
//
// Mock2 adds `users.is_superadmin` as the local break-glass marker that
// survives the future LDAPS user-provisioning layer. The one behavioural
// rule it carries: a superadmin cannot be deactivated or demoted by a
// non-superadmin. Enforced in routes/user.js on the demote (role -> user)
// and delete/deactivate paths.
//
// Kept as a pure predicate here (no DB, no Express) so the rule is
// unit-testable at the module boundary without the native DB (risk R9).

// action: 'demote' | 'deactivate' (deactivate covers account deletion —
// the only deactivation path the current user store has).
export function checkSuperadminProtection({ actorIsSuperadmin, targetIsSuperadmin, action }) {
  if (targetIsSuperadmin && !actorIsSuperadmin) {
    return {
      allowed: false,
      error: `Only a superadmin can ${action} a superadmin account`,
    };
  }
  return { allowed: true };
}
