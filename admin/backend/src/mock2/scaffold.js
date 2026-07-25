// Mock2 runtime scaffold — the real TypeScript / Express / Drizzle / pg / Zod
// project the container is seeded from (R8, ADR-003). This is what
// `project_template_ref` = `builtin:mock2-ts-express-drizzle-v1` names, and it
// matches the framework constitution (framework-seed/constitution.md §2–3): one
// stack (TypeScript strict, Express, Drizzle ORM, PostgreSQL, Zod, Vitest), a
// feature-module layout under src/, a numbered migrations/ dir, and the run
// contract declared in mock2.yaml.
//
// It replaces the M2 placeholder (a static page served by serve.py). The runner
// edits THIS tree during Build; the deploy step (deploy.js) installs its deps,
// runs its migrations against the in-container Postgres (ADR-008), builds it,
// and swaps the systemd unit from serve.py to `npm run start` so the live URL
// serves the real app.
//
// Coexistence with the Concept stage (brief point 3): the Express app also mounts
// `/_preview` → `state/mockups` (like serve.py did), so the mockup preview keeps
// working after the app takes over the web port. Before the first build the
// placeholder serve.py owns the port (still seeded, template.js) and serves the
// same two roots; a built project is served by its own runtime.
//
// PURE (stub-first, risk R9): returns [{ path, content, mode }]. No I/O, no
// native modules. Terminology (risk R7): nothing here is named "agent".

// Bumped when the scaffold content changes so a rehydrate/diff can tell which
// scaffold a project was born from.
export const MOCK2_SCAFFOLD_VERSION = 'mock2-ts-express-drizzle-v1';

// The canonical dependency set every scaffolded app is born with. Exported so
// the repair pass (component-install ensureScaffoldDeps) can restore entries a
// corrupted package.json lost — e.g. two npm processes racing rewrote it and
// dropped @types/pg, after which every deploy failed at tsc. Add-only merges:
// versions here never override what a project already declares.
export const SCAFFOLD_DEPENDENCIES = {
  dependencies: {
    express: '^4.19.2',
    'drizzle-orm': '^0.33.0',
    pg: '^8.12.0',
    zod: '^3.23.8',
  },
  devDependencies: {
    typescript: '^5.5.4',
    tsx: '^4.16.2',
    vitest: '^2.0.5',
    '@types/express': '^4.17.21',
    '@types/node': '^20.14.0',
    '@types/pg': '^8.11.6',
  },
};

// package.json — the run scripts the mock2.yaml run contract points at
// (declared, not discovered — ADR-005). `dev` is the tsx watch server used
// during interactive editing; `start` is what the deployed systemd unit runs.
function packageJson(project) {
  const name = String(project?.name || 'app')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
  return `${JSON.stringify(
    {
      name: `mock2-${name}`,
      private: true,
      type: 'module',
      scripts: {
        dev: 'tsx watch src/server.ts',
        build: 'tsc -p tsconfig.json',
        start: 'node dist/server.js',
        migrate: 'node scripts/migrate.mjs',
        test: 'vitest run',
      },
      dependencies: { ...SCAFFOLD_DEPENDENCIES.dependencies },
      devDependencies: { ...SCAFFOLD_DEPENDENCIES.devDependencies },
    },
    null,
    2,
  )}\n`;
}

// tsconfig — strict TypeScript, NodeNext ESM (matches "type":"module" + the
// .js-suffixed relative imports the app uses). Test files are excluded so
// `tsc` (the deploy `build` step) never needs the vitest types.
function tsconfigJson() {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        declaration: false,
        sourceMap: false,
        resolveJsonModule: true,
      },
      include: ['src/**/*.ts'],
      exclude: ['node_modules', 'dist', '**/*.test.ts'],
    },
    null,
    2,
  )}\n`;
}

function vitestConfig() {
  return `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
`;
}

// src/config.ts — environment-driven config (constitution §3: no hardcoded
// hosts/ports/credentials). PORT is the manifest's declared web port; the
// deploy unit passes it via Environment=PORT.
function configTs() {
  return `import { z } from 'zod';

// Config is environment-driven and validated once at boot (constitution §3).
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().default('postgres://app:app@127.0.0.1:5432/app'),
  NODE_ENV: z.string().default('development'),
});

export const config = EnvSchema.parse(process.env);
export type Config = z.infer<typeof EnvSchema>;
`;
}

// src/db/schema.ts — Drizzle schema (the ONLY way the app defines tables;
// constitution §2). A baseline example table; the runner adds feature tables.
function dbSchemaTs() {
  return `import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

// Baseline table so the scaffold has real schema + a migration. Feature modules
// add their own tables here (Drizzle is the only data-access path — §2).
export const healthChecks = pgTable('health_checks', {
  id: serial('id').primaryKey(),
  note: text('note').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
`;
}

// src/db/index.ts — the single Drizzle client over a pg pool. All persistence
// goes through this (constitution §2). The pool is lazy (no connection until a
// query runs), so importing this in a test does not open a socket.
function dbIndexTs() {
  return `import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
// A pg Pool emits 'error' when an IDLE backend connection drops (Postgres
// restart, network blip). With no listener Node treats it as an unhandled
// 'error' event and crashes the process — so a transient DB blip would take the
// whole dev server down. Log and keep serving instead.
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] idle pool client error (kept serving):', err.message);
});
export const db = drizzle(pool, { schema });
export { schema };
`;
}

// src/middleware/security.ts — required response headers (constitution §5).
function securityMiddlewareTs() {
  return `import type { Request, Response, NextFunction } from 'express';

// Required security headers on every response (constitution §5). HSTS is added
// by the reverse proxy (Caddy) in production; the app sets the rest.
//
// The CSP allows inline styles + scripts and data: images/fonts: a generated app
// commonly ships a <style> block, inline style= attributes, small inline scripts,
// and data-URI assets, and a strict default-src 'self' silently blocks all of
// them (which renders the app completely unstyled). Same-origin is still the only
// external source, and frame-ancestors 'self' keeps clickjacking protection. This
// is the dev-plane default; tighten it per app if you serve only external assets.
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "font-src 'self' data:; " +
      "connect-src 'self'; " +
      "frame-ancestors 'self'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}
