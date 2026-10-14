// Restore the exact production better-sqlite3 addon after candidate npm ci
// --ignore-scripts. The runtime image has no compiler; that npm command
// removes native binaries. Refuse a version mismatch and prove the copied
// binding opens an in-memory database before the complete test suite starts.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { ensureSelfCheckRuntime } from './self-check-runtime.mjs';

const candidate = resolve(process.cwd());
const expected = resolve('/var/lib/proxypilot/self/candidate/admin/backend');
if (candidate !== expected) throw new Error('SELF_CHECK_WRONG_CANDIDATE');
const runtime = '/app/backend';
const packagePath = 'node_modules/better-sqlite3/package.json';
const addonPath = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';
const installed = JSON.parse(readFileSync(join(candidate, packagePath), 'utf8'));
const trusted = JSON.parse(readFileSync(join(runtime, packagePath), 'utf8'));
if (installed.name !== 'better-sqlite3' || installed.version !== trusted.version)
  throw new Error('SELF_CHECK_NATIVE_VERSION_MISMATCH');
const source = join(runtime, addonPath);
if (!existsSync(source) || !statSync(source).isFile())
  throw new Error('SELF_CHECK_NATIVE_SOURCE_MISSING');
const destination = join(candidate, addonPath);
mkdirSync(dirname(destination), { recursive: true });
if (!realpathSync(dirname(destination)).startsWith(realpathSync(candidate) + sep))
  throw new Error('SELF_CHECK_NATIVE_DESTINATION_ESCAPE');
copyFileSync(source, destination);
const requireCandidate = createRequire(join(candidate, 'package.json'));
const Database = requireCandidate('better-sqlite3');
const db = new Database(':memory:');
try {
  if (db.prepare('SELECT 1 AS value').get().value !== 1)
    throw new Error('SELF_CHECK_NATIVE_PROBE_FAILED');
} finally {
  db.close();
}
console.log(`Candidate better-sqlite3 ${installed.version} native probe passed`);
ensureSelfCheckRuntime();
// Older live check policies run npm ci with NODE_ENV=production, omitting
// Vite. Prepare the fixed candidate's build tools here so the bootstrap can
// run all checks with skip_install:true. The new policy includes dev tools
// explicitly for subsequent releases. This never installs into live source.
const frontend = resolve(candidate, '../frontend');
if (!existsSync(join(frontend, 'node_modules/vite/bin/vite.js'))) {
  const buildTools = spawnSync('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'],
    { cwd: frontend, env: process.env, stdio: 'inherit', timeout: 15 * 60 * 1000 });
  if (buildTools.status !== 0) throw new Error('SELF_CHECK_FRONTEND_DEPENDENCIES_FAILED');
}
