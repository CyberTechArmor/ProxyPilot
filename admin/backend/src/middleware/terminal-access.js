import { getDb } from '../db.js';
import { getUserPermissions } from './auth.js';
import { requireLocalProof } from '../lib/sso/sessions.js';

// A proxy feature grant alone is not authority over every guest. Delegated
// guest operators also need an explicit write grant on a service in that guest.
export function canManageGuest(user, name) {
  if (!user || user.linkOnly || user.enrollmentOnly || !/^[a-zA-Z0-9_-]{1,64}$/.test(name || '')) return false;
  const db = getDb();
  const current = db.prepare('SELECT role FROM users WHERE id=?').get(user.id);
  if (current?.role === 'admin') return true;
  if (current?.role !== 'user' || !getUserPermissions(user.id).includes('proxy')) return false;
  return !!db.prepare(`SELECT 1 FROM services s JOIN user_service_access a ON a.service_id=s.id
    WHERE a.user_id=? AND a.can_write=1 AND s.lxc_container_name=? AND s.is_admin=0`).get(user.id, name);
}

export function requireGuestAccess(req, res, next) {
  try {
    if (canManageGuest(req.user, req.params.name)) return next();
    return res.status(403).json({ error: 'Guest access denied' });
  } catch { return res.status(503).json({ error: 'Guest authorization unavailable' }); }
}

export function terminalDecision({ user, session, target, origin, opening = false, mock2Authorizer }) {
  try {
    const current = getDb().prepare('SELECT role FROM users WHERE id=?').get(user?.id);
    if (!current || !['admin', 'user'].includes(current.role) || session?.user_id !== user.id ||
        session.linkOnly || user.linkOnly || user.enrollmentOnly) return false;
    const identity = { ...user, role: current.role };
    if (target.kind === 'host') {
      if (current.role !== 'admin' || !(Date.parse(session.sudo_until) > Date.now())) return false;
      if (opening) requireLocalProof(getDb(), user.jti, origin);
      return true;
    }
    if (target.kind === 'lxc') return canManageGuest(identity, target.target);
    if (target.kind === 'mock2') {
      const decision = mock2Authorizer?.({ user: identity, projectId: target.projectId });
      if (!decision?.ok || typeof decision.containerName !== 'string') return false;
      if (target.target && target.target !== decision.containerName) return false;
      target.target = decision.containerName;
      return true;
    }
    return false;
  } catch { return false; }
}
