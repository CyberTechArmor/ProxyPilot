import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, statSync } from 'fs';
import { initDatabase, getDb } from './db.js';
import { authRouter } from './routes/auth.js';
import { servicesRouter } from './routes/services.js';
import { userRouter } from './routes/user.js';
import { lxcRouter } from './routes/lxc.js';
import { sshAccessRouter } from './routes/ssh-access.js';
import { firewallRouter } from './routes/firewall.js';
import { vpnRouter } from './routes/vpn.js';
import { securityRouter } from './routes/security.js';
import { cvesRouter } from './routes/cves.js';
import { housekeepingRouter } from './routes/housekeeping.js';
import { backupsRouter } from './routes/backups.js';
import { notificationsRouter } from './routes/notifications.js';
import { ldapRouter } from './routes/ldap.js';
import { authenticateToken, assertJwtSecret, sweepStaleSessions, blockPendingRole } from './middleware/auth.js';
import { reconcileAllServiceL4Forwards } from './lib/l4-startup.js';
import { autoHealVpnListenPort } from './lib/vpn-startup.js';
import { hydrate as hydrateBackupSchedules } from './lib/backup-scheduler.js';
import { hydrate as hydrateS3Healthcheck } from './lib/backup-s3-healthcheck.js';
import { csrfProtection } from './middleware/csrf.js';
import { attachTerminalServer, setMock2TerminalAuthorizer } from './routes/terminal-ws.js';
import { decryptSecret } from './lib/secrets.js';
import { postNotification } from './lib/notifications.js';
import { backupRoot, ensureRoot } from './lib/backup-local-store.js';
// Mock2 gate ONLY — the pure decision layer, no native/DB imports, so a
// disabled host never loads the module (ADR-001). The module itself is
// dynamically imported below only when the gate resolves enabled.
import { resolveMock2Gate } from './mock2/gating.js';

// Load environment variables - check multiple paths for .env
// The .env file may be in the install root (/opt/proxypilot/.env) or
// in the backend dir (admin/backend/.env) depending on deployment method
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPaths = [
  join(__dirname, '../../../.env'),  // Install root: /opt/proxypilot/.env (from src/)
  join(__dirname, '../../.env'),     // Project root when running from repo
  join(__dirname, '../.env'),        // Backend dir: admin/backend/.env
];

let envLoaded = false;
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath });
    console.log('Loaded .env from:', envPath);
    envLoaded = true;
    break;
  }
}
if (!envLoaded) {
  // Fallback: let dotenv try default paths
  config();
}

// Boot-time guard: in production NODE_ENV the server refuses to start
// with a missing, default, or weak JWT_SECRET. Must run AFTER dotenv
// has loaded the .env, BEFORE any code path that signs or verifies a
// token. Dev environments are allowed to fall through with a warning.
assertJwtSecret();

const app = express();
const PORT = process.env.PORT || 3001;

// Determine frontend path - check multiple locations
const possibleFrontendPaths = [
  join(__dirname, '../../frontend/dist'),
  join(__dirname, '../../../frontend/dist'),
  '/app/frontend/dist',
];
const FRONTEND_PATH = possibleFrontendPaths.find(p => existsSync(p)) || possibleFrontendPaths[0];
console.log('Frontend path:', FRONTEND_PATH, '- exists:', existsSync(FRONTEND_PATH));

// Security middleware. CSP previously disabled wholesale; replaced with
// a real policy that closes the obvious XSS vectors:
//   * default-src 'self'  — no remote anything by default
//   * script-src 'self'   — no inline JS, no remote JS
//   * style-src 'self' 'unsafe-inline' — Tailwind + React runtime styles
//     need inline style attributes; this is the standard concession
//   * img-src 'self' data: — TOTP setup renders QR codes as data: URIs
//   * connect-src 'self' — fetch only to same-origin (the backend)
//   * frame-ancestors 'none' — prevents clickjacking via iframe embed
//   * object-src 'none' — no Flash/PDF plugin embeds
//   * base-uri 'self' — locks <base> to defeat one XSS pivot
// Resolve the Mock2 gate up front (native-free) so the CSP can conditionally
// permit the admin SPA to embed a project's live preview. Reused for the module
// mount below.
const mock2Gate = resolveMock2Gate({ env: process.env, existsSync });

