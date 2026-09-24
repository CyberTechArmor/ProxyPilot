import { getDb } from '../db.js';
import { requireSudo } from './auth.js';
import { canManageGuest } from './terminal-access.js';
import { exportStore } from '../lib/lxc-exports-instance.js';

// Default-deny shared host operations. A guest grant is not a network,
// provisioning, routing or cross-guest restore grant.
const GUEST_PATHS = new Set([
  '/containers/:name', '/containers/:name/state', '/containers/:name/snapshots',
  '/containers/:name/create-status', '/containers/:name/listening-ports',
  '/containers/:name/exec', '/containers/:name/tab-complete',
  '/containers/:name/files', '/containers/:name/files/download', '/containers/:name/files/upload',
  '/containers/:name/zip-upload', '/containers/:name/zip-upload/:uploadId/apply', '/containers/:name/zip-upload/:uploadId',
  '/containers/:name/start', '/containers/:name/stop', '/containers/:name/restart', '/containers/:name/reboot',
  '/containers/:name/export-info', '/containers/:name/export',
  '/containers/:name/snapshot/:snapshotName/export-info', '/containers/:name/snapshot/:snapshotName/export',
]);
export function lxcRoutePolicy(method, path) {
  if (method === 'GET' && ['/status', '/containers', '/containers/with-ip', '/exports'].includes(path)) return 'list';
  if (path === '/exports' && method === 'POST') return 'export-create';
  if (['/exports/:id', '/exports/:id/download'].includes(path)) return 'export';
  if (GUEST_PATHS.has(path)) return 'guest';
  return method === 'GET' ? 'admin' : 'admin-sudo';
}
export function lxcAccess(method, path) {
  const policy = lxcRoutePolicy(method, path);
  return (req, res, next) => {
    try {
      const role = getDb().prepare('SELECT role FROM users WHERE id=?').get(req.user?.id)?.role;
      if (!['admin', 'user'].includes(role) || req.user?.linkOnly || req.user?.enrollmentOnly)
        return res.status(403).json({ error: 'Guest access denied' });
      req.user.role = role;
      if (role === 'admin') return policy === 'admin-sudo' ? requireSudo(req,res,next) : next();
      if (policy === 'list') return next(); // The handler filters every returned resource.
      let target;
      if (policy === 'guest') target = req.params.name;
      if (policy === 'export-create') target = req.body?.container;
      if (policy === 'export') {
        const row = exportStore().get(req.params.id);
        target = row?.container;
      }
      if (target && canManageGuest(req.user,target)) return next();
      return res.status(403).json({ error: 'Guest access denied' });
    } catch { return res.status(503).json({ error: 'Guest authorization unavailable' }); }
  };
}
