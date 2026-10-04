import { z } from 'zod';
import { OperationsError, fail, parse } from '../lib/operational-projects-logic.js';
import { browserConnectionCapabilities } from '../lib/operational-browser-connections.js';

const empty = z.object({}).strict();
// Inherits authenticateToken, pending-account protection, CSRF and no-store
// from Operations. This namespace is inert metadata, separate from broker use.
export function registerBrowserConnectionRoutes(router, { store, agentsOnly, expected, requireSudo }) {
  const root = '/:id/browser-connections';
  const handle = (operation, { status = 200, mutation = false } = {}) => (req, res) => {
    try {
      if (req.user?.mcp === true || req.operationsActor?.mcp === true || req.operationsActor?.human === false)
        fail(403, 'A current human session is required');
      const data = operation(req, req.operationsActor);
      if (data.connection?.revision) res.set('ETag', `"${data.connection.revision}"`);
      return res.status(status).json(data);
    } catch (error) {
      const known = error instanceof OperationsError;
      if (mutation && known && [401, 403, 404].includes(error.status)) {
        try { store.auditDenied(req.operationsActor, req.params.id, 'browser_connection_metadata', error.status); } catch { /* preserve refusal */ }
      }
      return res.status(known ? error.status : 500).json({ error: known ? error.message : 'Unable to complete browser connection metadata request' });
    }
  };
  const queryEmpty = req => parse(empty, req.query ?? {});
  router.get(`${root}/capabilities`, agentsOnly, handle((r, a) => {
    queryEmpty(r); store.get(a, r.params.id); return browserConnectionCapabilities();
  }));
  router.get(root, agentsOnly, handle((r, a) => store.browserConnections(a, r.params.id, r.query)));
  router.post(root, agentsOnly, handle((r, a) => {
    queryEmpty(r); return store.createBrowserConnection(a, r.params.id, expected(r), r.body);
  }, { status: 201, mutation: true }));
  router.get(`${root}/:connectionId`, agentsOnly, handle((r, a) => {
    queryEmpty(r); return store.browserConnection(a, r.params.id, r.params.connectionId);
  }));
  router.patch(`${root}/:connectionId`, agentsOnly, handle((r, a) => {
    queryEmpty(r); return store.updateBrowserConnection(a, r.params.id, r.params.connectionId, expected(r), r.body);
  }, { mutation: true }));
  router.post(`${root}/:connectionId/revoke`, agentsOnly, handle((r, a) => {
    queryEmpty(r); return store.revokeBrowserConnection(a, r.params.id, r.params.connectionId, expected(r), r.body);
  }, { mutation: true }));
  router.get(`${root}/:connectionId/versions`, agentsOnly, handle((r, a) => store.browserConnectionVersions(a, r.params.id, r.params.connectionId, r.query)));
  router.get(`${root}/:connectionId/grants`, agentsOnly, handle((r, a) => store.browserConnectionGrants(a, r.params.id, r.params.connectionId, r.query)));
  router.post(`${root}/:connectionId/grants`, agentsOnly, requireSudo, handle((r, a) => {
    queryEmpty(r); return store.grantBrowserConnection(a, r.params.id, r.params.connectionId, expected(r), r.body);
  }, { status: 201, mutation: true }));
  router.post(`${root}/:connectionId/grants/:grantId/revoke`, agentsOnly, handle((r, a) => {
    queryEmpty(r); return store.revokeBrowserConnectionGrant(a, r.params.id, r.params.connectionId, r.params.grantId, expected(r), r.body);
  }, { mutation: true }));
}
