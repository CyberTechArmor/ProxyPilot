// A6 UI harness. The real app (Vite, providers, API client, pages), the real
// Operations router and stores, the real A5 coordinator and A6 service on an
// in-memory database, and a SCRIPTED supervisor (backend helpers/agent-runs-world.js)
// that signs real teardown receipts and serves PNG frames. Only the session and
// the sudo check are fixtures: a `pp_harness_user` cookie names the account, and
// POST /api/auth/sudo accepts the fixture password and TOTP below. The real CSRF
// middleware guards every write. The production backend (index.js) never imports
// this file or the world helper. A7: the real live WebSocket route over the
// scripted supervisor's relay (the live view is unavailable unless a journey
// turns it on, as on a host without the live install), and a fixture
// agent-control check (the same password and code) that records a grant for
// the fixture session.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import express from '../../backend/node_modules/express/index.js';
import { csrfProtection } from '../../backend/src/middleware/csrf.js';
import { createOperationsRouter } from '../../backend/src/routes/operational-projects.js';
import { createOperationsSettingsRouter } from '../../backend/src/routes/operations-settings.js';
import { effectiveToggles } from '../../backend/src/lib/operations-toggles.js';
import { agentRunsWorld } from '../../backend/src/__tests__/helpers/agent-runs-world.js';
import { attachAgentLiveServer } from '../../backend/src/routes/agent-live-ws.js';

export const SUDO_PASSWORD = 'harness-password';
export const SUDO_TOTP = '246810';
const root = fileURLToPath(new URL('..', import.meta.url));

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(part => {
    const at = part.indexOf('=');
    return [part.slice(0, at), decodeURIComponent(part.slice(at + 1))];
  }));
}

// `toggles: true` serves the administrators' toggles (all off at start) exactly as
// index.js does; otherwise Operations, agent metadata and agent runs are on.
export async function startHarness({ execution = true, delayMs = 350, toggles = false, world: worldOptions = {}, selectedBrowserFixture = null } = {}) {
  const world = agentRunsWorld({ execution, ...worldOptions });
  world.supervisor.scenario.delayMs = delayMs;
  world.f.db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL,
    resource_type TEXT, resource_id TEXT, details TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  const admin = world.f.addUser('admin');
  world.f.db.prepare('UPDATE users SET username=? WHERE id=?').run('ada-admin', admin.id);
  world.users.admin = { ...admin, username: 'ada-admin' };
  const byName = Object.fromEntries(Object.entries(world.users).map(([role, u]) => [role, u]));
  const sudoUntil = new Map();
  const requests = [];
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    req.cookies = cookies(req);
    const csrf = req.cookies.pp_csrf || 'harness-csrf';
    res.setHeader('Set-Cookie', `pp_csrf=${csrf}; Path=/; SameSite=Strict`);
    const role = req.cookies.pp_harness_user;
    const u = role && byName[role];
    if (u) req.user = { id: u.id, username: u.username, role: u.role === 'admin' ? 'admin' : 'user', jti: `harness-${role}` };
    requests.push({ method: req.method, path: req.path, role: role || null });
    next();
  });
  app.use('/api/', csrfProtection);
  const who = req => req.user && { user: { ...req.user, permissions: [], hasPasskey: false, totpEnabled: true } };
  app.get('/api/auth/verify', (req, res) => req.user ? res.json(who(req)) : res.status(401).json({ error: 'Not authenticated' }));
  app.get('/api/user/profile', (req, res) => req.user ? res.json(who(req)) : res.status(401).json({ error: 'Not authenticated' }));
  app.get('/api/auth/sso/session', (_req, res) => res.json({ canReauthenticate: false }));
  app.get('/api/user/version', (_req, res) => res.json({ version: 'a6-harness' }));
  app.get('/api/user/version/check', (_req, res) => res.json({ updateAvailable: false }));
  app.get('/api/notifications', (_req, res) => res.json({ notifications: [], unread_count: 0 }));
  app.post('/api/auth/sudo', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.body?.password !== SUDO_PASSWORD || req.body?.totpCode !== SUDO_TOTP)
      return res.status(401).json({ error: 'Invalid password or TOTP code' });
    sudoUntil.set(req.user.id, Date.now() + 4 * 3600_000);
    return res.json({ ok: true });
  });
  // A7: the agent-control verification, per fixture session; never sudo.
  const controlGrants = new Set();
  app.post('/api/auth/agent-control', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.body?.password !== SUDO_PASSWORD || req.body?.totpCode !== SUDO_TOTP)
      return res.status(401).json({ error: 'Invalid credentials', agent_control_failed: true });
    controlGrants.add(req.user.jti);
    return res.json({ verified: true, factor: 'totp' });
  });
  // Same envelope and sliding window as middleware/auth.js requireSudo.
  const requireSudo = (req, res, next) => {
    if ((sudoUntil.get(req.user?.id) ?? 0) <= Date.now())
      return res.status(401).json({ error: 'sudo_required', sudo_required: true, message: 'This action requires sudo re-authentication.' });
    sudoUntil.set(req.user.id, Date.now() + 4 * 3600_000);
    return next();
  };
  const authed = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Authentication required' });
  const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });
  const toggle = name => () => effectiveToggles(world.f.db)[name];
  app.use('/api/operations-settings', authed, createOperationsSettingsRouter({ Router: express.Router, db: () => world.f.db,
    requireAdmin, requireSudo }));
  app.use('/api/operational-projects', authed,
    createOperationsRouter({ Router: express.Router, store: world.f.store, lookupLimiter: (_req, _res, next) => next(),
      browserRuntime: selectedBrowserFixture ? selectedBrowserFixture(world) : null,
      agentRuns: world.service, requireSudo, controlVerified: req => controlGrants.has(req.user?.jti), ...(toggles
        ? { enabled: toggle('operations'), agentsEnabled: toggle('agents_metadata'), agentRunsEnabled: toggle('agent_runs') }
        : { enabled: true, agentsEnabled: true }) }));
  app.use('/api/', (_req, res) => res.status(404).json({ error: 'Not found in the A6 harness' }));
  const server = await createServer({ root, configFile: `${root}/vite.config.js`, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'a6-harness',
      configureServer(vite) { vite.middlewares.use((req, res, next) => req.url.startsWith('/api/') ? app(req, res, next) : next()); } }] });
  world.supervisor.scenario.liveError = 'LIVE_UNAVAILABLE';
  attachAgentLiveServer(server.httpServer, { agentRuns: world.service,
    enabled: () => !toggles || Object.values(effectiveToggles(world.f.db)).every(Boolean),
    verify: (req) => {
      const role = cookies(req).pp_harness_user, u = role && byName[role];
      if (!u) { const e = new Error('Authentication required'); e.statusCode = 401; throw e; }
      return { user: { id: u.id, username: u.username, role: 'user', jti: `harness-${role}` } };
    } });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  return { origin, world, requests, sudoUntil, controlGrants, close: async () => { await server.close(); world.f.close(); } };
}
