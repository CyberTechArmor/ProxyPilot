// Production routes/auth/CSRF/SQLite and built UI; scripted upstream transport.
import express from 'express';
import { resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { makeDb, apiFixture, serviceFixture, keycloakFixture } from './vaultwarden-fixture.js';
import { readVaultwarden } from '../../lib/setup-engine/vaultwarden-store.js';
import { getJob, jobView } from '../../lib/setup-engine/store.js';
const db = makeDb(process.argv[2]), upstream = serviceFixture(db);
globalThis.__g7Send = upstream.send;
globalThis.__g7Reader = async () => keycloakFixture(readVaultwarden(db)).getReader();
const actual = new URL('../../lib/setup-engine/vaultwarden-api.js?actual', import.meta.url).href;
const identity = new URL('../../lib/setup-engine/vaultwarden-identity.js?actual', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/vaultwarden-api.js') && context.parentURL?.includes('/admin/backend/src/') && !context.parentURL.includes('?actual')) return { url: 'data:text/javascript,' + encodeURIComponent(`import {createClient as base} from ${JSON.stringify(actual)};export * from ${JSON.stringify(actual)};export const createClient=(origin,opts={})=>base(origin,{...opts,send:globalThis.__g7Send});`), shortCircuit: true };
  if (specifier.endsWith('/vaultwarden-identity.js') && context.parentURL?.includes('/admin/backend/src/') && !context.parentURL.includes('?actual')) return { url: 'data:text/javascript,' + encodeURIComponent(`import {verifyClient as base} from ${JSON.stringify(identity)};export const verifyClient=(db,r)=>base(db,r,{getReader:globalThis.__g7Reader});`), shortCircuit: true };
  return next(specifier, context);
} });
const fixture = await apiFixture(db); const { authenticateToken } = await import('../../middleware/auth.js');
fixture.app.get('/api/auth/verify', authenticateToken, (req, res) => res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role } }));
fixture.app.get('/api/setup/overview', authenticateToken, (_req, res) => res.json({ jobs: db.prepare('SELECT id FROM setup_jobs ORDER BY created_at DESC').all().map(r => jobView(getJob(db, r.id))), locks: [], runners: [] }));
fixture.app.get('/api/setup/jobs/:id', authenticateToken, (req, res) => res.json({ job: jobView(getJob(db, req.params.id)) }));
fixture.app.get('/api/notifications', (_req, res) => res.json({ notifications: [], unread_count: 0 })); fixture.app.get('/api/*', (_req, res) => res.json({}));
const dist = resolve(import.meta.dirname, '../../../../frontend/dist'); fixture.app.use(express.static(dist)); fixture.app.get('*', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
process.send({ url: fixture.url, tokens: fixture.tokens }); process.on('message', async msg => { if (msg === 'close') { await fixture.close(); db.close(); process.exit(0); } });