const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'", 'data:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};
// Mock2 (ADR-001): ONLY when the module is enabled do we allow the project page
// to iframe a project's live mockup/app preview (its own HTTPS subdomain). A
// disabled or production-pinned host emits the exact original CSP — no frame-src
// key at all, so its response headers stay byte-for-byte unchanged. Scoped to
// https: (the previews are always HTTPS project domains); frame-ancestors 'none'
// still forbids the admin app itself from being embedded anywhere.
if (mock2Gate.enabled) {
  cspDirectives.frameSrc = ["'self'", 'https:'];
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: cspDirectives,
  },
  crossOriginEmbedderPolicy: false,
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 60 * 60 * 24 * 365, includeSubDomains: true, preload: false }
    : false,
}));

// CORS configuration. In production, only allow the configured DOMAIN
// over HTTPS — the http:// alias was a development crutch and accepting
// it in production lets a downgrade attack on the user's network slip
// the same-origin assumption.
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [`https://${process.env.DOMAIN}`]
    : ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));

// Rate limiting - increased for dashboard usage
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 300, // 300 requests per minute (5 per second)
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Stricter rate limit for credential-bearing auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again later.' },
});
app.use('/api/auth/login', authLimiter);

// First-time setup endpoints — even tighter cap. These are only used once
// per install but are unauthenticated, so brute-forcing them must be
// expensive. Both the password-set and the TOTP-confirm steps are
// covered.
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many setup attempts, please try again later.' },
});
app.use('/api/auth/initial-setup', setupLimiter);
app.use('/api/auth/complete-totp-setup', setupLimiter);

// setup-status is polled by the frontend on every page load to decide
// whether to show the setup wizard, so it needs a higher ceiling than
// the credential endpoints. Still rate-limited to prevent enumeration
// at scale.
const setupStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/auth/setup-status', setupStatusLimiter);

// Body parsing. Routes that legitimately accept large payloads (base64
// file upload/import on the services router) get the 55mb limit
// mounted FIRST on their specific paths. The global default (1mb)
// runs after — Express middleware runs in registration order, and
// once a path-specific parser has populated req.body the default is a
// no-op for that request. This shrinks the unauth and CRUD attack
// surface without breaking the upload endpoints.
//
// LXC routes (lxc.js) use multer for uploads, which has its own 2GB
// limit and does not flow through express.json regardless of order.
const DEFAULT_BODY_LIMIT = '1mb';
const UPLOAD_BODY_LIMIT = '55mb';
const uploadJson = express.json({ limit: UPLOAD_BODY_LIMIT });
const uploadPaths = [
  '/api/services/:id/upload/*',
  '/api/services/:id/files/*',
  '/api/services/:id/import-files',
  '/api/services/import',
  '/api/services/terminal/upload-file',
  '/api/services/docker/volumes/import',
  '/api/services/discover/import',
];
for (const p of uploadPaths) {
  app.use(p, uploadJson);
}
// Multi-modal chat: the mock2 composers accept image attachments (client-side
// downscaled; ≤4 per message, ≤2.5MB decoded each — enforced again server-side
// by chat-image-logic). 16mb covers the worst case with headroom without
// widening the global 1mb default.
const chatImagesJson = express.json({ limit: '16mb' });
for (const p of ['/api/mock2/projects/:id/chat', '/api/mock2/projects/:id/ask', '/api/mock2/projects/:id/cycles']) {
  app.use(p, chatImagesJson);
}
app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT }));

