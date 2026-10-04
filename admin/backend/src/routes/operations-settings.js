import { setOperationsToggle, toggleState } from '../lib/operations-toggles.js';

// Administrators turn Operations, agent metadata and agent runs on or off here
// (lib/operations-toggles.js). Reading is admin-only; changing also needs sudo,
// which the api.js modal answers. Router, auth and sudo are injected so tests
// and the UI harness use the real handlers without the production database.
export function createOperationsSettingsRouter({ Router, db, requireAdmin, requireSudo, sourceMemory = null }) {
  const router = Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(requireAdmin);
  const handle = fn => (req, res) => {
    try { return res.json(fn(req)); }
    catch (err) { return res.status(err.status || 500).json({ error: err.status ? err.message : 'Unable to change Operations settings' }); }
  };
  router.get('/', handle(() => ({ ...toggleState(db()), ...(sourceMemory ? { source_memory: sourceMemory.status() } : {}) })));
  router.post('/source-memory', requireSudo, handle(req => {
    if (!sourceMemory) throw Object.assign(new Error('Source Memory setup is unavailable.'), { status: 404 });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) throw Object.assign(new Error('Send an empty object; this operation accepts no paths or settings.'), { status: 400 });
    return { ...toggleState(db()), source_memory: sourceMemory.enable(req.user, req.ip) };
  }));
  router.put('/:name', requireSudo, handle(req => {
    const body = req.body ?? {};
    if (Object.keys(body).join(',') !== 'enabled') throw Object.assign(new Error('Send { "enabled": true | false }.'), { status: 400 });
    return setOperationsToggle(db(), req.params.name, body.enabled, req.user, req.ip);
  }));
  return router;
}
