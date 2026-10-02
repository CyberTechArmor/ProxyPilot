// Local integration fixture: real Operations store/router/CSRF and website
// review service. ONLY authenticated sessions, DNS/HTTP transport and the model
// adapter are scripted. No public network, credential broker or provider runs.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import tailwindcss from 'tailwindcss';
import loadTailwindConfig from 'tailwindcss/loadConfig.js';
import autoprefixer from 'autoprefixer';
import express from '../../backend/node_modules/express/index.js';
import { csrfProtection } from '../../backend/src/middleware/csrf.js';
import { createOperationsRouter } from '../../backend/src/routes/operational-projects.js';
import { operationsFixture } from '../../backend/src/__tests__/helpers/operations-fixture.js';
import { createPublicFetcher } from '../../backend/src/lib/operational-public-web.js';
import { createWebsiteReviewService, websiteReviewMigration1116, REVIEW_CONSENT } from '../../backend/src/lib/operational-website-review.js';

export { REVIEW_CONSENT };
export const WEBSITE = 'https://museum.example.org/';
export const SUMMARY = 'The public museum presents local history exhibits and family learning events. The sampled pages describe its collections and educational programme.';
export const CSRF = 'website-review-integration-csrf';
const cookieMap = header => Object.fromEntries(String(header || '').split(';').map(s => s.trim().split('=')).filter(p => p.length === 2));