// Cookie parsing — needed for the httpOnly JWT cookie + the CSRF
// double-submit cookie. Must be installed before any route or
// middleware reads req.cookies.
app.use(cookieParser());

// CSRF protection on every state-changing request. GET/HEAD/OPTIONS
// and the unauthenticated auth endpoints are exempt; everything else
// must echo the pp_csrf cookie via X-CSRF-Token. Mounted before the
// API routers but after rate limiters so abusive callers still get
// throttled.
app.use('/api/', csrfProtection);

// Initialize database
initDatabase();

// Sweep orphan in_progress backup rows.  The create-backup
// route inserts a row in 'in_progress' immediately, then packs +
// fans out + flips it to 'ok' / 'failed'.  If the process dies
// mid-pack (operator restarts the container, Caddy upstream
// times out, etc.) the row sticks at 'in_progress' forever and
// shows up in the dashboard as a never-ending spinner.  Since
// no in_progress row from before this boot can be valid (the
// pack was running in this very process), mark them all failed
// at startup.
try {
  const db = getDb();
  const orphans = db.prepare(
    `UPDATE backups
     SET status = 'failed',
         error = COALESCE(error, 'orphaned in_progress at admin restart')
     WHERE status = 'in_progress'`
  ).run();
  if (orphans.changes > 0) {
    console.log(`[backups] swept ${orphans.changes} orphan in_progress row(s) at boot`);
  }
} catch (err) {
  console.error('[backups] orphan sweep failed at boot:', err?.message || err);
}

// Detect 'ok' backups whose local file is missing AND that have
// no S3 copy — these are unrestorable orphans, typically caused
// by /var/lib/proxypilot not being bind-mounted into the admin
// container so a docker compose rebuild wiped the ephemeral
// storage out from under the DB rows.  Surface them by flipping
// the status to 'failed' with a clear note; the operator can
// dismiss them via the trash button.  We don't auto-delete the
// row because the operator might still want to see what was
// captured (manifest, audit history) before clearing it.
try {
  const db = getDb();
  const candidates = db.prepare(
    `SELECT id, local_path FROM backups
     WHERE status = 'ok'
       AND local_path IS NOT NULL
       AND s3_uploaded = 0`
  ).all();
  let flagged = 0;
  const update = db.prepare(
    `UPDATE backups
     SET status = 'failed',
         error = 'local file missing — wiped on container rebuild (check that /var/lib/proxypilot is bind-mounted)'
     WHERE id = ?`
  );
  for (const row of candidates) {
    if (!row.local_path) continue;
    try {
      statSync(row.local_path);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        update.run(row.id);
        flagged += 1;
      }
    }
  }
  if (flagged > 0) {
    console.log(`[backups] flagged ${flagged} backup(s) with missing local file at boot`);
  }
} catch (err) {
  console.error('[backups] missing-file sweep failed at boot:', err?.message || err);
}

