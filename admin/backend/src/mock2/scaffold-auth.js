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

// The wiring targets — the scaffold entry files the wired variants replace,
// plus the platform admin/profile pages the wired app serves (the component
// ships the full admin API — users, roles/permissions, LDAPS, self-signup —
// and these pages are its deterministic UI, so every base app STARTS with a
// working admin area; builds add app features, not user management).
export const AUTH_WIRING_TARGETS = Object.freeze([
  'src/app.ts', 'src/server.ts',
  'public/admin.html', 'public/admin.js', 'public/profile.html',
  'public/login.html',
]);

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

// src/app.ts, wired: withAuth + bootstrapGate mounted before every route, ALL
// of the component's routers under /api (auth, admin users/roles/LDAPS,
// external self-signup + its admin toggle), the shipped sign-in page at
// /login, the platform admin console at /admin and profile at /profile, an
// identity endpoint at /api/me, the extracted design stylesheet at
// /design.css, and an authenticated app shell at / that the build extends.
// Matches the component's own mount example (usage_md §2) and the scaffold's
// conventions (NodeNext ESM, .js-suffixed relative imports, securityHeaders,
// /_preview coexistence).
function wiredAppTs() {
  return `import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from './middleware/security.js';
import healthRoutes from './health/routes.js';
import {
  withAuth, bootstrapGate, authRoutes, adminAuthRoutes, isAuthenticated,
  externalAuthRoutes, adminExternalRoutes, requireRole, getAuth, authRepo, toPublicUser,
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

  // Concept-stage mockup preview (coexists with the app) — same contract as the
  // placeholder dev server: /_preview serves state/mockups, default current.html.
  // Mounted BEFORE the auth gate: the mockup is static, non-functional design
  // HTML the operator reviews from the ProxyPilot dashboard while the app has
  // ZERO users — behind bootstrapGate every preview navigation would 302 to
  // /login, whose frame-ancestors 'self' blanks the dashboard's iframe.
  app.use('/_preview', (_req, res, next) => {
    // The dashboard embeds this preview from its own (different) origin. The
    // app-wide security headers pin frame-ancestors to 'self', which blanks
    // that iframe — relax framing for the preview ONLY (the app itself stays
    // framed-off).
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors *");
    res.removeHeader('X-Frame-Options');
    next();
  }, express.static(MOCKUPS_DIR, { index: 'current.html' }));

  // The extracted design tokens stylesheet — pages (and the mockup preview
  // above) link /design.css, so it must stay reachable before the gate too.
  app.get('/design.css', (_req, res) => {
    if (fs.existsSync(DESIGN_CSS)) res.type('text/css').sendFile(DESIGN_CSS);
    else res.type('text/css').send('');
  });

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
  // External self-signup (public endpoints re-check the admin toggle) + its
  // admin surface (the on/off switch and the external-accounts roster).
  app.use('/api/auth', externalAuthRoutes);
  app.use('/api/admin/external', requireRole('admin'), adminExternalRoutes);

  // Who am I — the signed-in identity (drives the profile page and the app
  // shell's admin-link visibility). The token's claims are the source of
  // truth; the DB row enriches with email/status when reachable.
  app.get('/api/me', async (req, res) => {
    if (!isAuthenticated(req)) {
      res.status(401).json({ error: 'UNAUTHENTICATED' });
      return;
    }
    const auth = getAuth(req);
    let user = null;
    try {
      const row = auth.userId != null ? await authRepo.findUserById(auth.userId) : undefined;
      user = row ? toPublicUser(row) : null;
    } catch {
      // The identity from the verified token is still returned below.
    }
    res.json({ user, role: auth.role, tenantId: auth.tenantId, provider: auth.provider ?? user?.provider ?? 'local' });
  });

  // The sign-in page (shows the create-administrator form while uninitialized).
  app.get('/login', (_req, res) => res.sendFile('login.html', { root: PUBLIC_DIR }));

  // Static assets — CSS / JS / images the app ships under public/ are served at
  // the root (so <link href="/styles.css"> resolves). index:false so a stray
  // public/index.html never shadows the app's own routes.
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // The platform admin console (users, roles & permissions, LDAPS directory,
  // self-signup) and the profile page — served with the app from day one.
  // These pages drive the component's /api/admin/* surface; builds add app
  // screens, never a second user-management UI.
  app.get('/admin', (req, res) => {
    if (!isAuthenticated(req)) {
      res.redirect('/login');
      return;
    }
    if (getAuth(req).role !== 'admin') {
      res.redirect('/');
      return;
    }
    res.sendFile('admin.html', { root: PUBLIC_DIR });
  });
  app.get('/profile', (req, res) => {
    if (!isAuthenticated(req)) {
      res.redirect('/login');
      return;
    }
    res.sendFile('profile.html', { root: PUBLIC_DIR });
  });

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
          '<p><a href="/admin">Admin console</a> · <a href="/profile">Profile</a></p>' +
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

// public/admin.html — the platform admin console: users, roles & permissions,
// the LDAPS directory connection, and external self-signup. Static page in the
// base style (base.css + design.css); admin.js drives the component's
// /api/admin/* surface. NO app features live here — builds add screens to the
// app shell, never a second user-management UI.
function adminHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Admin console</title>
<link rel="stylesheet" href="/design.css">
<link rel="stylesheet" href="/base.css">
<style>
.note{font-size:12.5px;color:var(--app-muted,#5a6b81);margin:6px 0 0;overflow-wrap:anywhere}
.note.err{color:var(--app-danger,#d24545)}
.linklike{background:none;border:none;padding:2px 4px;cursor:pointer;color:var(--app-muted,#5a6b81);font-size:12px;min-height:0}
.linklike:hover{color:var(--app-text,#12263f)}
.row-2{display:grid;grid-template-columns:1fr;gap:0 16px}
@media (min-width:640px){.row-2{grid-template-columns:1fr 1fr}}
.sect{margin-top:22px}
.sect:first-child{margin-top:0}
.switch{display:flex;align-items:center;gap:10px;min-height:44px}
.switch input{width:18px;height:18px}
table.list input[type=checkbox]{width:18px;height:18px}
</style>
</head>
<body>
<header class="app">
  <span class="brand"><span class="logo">◆</span> Admin console</span>
  <nav><a class="btn subtle sm" href="/">← App</a> <a class="btn subtle sm" href="/profile">Profile</a></nav>
  <span class="headspace"></span>
  <button class="btn subtle sm" id="logout">Sign out</button>
</header>
<main class="wrap">
  <p class="note" id="page-note"></p>

  <div class="card sect">
    <div class="card-h"><h3>Users</h3><span class="badge b-info" id="users-count"></span></div>
    <div class="card-b">
      <p class="note">Accounts that have signed in. Change a role, or deactivate an account to block sign-in.
      New internal users appear after their first sign-in (local password or the directory below).</p>
      <div class="table-scroll">
        <table class="list">
          <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Provider</th><th>Last sign-in</th><th></th></tr></thead>
          <tbody id="users-body"></tbody>
        </table>
      </div>
      <p class="note" id="users-note"></p>
    </div>
  </div>

  <div class="card sect">
    <div class="card-h"><h3>Roles &amp; permissions</h3></div>
    <div class="card-b">
      <p class="note">Tick a box to allow that permission for the role (differences from the built-in default are
      stored as overrides). System roles can't be deleted; custom roles authorize purely through this matrix.</p>
      <div class="table-scroll">
        <table class="list" id="perm-table"></table>
      </div>
      <div class="row-2" style="margin-top:12px">
        <div class="field"><label for="new-role-key">New role key (a–z, 0–9, _)</label><input id="new-role-key" placeholder="auditor"></div>
        <div class="field"><label for="new-role-label">Label</label><input id="new-role-label" placeholder="Auditor"></div>
      </div>
      <button class="btn sm" id="add-role">Add role</button>
      <p class="note" id="perm-note"></p>
    </div>
  </div>

  <div class="card sect">
    <div class="card-h"><h3>Directory sign-in (LDAPS)</h3><span class="badge b-neutral" id="ld-badge">optional</span></div>
    <div class="card-b">
      <p class="note">Connect an enterprise directory so staff sign in with their existing accounts. Secrets are
      encrypted at rest and never shown back. Local password sign-in keeps working either way.</p>
      <div class="row-2">
        <div class="field"><label for="ld-host">Host</label><input id="ld-host" placeholder="ldaps.example.com"></div>
        <div class="field"><label for="ld-port">Port</label><input id="ld-port" type="number" value="636"></div>
        <div class="field"><label for="ld-basedn">Base DN</label><input id="ld-basedn" placeholder="dc=example,dc=com"></div>
        <div class="field"><label for="ld-binddn">Bind DN (service account)</label><input id="ld-binddn" placeholder="cn=svc,dc=example,dc=com"></div>
        <div class="field"><label for="ld-bindpw">Bind password (blank keeps the stored one)</label><input id="ld-bindpw" type="password" autocomplete="new-password"></div>
        <div class="field"><label for="ld-filter">User search filter</label><input id="ld-filter" placeholder="(sAMAccountName={{username}})"></div>
      </div>
      <div class="switch"><input type="checkbox" id="ld-tls" checked><label for="ld-tls">Verify the directory's TLS certificate</label></div>
      <div class="field"><label for="ld-ca">CA certificate (PEM, optional — blank keeps the stored one)</label><textarea id="ld-ca" rows="3" placeholder="-----BEGIN CERTIFICATE-----"></textarea></div>
      <div class="switch"><input type="checkbox" id="ld-clear-ca"><label for="ld-clear-ca">Remove the stored CA certificate (use the system trust store)</label></div>
      <p><button class="btn sm" id="ld-save">Save settings</button> <button class="btn subtle sm" id="ld-test">Test connection</button></p>
      <p class="note" id="ld-status"></p>
      <p class="note" id="ld-note"></p>
    </div>
  </div>

  <div class="card sect">
    <div class="card-h"><h3>Self-signup (external accounts)</h3><span class="badge b-neutral" id="ext-badge">off</span></div>
    <div class="card-b">
      <p class="note">When enabled, outside individuals can create their own least-privileged accounts from the
      sign-in page. They only ever see their own data; internal roles are unaffected.</p>
      <div class="switch"><input type="checkbox" id="ext-enabled"><label for="ext-enabled">Allow external self-signup</label></div>
      <p class="note" id="ext-status"></p>
      <div class="table-scroll">
        <table class="list">
          <thead><tr><th>Email</th><th>Status</th></tr></thead>
          <tbody id="ext-body"></tbody>
        </table>
      </div>
      <p class="note" id="ext-note"></p>
    </div>
  </div>
</main>
<script src="/admin.js"></script>
</body>
</html>
`;
}

