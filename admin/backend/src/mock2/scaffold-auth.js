// Mock2 deterministic auth wiring — the code half of "the base app can log in
// from day one". The auth component's pre-install copies its files byte-exact
// (component-install.js), but files alone don't mount the bootstrap gate or
// serve the sign-in page: that WIRING used to live in usage_md guidance a
// low-effort build model could skim past — which is exactly how projects
// shipped with a superadmin bootstrap sitting unwired on disk. This module
// makes the wiring deterministic: when an installed component provides the
// bootstrap gate, the installer rewrites the scaffold's still-pristine entry
// files (src/app.ts, src/server.ts) to versions that mount it — no model turn
// involved, so it cannot be skipped or misread.
//
// Keep-existing semantics match the rest of the installer: a target that a
// build already adapted (its hash matches neither a known scaffold seed nor
// the wired content) is left alone and reported, never clobbered.
//
// PURE (stub-first, risk R9): plans and file contents only — no I/O, no native
// modules. Terminology (risk R7): nothing here is named "agent".

import { createHash } from 'node:crypto';
import { buildScaffoldFiles } from './scaffold.js';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// The wiring targets — the scaffold entry files the wired variants replace.
export const AUTH_WIRING_TARGETS = Object.freeze(['src/app.ts', 'src/server.ts']);

// componentWiresBootstrap — does this component provide the forced first-admin
// flow this module knows how to wire? Requires the gate export, the module
// barrel, and the shipped sign-in page (the gate redirects to /login).
export function componentWiresBootstrap(contract, files = []) {
  const exports = Array.isArray(contract?.exports) ? contract.exports : [];
  const paths = new Set(files.map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean));
  return (
    exports.includes('bootstrapGate')
    && exports.includes('authRoutes')
    && exports.includes('initAuth')
    && paths.has('src/auth/index.ts')
    && paths.has('public/login.html')
  );
}

// src/app.ts, wired: withAuth + bootstrapGate mounted before every route, the
// component's routers under /api, the shipped sign-in page at /login, the
// extracted design stylesheet at /design.css, and an authenticated app shell
// at / that the build extends. Matches the component's own mount example
// (usage_md §2) and the scaffold's conventions (NodeNext ESM, .js-suffixed
// relative imports, securityHeaders, /_preview coexistence).
function wiredAppTs() {
  return `import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from './middleware/security.js';
import healthRoutes from './health/routes.js';
import {
  withAuth, bootstrapGate, authRoutes, adminAuthRoutes, isAuthenticated,
} from './auth/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/app.ts -> dist/app.js at runtime; either way this file sits one dir under
// the project root, so state/ is at ../state and public at ../public.
const MOCKUPS_DIR = path.resolve(__dirname, '..', 'state', 'mockups');
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const DESIGN_CSS = path.resolve(__dirname, '..', 'state', 'design.css');

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(securityHeaders);

  // Auth is wired by the platform and is part of the base app contract:
  // withAuth attaches the caller's identity, bootstrapGate() forces the
  // create-administrator flow while zero users exist (503 for APIs, redirect
  // to /login for pages), and the component's routers own /api/auth/* and
  // /api/admin/*. Do NOT remove or re-implement any of this — add screens
  // BEHIND it (guard routes with requireAuth / requireRole / requirePermission
  // from './auth/index.js').
  app.use(withAuth);
  app.use(bootstrapGate());

  app.use('/api', healthRoutes);
  app.use('/api', authRoutes);
  app.use('/api', adminAuthRoutes);

  // The sign-in page (shows the create-administrator form while uninitialized).
  app.get('/login', (_req, res) => res.sendFile('login.html', { root: PUBLIC_DIR }));

  // The extracted design tokens stylesheet — pages link /design.css so the
  // approved look applies app-wide. Empty until the design is approved.
  app.get('/design.css', (_req, res) => {
    if (fs.existsSync(DESIGN_CSS)) res.type('text/css').sendFile(DESIGN_CSS);
    else res.type('text/css').send('');
  });

  // Static assets — CSS / JS / images the app ships under public/ are served at
  // the root (so <link href="/styles.css"> resolves). index:false so a stray
  // public/index.html never shadows the app's own routes.
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // Concept-stage mockup preview (coexists with the app) — same contract as the
  // placeholder dev server: /_preview serves state/mockups, default current.html.
  app.use('/_preview', (_req, res, next) => {
    // The ProxyPilot dashboard embeds this mockup preview in an iframe from its
    // own (different) origin. The app-wide security headers pin frame-ancestors
    // to 'self', which blanks that iframe — relax framing for the preview ONLY
    // (it is non-functional, static mockup HTML; the app itself stays framed-off).
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors *");
    res.removeHeader('X-Frame-Options');
    next();
  }, express.static(MOCKUPS_DIR, { index: 'current.html' }));

  // The authenticated app shell (public/app-shell.html — the base-style page
  // the build extends with screens); unauthenticated visitors always land on
  // /login. Inline fallback if a build removed the shell file.
  app.get('/', (req, res) => {
    if (!isAuthenticated(req)) {
      res.redirect('/login');
      return;
    }
    const shell = path.join(PUBLIC_DIR, 'app-shell.html');
    if (fs.existsSync(shell)) {
      res.sendFile(shell);
      return;
    }
    res
      .type('html')
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<meta name="robots" content="noindex, nofollow"><title>Application</title>' +
          '<link rel="stylesheet" href="/design.css"></head>' +
          '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:12vh auto;padding:0 1rem">' +
          '<h1>You are signed in.</h1>' +
          '<p>This is the base application shell — authentication, the first-admin bootstrap, ' +
          'and the design stylesheet are already working. Describe screens in the ProxyPilot ' +
          'chat and the build will add them here, behind this sign-in.</p>' +
          '<p><button id="logout" style="min-height:44px;padding:0 1rem">Sign out</button></p>' +
          '<script>document.getElementById(\\'logout\\').addEventListener(\\'click\\', async () => {' +
          'await fetch(\\'/api/auth/logout\\', { method: \\'POST\\' }); window.location.assign(\\'/login\\');' +
          '});</script>' +
          '</body></html>',
      );
  });

  return app;
}
`;
}