// Probe every backup_destinations row for credential decryption.
// AES-GCM auth fails (raw message: "Unsupported state or unable
// to authenticate data") when the secret was encrypted under a
// different TOTP_ENCRYPTION_KEY than the one currently on disk.
// Most common cause: in-place restore wrote the DB but didn't
// match the .env's at-rest key, leaving every destination's
// secret unrecoverable.  Surface this at boot in the admin log
// + via a notification so the operator sees it before the next
// upload (snapshot push, scheduled backup) fails with a cryptic
// crypto error.
try {
  const db = getDb();
  const dests = db.prepare(
    `SELECT id, name, secret_key_enc FROM backup_destinations`
  ).all();
  const broken = [];
  for (const d of dests) {
    if (!d.secret_key_enc) continue;
    try { decryptSecret(d.secret_key_enc); }
    catch (err) {
      broken.push({ name: d.name, error: err?.message || String(err) });
    }
  }
  if (broken.length > 0) {
    console.error(
      `[secrets] ${broken.length} backup destination(s) failed credential decrypt at boot — ` +
      `TOTP_ENCRYPTION_KEY likely doesn't match the one used at encrypt time. ` +
      `Affected: ${broken.map((b) => b.name).join(', ')}. ` +
      `Re-enter the secret key in Housekeeping → Storage for each, or restore the matching .env.`
    );
    try {
      postNotification({
        level: 'error',
        title: `${broken.length} backup destination${broken.length === 1 ? '' : 's'} have unreadable credentials`,
        body: `TOTP_ENCRYPTION_KEY mismatch (common after in-place restore). ` +
          `Affected: ${broken.map((b) => b.name).join(', ')}. ` +
          `Re-enter the secret key in Housekeeping → Storage, or restore the matching .env.`,
        source: 'secrets-boot-probe',
        dedupe_key: 'secrets-boot-probe',
      });
    } catch { /* notification post may fail before init; non-fatal */ }
  }
} catch (err) {
  console.error('[secrets] boot decrypt probe failed:', err?.message || err);
}

// Probe that the local-backup root is writable.  When admin
// runs in a container without /var/lib/proxypilot bind-mounted
// (or with a host-side ownership mismatch), every backup
// create lands in the writable layer — invisible to host-side
// tooling, lost on rebuild — or fails outright.  Writing a
// throwaway sentinel at boot surfaces the breakage before the
// operator's first backup attempt does.
try {
  ensureRoot();
  const probePath = `${backupRoot()}/.proxypilot-write-probe`;
  await import('node:fs').then((fs) => {
    fs.writeFileSync(probePath, '');
    fs.unlinkSync(probePath);
  });
} catch (err) {
  const code = err?.code || 'unknown';
  console.error(
    `[backups] backup root ${backupRoot()} is not writable at boot (${code}): ${err?.message || err}. ` +
    `New backups will fail with "local write failed". ` +
    `Likely cause: /var/lib/proxypilot not bind-mounted into the admin container, ` +
    `or host-side ownership mismatch.`
  );
  try {
    postNotification({
      level: 'error',
      title: 'Backup root is not writable',
      body: `${backupRoot()} (${code}). New backups will fail with "local write failed". ` +
        `Check the bind mount + host-side ownership.`,
      source: 'backup-root-probe',
      dedupe_key: 'backup-root-probe',
    });
  } catch { /* tolerated */ }
}

// Sweep orphan 'running' restore_runs.  runModeA/B/C all live
// inside the admin process — their progress sits in the
// restore_runs row's steps_json + status columns.  A process
// restart mid-run (operator restart, OOM, crash mid-pack) leaves
// the row at status='running' indefinitely; the dry-runs panel
// then polls forever and the operator sees a stuck "running"
// pill with no way to clear it short of SQL.  Same shape of fix
// as the in_progress backup sweep above: nothing was actually
// running across the boot boundary, so flip every 'running' row
// to 'failed' with a clear note, finalising the timestamp so
// the panel auto-stops polling on the next refresh.
try {
  const db = getDb();
  const orphans = db.prepare(
    `UPDATE restore_runs
     SET status = 'failed',
         finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
         notes = COALESCE(notes, 'orphaned running at admin restart')
     WHERE status = 'running'`
  ).run();
  if (orphans.changes > 0) {
    console.log(`[restore] swept ${orphans.changes} orphan running run(s) at boot`);
  }
} catch (err) {
  console.error('[restore] orphan sweep failed at boot:', err?.message || err);
}

