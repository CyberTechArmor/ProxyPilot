// Three-tier RBAC role vocabulary (ADR-011) — the frontend mirror of the
// backend admin/backend/src/lib/roles.js. The API now returns `effectiveRole`
// on every user object; this helper falls back to computing it from
// `role` + `isSuperadmin` so the label/gating logic never drifts.
//
//   superadmin  — full control, incl. other superadmins + the superadmin grant
//   admin       — support role: everything except touching superadmins
//   developer   — AI-assisted dev flow (Projects); sees only what it owns/shares
//   pending     — authenticated but no role yet: no access, awaiting assignment

export function effectiveRole(user) {
  if (!user) return 'pending';
  if (user.effectiveRole) return user.effectiveRole;
  if (user.role === 'admin') return user.isSuperadmin ? 'superadmin' : 'admin';
  if (user.role === 'developer' || user.role === 'user') return 'developer';
  return 'pending';
}

export const ROLE_LABELS = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  developer: 'Developer',
  pending: 'Awaiting role',
};

export function roleLabel(user) {
  return ROLE_LABELS[effectiveRole(user)] || ROLE_LABELS.pending;
}

// Operator = an admin tier (superadmin or admin) — the full ProxyPilot
// operator surface (Dashboard, Incus, VPN, Firewall, Users, …).
export function isOperator(user) {
  const r = effectiveRole(user);
  return r === 'superadmin' || r === 'admin';
}
export function isSuperadmin(user) {
  return effectiveRole(user) === 'superadmin';
}
export function isDeveloper(user) {
  return effectiveRole(user) === 'developer';
}
export function isPending(user) {
  return effectiveRole(user) === 'pending';
}

// The user object the app carries comes from the API response OR the
// localStorage cache written from it. This reads whichever is present.
export function resolveUser(ctxUser) {
  if (ctxUser) return ctxUser;
  try {
    return JSON.parse(localStorage.getItem('user') || '{}');
  } catch {
    return {};
  }
}
