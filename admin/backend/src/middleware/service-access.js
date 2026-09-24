import { getDb } from '../db.js';
import { canViewService, canWriteService, requireSudo } from './auth.js';

// Content delegation never confers host, Docker, arbitrary routing or raw Caddy
// authority. New endpoints default to administrator-only, including new reads.
const READS = new Set(['/:id', '/:id/routes', '/:id/files', '/:id/files/*',
  '/:id/versions/*', '/:id/version/:versionId', '/:id/download/*',
  '/:id/export-files', '/:id/detected-ports']);
const WRITES = new Set(['POST /:id/favorite', 'PUT /:id/files/*',
  'DELETE /:id/files/*', 'POST /:id/revert/:versionId',
  'PUT /:id/version/:versionId/notes', 'POST /:id/upload/*',
  'POST /:id/zip-upload', 'POST /:id/zip-upload/:uploadId/apply',
  'DELETE /:id/zip-upload/:uploadId', 'POST /:id/import-files']);

export function serviceRoutePolicy(method, path) {
  if (method === 'GET' && path === '/') return 'list';
  if (method === 'POST' && path === '/export') return 'export';
  if (method === 'GET' && READS.has(path)) return 'view';
  if (WRITES.has(`${method} ${path}`)) return 'write';
  return method === 'GET' ? 'admin' : 'admin-sudo';
}

export function serviceAccess(method, path) {
  const policy = serviceRoutePolicy(method, path);
  return (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      const user = getDb().prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
      if (!user || !['admin', 'user'].includes(user.role) || req.user.linkOnly)
        return res.status(403).json({ error: 'Service access denied' });
      req.user.role = user.role;
      if (user.role === 'admin') {
        if (policy === 'admin-sudo') return requireSudo(req, res, next);
        return next();
      }
      if (policy === 'list') return next(); // Handler filters each result.
      if (policy === 'export') {
        const ids = req.body?.serviceIds;
        if (ids != null && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !canViewService(req.user.id, id))))
          return res.status(403).json({ error: 'Service access denied' });
        return next(); // Handler also filters the omitted/all case.
      }
      const id = req.params.id;
      if (policy === 'view' && canViewService(req.user.id, id)) return next();
      if (policy === 'write' && canWriteService(req.user.id, id)) {
        const service = getDb().prepare('SELECT is_admin, type, kind FROM services WHERE id = ?').get(id);
        if (service && !service.is_admin && (path === '/:id/favorite' || service.type === 'static' || service.kind === 'static_site')) return next();
      }
      return res.status(403).json({ error: 'Service access denied' });
    } catch {
      return res.status(503).json({ error: 'Service authorization unavailable' });
    }
  };
}
