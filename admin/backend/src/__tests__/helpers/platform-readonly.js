// Runs the GENERATED src/platform/readonly.ts (scaffold-platform.js) as it
// ships, under Node's own type stripping, with only its imports stubbed:
// drizzle's sql.raw is the identity, ../config.js reads DATABASE_URL from the
// environment, and ../db/index.js is either a scripted fake (unit tests) or a
// real pg client over DATABASE_URL (the real-Docker test). Each call is one
// child process, so every environment variable the module reads at load time
// (READONLY_DB_ROLE, MOCK2_FOUNDATION_PG_PORT) is the one the call passes.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildPlatformFiles } from '../../mock2/scaffold-platform.js';

const require = createRequire(import.meta.url);

// The scripted database: RO_FAKE_ROLES = {"name": canLogin, …} answers the
// role lookups; RO_FAKE_DENY=1 makes every CREATE/ALTER ROLE fail the way a
// role without CREATEROLE does. finish() hands back every statement it saw.
const FAKE_DB = `const roles = JSON.parse(process.env.RO_FAKE_ROLES || '{}');
const queries = [];
export const db = {
  async execute(q) {
    const text = String(q);
    queries.push(text);
    let m;
    if ((m = text.match(/SELECT 1 FROM pg_roles WHERE rolname = '([^']*)'/))) return { rows: m[1] in roles ? [{ x: 1 }] : [] };
    if ((m = text.match(/SELECT rolcanlogin FROM pg_roles WHERE rolname = '([^']*)'/))) return { rows: m[1] in roles ? [{ rolcanlogin: roles[m[1]] }] : [] };
    if (process.env.RO_FAKE_DENY === '1' && /^\\s*(CREATE|ALTER) ROLE/.test(text)) throw new Error('permission denied to create role');
    return { rows: [] };
  },
};
export async function finish() { return queries; }
`;

// A real connection, exactly like the app's (DATABASE_URL). Statements carry
// the issued password, so only their number is reported.
const realDb = () => `import pg from ${JSON.stringify(pathToFileURL(require.resolve('pg')).href)};
let client = null;
let count = 0;
export const db = {
  async execute(q) {
    if (!client) { client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); }
    count += 1;
    return client.query(String(q));
  },
};
export async function finish() { if (client) await client.end(); return count; }
`;

const VERIFY = `import * as ro from './src/platform/readonly.ts';
import { finish } from './src/db/index.js';
const out = { role: ro.RO_ROLE, foundationRole: ro.FOUNDATION_RO_ROLE };
try {
  const mode = process.argv[2];
  if (mode === 'parts') { out.url = ro.connectionUrl('app_readonly', 'pw'); out.odbc = ro.odbcDsn('app_readonly', 'pw'); }
  else if (mode === 'enable') out.result = await ro.enableReadonly();
  else if (mode === 'disable') out.result = await ro.disableReadonly();
  else if (mode === 'status') out.result = await ro.status();
  else throw new Error('unknown mode ' + mode);
} catch (e) {
  out.error = { code: e.code ?? null, message: e.message, privilege: e instanceof ro.DbPrivilegeError, name: e.constructor.name };
}
out.queries = await finish();
process.stdout.write(JSON.stringify(out));
`;

// materializeReadonly(dir, { foundation, real }) — the app layout the module
// expects: src/platform/readonly.ts, src/db/index.js, src/config.js, and, for
// a foundation app, foundation/bin/foundation.mjs (the marker it looks for).
export function materializeReadonly(dir, { foundation = false, real = false } = {}) {
  const source = buildPlatformFiles().find((f) => f.path === 'src/platform/readonly.ts').content;
  mkdirSync(join(dir, 'src', 'platform'), { recursive: true });
  mkdirSync(join(dir, 'src', 'db'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(dir, 'src', 'platform', 'drizzle-stub.js'), 'export const sql = { raw: (s) => s };\n');
  writeFileSync(join(dir, 'src', 'platform', 'readonly.ts'), source.replace("from 'drizzle-orm'", "from './drizzle-stub.js'"));
  writeFileSync(join(dir, 'src', 'db', 'index.js'), real ? realDb() : FAKE_DB);
  writeFileSync(join(dir, 'src', 'config.js'), 'export const config = { DATABASE_URL: process.env.DATABASE_URL };\n');
  writeFileSync(join(dir, 'verify.mjs'), VERIFY);
  if (foundation) {
    mkdirSync(join(dir, 'foundation', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'foundation', 'bin', 'foundation.mjs'), '// marker\n');
  }
  return source;
}

// runReadonly(dir, mode, env) → the parsed result of one call.
export function runReadonly(dir, mode, env = {}) {
  const base = { ...process.env };
  for (const k of ['DATABASE_URL', 'READONLY_DB_ROLE', 'MOCK2_FOUNDATION_PG_PORT', 'RO_FAKE_ROLES', 'RO_FAKE_DENY']) delete base[k];
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(dir, 'verify.mjs'), mode], {
    cwd: dir, encoding: 'utf8', env: { ...base, ...env }, timeout: 60000,
  });
  if (r.status !== 0) throw new Error(`readonly.ts ${mode} exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