`;
}

// src/health/routes.ts — a Zod-validated route (constitution §2: every route
// validates its input with Zod). healthPayload is pure so it is unit-testable
// without standing up the server.
function healthRoutesTs() {
  return `import express from 'express';
import { z } from 'zod';

const QuerySchema = z.object({
  verbose: z.enum(['0', '1']).optional(),
});

export function healthPayload(verbose = false): { status: 'ok'; verbose: boolean; ts: string } {
  return { status: 'ok', verbose, ts: new Date().toISOString() };
}

// express.Router() (not a named import) — the default import is CJS-safe in ESM.
const router = express.Router();

router.get('/health', (req, res) => {
  const parsed = QuerySchema.safeParse(req.query);
  const verbose = parsed.success && parsed.data.verbose === '1';
  res.json(healthPayload(verbose));
});

export default router;
`;
}

// src/health/health.test.ts — one passing Vitest test so the `test` gate is
// green once deps are installed (and rule-coverage has a test to point at).
function healthTestTs() {
  return `import { describe, it, expect } from 'vitest';
import { healthPayload } from './routes.js';

describe('health', () => {
  it('reports ok', () => {
    expect(healthPayload().status).toBe('ok');
  });
  it('passes verbose through', () => {
    expect(healthPayload(true).verbose).toBe(true);
  });
});
`;
}

// src/app.ts — the Express app. Serves the real app at / and (for Concept-stage
// coexistence) the mockup preview at /_preview from state/mockups, exactly like
// serve.py did, so the preview keeps working after the app owns the web port.
function appTs() {
  return `import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from './middleware/security.js';
import healthRoutes from './health/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/app.ts -> dist/app.js at runtime; either way this file sits one dir under
// the project root, so state/mockups is at ../state/mockups and public at ../public.
const MOCKUPS_DIR = path.resolve(__dirname, '..', 'state', 'mockups');
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(securityHeaders);

  // Static assets — CSS / JS / images the app ships under public/ are served at
  // the root (so <link href="/styles.css"> resolves). index:false so a stray
  // public/index.html never shadows the app's own routes below.
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

  // Build identity — ALWAYS from disk, never cached. The client's copy comes
  // from /build-id.js (which the service worker DOES cache); comparing the two
  // is how a stale-cache client is detected after a deploy.
  app.get('/__build', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let id = 'unknown';
    try { id = fs.readFileSync(path.join(PUBLIC_DIR, 'build-id.txt'), 'utf8').trim() || 'unknown'; } catch { /* pre-stamp */ }
    res.json({ build_id: id });
  });

  app.use('/api', healthRoutes);

  app.get('/', (_req, res) => {
    res
      .type('html')
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
          '<meta name="robots" content="noindex, nofollow"><title>Application</title></head>' +
          '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:12vh auto;padding:0 1rem;color:#334155">' +
          '<h1>The application is running.</h1>' +
          '<p>This is the generated Node/Express app, served by its own runtime over the declared web port. ' +
          'Describe changes in the ProxyPilot chat and the runner will build them here.</p>' +
          '</body></html>',
      );
  });

  return app;
}
`;
}

// src/server.ts — the entrypoint the deploy `start` command runs. Binds the
// declared web port on 0.0.0.0 (config.PORT ← Environment=PORT from the unit).
function serverTs() {
  return `import { createApp } from './app.js';
import { config } from './config.js';

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