export async function startWebsiteReviewHarness({ useVite = true } = {}) {
  const f = operationsFixture();
  websiteReviewMigration1116(f.adapter);
  const users = { owner: f.addUser(), editor: f.addUser(), viewer: f.addUser() };
  const project = f.store.create(users.owner, { name: 'Public museum review', members: [{ user_id: users.editor.id, role: 'editor' }, { user_id: users.viewer.id, role: 'viewer' }] });
  // Current policy: Save atomically publishes an approved immutable guide.
  const { version } = f.store.saveDraft(users.owner, project.id, 1, { title: 'Summarize website', instructions: 'Summarize the website, cite the sampled public sources, and state the limits of the review.' });
  assert.equal(f.store.get(users.owner, project.id).current_version.id, version.id);
  const queued = [], requests = [], transport = [], modelCalls = [], cancellations = [];
  const scenario = { providerCode: null };
  let modelGate = null, server;

  // Exercise the real DNS screening, bounded response reader, robots policy,
  // URL/link policy and extraction. Responses never leave this process.
  const fetchPage = createPublicFetcher({
    resolve: async host => { assert.equal(host, 'museum.example.org'); return [{ address: '93.184.216.34', family: 4 }]; },
    request(url, options, callback) {
      assert.equal(url.origin, new URL(WEBSITE).origin, 'only scripted public origin is reachable');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers.Cookie, undefined);
      const req = new EventEmitter(); let response, destroyed = false;
      req.destroy = () => { destroyed = true; response?.destroy(); };
      req.end = () => queueMicrotask(() => {
        if (destroyed) return;
        transport.push({ url: url.href, method: options.method, scripted_fixture: true });
        const socket = new EventEmitter(); req.emit('socket', socket); socket.emit('secureConnect');
        if (destroyed) return;
        const about = url.pathname === '/about';
        const body = url.pathname === '/robots.txt' ? 'User-agent: *\nAllow: /\n' : `<html><head><title>${about ? 'Museum learning' : 'Public museum'}</title></head><body><main>${(about ? 'The museum offers family learning activities and educational visits about local history. ' : 'The museum hosts local history exhibits, collection displays, and family learning events. ').repeat(6)}</main>${about ? '' : '<a href="/about">Learning</a><a href="https://attacker.example.org/">External link</a>'}</body></html>`;
        response = Readable.from([Buffer.from(body)]);
        response.statusCode = 200;
        response.headers = { 'content-type': url.pathname === '/robots.txt' ? 'text/plain' : 'text/html', 'content-length': String(Buffer.byteLength(body)) };
        callback(response);
      });
      return req;
    },
  });
  const model = {
    readiness: async () => scenario.providerCode ? { available: false, code: scenario.providerCode } : { available: true },
    cancel: async id => { cancellations.push(id); },
    review: async (request, { signal }) => {
      modelCalls.push(structuredClone(request));
      assert.equal(request.guide_hash, version.content_hash);
      assert.equal(request.guide.includes('proxypilot-rules'), false, 'freeform guide uses no demo rules');
      assert.equal(request.credential, undefined); assert.equal(request.binding_id, undefined);
      const gate = modelGate; gate?.entered(); if (gate) await gate.wait;
      // Deliberately return late after cancellation: service must suppress it.
      return { text: JSON.stringify({ summary: SUMMARY, findings: ['Family learning is a stated focus.'], limitations: ['Only two sampled public pages were read; JavaScript and login were not used.'], citations: [1, 2] }), usage: { prompt_tokens: 800, completion_tokens: 150 }, settled_usd: '0.001', price_table_revision: 1, attestation: 'SCRIPTED_MODEL_FIXTURE_NOT_A_PROVIDER_RECEIPT', fixture_signal_aborted: signal.aborted };
    },
  };
  const service = createWebsiteReviewService({ db: f.adapter, store: f.store, fetchPage, model, schedule: fn => queued.push(fn) });
  const app = express(); app.use(express.json({ limit: '1mb' }));
  app.use('/api', (req, res, next) => {
    req.cookies = cookieMap(req.headers.cookie);
    const role = req.cookies.pp_review_fixture_session, user = users[role];
    req.user = user ? { ...user, username: `fixture-${role}`, jti: `website-review-${role}` } : null;
    res.setHeader('Set-Cookie', `pp_csrf=${CSRF}; Path=/; SameSite=Strict`);
    const record = { method: req.method, path: req.originalUrl.split('?')[0], role, if_match: req.get('If-Match'), csrf: req.get('X-CSRF-Token'), body: structuredClone(req.body || {}) };
    requests.push(record); res.on('finish', () => { record.status = res.statusCode; }); next();
  });
  app.use('/api', csrfProtection);
  const who = req => ({ user: req.user && { ...req.user, permissions: [], hasPasskey: false, totpEnabled: true } });
  app.get('/api/auth/verify', (req, res) => req.user ? res.json(who(req)) : res.status(401).json({ error: 'Unauthenticated fixture session' }));
  app.get('/api/user/profile', (req, res) => res.json(who(req)));
  app.get('/api/auth/sso/session', (_req, res) => res.json({ canReauthenticate: false }));
  app.get('/api/branding', (_req, res) => res.json({}));
  app.get('/api/notifications', (_req, res) => res.json({ notifications: [], unread_count: 0 }));
  app.get('/api/user/version', (_req, res) => res.json({ version: 'website-review-local-integration' }));
  app.get('/api/user/version/check', (_req, res) => res.json({ updateAvailable: false }));
  app.get('/api/mock2/status', (_req, res) => res.json({ enabled: false }));
  app.get('/api/cves', (_req, res) => res.json({ cves: [] }));
  app.get('/api/connections/capabilities', (_req, res) => res.json({ available: false }));
  app.use('/api/operational-projects', (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Unauthenticated fixture session' }), createOperationsRouter({ Router: express.Router, store: f.store, enabled: true, agentsEnabled: true, websiteReviews: service, lookupLimiter: (_req, _res, next) => next() }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown integration fixture endpoint' }));
  if (useVite) {
    const root = fileURLToPath(new URL('..', import.meta.url));
    // Resolve the actual frontend stylesheet configuration even when the test
    // is invoked from the repository root. Content globs also need that root.
    const tailwind = loadTailwindConfig(`${root}/tailwind.config.js`);
    tailwind.content = tailwind.content.map(glob => join(root, glob).replaceAll('\\', '/'));
    server = await createServer({ root, configFile: `${root}/vite.config.js`, css: { postcss: { plugins: [tailwindcss(tailwind), autoprefixer()] } }, cacheDir: join(tmpdir(), `pp-website-review-vite-${process.pid}`), logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{ name: 'website-review-real-api', configureServer(vite) { vite.middlewares.use((req, res, next) => req.url?.startsWith('/api/') ? app(req, res, next) : next()); } }] });
    await server.listen();
  } else server = await new Promise(done => { const http = app.listen(0, '127.0.0.1', () => done(http)); });
  const port = (useVite ? server.httpServer : server).address().port;
  return {
    f, users, project, version, service, requests, transport, modelCalls, cancellations, scenario, queued,
    origin: `http://127.0.0.1:${port}`,
    executeNext: () => { const job = queued.shift(); assert(job, 'explicit Start scheduled one real execution'); return job(); },
    holdNextModel() { let release, entered; const wait = new Promise(done => { release = done; }), started = new Promise(done => { entered = done; }); modelGate = { wait, started, release, entered }; },
    waitForModel: () => modelGate.started,
    releaseModel() { modelGate?.release(); modelGate = null; },
    async close() { modelGate?.release(); service.close(); if (useVite) await server.close(); else await new Promise((done, reject) => server.close(err => err ? reject(err) : done())); f.close(); },
  };
}