// public/admin.js — drives the admin console against the component's admin API.
// Vanilla JS (no framework, no build step); every fetch rides the httpOnly
// access-token cookie the sign-in set. 401 → back to /login.
function adminJs() {
  return `// Platform admin console (wired by ProxyPilot's base-app setup).
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 401) { window.location.assign('/login'); throw new Error('Signed out'); }
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var msg = (body && (body.message || body.error)) || ('HTTP ' + res.status);
          throw new Error(msg);
        }
        return body;
      });
    });
  }

  function note(id, text, isError) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'note' + (isError ? ' err' : '');
  }

  var roles = []; // [{ role, label, isSystem, isEditable, isDeletable, permissions: [...] }]

  // ---- Roles & permissions ----
  function loadPermissions() {
    return api('/api/admin/permissions').then(function (data) {
      roles = data.roles || [];
      var head = '<tr><th>Permission</th>' + roles.map(function (r) {
        var tools = '';
        if (r.isEditable) tools += ' <button class="linklike rename-role" data-role="' + esc(r.role) + '" title="Rename role">✎</button>';
        if (r.isDeletable) tools += ' <button class="linklike del-role" data-role="' + esc(r.role) + '" title="Delete role">✕</button>';
        return '<th>' + esc(r.label || r.role) + tools + '</th>';
      }).join('') + '</tr>';
      var rows = (data.permissions || []).map(function (p) {
        return '<tr><td>' + esc(p) + '</td>' + roles.map(function (r) {
          var cell = null;
          (r.permissions || []).forEach(function (c) { if (c.permission === p) cell = c; });
          var checked = cell && cell.allowed ? ' checked' : '';
          var overridden = cell && cell.source === 'override' ? ' title="override (differs from the built-in default)"' : '';
          return '<td style="text-align:center"><input type="checkbox" class="perm-box" data-role="' + esc(r.role) + '" data-perm="' + esc(p) + '"' + checked + overridden + '></td>';
        }).join('') + '</tr>';
      }).join('');
      document.getElementById('perm-table').innerHTML = head + rows;
    });
  }

  document.getElementById('perm-table').addEventListener('change', function (ev) {
    var box = ev.target;
    if (!box.classList.contains('perm-box')) return;
    api('/api/admin/permissions', { method: 'PUT', body: { role: box.dataset.role, permission: box.dataset.perm, allowed: box.checked } })
      .then(function () { note('perm-note', 'Saved.'); })
      .catch(function (err) { box.checked = !box.checked; note('perm-note', err.message, true); });
  });

  document.getElementById('perm-table').addEventListener('click', function (ev) {
    var btn = ev.target;
    if (btn.classList.contains('rename-role')) {
      var label = window.prompt('New label for role "' + btn.dataset.role + '":');
      if (!label) return;
      api('/api/admin/permissions/roles/' + encodeURIComponent(btn.dataset.role), { method: 'PATCH', body: { label: label } })
        .then(function () { return loadPermissions().then(loadUsers); })
        .catch(function (err) { note('perm-note', err.message, true); });
    } else if (btn.classList.contains('del-role')) {
      if (!window.confirm('Delete role "' + btn.dataset.role + '"? Users holding it must be moved first.')) return;
      api('/api/admin/permissions/roles/' + encodeURIComponent(btn.dataset.role), { method: 'DELETE' })
        .then(function () { return loadPermissions().then(loadUsers); })
        .catch(function (err) { note('perm-note', err.message, true); });
    }
  });

  document.getElementById('add-role').addEventListener('click', function () {
    var key = document.getElementById('new-role-key').value.trim().toLowerCase();
    var label = document.getElementById('new-role-label').value.trim();
    if (!key || !label) { note('perm-note', 'Both a key and a label are required.', true); return; }
    api('/api/admin/permissions/roles', { method: 'POST', body: { key: key, label: label } })
      .then(function () {
        document.getElementById('new-role-key').value = '';
        document.getElementById('new-role-label').value = '';
        note('perm-note', 'Role created — set its permissions above.');
        return loadPermissions().then(loadUsers);
      })
      .catch(function (err) { note('perm-note', err.message, true); });
  });

  // ---- Users ----
  function loadUsers() {
    return api('/api/admin/users').then(function (users) {
      users = users || [];
      document.getElementById('users-count').textContent = users.length + ' account' + (users.length === 1 ? '' : 's');
      var tb = document.getElementById('users-body');
      tb.innerHTML = users.map(function (u) {
        var options = roles.map(function (r) {
          return '<option value="' + esc(r.role) + '"' + (r.role === u.role ? ' selected' : '') + '>' + esc(r.label || r.role) + '</option>';
        }).join('');
        return '<tr>' +
          '<td>' + esc(u.email) + '</td>' +
          '<td><select class="role-sel" data-user="' + u.id + '">' + options + '</select></td>' +
          '<td><span class="badge ' + (u.isActive ? 'b-ok' : 'b-warn') + '">' + (u.isActive ? 'active' : 'disabled') + '</span></td>' +
          '<td>' + esc(u.provider || 'local') + '</td>' +
          '<td>' + (u.lastLoginAt ? esc(String(u.lastLoginAt).slice(0, 16).replace('T', ' ')) : '—') + '</td>' +
          '<td><button class="btn subtle sm toggle-active" data-user="' + u.id + '" data-next="' + (u.isActive ? 'false' : 'true') + '">' + (u.isActive ? 'Deactivate' : 'Activate') + '</button> ' +
          '<button class="btn subtle sm signin-link" data-user="' + u.id + '" title="One-time sign-in link: the user clicks it, chooses a password, and is signed in. Consumed when the password is set (link previews never spend it); expires in 7 days.">Sign-in link</button></td>' +
          '</tr>';
      }).join('');
    });
  }

  document.getElementById('users-body').addEventListener('change', function (ev) {
    var sel = ev.target;
    if (!sel.classList.contains('role-sel')) return;
    api('/api/admin/users/' + sel.dataset.user + '/role', { method: 'PATCH', body: { role: sel.value } })
      .then(function () { note('users-note', 'Role updated.'); })
      .catch(function (err) { note('users-note', err.message, true); loadUsers(); });
  });

  document.getElementById('users-body').addEventListener('click', function (ev) {
    var btn = ev.target;
    if (!btn.classList.contains('toggle-active')) return;
    api('/api/admin/users/' + btn.dataset.user + '/status', { method: 'PATCH', body: { isActive: btn.dataset.next === 'true' } })
      .then(function () { note('users-note', 'Status updated.'); return loadUsers(); })
      .catch(function (err) { note('users-note', err.message, true); });
  });

  // One-time sign-in link: no temporary passwords — the user clicks the link,
  // chooses a password, and is signed in. Consumed on password set (mail/SMS
  // previews never spend it); reissuing voids nothing until one is used.
  document.getElementById('users-body').addEventListener('click', function (ev) {
    var lbtn = ev.target;
    if (!lbtn.classList.contains('signin-link')) return;
    api('/api/admin/users/' + lbtn.dataset.user + '/login-link', { method: 'POST', body: {} })
      .then(function (r) {
        var url = window.location.origin + r.path;
        var copy = navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(url)
          : Promise.reject(new Error('no clipboard'));
        return copy
          .then(function () { note('users-note', 'One-time sign-in link copied — send it to the user (chat, email, or SMS). They set a password and are signed in; valid 7 days or until used.'); })
          .catch(function () { window.prompt('One-time sign-in link — copy and send it to the user:', url); note('users-note', 'Sign-in link generated.'); });
      })
      .catch(function (err) { note('users-note', err.message, true); });
  });

  // ---- LDAPS ----
  function fillLdaps(v) {
    document.getElementById('ld-host').value = v.host || '';
    document.getElementById('ld-port').value = v.port || 636;
    document.getElementById('ld-basedn').value = v.baseDn || '';
    document.getElementById('ld-binddn').value = v.bindDn || '';
    document.getElementById('ld-filter').value = v.userSearchFilter || '';
    document.getElementById('ld-tls').checked = v.tlsVerify !== false;
    document.getElementById('ld-badge').textContent = v.configured ? 'configured' : 'optional';
    document.getElementById('ld-badge').className = 'badge ' + (v.configured ? 'b-ok' : 'b-neutral');
    var s = [];
    if (v.bindPasswordSet) s.push('bind password stored');
    if (v.caCertSet) s.push('CA certificate stored');
    if (v.status) s.push('status: ' + v.status);
    if (v.lastTestedAt) s.push('last tested ' + String(v.lastTestedAt).slice(0, 16).replace('T', ' '));
    note('ld-status', s.join(' · '));
  }
  function loadLdaps() { return api('/api/admin/ldaps').then(fillLdaps); }

  document.getElementById('ld-save').addEventListener('click', function () {
    var body = {
      host: document.getElementById('ld-host').value.trim(),
      port: Number(document.getElementById('ld-port').value) || 636,
      baseDn: document.getElementById('ld-basedn').value.trim(),
      bindDn: document.getElementById('ld-binddn').value.trim(),
      userSearchFilter: document.getElementById('ld-filter').value.trim() || '(sAMAccountName={{username}})',
      tlsVerify: document.getElementById('ld-tls').checked,
    };
    var pw = document.getElementById('ld-bindpw').value;
    if (pw) body.bindPassword = pw;
    if (document.getElementById('ld-clear-ca').checked) body.caCert = '__CLEAR__';
    else if (document.getElementById('ld-ca').value.trim()) body.caCert = document.getElementById('ld-ca').value;
    api('/api/admin/ldaps', { method: 'PUT', body: body })
      .then(function (r) {
        document.getElementById('ld-bindpw').value = '';
        document.getElementById('ld-ca').value = '';
        document.getElementById('ld-clear-ca').checked = false;
        note('ld-note', (r && r.message) || 'Saved.');
        if (r && r.settings) fillLdaps(r.settings);
      })
      .catch(function (err) { note('ld-note', err.message, true); });
  });

  document.getElementById('ld-test').addEventListener('click', function () {
    note('ld-note', 'Testing…');
    api('/api/admin/ldaps/test', { method: 'POST' })
      .then(function (r) { note('ld-note', r.message || (r.ok ? 'Connection OK.' : 'Test failed.'), !r.ok); return loadLdaps(); })
      .catch(function (err) { note('ld-note', err.message, true); });
  });

  // ---- External self-signup ----
  function loadExternal() {
    return api('/api/admin/external').then(function (d) {
      document.getElementById('ext-enabled').checked = !!d.external_signup_enabled;
      document.getElementById('ext-badge').textContent = d.external_signup_enabled ? 'on' : 'off';
      document.getElementById('ext-badge').className = 'badge ' + (d.external_signup_enabled ? 'b-ok' : 'b-neutral');
      note('ext-status', (d.external_user_count || 0) + ' external account(s)');
      return api('/api/admin/external/users');
    }).then(function (d) {
      var users = (d && d.users) || [];
      document.getElementById('ext-body').innerHTML = users.map(function (u) {
        var active = u.isActive !== false;
        return '<tr><td>' + esc(u.email) + '</td><td><span class="badge ' + (active ? 'b-ok' : 'b-warn') + '">' + (active ? 'active' : 'disabled') + '</span></td></tr>';
      }).join('');
    });
  }

  document.getElementById('ext-enabled').addEventListener('change', function (ev) {
    api('/api/admin/external', { method: 'PUT', body: { enabled: ev.target.checked } })
      .then(function () { return loadExternal(); })
      .catch(function (err) { ev.target.checked = !ev.target.checked; note('ext-note', err.message, true); });
  });

  document.getElementById('logout').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(function () {
      window.location.assign('/login');
    });
  });

  // ---- boot ----
  loadPermissions()
    .then(loadUsers)
    .then(loadLdaps)
    .then(loadExternal)
    .catch(function (err) { note('page-note', err.message, true); });
})();
`;
}