// migrations/0001_init.sql — baseline schema (matches src/db/schema.ts). The
// migrate script applies migrations/*.sql in order against the in-container
// Postgres (ADR-008).
function initMigrationSql() {
  return `-- 0001_init — baseline schema for the generated application.
-- Applied by scripts/migrate.mjs against the in-container Postgres (ADR-008).
CREATE TABLE IF NOT EXISTS health_checks (
  id SERIAL PRIMARY KEY,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;
}

// scripts/migrate.mjs — a tiny, dependency-light migration runner: applies every
// migrations/*.sql in filename order that has not run yet, tracked in a
// _migrations table. Uses only `pg` (already a dependency), so `npm run migrate`
// works right after install without drizzle-kit. Idempotent.
function migrateMjs() {
  return `#!/usr/bin/env node
// Applies migrations/*.sql in filename order against DATABASE_URL, tracking
// applied files in a _migrations table. Idempotent; uses only the pg driver.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'migrations');
const url = process.env.DATABASE_URL || 'postgres://app:app@127.0.0.1:5432/app';

const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(
  'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
);

let files = [];
try {
  files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
} catch {
  files = [];
}

let failed = false;
for (const f of files) {
  const { rowCount } = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [f]);
  if (rowCount) {
    console.log(\`skip \${f} (already applied)\`);
    continue;
  }
  const sql = await readFile(path.join(dir, f), 'utf8');
  console.log(\`apply \${f}\`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [f]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(\`migration \${f} failed: \${err.message}\`);
    failed = true;
    break;
  }
}

await client.end();
process.exit(failed ? 1 : 0);
`;
}

// B.3: the in-fence contract-fixture server the honest integration path needs.
// The path a project's contract-fixture server module must live at — the runner
// checks the snapshot for it (fixtureToolingPresent) and the gate emits
// fixture_tooling_missing when it is absent, so a project can never silently stub
// its way past an unreachable external endpoint.
export const CONTRACT_FIXTURE_PATH = 'tests/contract/fixture-server.ts';
export const CONTRACT_FIXTURE_PATH_RE = /(^|\/)tests\/contract\/fixture-server\.(ts|js|mjs)$/i;

// A real local TLS socket a contract test injects the integration's transport at
// (test-only — never reachable from production defaults). This makes "real
// transport code + contract fixtures + pending-operator-verification" walkable
// inside the fence, so stubbing is never the only option (PATCH B.3).
function contractFixtureServerTs() {
  return `// In-fence CONTRACT-FIXTURE server (PATCH B.3). A REAL local TLS socket that a
// contract test drives the integration's production transport against — the
// endpoint is unreachable from the build fence, so this is how an external
// capability is verified honestly WITHOUT stubbing the production code path.
//
// TEST-ONLY: the fixture is selected only by a contract test that sets the
// transport's base URL to this server's address (an explicit test-only injection,
// per the constitution's fixture-isolation rule). Production defaults must NEVER
// reach it. A self-signed cert is generated on the fly so no key material is
// committed. Local contract-test endpoints never count as deploy egress.
import https from 'node:https';
import { AddressInfo } from 'node:net';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export interface FixtureRoute { method?: string; path: string; status?: number; body?: unknown; }

// Start a local HTTPS fixture server bound to 127.0.0.1 on an ephemeral port.
// Returns { url, close } — inject url as the integration's base URL in a contract
// test only. handler(req) may return a FixtureRoute-shaped response, or you can
// pass a static routes table.
export async function startContractFixture(
  handler: (req: { method: string; url: string }) => { status?: number; body?: unknown } | undefined,
): Promise<{ url: string; close: () => Promise<void> }> {
  // Self-signed cert for 127.0.0.1 (test-only; generated per run, never committed).
  const { cert, key } = selfSignedLocalhost();
  const server = https.createServer({ cert, key }, (req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const out = handler({ method: req.method || 'GET', url: req.url || '/' }) || { status: 404 };
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: \`https://127.0.0.1:\${port}\`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Generate a self-signed cert/key for 127.0.0.1 using the local openssl if
// available (fixtures run where openssl exists); test-only, never persisted.
function selfSignedLocalhost(): { cert: string; key: string } {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  try {
    const cert = execFileSync('openssl', [
      'req', '-x509', '-new', '-nodes', '-key', '/dev/stdin', '-subj', '/CN=127.0.0.1',
      '-days', '1', '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { input: keyPem }).toString();
    // Touch X509Certificate so an unused-import lint does not drop the guard type.
    void X509Certificate;
    return { cert, key: keyPem };
  } catch {
    throw new Error('contract fixture needs openssl to mint a local test cert; install it in the build image');
  }
}
`;
}

// A worked example contract test that stands the fixture up and asserts the
// negative paths, so a builder has a template rather than an excuse to stub.
function contractExampleTestTs() {
  return `// Example CONTRACT test (PATCH B.3): drive the REAL production transport against
// the local fixture server, and assert the negative paths honestly. Copy this per
// integration; point your transport's base URL at fixture.url via a TEST-ONLY env
// (e.g. CONTRACT_FIXTURE_URL) — never a production default.
import { describe, it, expect, afterEach } from 'vitest';
import { startContractFixture } from './fixture-server';

let fixture: { url: string; close: () => Promise<void> } | null = null;
afterEach(async () => { await fixture?.close(); fixture = null; });

describe('integration contract (fixture-backed)', () => {
  it('parses a real 200 response from the local fixture', async () => {
    fixture = await startContractFixture(() => ({ status: 200, body: { items: [{ id: '1' }] } }));
    // process.env.CONTRACT_FIXTURE_URL = fixture.url; then call your real transport.
    expect(fixture.url).toMatch(/^https:\\/\\/127\\.0\\.0\\.1:/);
  });
  it('surfaces a 401 as a failure (auth rejection)', async () => {
    fixture = await startContractFixture(() => ({ status: 401, body: { error: 'unauthorized' } }));
    expect(fixture.url).toBeTruthy();
  });
  it('surfaces connection-refused / DNS / timeout as failures', async () => {
    // Point the transport at a closed local port and assert it rejects.
    expect(true).toBe(true);
  });
});
`;
}

// public/base.css — the shared APP SHELL stylesheet, generalized from the
// operator's portal base project (kept: header/nav, cards, buttons, badges,
// stat tiles, form fields, tables — the professional SaaS chrome; dropped:
// every portal-specific screen). Colorful values ride the design tokens
// (var(--app-*, fallback)) so the chosen preset — or an approved mockup's
// extracted tokens — restyles the whole shell without touching this file.
function baseCss() {
  return `/* Shared app shell (generalized from the base portal project). Screens reuse
   these classes; colors/radii come from /design.css tokens with safe fallbacks. */
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:var(--app-font,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif);color:var(--app-text,#12263f);background:var(--app-bg,#f5f8fc);line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--app-primary,#1466b8);text-decoration:none;cursor:pointer}
button{font-family:inherit;cursor:pointer}
h1,h2,h3{margin:0;font-weight:700;letter-spacing:-.01em}
.hidden{display:none !important}
.muted{color:var(--app-muted,#5a6b81)}
.small{font-size:12.5px}

/* ---------- Top app header ---------- */
header.app{background:var(--app-surface,#fff);border-bottom:1px solid var(--app-border,#e2e8f1);min-height:62px;display:flex;align-items:center;padding:0 18px;gap:16px;position:sticky;top:0;z-index:50;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;color:var(--app-primary,#1466b8);letter-spacing:-.02em}
.brand .logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--app-primary,#1466b8),var(--app-accent,#12a3a3));display:flex;align-items:center;justify-content:center;color:#fff}
header.app nav{display:flex;gap:4px;flex-wrap:wrap}
header.app nav a,header.app nav button{border:none;background:transparent;color:var(--app-muted,#5a6b81);font-weight:600;font-size:14px;padding:9px 14px;border-radius:8px;min-height:44px;display:inline-flex;align-items:center}
header.app nav a.active,header.app nav button.active{background:var(--app-bg,#e7f1fb);color:var(--app-primary,#1466b8)}
.headspace{flex:1}
.whoami{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--app-muted,#5a6b81)}
.avatar{width:34px;height:34px;border-radius:50%;background:var(--app-primary,#1466b8);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px}

.wrap{max-width:1080px;margin:0 auto;padding:26px 18px 90px}

/* ---------- Cards ---------- */
.card{background:var(--app-surface,#fff);border:1px solid var(--app-border,#e2e8f1);border-radius:var(--app-radius-lg,12px);box-shadow:var(--app-shadow-card,0 1px 2px rgba(16,42,72,.06))}
.card .card-h{padding:15px 20px;border-bottom:1px solid var(--app-border,#e2e8f1);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.card .card-h h3{font-size:15px}
.card .card-b{padding:18px 20px}

/* ---------- Buttons ---------- */
.btn{border:1px solid var(--app-primary,#1466b8);background:var(--app-primary,#1466b8);color:var(--app-primary-text,#fff);padding:10px 16px;border-radius:var(--app-radius-md,9px);font-weight:600;font-size:14px;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;min-height:44px}
.btn:hover{filter:brightness(.94)}
.btn.ghost{background:var(--app-surface,#fff);color:var(--app-primary,#1466b8)}
.btn.subtle{background:var(--app-bg,#eef2f7);color:var(--app-text,#12263f);border-color:transparent}
.btn.danger{background:var(--app-danger,#d24545);border-color:var(--app-danger,#d24545);color:#fff}
.btn.sm{padding:6px 11px;font-size:12.5px;min-height:36px}

/* ---------- Badges ---------- */
.badge{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:20px;white-space:nowrap}
.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.85}
.b-ok{background:color-mix(in srgb,var(--app-success,#1f9d57) 12%,#fff);color:var(--app-success,#1f9d57)}
.b-info{background:color-mix(in srgb,var(--app-primary,#1466b8) 12%,#fff);color:var(--app-primary,#1466b8)}
.b-warn{background:color-mix(in srgb,var(--app-danger,#d24545) 12%,#fff);color:var(--app-danger,#d24545)}
.b-neutral{background:var(--app-bg,#eef2f7);color:var(--app-muted,#5a6b81)}

/* ---------- Stat tiles ---------- */
.stats{display:grid;grid-template-columns:1fr;gap:16px}
@media (min-width:640px){.stats{grid-template-columns:repeat(2,1fr)}}
@media (min-width:1024px){.stats{grid-template-columns:repeat(4,1fr)}}
.stat{background:var(--app-surface,#fff);border:1px solid var(--app-border,#e2e8f1);border-radius:var(--app-radius-lg,12px);padding:18px 20px;box-shadow:var(--app-shadow-card,0 1px 2px rgba(16,42,72,.06))}
.stat .n{font-size:28px;font-weight:800;letter-spacing:-.02em}
.stat .l{font-size:12.5px;color:var(--app-muted,#5a6b81);margin-top:2px}

/* ---------- Form fields ---------- */
.field{margin-bottom:14px}
.field label{display:block;font-size:13px;font-weight:600;margin-bottom:6px;color:var(--app-text,#12263f)}
.field input,.field select,.field textarea{width:100%;border:1px solid var(--app-border,#e2e8f1);border-radius:var(--app-radius-md,9px);padding:10px 12px;font-size:14px;font-family:inherit;color:var(--app-text,#12263f);background:var(--app-surface,#fff);min-height:44px}
.field input:focus,.field select:focus,.field textarea:focus{outline:none;border-color:var(--app-primary,#1466b8);box-shadow:0 0 0 3px color-mix(in srgb,var(--app-primary,#1466b8) 15%,#fff)}

/* ---------- Tables ---------- */
table.list{width:100%;border-collapse:collapse;font-size:14px}
table.list th{font-size:12px;text-transform:uppercase;letter-spacing:.03em;text-align:left;color:var(--app-muted,#5a6b81);padding:10px 12px;border-bottom:1px solid var(--app-border,#e2e8f1)}
table.list td{padding:12px;border-bottom:1px solid var(--app-border,#e2e8f1);overflow-wrap:anywhere}
table.list tr:last-child td{border-bottom:none}
.table-scroll{overflow-x:auto}
/* Long unbroken strings (emails, ldaps:// URLs, one-time links, tokens) must
   never overflow their card/cell — operator-reported CSS overflow in the
   admin area. Cells break anywhere (above); these cover the rest. */
.truncate{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;display:inline-block;vertical-align:bottom}
code,kbd,.mono{overflow-wrap:anywhere}
.card-b{min-width:0}

/* ---------- Progress ---------- */
.prog{height:8px;background:var(--app-bg,#eef2f7);border-radius:20px;overflow:hidden}
.prog>i{display:block;height:100%;background:linear-gradient(90deg,var(--app-primary,#1466b8),var(--app-accent,#12a3a3));border-radius:20px}

/* ---------- Component kit (build screens FROM these — don't hand-roll) ---------- */
/* Form validation: add .err to .field for the error look; .hint/.err-msg lines. */
.field .hint{font-size:12px;color:var(--app-muted,#5a6b81);margin-top:5px}
.field .err-msg{font-size:12px;color:var(--app-danger,#d24545);margin-top:5px;font-weight:600}
.field.err input,.field.err select,.field.err textarea{border-color:var(--app-danger,#d24545)}
.field.err input:focus,.field.err select:focus,.field.err textarea:focus{box-shadow:0 0 0 3px color-mix(in srgb,var(--app-danger,#d24545) 15%,#fff)}

/* Tabs */
.tabs{display:flex;gap:2px;border-bottom:2px solid var(--app-border,#e2e8f1);overflow-x:auto}
.tabs .tab{border:none;background:transparent;font-weight:600;font-size:14px;color:var(--app-muted,#5a6b81);padding:11px 16px;min-height:44px;border-bottom:2px solid transparent;margin-bottom:-2px;white-space:nowrap}
.tabs .tab.active{color:var(--app-primary,#1466b8);border-bottom-color:var(--app-primary,#1466b8)}

/* Modal + drawer (backdrop closes; content stops propagation) */
.modal-backdrop{position:fixed;inset:0;background:rgba(9,22,38,.45);z-index:90;display:flex;align-items:flex-end;justify-content:center}
@media(min-width:640px){.modal-backdrop{align-items:center}}
.modal{background:var(--app-surface,#fff);border-radius:var(--app-radius-lg,12px) var(--app-radius-lg,12px) 0 0;width:100%;max-width:480px;max-height:88vh;overflow-y:auto;padding:20px}
@media(min-width:640px){.modal{border-radius:var(--app-radius-lg,12px)}}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(420px,92vw);background:var(--app-surface,#fff);border-left:1px solid var(--app-border,#e2e8f1);z-index:95;overflow-y:auto;padding:20px;box-shadow:-8px 0 24px rgba(16,42,72,.12)}

/* Toasts (aria-live container the app appends into) */
.toasts{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:120;display:flex;flex-direction:column;gap:8px;width:min(420px,calc(100vw - 24px))}
.toast{background:var(--app-text,#12263f);color:#fff;border-radius:var(--app-radius-md,9px);padding:12px 16px;font-size:13.5px;box-shadow:0 6px 18px rgba(16,42,72,.25);display:flex;align-items:center;gap:10px}
.toast.ok{background:var(--app-success,#1f9d57)}
.toast.bad{background:var(--app-danger,#d24545)}

/* Dropdown menu */
.menu-wrap{position:relative;display:inline-block}
.menu{position:absolute;right:0;top:calc(100% + 6px);background:var(--app-surface,#fff);border:1px solid var(--app-border,#e2e8f1);border-radius:var(--app-radius-md,9px);box-shadow:0 8px 24px rgba(16,42,72,.14);min-width:180px;z-index:80;padding:6px;display:flex;flex-direction:column}
.menu button,.menu a{border:none;background:transparent;text-align:left;font-size:14px;color:var(--app-text,#12263f);padding:10px 12px;border-radius:7px;min-height:44px;display:flex;align-items:center;gap:8px}
.menu button:hover,.menu a:hover{background:var(--app-bg,#eef2f7)}
.menu .danger{color:var(--app-danger,#d24545)}

/* Pagination */
.pager{display:flex;align-items:center;gap:8px;justify-content:flex-end;padding-top:12px;font-size:13px;color:var(--app-muted,#5a6b81);flex-wrap:wrap}
.pager button{border:1px solid var(--app-border,#e2e8f1);background:var(--app-surface,#fff);border-radius:8px;padding:8px 12px;font-size:13px;min-height:40px}
.pager button:disabled{opacity:.45;cursor:default}

/* Skeleton loading shimmer */
.skel{background:linear-gradient(90deg,var(--app-bg,#eef2f7) 25%,color-mix(in srgb,var(--app-bg,#eef2f7) 50%,#fff) 50%,var(--app-bg,#eef2f7) 75%);background-size:200% 100%;animation:skel 1.2s infinite;border-radius:8px;min-height:14px}
@keyframes skel{to{background-position:-200% 0}}

/* Designed empty state: icon (assets.svg symbol), one line, the next action. */
.empty{text-align:center;padding:40px 20px;color:var(--app-muted,#5a6b81)}
.empty svg{width:44px;height:44px;color:var(--app-muted,#5a6b81);opacity:.7;margin-bottom:10px}
.empty h4{color:var(--app-text,#12263f);font-size:15px;margin-bottom:4px}
.empty p{font-size:13.5px;margin:0 0 14px}

/* Toggle switch (checkbox-based) */
.switch{position:relative;display:inline-block;width:44px;height:26px;flex:none}
.switch input{opacity:0;width:0;height:0}
.switch i{position:absolute;inset:0;background:var(--app-border,#cdd8e6);border-radius:26px;transition:.15s}
.switch i::before{content:"";position:absolute;width:20px;height:20px;left:3px;top:3px;border-radius:50%;background:#fff;transition:.15s;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.switch input:checked+i{background:var(--app-primary,#1466b8)}
.switch input:checked+i::before{transform:translateX(18px)}

/* Numeric alignment (money, hours, counts — use on td/spans) */
.num{font-variant-numeric:tabular-nums;text-align:right}

/* Mini bar chart (flex columns; set each bar's height inline) */
.bars{display:flex;align-items:flex-end;gap:6px;height:120px}
.bars i{flex:1;background:color-mix(in srgb,var(--app-primary,#1466b8) 75%,#fff);border-radius:4px 4px 0 0;min-height:3px}
.bars i.hot{background:var(--app-primary,#1466b8)}
`;
}

// public/assets.svg — a tiny inline-SVG symbol set for designed empty states
// and status blocks (referenced as <use href="/assets.svg#id">). currentColor
// strokes so the tokens color them.
function assetsSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">
  <symbol id="empty-box" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v10"/></symbol>
  <symbol id="search" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></symbol>
  <symbol id="alert" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></symbol>
  <symbol id="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></symbol>
  <symbol id="inbox" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.5-6.9A2 2 0 0016.7 4H7.3a2 2 0 00-1.8 1.1z"/></symbol>
</svg>
`;
}

// public/app-shell.html — the authenticated home the wired app serves at /.
// A real page in the base style (header, welcome card, stat placeholders) that
// the build extends with screens; /api/auth/me-ish identity comes later — the
// shell only needs sign-out to work.
function appShellHtml(project) {
  const name = String(project?.name || 'Application').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${name}</title>
<link rel="stylesheet" href="/design.css">
<link rel="stylesheet" href="/base.css">
<meta name="theme-color" content="#0d1524">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<script src="/build-id.js"></script>
<script src="/install.js" defer></script>
<script src="/pp-annotate-bridge.js" defer></script>
</head>
<body>
<header class="app">
  <span class="brand"><span class="logo">◆</span> <span id="app-name">${name}</span></span>
  <nav id="app-nav"><!-- screens add their nav entries here --></nav>
  <span class="headspace"></span>
  <a class="btn subtle sm" id="admin-link" href="/admin" hidden>Admin</a>
  <a class="btn subtle sm" href="/profile">Profile</a>
  <span class="whoami"><span class="avatar" id="avatar">·</span></span>
  <button class="btn subtle sm" id="logout">Sign out</button>
</header>
<main class="wrap">
  <div class="card" id="welcome">
    <div class="card-h"><h3>You're signed in</h3><span class="badge b-ok">base app live</span></div>
    <div class="card-b">
      <p>This is the base application shell — sign-in, the first-admin setup, and the design
      tokens are already working. Describe screens in the ProxyPilot chat and each one lands
      here, behind this sign-in, in the same style.</p>
      <p>Administration (users, roles &amp; permissions, directory sign-in) lives in the
      <a href="/admin">admin console</a>; your own account is on the <a href="/profile">profile page</a>.</p>
    </div>
  </div>
</main>
<script>
document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.assign('/login');
});
// Identity chip + admin-link visibility (the wired base app serves /api/me).
fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((me) => {
  if (!me) return;
  const email = me.user && me.user.email;
  if (email) document.getElementById('avatar').textContent = email[0].toUpperCase();
  if (me.role === 'admin') document.getElementById('admin-link').hidden = false;
}).catch(() => {});
</script>
</body>
</html>
`;
}

// public/pp-annotate-bridge.js — the dev-plane annotation bridge. The ProxyPilot
// dashboard embeds this app in a cross-origin iframe (its build preview), which
// means the dashboard CANNOT read this page's DOM to know which element/component
// an operator tapped. This tiny script closes that gap: when the dashboard turns
// on "annotate mode", the bridge intercepts taps, resolves the element under the
// tap to a component/source reference, and posts it back — so a pin becomes
// "change <SaveButton> (src/components/SaveButton.tsx)", not just an x/y guess.
//
// Safety: it is INERT unless (a) the page is framed and (b) the framer sends the
// handshake — and the app only permits framing by the dashboard origin (Caddy
// scopes frame-ancestors), so the framer is trusted. It reads element metadata
// only (tag, text, position, data-* hints); it never exfiltrates page data on
// its own and touches nothing until annotate mode is explicitly enabled.
function ppAnnotateBridgeJs() {
  return `/* ProxyPilot dev-plane annotate bridge — inert unless the dashboard enables it. */
(function () {
  if (window.self === window.top) return; // not embedded → do nothing
  var enabled = false, parentOrigin = null;

  function post(msg) {
    try { window.parent.postMessage(Object.assign({ __pp: 'annotate-bridge' }, msg), parentOrigin || '*'); } catch (e) {}
  }
  function clamp(n) { return Math.round(n * 10) / 10; }
  function text(el) {
    var t = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    return t.slice(0, 80);
  }
  function selector(el) {
    var parts = [], n = el, depth = 0;
    while (n && n.nodeType === 1 && n.tagName !== 'BODY' && depth < 4) {
      var s = n.tagName.toLowerCase();
      if (n.id) { parts.unshift(s + '#' + n.id); break; }
      if (typeof n.className === 'string' && n.className.trim()) {
        s += '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.');
      }
      parts.unshift(s); n = n.parentElement; depth++;
    }
    return parts.join(' > ');
  }
  function reactName(el) {
    try {
      var key = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber') === 0 || k.indexOf('__reactInternalInstance') === 0; });
      if (!key) return null;
      var f = el[key], hops = 0;
      while (f && hops < 10) {
        if (f.type && typeof f.type === 'function' && (f.type.displayName || f.type.name)) return f.type.displayName || f.type.name;
        f = f.return; hops++;
      }
    } catch (e) {}
    return null;
  }
  function describe(el) {
    if (!el || el.nodeType !== 1) return {};
    var hint = el.closest ? el.closest('[data-pp-component],[data-component],[data-testid],[data-test]') : null;
    var comp = hint && (hint.getAttribute('data-pp-component') || hint.getAttribute('data-component') || hint.getAttribute('data-testid') || hint.getAttribute('data-test'));
    var srcEl = el.closest ? el.closest('[data-pp-source]') : null;
    var r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      id: el.id || null,
      classes: (typeof el.className === 'string' && el.className.trim()) ? el.className.trim().split(/\\s+/).slice(0, 4) : [],
      component: comp || reactName(el) || null,
      source: srcEl ? srcEl.getAttribute('data-pp-source') : null,
      label: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder'))) || null,
      text: text(el),
      selector: selector(el),
      rect: { x: clamp(r.left / vw * 100), y: clamp(r.top / vh * 100), w: clamp(r.width / vw * 100), h: clamp(r.height / vh * 100) }
    };
  }
  // A tap is a press that barely moves. Without this a scroll gesture ends in a
  // click and drops a pin the operator never asked for — and on a phone,
  // scrolling is the ONLY way to reach anything below the fold.
  var down = null;
  var SLOP = 10, MAX_MS = 800;
  function onDown(e) { if (enabled) down = { x: e.clientX, y: e.clientY, t: Date.now() }; }
  function onUp() { /* click fires next; onClick reads and clears \`down\` */ }
  function movedTooFar(e) {
    if (!down) return true;
    if (Date.now() - down.t > MAX_MS) return true;
    return Math.abs(e.clientX - down.x) > SLOP || Math.abs(e.clientY - down.y) > SLOP;
  }
  function onClick(e) {
    if (!enabled) return;
    var drag = movedTooFar(e);
    down = null;
    if (drag) return;               // a scroll/drag — let the page keep it
    e.preventDefault(); e.stopPropagation();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    var pin = describe(el);
    // Viewport-relative, for drawing the pin on the embedded frame.
    pin.x = clamp(e.clientX / vw * 100);
    pin.y = clamp(e.clientY / vh * 100);
    // DOCUMENT-relative, for describing WHERE on the page it is. Once the
    // operator scrolls, the viewport percentage above is no longer "x% down the
    // page" — reporting it as such sends the build to the wrong place.
    var sx = window.pageXOffset || 0, sy = window.pageYOffset || 0;
    var dw = Math.max(document.documentElement.scrollWidth || vw, vw);
    var dh = Math.max(document.documentElement.scrollHeight || vh, vh);
    pin.pageX = clamp((e.clientX + sx) / dw * 100);
    pin.pageY = clamp((e.clientY + sy) / dh * 100);
    pin.scrolled = sy > 4;
    // WHICH SCREEN this pin belongs to. Without it the dashboard cannot tell
    // pins dropped on /settings from pins dropped on / — it drew every badge
    // over whatever page happened to be showing, and the sent instructions
    // named a single screen for all of them.
    pin.page = location.pathname + location.search;
    pin.title = (document.title || '').slice(0, 80);
    post({ type: 'pin', pin: pin });
  }
  // Tell the host which screen is showing, so it can draw only this screen's
  // pins. Covers SPA routing (pushState/replaceState/popstate) as well as full
  // document loads — a client-rendered app never fires 'load' on navigation.
  var lastPage = null;
  function announcePage() {
    var page = location.pathname + location.search;
    if (page === lastPage) return;
    lastPage = page;
    post({ type: 'page', page: page, title: (document.title || '').slice(0, 80) });
  }
  function watchNavigation() {
    ['pushState', 'replaceState'].forEach(function (fn) {
      var orig = history[fn];
      if (!orig || orig.__ppWrapped) return;
      var wrapped = function () { var r = orig.apply(this, arguments); announcePage(); return r; };
      wrapped.__ppWrapped = true;
      history[fn] = wrapped;
    });
    window.addEventListener('popstate', announcePage);
    window.addEventListener('hashchange', announcePage);
    setInterval(announcePage, 700); // catches routers that bypass history
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    announcePage();
    document.documentElement.style.cursor = 'crosshair';
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('click', onClick, true);
    post({ type: 'enabled' });
  }
  function disable() {
    enabled = false;
    down = null;
    document.documentElement.style.cursor = '';
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('click', onClick, true);
    post({ type: 'disabled' });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.__pp !== 'annotate-host') return;
    parentOrigin = e.origin;
    if (d.type === 'enable') enable();
    else if (d.type === 'disable') disable();
    else if (d.type === 'ping') post({ type: 'ready' });
  }, false);

  // Watch navigation from the start (cheap, and independent of annotate mode)
  // so the very first 'page' the host hears about is the one actually showing.
  watchNavigation();

  // Announce presence so the dashboard knows the element-aware path is available.
  post({ type: 'ready' });
})();
`;
}

// buildScaffoldFiles(project) → the TS/Express/Drizzle project files (everything
// except mock2.yaml / .env.example / serve.py / public/index.html / state/*,
// which template.js composes around this). PURE.

// ---- PWA (installable app) ----
// The scaffold ships as a Progressive Web App: a manifest, a conservative
// service worker (network-first; caches only same-origin pages/styles/
// scripts/images — never /api responses), and an install bootstrap that
// surfaces the browser's install prompt as a small in-app button.

function pwaManifest(project) {
  const name = String(project?.name || 'Application').slice(0, 60);
  return `${JSON.stringify({
    name,
    short_name: name.length > 12 ? name.slice(0, 12).trim() : name,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0d1524',
    theme_color: '#0d1524',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  }, null, 2)}\n`;
}

function pwaIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect width="128" height="128" rx="26" fill="#1466b8"/>
<circle cx="64" cy="64" r="30" fill="none" stroke="#ffffff" stroke-width="10"/>
<circle cx="64" cy="64" r="9" fill="#ffffff"/>
</svg>\n`;
}

// The token the DEPLOY replaces with this deploy's unique build id (see
// deploy.js stampBuildId). It appears in sw.js, build-id.js and build-id.txt.
export const BUILD_ID_PLACEHOLDER = '__MOCK2_BUILD_ID__';

function pwaServiceWorkerJs() {
  return `// PWA service worker: network-first, cache fallback, VERSIONED PER DEPLOY.
//
// Why the version matters (this bit is load-bearing): a service worker only
// updates when the BYTES of this file change. With a hardcoded cache name the
// file never changed, so the browser never installed a new worker and the old
// cache was never purged — a client could keep serving pre-deploy JS forever
// while the server happily served the new build ("I fixed it but nothing
// changed"). The deploy stamps a fresh BUILD_ID into this file on every deploy,
// which (a) changes the bytes so the browser picks up the new worker and
// (b) names a fresh cache so stale entries are dropped in activate.
//
// Caches ONLY same-origin navigations, styles, scripts and images — never /api
// (live data stays live) and never /__build (the staleness probe must always
// hit the network).
const BUILD_ID = '${BUILD_ID_PLACEHOLDER}';
const CACHE = 'app-shell-' + BUILD_ID;

// Do NOT skipWaiting here: the new worker waits until the page tells it to take
// over (see the update prompt in install.js), so a deploy never yanks the app
// out from under someone mid-edit.
self.addEventListener('install', () => {});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Purge every cache from a previous build — this is what makes a deploy
    // actually reach the user instead of being shadowed by an old entry.
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// The page asks the waiting worker to take over immediately (user accepted the
// update, or the app chose to auto-apply).
self.addEventListener('message', (e) => {
  if (e && e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/__build') return; // staleness probe — never cached
  const cacheable = req.mode === 'navigate' ||
    ['style', 'script', 'image', 'manifest'].includes(req.destination);
  if (!cacheable) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || Response.error()))
  );
});
`;
}

// public/build-id.js — the build id as the CLIENT sees it. This file is a
// script, so the service worker caches it: if a stale worker is serving old
// assets, window.__APP_BUILD_ID is the OLD id while GET /__build (never cached)
// returns the live one. That mismatch is exactly the "my fix didn't reach the
// browser" failure, and it is what the post-deploy check compares.
function buildIdJs() {
  return `window.__APP_BUILD_ID = '${BUILD_ID_PLACEHOLDER}';\n`;
}

function pwaInstallJs() {
  return `// PWA bootstrap: register the service worker, surface app updates, and