// Sweep orphan 'pending' snapshot S3 export rows.  The export
// flow inserts the row in 'pending' immediately, attaches the
// in-flight Upload to ACTIVE_UPLOADS, then flips to 'exported'
// or 'failed' on completion.  ACTIVE_UPLOADS is in-memory, so a
// process restart leaves the row at 'pending' forever — the
// snapshot panel keeps rendering "preparing…" with no banner
// (because the in-memory queue is empty post-boot) and the
// operator has no path forward except a manual SQL update.
// Same shape of fix as the in_progress backup sweep above:
// no pending row from before this boot can still be running.
try {
  const db = getDb();
  const orphans = db.prepare(
    `UPDATE lxc_snapshot_s3_exports
     SET status = 'failed',
         finished_at = CURRENT_TIMESTAMP,
         error = COALESCE(error, 'orphaned pending at admin restart')
     WHERE status = 'pending'`
  ).run();
  if (orphans.changes > 0) {
    console.log(`[snapshot-s3-export] swept ${orphans.changes} orphan pending row(s) at boot`);
  }
} catch (err) {
  console.error('[snapshot-s3-export] orphan sweep failed at boot:', err?.message || err);
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), frontendPath: FRONTEND_PATH });
});

// API Routes. blockPendingRole sits on every router EXCEPT /api/auth
// and /api/user: 'pending' accounts (LDAP-provisioned, no role assigned
// yet) may authenticate and manage their own profile (which /api/user
// serves — its admin-only endpoints carry requireAdmin themselves), but
// see nothing else until an admin assigns them a role.
app.use('/api/auth', authRouter);
app.use('/api/services', authenticateToken, blockPendingRole, servicesRouter);
app.use('/api/user', authenticateToken, userRouter);
app.use('/api/lxc', authenticateToken, blockPendingRole, lxcRouter);
app.use('/api/ssh-access', authenticateToken, blockPendingRole, sshAccessRouter);
app.use('/api/firewall', authenticateToken, blockPendingRole, firewallRouter);
app.use('/api/vpn', authenticateToken, blockPendingRole, vpnRouter);
app.use('/api/security', authenticateToken, blockPendingRole, securityRouter);
app.use('/api/cves', authenticateToken, blockPendingRole, cvesRouter);
app.use('/api/housekeeping', authenticateToken, blockPendingRole, housekeepingRouter);
app.use('/api/backups', authenticateToken, blockPendingRole, backupsRouter);
app.use('/api/notifications', authenticateToken, blockPendingRole, notificationsRouter);
app.use('/api/ldap', authenticateToken, ldapRouter);