// src/server.ts, wired: inject the Drizzle client + env config into the auth
// module BEFORE the app serves a request (initAuth), wire the LDAPS transport
// (no-op unless configured), then listen. AuthDb's schema generic is
// irrelevant (the module never uses db.query.*), hence the documented cast.
function wiredServerTs() {
  return `import { createApp } from './app.js';
import { config } from './config.js';
import { db } from './db/index.js';
import {
  initAuth, loadAuthConfigFromEnv, wireLdapsFromConfig, type AuthDb,
} from './auth/index.js';

// Inject the host db + config once, before any request (the auth module throws
// a clear "not initialized" error otherwise). The cast is per the component's
// contract: AuthDb's schema generic is irrelevant — only query-builder methods
// are used, never db.query.* — so any NodePgDatabase satisfies it.
initAuth({ db: db as unknown as AuthDb, config: loadAuthConfigFromEnv() });
await wireLdapsFromConfig({ probe: true });

const app = createApp();

// Retry EADDRINUSE instead of crashing: right after a deploy the port can stay
// held for a few seconds while the previous server unwinds. A crash here puts
// systemd into a restart loop that fails the platform health check even though
// the app is fine — retrying simply wins the port the moment it frees.
function listen(attempt = 0) {
  const server = app.listen(config.PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(\`app listening on 0.0.0.0:\${config.PORT}\`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && attempt < 60) {
      // eslint-disable-next-line no-console
      console.warn(\`port \${config.PORT} in use — retrying in 2s (attempt \${attempt + 1}/60)\`);
      setTimeout(() => listen(attempt + 1), 2000);
    } else {
      throw err;
    }
  });
}
listen();
`;
}

// The wired file set (path → content). PURE.
export function buildAuthWiredFiles() {
  return [
    { path: 'src/app.ts', content: wiredAppTs() },
    { path: 'src/server.ts', content: wiredServerTs() },
  ];
}

// Known-pristine hashes per target: the scaffold seed content (any project name
// — these files don't vary by project). A target matching one of these is safe
// to rewrite; anything else was adapted by a build and is KEPT.
function pristineShaByPath() {
  const seeds = buildScaffoldFiles({ name: 'app' });
  const out = new Map();
  for (const t of AUTH_WIRING_TARGETS) {
    const seed = seeds.find((f) => f.path === t);
    out.set(t, new Set(seed ? [sha256(seed.content)] : []));
  }
  return out;
}
const PRISTINE = pristineShaByPath();

// planAuthWiring — decide, per target, what the installer should do given the
// component's contract/files and the CURRENT in-container sha256 of each
// target (null/undefined = file missing).
//
//   wire          → write the wired content (target pristine or missing)
//   already-wired → nothing to do (idempotent re-install)
//   kept-adapted  → a build changed this file; keep it and say so
export function planAuthWiring({ contract, files = [], currentShaByPath = new Map() } = {}) {
  if (!componentWiresBootstrap(contract, files)) return { applies: false, actions: [] };
  const shaOf = (p) => (currentShaByPath instanceof Map ? currentShaByPath.get(p) : currentShaByPath?.[p]) ?? null;
  const actions = buildAuthWiredFiles().map(({ path, content }) => {
    const cur = shaOf(path);
    if (cur === sha256(content)) return { path, action: 'already-wired' };
    if (cur == null || PRISTINE.get(path)?.has(cur)) return { path, action: 'wire', content };
    return { path, action: 'kept-adapted' };
  });
  return { applies: true, actions };
}
