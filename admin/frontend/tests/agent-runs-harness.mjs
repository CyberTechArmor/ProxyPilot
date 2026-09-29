// A6 UI harness. The real app (Vite, providers, API client, pages), the real
// Operations router and stores, the real A5 coordinator and A6 service on an
// in-memory database, and a SCRIPTED supervisor (backend helpers/agent-runs-world.js)
// that signs real teardown receipts and serves PNG frames. Only the session and
// the sudo check are fixtures: a `pp_harness_user` cookie names the account, and
// POST /api/auth/sudo accepts the fixture password and TOTP below. The real CSRF
// middleware guards every write. The production backend (index.js) never imports
// this file or the world helper.
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import express from '../../backend/node_modules/express/index.js';
import { csrfProtection } from '../../backend/src/middleware/csrf.js';
import { createOperationsRouter } from '../../backend/src/routes/operational-projects.js';
import { agentRunsWorld } from '../../backend/src/__tests__/helpers/agent-runs-world.js';

export const SUDO_PASSWORD = 'harness-password';
export const SUDO_TOTP = '246810';
const root = fileURLToPath(new URL('..', import.meta.url));

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(part => {
    const at = part.indexOf('=');
    return [part.slice(0, at), decodeURIComponent(part.slice(at + 1))];
  }));
}

export async function startHarness({ execution = true, delayMs = 350, world: worldOptions = {} } = {}) {
  const world = agentRunsWorld({ execution, ...worldOptions });
  world.supervisor.scenario.delayMs = delayMs;
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
    if (u) req.user = { id: u.id, username: u.username, role: 'user' };
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
  // Same envelope and sliding window as middleware/auth.js requireSudo.
  const requireSudo = (req, res, next) => {
    if ((sudoUntil.get(req.user?.id) ?? 0) <= Date.now())
      return res.status(401).json({ error: 'sudo_required', sudo_required: true, message: 'This action requires sudo re-authentication.' });
    sudoUntil.set(req.user.id, Date.now() + 4 * 3600_000);
    return next();
  };
  app.use('/api/operational-projects', (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Authentication required' }),
    createOperationsRouter({ Router: express.Router, store: world.f.store, enabled: true, agentsEnabled: true,
      agentRuns: world.service, requireSudo, lookupLimiter: (_req, _res, next) => next() }));
  app.use('/api/', (_req, res) => res.status(404).json({ error: 'Not found in the A6 harness' }));
  const server = await createServer({ root, configFile: `${root}/vite.config.js`, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'a6-harness',
      configureServer(vite) { vite.middlewares.use((req, res, next) => req.url.startsWith('/api/') ? app(req, res, next) : next()); } }] });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  return { origin, world, requests, sudoUntil, close: async () => { await server.close(); world.f.close(); } };
}