// Mock2 — absence-by-installation (ADR-001). The gate is evaluated with
// no native imports; only when it resolves enabled do we dynamically
// import the module (which opens data/db/mock2.db and pulls in
// better-sqlite3) and mount /api/mock2. On a disabled or production-pinned
// host: no import, no state file, no route (every /api/mock2/* is a 404,
// indistinguishable from an unknown path), and the frontend hides its nav.
// Top-level await here runs before the SPA catch-all and error middleware
// below, preserving Express's route ordering. (mock2Gate is resolved up top,
// where the CSP also consumes it.)
if (mock2Gate.warning) {
  console.warn(mock2Gate.warning);
}
if (mock2Gate.enabled) {
  try {
    const { initMock2Db, createMock2Router, sweepMock2OnBoot, reconcileMock2Domains, sweepIdleStops, reconcileMock2Firewall, reconcileMock2Egress, seedFrameworkV1, upgradeFrameworkFromSeed, sweepMock2Locks, mock2TerminalAuthorize } = await import('./mock2/index.js');
    initMock2Db();
    // Register the project-terminal authorizer into the core streaming-terminal
    // route now that the module is enabled (ADR-001: the core never imports mock2
    // statically). Off ⇒ never registered ⇒ /api/terminal/mock2/* stays a 404.
    setMock2TerminalAuthorizer(mock2TerminalAuthorize);
    sweepMock2OnBoot();
    // Framework registry seed (M5, ADR-003 / risk R8): insert the vendored
    // placeholder version 1 on first enabled boot. Idempotent — a no-op once any
    // version exists. Non-fatal (a failed seed just leaves an empty registry).
    try { seedFrameworkV1(null); } catch (err) { console.error('[mock2] framework seed failed:', err?.message || err); }
    // Seed upgrade: if the vendored framework seed changed since the latest
    // published version (e.g. a fixed gate script), publish it as a new version so
    // the fix can actually reach projects (they adopt it via drift → update cycle;
    // nothing auto-remediates). Idempotent — a no-op when the seed is unchanged.
    try { upgradeFrameworkFromSeed(null); } catch (err) { console.error('[mock2] framework seed upgrade failed:', err?.message || err); }
    app.use('/api/mock2', authenticateToken, blockPendingRole, createMock2Router());
    // Re-publish enabled parent-domain Caddy site files after restart (M1).
    // Non-fatal — never blocks the listen even if Caddy is momentarily down.
    reconcileMock2Domains().catch((err) =>
      console.error('[mock2] domain reconcile failed:', err?.message || err));
    // Re-apply the M4 network isolation after restart: the per-project nftables
    // fence and the squid egress ACLs are DB-authoritative, so a restart
    // re-asserts them (l4-reconciler boot pattern). Non-fatal, fire-and-forget.
    reconcileMock2Firewall().catch((err) =>
      console.error('[mock2] firewall reconcile failed:', err?.message || err));
    reconcileMock2Egress().catch((err) =>
      console.error('[mock2] egress reconcile failed:', err?.message || err));
    // Idle-stop sweep (M3 groundwork): stop containers idle past the configured
    // window. Non-fatal, fire-and-forget; M9 adds the periodic timer.
    sweepIdleStops().catch((err) =>
      console.error('[mock2] idle sweep failed:', err?.message || err));
    // M6 checkout-lock idle sweep (ADR-004): auto-release stale human checkouts,
    // on boot and every 60s. Orphaned CYCLE locks are already released by
    // sweepMock2OnBoot above; this reclaims idle human holds. Non-fatal.
    sweepMock2Locks().catch((err) => console.error('[mock2] lock sweep failed:', err?.message || err));
    setInterval(() => {
      sweepMock2Locks().catch((err) => console.error('[mock2] lock sweep failed:', err?.message || err));
    }, 60000).unref();
    console.log('[mock2] module ENABLED — /api/mock2 mounted, mock2.db ready');
  } catch (err) {
    console.error('[mock2] failed to initialize — leaving module unmounted:', err?.message || err);
  }
} else if (!mock2Gate.pinned) {
  console.log('[mock2] module disabled (MOCK2_ENABLED not true) — no route, no state file');
} else {
  console.log('[mock2] module hard-off via production pin — no route, no state file');
}

// API 404 guard — MUST sit after every /api router (including the conditional
// Mock2 mount above) and BEFORE the SPA catch-all. Without it, the `app.get('*')`
// below serves index.html with a 200 for an unmatched GET /api/* — so a GET to a
// disabled/unmounted module's endpoint (e.g. /api/mock2/status when Mock2 is off
// or failed to load) returns HTML instead of a 404, and a client probing for the
// feature's presence gets a false positive (then its POSTs 404 with an HTML body,
// surfacing as "404 (no JSON body)"). Returning JSON here keeps every /api/* path
// honestly a 404 when nothing matched, in both dev and production.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  console.log('Serving static files from:', FRONTEND_PATH);
  app.use(express.static(FRONTEND_PATH));

  // Handle SPA routing - serve index.html for all non-API routes
  app.get('*', (req, res) => {
    const indexPath = join(FRONTEND_PATH, 'index.html');
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      console.error('index.html not found at:', indexPath);
      res.status(404).send('Frontend not found. Please rebuild the application.');
    }
  });
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// Stale-session sweeper: reap revoked/expired session rows older than
// SESSION_RETENTION_DAYS so the sessions table stays bounded under
// long-running deployments. Once on boot, then every 6 hours.
sweepStaleSessions();
setInterval(sweepStaleSessions, 6 * 60 * 60 * 1000).unref();