// public/profile.html — the signed-in user's own page: identity, role, account
// type, and sign-out. Passwords are administrator/directory-managed in the base
// app, and the page says so.
function profileHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Profile</title>
<link rel="stylesheet" href="/design.css">
<link rel="stylesheet" href="/base.css">
<style>
.kv{display:grid;grid-template-columns:auto 1fr;gap:8px 18px;font-size:14px}
.kv dt{color:var(--app-muted,#5a6b81)}
.kv dd{margin:0;font-weight:600;word-break:break-all}
.note{font-size:12.5px;color:var(--app-muted,#5a6b81);margin-top:12px}
</style>
</head>
<body>
<header class="app">
  <span class="brand"><span class="logo">◆</span> Profile</span>
  <nav><a class="btn subtle sm" href="/">← App</a> <a class="btn subtle sm" id="admin-link" href="/admin" hidden>Admin console</a></nav>
  <span class="headspace"></span>
  <button class="btn subtle sm" id="logout">Sign out</button>
</header>
<main class="wrap">
  <div class="card">
    <div class="card-h"><h3>Your account</h3><span class="badge b-ok" id="role-badge"></span></div>
    <div class="card-b">
      <dl class="kv">
        <dt>Email</dt><dd id="me-email">…</dd>
        <dt>Role</dt><dd id="me-role">…</dd>
        <dt>Sign-in</dt><dd id="me-provider">…</dd>
        <dt>Status</dt><dd id="me-status">…</dd>
      </dl>
      <p class="note">Passwords are managed by an administrator (or by your directory when enterprise
      sign-in is configured). Contact an administrator to change yours.</p>
    </div>
  </div>
</main>
<script>
(function () {
  'use strict';
  fetch('/api/me', { credentials: 'same-origin' }).then(function (res) {
    if (res.status === 401) { window.location.assign('/login'); throw new Error('signed out'); }
    return res.json();
  }).then(function (me) {
    var email = (me.user && me.user.email) || '(unknown)';
    document.getElementById('me-email').textContent = email;
    document.getElementById('me-role').textContent = me.role || 'viewer';
    document.getElementById('role-badge').textContent = me.role || '';
    document.getElementById('me-provider').textContent = me.provider === 'ldap' ? 'Enterprise directory (LDAPS)' : 'Local password';
    document.getElementById('me-status').textContent = me.user && me.user.isActive === false ? 'disabled' : 'active';
    if (me.role === 'admin') document.getElementById('admin-link').hidden = false;
  }).catch(function () { /* redirected or transient */ });
  document.getElementById('logout').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(function () {
      window.location.assign('/login');
    });
  });
})();
</script>
</body>
</html>
`;
}

// public/login.html — the split sign-in page: a 2/3 brand banner beside a 1/3
// form column (stacked on small screens). LAYOUT ONLY: every element id, form,
// and the /login.js script are exactly the component's contract — login.js is
// untouched and keeps driving the bootstrap/login/setup flows. Colors ride the
// design tokens (/design.css) with tasteful dark fallbacks for projects whose
// design isn't extracted yet.
function loginHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Sign in</title>
  <link rel="stylesheet" href="/design.css">
  <style>
    :root {
      --bg: var(--app-bg, #0f1115); --card: var(--app-surface, #1a1d24);
      --fg: var(--app-text, #e6e8ec); --muted: var(--app-muted, #9aa1ad);
      --accent: var(--app-primary, #4f7cff); --accent-2: var(--app-accent, #7c5cff);
      --border: var(--app-border, #2a2e38); --err: var(--app-danger, #ff6b6b);
      --radius: var(--app-radius-lg, 12px);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg);
      font: 15px/1.5 var(--app-font, system-ui, -apple-system, Segoe UI, Roboto, sans-serif);
    }
    .split { display: grid; grid-template-columns: 1fr; min-height: 100vh; }
    @media (min-width: 900px) { .split { grid-template-columns: 2fr 1fr; } }

    /* ---- banner (2/3) ---- */
    .banner {
      position: relative; overflow: hidden; display: flex; flex-direction: column;
      justify-content: center; padding: 40px 32px; min-height: 160px; color: #fff;
      background: var(--accent);
      background: linear-gradient(135deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 55%, var(--accent-2)) 55%, var(--accent-2) 100%);
    }
    @media (min-width: 900px) { .banner { padding: 64px; } }
    .banner::before, .banner::after {
      content: ""; position: absolute; border-radius: 50%;
      background: rgba(255, 255, 255, .08); pointer-events: none;
    }
    .banner::before { width: 420px; height: 420px; right: -120px; top: -140px; }
    .banner::after { width: 280px; height: 280px; left: -90px; bottom: -110px; }
    .banner .logo { font-size: 34px; margin-bottom: 14px; }
    .banner h1 { margin: 0 0 8px; font-size: clamp(26px, 4vw, 40px); letter-spacing: -.02em; }
    .banner p { margin: 0; max-width: 34rem; font-size: 15.5px; opacity: .9; }
    .banner .foot { position: absolute; bottom: 18px; left: 32px; font-size: 12px; opacity: .65; }
    @media (min-width: 900px) { .banner .foot { left: 64px; } }

    /* ---- form column (1/3) ---- */
    .pane { display: flex; align-items: center; justify-content: center; padding: 28px 20px; }
    .login-wrap { width: 100%; max-width: 380px; }
    .login-card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 28px;
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; margin-bottom: 18px; }
    .logo { color: var(--accent); font-size: 20px; }
    h2 { margin: 0 0 6px; font-size: 20px; }
    .muted { color: var(--muted); margin: 0 0 18px; font-size: 14px; }
    .field { display: block; margin-bottom: 16px; }
    .field > span { display: block; margin-bottom: 6px; font-size: 13px; color: var(--muted); }
    input {
      width: 100%; padding: 10px 12px; border-radius: 8px; min-height: 44px;
      border: 1px solid var(--border); background: color-mix(in srgb, var(--card) 70%, var(--bg)); color: var(--fg); font: inherit;
    }
    input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
    .field small { display: block; margin-top: 6px; }
    .btn {
      width: 100%; padding: 11px 14px; border: 0; border-radius: 8px; min-height: 44px;
      background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer;
    }
    .btn:hover { filter: brightness(1.05); }
    .form-msg { color: var(--err); min-height: 1.2em; margin: 12px 0 0; font-size: 14px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
<div class="split">
  <aside class="banner">
    <span class="logo" aria-hidden="true">◆</span>
    <h1>Welcome</h1>
    <p>Sign in to continue to your application. Your account, role, and permissions
    are managed by your administrator.</p>
    <span class="foot">Secured sign-in · sessions expire automatically</span>
  </aside>
  <main class="pane">
  <div class="login-wrap">
    <section class="panel login-card">
      <div class="brand login-brand">
        <span class="logo">◆</span>
        <span>Sign in</span>
      </div>

      <!-- Loading state while we ask the server which flow to show. -->
      <div id="login-loading">
        <h2>Sign in</h2>
        <p class="muted">Loading…</p>
      </div>

      <!-- First-run: no superadmin exists yet. Create one. -->
      <form id="form-bootstrap" hidden autocomplete="off">
        <h2>Create the first administrator</h2>
        <p class="muted">
          No account exists yet. Create the superadmin to finish setting up the app.
        </p>
        <label class="field">
          <span>Email</span>
          <input id="bootstrap-email" type="email" required autocomplete="username">
        </label>
        <label class="field">
          <span>Password</span>
          <input id="bootstrap-password" type="password" required minlength="12"
                 autocomplete="new-password">
          <small class="muted">At least 12 characters.</small>
        </label>
        <button class="btn login-btn" type="submit">Create administrator</button>
        <p class="form-msg" id="bootstrap-msg" role="alert"></p>
      </form>

      <!-- Normal sign-in. -->
      <form id="form-login" hidden autocomplete="off">
        <h2>Sign in</h2>
        <p class="muted">Use your account email and password (or your enterprise directory account when configured).</p>
        <label class="field">
          <span>Email</span>
          <input id="login-email" type="email" required autocomplete="username">
        </label>
        <label class="field">
          <span>Password</span>
          <input id="login-password" type="password" required autocomplete="current-password">
        </label>
        <button class="btn login-btn" type="submit">Sign in</button>
        <p class="form-msg" id="login-msg" role="alert"></p>
      </form>

      <!-- First-time password setup (server returned PASSWORD_SETUP_REQUIRED). -->
      <form id="form-setup" hidden autocomplete="off">
        <h2>Set your password</h2>
        <p class="muted">
          This account needs a password before you can sign in. Choose one now.
        </p>
        <label class="field">
          <span>Email</span>
          <input id="setup-email" type="email" required autocomplete="username" readonly>
        </label>
        <label class="field">
          <span>New password</span>
          <input id="setup-password" type="password" required minlength="12"
                 autocomplete="new-password">
          <small class="muted">At least 12 characters.</small>
        </label>
        <button class="btn login-btn" type="submit">Set password &amp; sign in</button>
        <p class="form-msg" id="setup-msg" role="alert"></p>
      </form>
    </section>
  </div>
  </main>
</div>

  <script src="/login.js"></script>
</body>
</html>
`;
}

// The wired file set (path → content). PURE.
export function buildAuthWiredFiles() {
  return [
    { path: 'src/app.ts', content: wiredAppTs() },
    { path: 'src/server.ts', content: wiredServerTs() },
    { path: 'public/admin.html', content: adminHtml() },
    { path: 'public/admin.js', content: adminJs() },
    { path: 'public/profile.html', content: profileHtml() },
    { path: 'public/login.html', content: loginHtml() },
  ];
}

// Wired-content history: sha256 of every PREVIOUS generation of the wired
// files (computed from the git revisions of this module). A target matching
// one of these was written by the installer, never touched by a build — safe
// to upgrade to the current wired content. Without this list, any fix to the
// wired files (e.g. mounting /_preview before the bootstrap gate) would read
// as "kept-adapted" on already-provisioned projects and never propagate.
// APPEND the outgoing hashes here whenever wiredAppTs/wiredServerTs change.
const WIRED_HISTORY = new Map([
  ['src/app.ts', [
    '5474502d25c50b7dace725b78293eea6a1208c372754231cb82b9df0af94297a', // v1: original wiring
    'f1c15fb614e17d6be1e52c392c3a5f088630214085f0917e76adf5d3ff009936', // v2: base-app-at-provisioning era
    '0115a022c6cfdb1c4dd0942e7f52c649e86cb6ed291c2637636b6ede4bf44fb9', // v3: /_preview CSP relax (still behind the gate)
    '90e2b13411612074ec2fa93dc9383f9a971c51c92a3cb0f18ab03559438a32c8', // v4: /_preview before the gate, pre admin-console
  ]],
  ['src/server.ts', [
    '070d8a86bed4239d087bf461ef9083acaca7c856188b18311f3560380d48919f', // v1-v2: pre listen-retry
    '23ee2276133346daf264ddae596d887f4a53ab464fb0597eb770c16005de22c5', // v3: EADDRINUSE listen-retry
  ]],
  ['public/admin.html', [
    // v1: pre overflow-wrap .note (long sign-in links / ldaps URLs overflowed)
    'b085d64f6a4d285efe47a0d85f9e844096cd235f5565a6de192b79d7dff0ee9c',
  ]],
  ['public/login.html', [
    // The component-shipped centered-card sign-in page (installer-written, no
    // human edits) — safe to upgrade to the wired split-layout page below.
    '7ca8c72fafbcbd8ef3995ce4da1e480bbf7fc5d1f2deae52c6a463f8ea542a33',
  ]],
  ['public/admin.js', [
    '4123ff0a11d3adf2bdb1b245bcc496f1f04ef165faed35a4fbffdb967346d4f8', // v1: pre sign-in-link button
  ]],
]);

// Same idea for the UNWIRED scaffold seeds: containers provisioned before the
// current scaffold still hold older seed generations of the entry files —
// pristine (no build touched them), just older. APPEND outgoing hashes when
// scaffold.js's appTs/serverTs change.
const SEED_HISTORY = new Map([
  ['src/app.ts', [
    'aaed8c6846f5c981a8c28f490f704ee0c8456e4afc0a731c9f6a4a6094bb8df9', // pre listen-retry / pre /_preview-CSP era
  ]],
  ['src/server.ts', [
    '6b2469766850122ff1ccece514835de8a79a6d31fa050f554258a92224e3ee86', // pre listen-retry era
  ]],
]);

// Known-pristine hashes per target: the scaffold seed content (any project name
// — these files don't vary by project) plus every historical wired generation.
// A target matching one of these is safe to rewrite; anything else was adapted
// by a build and is KEPT.
function pristineShaByPath() {
  const seeds = buildScaffoldFiles({ name: 'app' });
  const out = new Map();
  for (const t of AUTH_WIRING_TARGETS) {
    const seed = seeds.find((f) => f.path === t);
    out.set(t, new Set([
      ...(seed ? [sha256(seed.content)] : []),
      ...(SEED_HISTORY.get(t) || []),
      ...(WIRED_HISTORY.get(t) || []),
    ]));
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
