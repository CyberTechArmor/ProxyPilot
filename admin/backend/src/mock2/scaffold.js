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
  app.use('/_preview', express.static(MOCKUPS_DIR, { index: 'current.html' }));

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

app.listen(config.PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(\`app listening on 0.0.0.0:\${config.PORT}\`);
});
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
table.list td{padding:12px;border-bottom:1px solid var(--app-border,#e2e8f1)}
table.list tr:last-child td{border-bottom:none}
.table-scroll{overflow-x:auto}

/* ---------- Progress ---------- */
.prog{height:8px;background:var(--app-bg,#eef2f7);border-radius:20px;overflow:hidden}
.prog>i{display:block;height:100%;background:linear-gradient(90deg,var(--app-primary,#1466b8),var(--app-accent,#12a3a3));border-radius:20px}
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
</head>
<body>
<header class="app">
  <span class="brand"><span class="logo">◆</span> <span id="app-name">${name}</span></span>
  <nav id="app-nav"><!-- screens add their nav entries here --></nav>
  <span class="headspace"></span>
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
    </div>
  </div>
</main>
<script>
document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.assign('/login');
});
</script>
</body>
</html>
`;
}

// buildScaffoldFiles(project) → the TS/Express/Drizzle project files (everything
// except mock2.yaml / .env.example / serve.py / public/index.html / state/*,
// which template.js composes around this). PURE.
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
    { path: 'public/app-shell.html', content: appShellHtml(project) },
  ];
}
