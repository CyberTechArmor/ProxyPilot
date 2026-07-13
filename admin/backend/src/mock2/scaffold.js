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
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'self'");
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
// the project root, so state/mockups is at ../state/mockups.
const MOCKUPS_DIR = path.resolve(__dirname, '..', 'state', 'mockups');

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(securityHeaders);

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
    { path: 'migrations/0001_init.sql', content: initMigrationSql() },
    { path: 'scripts/migrate.mjs', content: migrateMjs(), mode: 0o755 },
  ];
}
