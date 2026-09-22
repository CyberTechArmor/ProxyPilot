// Isolated API process: production setup routes, auth/CSRF middleware and SQL.
// node:sqlite substitutes only for the native DB binding. No production boot
// sweep, host executor or real installation database is opened.
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import cookieParser from 'cookie-parser';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const db = new DatabaseSync(process.env.PLATFORM_TEST_DB);
globalThis.__platformTestDb = db;
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/db.js') && context.parentURL?.includes('/admin/backend/src/')) return { url: 'data:text/javascript,' + encodeURIComponent(`export const getDb = () => globalThis.__platformTestDb; export function logAudit(user, action, type, id, data) { getDb().prepare('INSERT INTO audit (action, data) VALUES (?, ?)').run(action, JSON.stringify(data)); }`), shortCircuit: true };
  return next(specifier, context);
} });
const { PLATFORM_PLAN_SCHEMA } = await import('../../lib/setup-engine/platform-plan.js');
const { ensureSetupEngineSchema, createJob, appendEvent } = await import('../../lib/setup-engine/store.js');
const { authenticateToken, blockPendingRole, generateToken } = await import('../../middleware/auth.js');
const { csrfProtection } = await import('../../middleware/csrf.js');
const { setupRouter } = await import('../../routes/setup.js');
ensureSetupEngineSchema(db); db.exec(PLATFORM_PLAN_SCHEMA);
const { KEYCLOAK_SCHEMA } = await import('../../lib/setup-engine/keycloak-store.js'); db.exec(KEYCLOAK_SCHEMA);
db.exec(`CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS service_http_routes (id TEXT PRIMARY KEY, domain TEXT);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT, role TEXT, password_hash TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT, expires_at TEXT, last_used_at TEXT DEFAULT CURRENT_TIMESTAMP, revoked_at TEXT, sudo_until TEXT, ip TEXT, user_agent TEXT);
CREATE TABLE IF NOT EXISTS audit (action TEXT, data TEXT);`);
db.exec(`INSERT OR IGNORE INTO services (id, name) VALUES ('existing', 'Existing app');
INSERT OR IGNORE INTO service_http_routes VALUES ('existing-route', 'route.example.com');
INSERT OR IGNORE INTO app_settings VALUES ('admin_domain', 'pilot.example.com'), ('auth_provider', 'unchanged-local'), ('tls_mode', 'manual');
INSERT OR IGNORE INTO users VALUES ('admin', 'test-admin', 'admin', 'existing-hash'), ('user', 'test-user', 'user', 'existing-hash');`);
const tokens = {};
for (const role of ['admin', 'user']) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(role);
  tokens[role] = generateToken(user);
}
db.prepare("UPDATE sessions SET sudo_until = ? WHERE user_id = 'admin'").run(new Date(Date.now() + 3600000).toISOString());
// Separate non-elevated admin session exercises the real fresh-auth refusal.
tokens.coldAdmin = generateToken(db.prepare("SELECT * FROM users WHERE id = 'admin'").get());
if (!db.prepare('SELECT 1 FROM setup_jobs LIMIT 1').get()) {
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'deferred', 'recovery_required']) {
    const job = createJob(db, { id: `fixture-${status}`, app: `example-${status.replaceAll('_', '-')}`, kind: 'probe', status });
    if (status === 'succeeded') db.prepare('UPDATE setup_jobs SET outcome = ?, verification_json = ? WHERE id = ?').run('serving', JSON.stringify({ state: 'configured', pending: ['credential_use_verified'] }), job.id);
    appendEvent(db, { jobId: job.id, kind: 'fixture', message: 'Redacted fixture event', data: { password: 'must-not-appear', result: status } });
  }
}
const app = express(); app.use(express.json()); app.use(cookieParser());
app.use('/api/', csrfProtection);
app.use('/api/setup', authenticateToken, blockPendingRole, setupRouter);
// Only browser-shell fixtures below; none changes the production setup routes.
app.get('/api/auth/verify', authenticateToken, (req, res) => res.json({ user: req.user }));
app.get('/api/user/version', (_req, res) => res.json({ version: 'G1 verification' }));
app.get('/api/user/version/check', (_req, res) => res.json({ updateAvailable: false }));
app.get('/api/mock2/status', (_req, res) => res.status(404).json({ error: 'disabled in fixture' }));
app.get('/api/cves', (_req, res) => res.json({ items: [] }));
app.get('/api/notifications', (_req, res) => res.json({ notifications: [], unread_count: 0 }));
app.get('/api/branding', (_req, res) => res.json({}));
const root = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)));
app.use(express.static(resolve(root, 'admin/frontend/dist')));
app.get('*', (_req, res) => res.sendFile(resolve(root, 'admin/frontend/dist/index.html')));
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
const server = app.listen(Number(process.env.PLATFORM_TEST_PORT || 0), '127.0.0.1', () => {
  const ready = { url: `http://127.0.0.1:${server.address().port}`, tokens };
  if (process.send) process.send(ready); else console.log(JSON.stringify(ready));
});
process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