// Wrap the express app in an http.Server so we can attach a WebSocket
// upgrade handler on the same port. The streaming-terminal route uses
// `noServer` mode and registers its own `upgrade` listener on `server`,
// so the order matters: attach BEFORE `server.listen()`.
const server = http.createServer(app);
attachTerminalServer(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ProxyPilot backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Frontend path: ${FRONTEND_PATH}`);

  // Async background work post-listen. Order matters: migrate the WG
  // listen port FIRST so any L4 forwards that conflict with the old
  // port (most commonly the WebRTC range vs. WG's IANA 51820 default)
  // can reconcile cleanly afterwards.
  setImmediate(async () => {
    try {
      const vpn = await autoHealVpnListenPort();
      // Log every outcome so silent runs are debuggable. Previously
      // we only logged on `migrated:true`, which made it impossible
      // to tell whether the helper ran-and-skipped or threw before
      // even getting to the log line.
      if (vpn.migrated) {
        console.log(
          `[VPN-startup] migrated wg0 listen port ${vpn.from} -> ${vpn.to}` +
          (vpn.endpoint ? ` (endpoint ${vpn.endpoint})` : '')
        );
      } else if (vpn.error) {
        console.error(`[VPN-startup] migrate failed: ${vpn.error}`);
      } else if (vpn.skipped) {
        console.log(`[VPN-startup] skipped: ${vpn.skipped}`);
      } else {
        console.log(`[VPN-startup] no action taken (state: ${JSON.stringify(vpn)})`);
      }
    } catch (err) {
      console.error('[VPN-startup] threw:', err.message || err);
    }
    try {
      const summary = await reconcileAllServiceL4Forwards({ db: getDb() });
      if (summary.services > 0) {
        console.log(
          `[L4-startup] done: ${summary.services} service(s), ${summary.applied} applied, ${summary.removed} removed, ${summary.errors.length} errored`
        );
      }
    } catch (err) {
      console.error('[L4-startup] failed:', err.message || err);
    }
    // Cert-mount boot reconcile. Walks every service_cert_mounts row
    // and re-attaches devices that vanished while the admin was down
    // (host reboot, manual incus restart, etc.). Drift cases — device
    // present but pointing at a different source — are surfaced
    // through the API but NOT silently overwritten here, matching the
    // architecture decision that operator edits beat ProxyPilot
    // intent at boot.
    try {
      const { reconcileServiceCertMounts } = await import('./lib/cert-mount-reconciler.js');
      const result = await reconcileServiceCertMounts({ db: getDb() });
      const counts = { created: 0, matched: 0, drifted: 0, missing: 0, error: 0 };
      for (const r of result.results) {
        counts[r.action] = (counts[r.action] || 0) + 1;
      }
      const total = result.results.length;
      if (total > 0) {
        console.log(
          `[cert-mount] reconciled ${total} row(s) at boot — created=${counts.created}, matched=${counts.matched}, drifted=${counts.drifted}, missing=${counts.missing}, error=${counts.error}`
        );
      }
    } catch (err) {
      console.error('[cert-mount] boot reconcile failed:', err.message || err);
    }
    try {
      // Hydrate the backup-schedule cron worker.  Each enabled
      // row in backup_schedules registers a node-cron task; the
      // worker drains a serial queue so concurrent ticks can't
      // saturate disk with parallel `incus export` runs.
      hydrateBackupSchedules();
    } catch (err) {
      console.error('[backup-scheduler] hydrate threw:', err.message || err);
    }
    try {
      // Daily S3 connection-test cron — probes every destination
      // at 02:30 host time (overridable via
      // PROXYPILOT_S3_HEALTHCHECK_CRON) and posts an error
      // notification on failure.
      hydrateS3Healthcheck();
    } catch (err) {
      console.error('[s3-healthcheck] hydrate threw:', err.message || err);
    }
  });
});