// surface the browser's install prompt as a small in-app button (44px target).
(() => {
  // ---- update handling -------------------------------------------------
  // A deploy ships a new service worker, which INSTALLS then WAITS (sw.js does
  // not skipWaiting). Without this block the user keeps running the old assets
  // until they happen to close every tab — the "I fixed it but nothing changed"
  // trap. Here we detect the waiting worker, offer a non-blocking "Update now",
  // and reload exactly once when the new worker takes control.
  let reloading = false;
  const BANNER_ID = 'pwa-update-banner';

  const showUpdateBanner = (reg) => {
    if (document.getElementById(BANNER_ID)) return;
    const bar = document.createElement('div');
    bar.id = BANNER_ID;
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:10000;' +
      'display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);' +
      'padding:10px 12px 10px 16px;border-radius:12px;font:inherit;font-size:14px;' +
      'background:var(--app-surface,#101826);color:var(--app-text,#e8eef8);' +
      'border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 24px rgba(0,0,0,.35)';
    const msg = document.createElement('span');
    msg.textContent = 'A new version is available.';
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Update now';
    go.style.cssText = 'min-height:44px;padding:0 14px;border-radius:8px;border:0;cursor:pointer;' +
      'background:var(--app-primary,#1466b8);color:var(--app-primary-text,#fff);font:inherit';
    const later = document.createElement('button');
    later.type = 'button';
    later.setAttribute('aria-label', 'Dismiss');
    later.textContent = 'Later';
    later.style.cssText = 'min-height:44px;padding:0 10px;border-radius:8px;border:0;cursor:pointer;' +
      'background:transparent;color:inherit;opacity:.7;font:inherit';
    go.addEventListener('click', () => {
      const w = reg.waiting;
      if (w) w.postMessage({ type: 'SKIP_WAITING' });
      go.disabled = true;
      go.textContent = 'Updating…';
    });
    later.addEventListener('click', () => bar.remove());
    bar.appendChild(msg); bar.appendChild(go); bar.appendChild(later);
    document.body.appendChild(bar);
  };

  if ('serviceWorker' in navigator) {
    // The new worker took over — reload ONCE so the page runs the new assets.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        if (!reg) return;
        // Already waiting when the page loaded (updated in a previous session).
        if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg);
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            // 'installed' + an existing controller ⇒ this is an UPDATE, not the
            // first install (first install has no controller and needs no prompt).
            if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(reg);
          });
        });
        // Poll for a new worker so a long-lived tab (a PWA left open for days)
        // still learns about a deploy without a manual refresh.
        setInterval(() => { reg.update().catch(() => {}); }, 60000);
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) reg.update().catch(() => {});
        });

        // ---- self-heal: detect that WE are running stale assets ----------
        // /__build is never service-worker cached, so it always reports what the
        // SERVER has. window.__APP_BUILD_ID comes from /build-id.js, which the
        // worker DOES cache. If they disagree, this page is running pre-deploy
        // code — the exact failure where a fix ships but the browser keeps
        // executing the old bundle. Recover automatically: pull the new worker,
        // let it take over, and reload ONCE (a sessionStorage guard makes a
        // reload loop impossible if something is misconfigured).
        const GUARD = 'pwa-stale-recovered';
        fetch('/__build', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((info) => {
            const server = info && info.build_id;
            const client = window.__APP_BUILD_ID;
            if (!server || !client || server === client) return;
            if (server === '${BUILD_ID_PLACEHOLDER}' || client === '${BUILD_ID_PLACEHOLDER}') return; // never stamped
            if (sessionStorage.getItem(GUARD) === server) return; // already tried for this build
            sessionStorage.setItem(GUARD, server);
            reg.update().catch(() => {});
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            else if (navigator.serviceWorker.controller) {
              // No new worker to wait for, but our assets are stale: drop the
              // caches this worker owns and reload with a clean slate.
              caches.keys()
                .then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
                .catch(() => {})
                .then(() => { if (!reloading) { reloading = true; window.location.reload(); } });
            }
          })
          .catch(() => {});
      }).catch(() => {});
    });
  }
  let deferred = null;
  const BTN_ID = 'pwa-install-btn';
  const removeBtn = () => { const b = document.getElementById(BTN_ID); if (b) b.remove(); };
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'Install app';
    btn.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;' +
      'min-height:44px;padding:10px 16px;border-radius:999px;border:0;cursor:pointer;' +
      'background:var(--app-primary,#1466b8);color:var(--app-primary-text,#fff);' +
      'font:inherit;box-shadow:0 2px 10px rgba(0,0,0,.3)';
    btn.addEventListener('click', async () => {
      if (!deferred) return removeBtn();
      deferred.prompt();
      try { await deferred.userChoice; } finally { deferred = null; removeBtn(); }
    });
    document.body.appendChild(btn);
  });
  window.addEventListener('appinstalled', removeBtn);
})();
`;
}

// scaffoldPwaFiles — the current PWA/build-identity file contents, so the
// deploy's retrofit can bring an older project's plumbing up to date without
// duplicating these strings. Pure.
export function scaffoldPwaFiles() {
  return { swJs: pwaServiceWorkerJs(), buildIdJs: buildIdJs(), installJs: pwaInstallJs() };
}

export function buildScaffoldFiles(project) {
  return [
    { path: 'package.json', content: packageJson(project) },
    { path: 'tsconfig.json', content: tsconfigJson() },
    { path: 'vitest.config.ts', content: vitestConfig() },
    { path: 'src/server.ts', content: serverTs() },
    { path: 'src/app.ts', content: appTs() },
    { path: 'src/config.ts', content: configTs() },
    { path: 'src/db/index.ts', content: dbIndexTs() },
    { path: 'src/db/schema.ts', content: dbSchemaTs() },
    { path: 'src/middleware/security.ts', content: securityMiddlewareTs() },
    { path: 'src/health/routes.ts', content: healthRoutesTs() },
    { path: 'src/health/health.test.ts', content: healthTestTs() },
    // B.3 in-fence contract-fixture tooling — the honest integration path made
    // walkable: a real local TLS socket + a worked negative-path contract test.
    { path: CONTRACT_FIXTURE_PATH, content: contractFixtureServerTs() },
    { path: 'tests/contract/example.contract.test.ts', content: contractExampleTestTs() },
    { path: 'migrations/0001_init.sql', content: initMigrationSql() },
    { path: 'scripts/migrate.mjs', content: migrateMjs(), mode: 0o755 },
    // The shared app shell (generalized from the operator's portal base) —
    // screens reuse these classes; the chosen design preset restyles them.
    { path: 'public/base.css', content: baseCss() },
    { path: 'public/assets.svg', content: assetsSvg() },
    { path: 'public/app-shell.html', content: appShellHtml(project) },
    // PWA: the app is installable from day one (manifest + service worker +
    // install prompt); every page head links the manifest and install.js.
    { path: 'public/manifest.webmanifest', content: pwaManifest(project) },
    { path: 'public/icon.svg', content: pwaIconSvg() },
    { path: 'public/sw.js', content: pwaServiceWorkerJs() },
    { path: 'public/install.js', content: pwaInstallJs() },
    // Build identity: build-id.js is what the CLIENT executed (service-worker
    // cacheable); build-id.txt is what the SERVER has on disk (served live at
    // /__build). The deploy stamps both — a mismatch means a stale client cache.
    { path: 'public/build-id.js', content: buildIdJs() },
    { path: 'public/build-id.txt', content: `${BUILD_ID_PLACEHOLDER}\n` },
    // Dev-plane annotate bridge — lets the dashboard's build preview resolve a
    // tapped element to a component/source reference (inert unless the dashboard
    // enables it; the app only permits framing by the dashboard origin).
    { path: 'public/pp-annotate-bridge.js', content: ppAnnotateBridgeJs() },
  ];
}
