// The constitution-lint gate (framework-seed/gates.json) — "PostgreSQL with
// pgvector, from the application foundation, is the only database"
// (docs/features/app-foundation.md). Ratchets: the gate sits in EVERY build
// tier, and the real POSIX sh script, run with `sh` against throwaway fixture
// repositories, catches each refused engine in every form a build writes it —
// import, require, dynamic import(), re-export, package.json dependency blocks,
// a DATABASE_URL literal — agrees with the JS classifier the finish guard uses,
// honours only the host-set MOCK2_DATABASE_EXCEPTION, and never fires on
// comments, docs or excluded trees. Generated apps drifted to SQLite because
// this gate ran in full builds only and read nothing but `src/` import lines.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseGateScripts, gateTier, gatesForProfile, buildGateBattery, gateStatusFromOutput,
} from '../mock2/cycle-logic.js';
import { classifyEngineSpecifier, sourceEngineHits, packageEngineHits } from '../mock2/database-exception-logic.js';

const gates = parseGateScripts(await readFile(new URL('../mock2/framework-seed/gates.json', import.meta.url), 'utf8'));
const lint = gates.find((g) => g.name === 'constitution-lint');
const HAVE_SH = spawnSync('sh', ['-c', 'exit 0']).status === 0;

// Every engine the rule refuses, as a build would write it. `family` sqlite is
// what a recorded exception allows; the rest are refused whatever is recorded.
const ENGINES = [
  ['sqlite3', 'sqlite'], ['better-sqlite3', 'sqlite'], ['node:sqlite', 'sqlite'], ['bun:sqlite', 'sqlite'],
  ['sqlite', 'sqlite'], ['@libsql/client', 'sqlite'], ['libsql', 'sqlite'], ['sql.js', 'sqlite'],
  ['drizzle-orm/better-sqlite3', 'sqlite'], ['drizzle-orm/libsql', 'sqlite'], ['drizzle-orm/sqlite-core', 'sqlite'],
  ['drizzle-orm/bun-sqlite', 'sqlite'], ['drizzle-orm/sql-js', 'sqlite'], ['drizzle-orm/expo-sqlite', 'sqlite'],
  ['drizzle-orm/op-sqlite', 'sqlite'], ['drizzle-orm/d1', 'sqlite'], ['drizzle-orm/sqlite-proxy', 'sqlite'],
  ['@electric-sql/pglite', 'other'], ['drizzle-orm/pglite', 'other'],
  ['mysql2', 'other'], ['mysql2/promise', 'other'], ['drizzle-orm/mysql-core', 'other'],
  ['mongoose', 'other'], ['mongodb', 'other'], ['typeorm', 'other'], ['sequelize', 'other'],
  ['prisma', 'other'], ['@prisma/client', 'other'], ['knex', 'other'],
];
// Package names (for the dependency blocks): bare module ids only.
const PACKAGES = ENGINES.filter(([s]) => !s.includes(':') && !/^drizzle-orm\//.test(s) && s !== 'mysql2/promise');

async function fixture(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'cl-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [p, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), content);
  }
  return dir;
}

const HAVE_GIT = spawnSync('git', ['--version']).status === 0;

function git(dir, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function commitAll(dir) {
  if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir }).status !== 0) git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'state');
}
async function committed(t, files) {
  const dir = await fixture(t, files);
  commitAll(dir);
  return dir;
}

function runGate(dir, env = {}) {
  const r = spawnSync('sh', ['-c', lint.script], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { code: r.status, out, status: gateStatusFromOutput(r.status, out) };
}

const PKG = JSON.stringify({ name: 'app', dependencies: { pg: '^8', 'drizzle-orm': '^0.44', zod: '^3' } }, null, 2);

// ---- tiers ----

test('constitution-lint is declared for the quick tier and lands in EVERY build tier', () => {
  assert.ok(lint, 'the seed still ships constitution-lint');
  assert.equal(lint.tier, 'quick', 'declared in gates.json, carried through parseGateScripts');
  for (const mode of ['quick', 'mvp', 'full']) {
    const battery = buildGateBattery(gates, mode);
    const g = battery.gates.find((x) => x.name === 'constitution-lint');
    assert.ok(g, `constitution-lint runs in the ${mode} battery`);
    assert.ok(!g.advisory, `constitution-lint blocks in the ${mode} battery`);
    assert.equal(g.profile, battery.profile, 'the battery profile rides on the gate (MOCK2_GATE_PROFILE)');
  }
  // The quick lane escalated to mvp keeps it too.
  assert.ok(buildGateBattery(gates, 'quick', { changedFiles: ['public/app.js'] }).gates.some((g) => g.name === 'constitution-lint'));
  // A framework version that lost the field still puts it in every tier, by name.
  const untagged = { name: 'constitution-lint', script: '#', order: 2 };
  assert.equal(gateTier(untagged), 'quick');
  for (const p of ['quick', 'mvp', 'full']) assert.equal(gatesForProfile([untagged], p).length, 1);
});

test('the gate script is POSIX sh and keeps the existing constitution checks', () => {
  assert.match(lint.script, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(lint.script, /(?:^|\s)\[\[\s|\bfunction\s+\w+\s*\{|<<<|\$\{[^}]*\/\/|\bdeclare\s|\blocal\s|\bxargs\s+-0|\bgrep\s+-[A-Za-z]*[oP]/m, 'no bashisms or GNU-only flags');
  assert.match(lint.script, /node_modules\/\.bin\/eslint \./, 'the ESLint run stays');
  assert.match(lint.script, /hard-coded role string literal/, 'the role-literal check stays');
  assert.match(lint.script, /MOCK2_DATABASE_EXCEPTION/);
  assert.match(lint.script, /a build cannot\./);
  if (HAVE_SH) {
    const r = spawnSync('sh', ['-n', '-c', lint.script]);
    assert.equal(r.status, 0, `sh -n: ${r.stderr}`);
  }
});

// ---- the engines, through the real script ----

test('the sh gate catches every refused engine as import / require / import() / re-export, and agrees with the JS classifier', { skip: !HAVE_SH }, async (t) => {
  const forms = [
    (s) => `import db from '${s}';\n`,
    (s) => `const db = require("${s}");\n`,
    (s) => `export async function open() { return import(\`${s}\`); }\n`,
    (s) => `export * from '${s}';\n`,
    (s) => `import type { X } from "${s}";\n`,
  ];
  for (const [spec, family] of ENGINES) {
    const c = classifyEngineSpecifier(spec);
    assert.ok(c, `JS classifier refuses ${spec}`);
    assert.equal(c.family, family, `${spec} family`);
    for (const [i, form] of forms.entries()) {
      const src = form(spec);
      assert.ok(sourceEngineHits('src/db.ts', src).length >= 1, `JS scan sees ${spec} (form ${i})`);
      const dir = await fixture(t, { 'package.json': PKG, 'src/db.ts': src });
      const r = runGate(dir);
      assert.equal(r.code, 1, `${spec} (form ${i}) must fail:\n${r.out}`);
      assert.match(r.out, /constitution-lint: FAIL — PostgreSQL \(with pgvector, from the application foundation\) is the only application database \(constitution §2\)\. Found: /);
      assert.ok(r.out.includes(`src/db.ts:1 ${spec} (`), `names the file, line and engine for ${spec}:\n${r.out}`);
      assert.match(r.out, /If the user explicitly asked for SQLite, they record it on the project \(Dev Studio → Foundation → Database exception\); a build cannot\./);
      // The exception allows the SQLite family and nothing else.
      const ex = runGate(dir, { MOCK2_DATABASE_EXCEPTION: 'sqlite' });
      if (family === 'sqlite') {
        assert.equal(ex.code, 0, `${spec} allowed by the recorded request:\n${ex.out}`);
        assert.equal(ex.status, 'passed');
        assert.match(ex.out, /SQLite allowed for this project by the user's recorded request/);
      } else {
        assert.equal(ex.code, 1, `${spec} is refused even with a SQLite exception`);
      }
    }
  }
});

test('the sh gate reads dependencies, devDependencies and optionalDependencies of every package.json — pretty or minified', { skip: !HAVE_SH }, async (t) => {
  for (const [name, family] of PACKAGES) {
    for (const block of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const doc = { name: 'app', scripts: { start: 'node dist/server.js' }, [block]: { pg: '^8', [name]: '^1.0.0' } };
      for (const text of [JSON.stringify(doc, null, 2), JSON.stringify(doc)]) {
        assert.ok(packageEngineHits('package.json', text).some((h) => h.name === name), `JS sees ${block}.${name}`);
        const dir = await fixture(t, { 'package.json': text, 'src/index.ts': 'export const ok = 1;\n' });
        const r = runGate(dir);
        assert.equal(r.code, 1, `${block}.${name} must fail:\n${r.out}`);
        assert.ok(r.out.includes(`package.json dependency ${name} (`), r.out);
        assert.equal(runGate(dir, { MOCK2_DATABASE_EXCEPTION: 'sqlite' }).code, family === 'sqlite' ? 0 : 1, `${name} with the exception`);
      }
    }
  }
  // A nested workspace manifest is read too; node_modules never is.
  const nested = await fixture(t, {
    'package.json': PKG, 'src/index.ts': 'export {};\n',
    'server/package.json': JSON.stringify({ dependencies: { 'better-sqlite3': '11' } }),
    'node_modules/x/package.json': JSON.stringify({ dependencies: { sqlite3: '5' } }),
  });
  const r = runGate(nested);
  assert.equal(r.code, 1);
  assert.match(r.out, /server\/package\.json dependency better-sqlite3 \(SQLite\)/);
  assert.doesNotMatch(r.out, /node_modules/);
});

test('names in other package.json fields, comments, docs, strings and relative files are not engines', { skip: !HAVE_SH }, async (t) => {
  const dir = await fixture(t, {
    'package.json': JSON.stringify({
      name: 'sqlite-free-app', description: 'moved off sqlite3 to Postgres', keywords: ['sqlite', 'mongodb'],
      scripts: { 'db:old': 'sqlite3 old.db .dump' }, dependencies: { pg: '^8', 'drizzle-orm': '^0.44' },
    }, null, 2),
    'src/db.ts': [
      "import { drizzle } from 'drizzle-orm/node-postgres';",
      "import pg from 'pg';",
      "import { pgTable } from 'drizzle-orm/pg-core';",
      "import { store } from './sqlite-store.js';",
      '// we used to import Database from "better-sqlite3" here',
      "/* import Database from 'better-sqlite3' */",
      " * require('sqlite3') in the old version",
      "const note = 'moved from \"sqlite file\" storage';",
      "const url = process.env.DATABASE_URL ?? 'postgres:///app?host=/run/mock2-foundation/postgres&user=app';",
    ].join('\n'),
    'docs/history.md': "We used `import Database from 'better-sqlite3'` before.\n",
    'README.md': 'DATABASE_URL=file:./dev.db was the old setup.\n',
    '.env.example': '# DATABASE_URL=sqlite:./old.db\nDATABASE_URL=postgres:///app?host=/run/mock2-foundation/postgres&user=app\n',
    'state/notes.js': "import x from 'better-sqlite3';\n",
    'dist/server.js': "const x = require('sqlite3');\n",
    'build/a.js': "const x = require('sqlite3');\n",
    'coverage/a.js': "const x = require('sqlite3');\n",
  });
  const r = runGate(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.status, 'passed');
  assert.match(r.out, /constitution-lint: OK/);
});

test('DATABASE_URL set to a sqlite: or file: URL is refused in source, env files, YAML and npm scripts', { skip: !HAVE_SH }, async (t) => {
  const cases = {
    'src/config.ts': "export const url = process.env.DATABASE_URL || 'file:./dev.db';\n",
    '.env.example': 'DATABASE_URL=sqlite:./app.db\n',
    'mock2.yaml': 'run:\n  env:\n    DATABASE_URL: "file:/srv/app/data/app.db"\n',
  };
  for (const [path, content] of Object.entries(cases)) {
    const dir = await fixture(t, { 'package.json': PKG, 'src/index.ts': 'export {};\n', [path]: content });
    const r = runGate(dir);
    assert.equal(r.code, 1, `${path}:\n${r.out}`);
    assert.match(r.out, /DATABASE_URL is a SQLite \(sqlite:\/file:\) URL/);
    assert.equal(runGate(dir, { MOCK2_DATABASE_EXCEPTION: 'sqlite' }).code, 0);
  }
  const npm = await fixture(t, {
    'package.json': JSON.stringify({ name: 'a', scripts: { dev: 'DATABASE_URL=file:./dev.db tsx src/server.ts' } }, null, 2),
    'src/index.ts': 'export {};\n',
  });
  assert.equal(runGate(npm).code, 1);
});

test('only the exact value "sqlite" excepts anything; the variable is the platform\'s, not a file\'s', { skip: !HAVE_SH }, async (t) => {
  const dir = await fixture(t, {
    'package.json': PKG, 'src/db.ts': "import Database from 'better-sqlite3';\n",
    '.env': 'MOCK2_DATABASE_EXCEPTION=sqlite\n', 'mock2.yaml': 'env:\n  MOCK2_DATABASE_EXCEPTION: sqlite\n',
  });
  assert.equal(runGate(dir).code, 1, 'a repo file cannot set it');
  for (const v of ['SQLITE', 'yes', '1', 'sqlite3', ' sqlite']) assert.equal(runGate(dir, { MOCK2_DATABASE_EXCEPTION: v }).code, 1, v);
  assert.equal(runGate(dir, { MOCK2_DATABASE_EXCEPTION: 'sqlite' }).code, 0);
});

test('src/ without a package.json does not pass silently; an empty project still skips; a root server.js is still read', { skip: !HAVE_SH }, async (t) => {
  const nopkg = await fixture(t, { 'src/index.ts': 'export const a = 1;\n' });
  const r = runGate(nopkg);
  assert.equal(r.code, 1);
  assert.match(r.out, /src\/ exists but there is no package\.json/);

  const empty = await fixture(t, { 'serve.py': 'print(1)\n' });
  const e = runGate(empty);
  assert.equal(e.code, 0);
  assert.equal(e.status, 'skipped');

  const rootjs = await fixture(t, { 'server.js': "const sqlite3 = require('sqlite3');\n" });
  assert.equal(runGate(rootjs).code, 1, 'no package.json and no src/ is no excuse for a SQLite import');
});

// The ESLint branch is the pre-existing one, kept as it was: its
// `ls .eslintrc* eslint.config.*` probe succeeds only when BOTH kinds of config
// exist (ls fails on any missing operand), so the fixture carries both.
test('eslint blocks only in the full tier; quick and mvp report it as advisory (MOCK2_GATE_PROFILE)', { skip: !HAVE_SH }, async (t) => {
  const dir = await fixture(t, {
    'package.json': PKG, 'src/index.ts': 'export {};\n', 'eslint.config.js': 'export default [];\n', '.eslintrc.json': '{}\n',
    'node_modules/.bin/eslint': '#!/bin/sh\necho "1:1 error fake lint finding"\nexit 1\n',
  });
  await chmod(join(dir, 'node_modules/.bin/eslint'), 0o755);
  assert.equal(runGate(dir).code, 1, 'unset → full (the old behaviour)');
  assert.equal(runGate(dir, { MOCK2_GATE_PROFILE: 'full' }).code, 1);
  for (const p of ['quick', 'mvp']) {
    const r = runGate(dir, { MOCK2_GATE_PROFILE: p });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`WARNING - eslint reported problems \\(advisory in the ${p} tier`));
  }
  // The database check blocks in every tier.
  await writeFile(join(dir, 'src/db.ts'), "import Database from 'better-sqlite3';\n");
  for (const p of ['quick', 'mvp', 'full']) assert.equal(runGate(dir, { MOCK2_GATE_PROFILE: p }).code, 1, p);
});

// ---- the foundation adapters (constitution §2 rule 5) ----

const ON_FOUNDATION = { 'foundation/bin/foundation.mjs': '// the platform-owned CLI\n' };
const FOUNDATION_PKG = JSON.stringify({ name: 'app', dependencies: { pg: '^8', '@aws-sdk/client-s3': '^3', '@aws-sdk/lib-storage': '^3' } }, null, 2);

test('on the foundation: a direct S3 client or embeddings call outside foundation/ is refused in every tier, pointing at the adapters', { skip: !HAVE_SH }, async (t) => {
  const cases = [
    ["import { S3Client } from '@aws-sdk/client-s3';", 'imports @aws-sdk/client-s3'],
    ["import { Upload } from '@aws-sdk/lib-storage';", 'imports @aws-sdk/lib-storage'],
    ["const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');", 'imports @aws-sdk/s3-request-presigner'],
    ["const Minio = await import('minio');", 'imports minio'],
    ['const r = await fetch(`${base}/v1/embeddings`, { method: "POST" });', 'calls an embeddings API URL (/v1/embeddings)'],
    ["const url = 'https://api.openai.com/v1/embeddings';", 'calls an embeddings API URL (/v1/embeddings)'],
    ["const r = await fetch(process.env.EMBED_BASE + '/embeddings', { method: 'POST' });", 'requests an /embeddings URL'],
    ['const out = await openai.embeddings.create({ model, input });', 'calls an SDK embeddings API'],
  ];
  for (const [line, what] of cases) {
    const dir = await fixture(t, { ...ON_FOUNDATION, 'package.json': FOUNDATION_PKG, 'src/features/files.ts': `// feature code\n${line}\n` });
    for (const p of ['quick', 'mvp', 'full']) {
      const r = runGate(dir, { MOCK2_GATE_PROFILE: p });
      assert.equal(r.code, 1, `${line} (${p}): ${r.out}`);
      assert.match(r.out, /only through the foundation adapters \(constitution §2 rule 5\)/);
      assert.match(r.out, /from '#foundation'/);
      assert.ok(r.out.includes(`src/features/files.ts:2 ${what}`), `${line}: ${r.out}`);
    }
  }
});

test('the adapters check reads only source outside foundation/: the SDK deps, the adapters, comments, the app\'s own /api routes and pre-foundation apps pass', { skip: !HAVE_SH }, async (t) => {
  const ok = await fixture(t, {
    ...ON_FOUNDATION,
    'package.json': FOUNDATION_PKG,
    'foundation/runtime/storage.mjs': "const s3 = await import('@aws-sdk/client-s3');\n",
    'foundation/runtime/embeddings.mjs': "const r = await fetch(base + '/embeddings', { method: 'POST' });\n",
    'src/features/files.ts': "import { storage, embeddings } from '#foundation';\n// never: import { S3Client } from '@aws-sdk/client-s3' or fetch('/v1/embeddings')\n/* fetch(`${base}/v1/embeddings`) */\nexport const list = () => fetch('/api/embeddings');\n",
    'src/routes/search.ts': "router.post('/embeddings', handler);\n",
    'README.md': 'Never call /v1/embeddings directly; @aws-sdk/client-s3 is the adapter\'s.\n',
  });
  const r = runGate(ok);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /constitution-lint: OK/);

  // An app from before the foundation (no foundation/bin/foundation.mjs) is not judged by this rule.
  const legacy = await fixture(t, { 'package.json': FOUNDATION_PKG, 'src/files.ts': "import { S3Client } from '@aws-sdk/client-s3';\n" });
  const l = runGate(legacy);
  assert.equal(l.code, 0, l.out);
});

test('the seeded scaffold (buildSeedFiles) passes the gate as it is written', { skip: !HAVE_SH }, async (t) => {
  const { buildSeedFiles } = await import('../mock2/template.js');
  const seed = buildSeedFiles({ name: 'Demo App' });
  assert.ok(seed.some((f) => f.path === 'foundation/bin/foundation.mjs'), 'the seed carries the foundation, so the adapters rule applies');
  const dir = await fixture(t, Object.fromEntries(seed.map((f) => [f.path, f.content])));
  const r = runGate(dir);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /constitution-lint: OK/);
  // As the platform runs it for a project on the foundation, in every tier, committed or not.
  for (const p of ['quick', 'mvp', 'full']) {
    const f = runGate(dir, { MOCK2_FOUNDATION: '1', MOCK2_GATE_PROFILE: p });
    assert.equal(f.code, 0, `${p}: ${f.out}`);
    assert.match(f.out, /constitution-lint: OK/);
    assert.doesNotMatch(f.out, /WARNING|FAIL/);
  }
  if (HAVE_GIT) {
    commitAll(dir);
    for (const p of ['quick', 'mvp', 'full']) assert.equal(runGate(dir, { MOCK2_FOUNDATION: '1', MOCK2_GATE_PROFILE: p }).code, 0, p);
  }
});

// ---- apps from before the foundation (MOCK2_FOUNDATION=0, from projects.foundation_version) ----
//
// The review finding: constitution-lint moved to every tier and reads the whole
// repository, so an app created before the foundation with a pre-existing
// sqlite3 devDependency, knex / prisma, drizzle's sqlite-core or
// DATABASE_URL=file: failed every quick and MVP build where it used to pass.
// Now: what such an app already has at HEAD is an advisory, the full build
// keeps exactly the refusals it had before, and what a build ADDS blocks in
// every tier (and at finish, on the host).

const LEGACY = { MOCK2_FOUNDATION: '0' };

// The database refusal constitution-lint had before the application foundation
// (gates.json before 2026-10-24), verbatim: in the full build, the ONLY one an
// app from before the foundation is held to for what it already has.
const PRE_FOUNDATION_DB_CHECK = `if [ ! -f package.json ] && [ ! -d src ]; then exit 0; fi
if [ -d src ]; then
  hits=$(grep -REln "(from|require)[^\\n]*(mysql2|better-sqlite3|sqlite3|mongoose|mongodb|typeorm|sequelize|prisma|knex)" src 2>/dev/null)
  if [ -n "$hits" ]; then exit 1; fi
fi
exit 0
`;

// What legacy apps really carry. `old` is what the pre-foundation check said.
const LEGACY_APPS = {
  'a sqlite3 devDependency': [{ 'package.json': JSON.stringify({ name: 'a', dependencies: { pg: '8' }, devDependencies: { sqlite3: '5' } }, null, 2), 'src/index.ts': 'export {};\n' }, 0],
  'knex and prisma dependencies': [{ 'package.json': JSON.stringify({ name: 'a', dependencies: { knex: '3', prisma: '5', '@prisma/client': '5' } }, null, 2), 'src/index.ts': 'export {};\n' }, 0],
  "drizzle's sqlite-core": [{ 'package.json': PKG, 'src/schema.ts': "import { sqliteTable, text } from 'drizzle-orm/sqlite-core';\n" }, 0],
  'DATABASE_URL=file:': [{ 'package.json': PKG, 'src/index.ts': 'export {};\n', '.env.example': 'DATABASE_URL=file:./dev.db\n' }, 0],
  'node:sqlite': [{ 'package.json': PKG, 'src/db.ts': "import { DatabaseSync } from 'node:sqlite';\n" }, 0],
  'a dynamic import of mongoose': [{ 'package.json': PKG, 'src/db.ts': "export const open = () => import('mongoose');\n" }, 0],
  'sqlite3 outside src/': [{ 'package.json': PKG, 'src/index.ts': 'export {};\n', 'server/db.js': "const sqlite3 = require('sqlite3');\n" }, 0],
  'a better-sqlite3 import under src/': [{ 'package.json': PKG, 'src/db.ts': "import Database from 'better-sqlite3';\n" }, 1],
  'a knex require under src/': [{ 'package.json': PKG, 'src/db.js': "const knex = require('knex')({ client: 'pg' });\n" }, 1],
  'a @prisma/client import under src/': [{ 'package.json': PKG, 'src/db.ts': "import { PrismaClient } from '@prisma/client';\n" }, 1],
  'a mysql2/promise import under src/': [{ 'package.json': PKG, 'src/db.ts': "import mysql from 'mysql2/promise';\n" }, 1],
};

test('an app from before the foundation: what it already has is an advisory below the full build, and the full build refuses exactly what it refused before', { skip: !HAVE_SH || !HAVE_GIT }, async (t) => {
  for (const [label, [files, old]] of Object.entries(LEGACY_APPS)) {
    const dir = await committed(t, files);
    const before = spawnSync('sh', ['-c', PRE_FOUNDATION_DB_CHECK], { cwd: dir, encoding: 'utf8' }).status;
    assert.equal(before, old, `${label}: the pre-foundation check said ${old}`);
    for (const p of ['quick', 'mvp']) {
      const r = runGate(dir, { ...LEGACY, MOCK2_GATE_PROFILE: p });
      assert.equal(r.code, 0, `${label} (${p}) must not block:\n${r.out}`);
      assert.equal(r.status, 'passed');
      assert.match(r.out, /constitution-lint: WARNING \(advisory, does not block this build\) — this app was created before the application foundation/, `${label} (${p})`);
      assert.match(r.out, /Already in the app: /);
      assert.match(r.out, /Moving this app onto the foundation is a separate, explicit step that no build takes on its own: its data access is rewritten to PostgreSQL through Drizzle \(DATABASE_URL from the environment\), its data is moved into the foundation's PostgreSQL, and the foundation runtime and stack are installed\./);
      assert.match(r.out, /a build that adds another engine is refused/);
    }
    const full = runGate(dir, { ...LEGACY, MOCK2_GATE_PROFILE: 'full' });
    assert.equal(full.code, before, `${label}: the full build behaves as before the foundation:\n${full.out}`);
    if (old === 0) assert.match(full.out, /WARNING \(advisory, does not block this build\)/, `${label}: still reported in the full build`);
    else assert.match(full.out, /constitution-lint: FAIL — PostgreSQL via Drizzle is the only application database \(constitution §2\)\. Found: src\/db\.[jt]s:1 /);
    // The same repository on the foundation: refused in every tier.
    for (const p of ['quick', 'mvp', 'full']) {
      const f = runGate(dir, { MOCK2_FOUNDATION: '1', MOCK2_GATE_PROFILE: p });
      assert.equal(f.code, 1, `${label} on the foundation (${p}) is refused:\n${f.out}`);
      assert.match(f.out, /constitution-lint: FAIL — PostgreSQL \(with pgvector, from the application foundation\) is the only application database/);
      assert.doesNotMatch(f.out, /created before the application foundation/);
    }
  }
});

test('an app from before the foundation: an engine this build ADDS (not at HEAD) blocks in every tier, beside the advisory for the old one', { skip: !HAVE_SH || !HAVE_GIT }, async (t) => {
  const added = {
    'a new import': ['src/store.ts', "import mysql from 'mysql2';\n", 'src/store.ts:1 mysql2 (MySQL)'],
    'a new dependency': ['package.json', JSON.stringify({ name: 'a', dependencies: { pg: '8', mongoose: '8' }, devDependencies: { sqlite3: '5' } }, null, 2), 'package.json dependency mongoose (MongoDB)'],
    'a new DATABASE_URL': ['.env.example', 'DATABASE_URL=sqlite:./app.db\n', '.env.example:1 DATABASE_URL is a SQLite'],
    'a new SQLite import': ['src/cache.ts', "import { sqliteTable } from 'drizzle-orm/sqlite-core';\n", 'src/cache.ts:1 drizzle-orm/sqlite-core (SQLite)'],
  };
  for (const [label, [path, content, named]] of Object.entries(added)) {
    const dir = await committed(t, { 'package.json': JSON.stringify({ name: 'a', dependencies: { pg: '8' }, devDependencies: { sqlite3: '5' } }, null, 2), 'src/index.ts': 'export {};\n' });
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
    for (const p of ['quick', 'mvp', 'full']) {
      const r = runGate(dir, { ...LEGACY, MOCK2_GATE_PROFILE: p });
      assert.equal(r.code, 1, `${label} (${p}):\n${r.out}`);
      const fail = r.out.split('\n').find((l) => l.startsWith('constitution-lint: FAIL'));
      assert.ok(fail && fail.includes(named), `${label} (${p}) names it: ${r.out}`);
      assert.match(fail, /This app was created before the application foundation/);
      assert.match(fail, /a build cannot\./);
      const warn = r.out.split('\n').find((l) => l.startsWith('constitution-lint: WARNING (advisory'));
      assert.ok(warn && warn.includes('package.json dependency sqlite3 (SQLite)'), `${label} (${p}): the old devDependency stays an advisory: ${r.out}`);
      assert.ok(!warn.includes(named), `${label} (${p}): the new one is not an advisory`);
    }
    // Once it is committed it is the app's own — the host's finish check is what stops a build committing it.
    commitAll(dir);
    assert.equal(runGate(dir, { ...LEGACY, MOCK2_GATE_PROFILE: 'quick' }).code, 0, `${label}: at HEAD it is an advisory`);
  }
});

test('an app from before the foundation: the SQLite exception still allows SQLite, in the full build too; no git checkout means everything found is reported, not added', { skip: !HAVE_SH || !HAVE_GIT }, async (t) => {
  const dir = await committed(t, { 'package.json': PKG, 'src/db.ts': "import Database from 'better-sqlite3';\nimport mysql from 'mysql2';\n" });
  const r = runGate(dir, { ...LEGACY, MOCK2_GATE_PROFILE: 'full', MOCK2_DATABASE_EXCEPTION: 'sqlite' });
  assert.equal(r.code, 1, 'mysql2 under src/ is still refused in the full build');
  assert.match(r.out, /SQLite allowed for this project by the user's recorded request[^\n]*src\/db\.ts:1 better-sqlite3/);
  assert.doesNotMatch(r.out.split('\n').find((l) => l.includes('FAIL')), /better-sqlite3/);
  await writeFile(join(dir, 'src/db.ts'), "import Database from 'better-sqlite3';\n");
  commitAll(dir);
  assert.equal(runGate(dir, { ...LEGACY, MOCK2_GATE_PROFILE: 'full', MOCK2_DATABASE_EXCEPTION: 'sqlite' }).code, 0);

  const plain = await fixture(t, { 'package.json': JSON.stringify({ name: 'a', devDependencies: { sqlite3: '5' } }), 'src/db.ts': "import Database from 'better-sqlite3';\n" });
  const q = runGate(plain, { ...LEGACY, MOCK2_GATE_PROFILE: 'quick' });
  assert.equal(q.code, 0, q.out);
  assert.match(q.out, /Already in the app: [^\n]*src\/db\.ts:1 better-sqlite3[^\n]*package\.json dependency sqlite3/);
  assert.equal(runGate(plain, { ...LEGACY, MOCK2_GATE_PROFILE: 'full' }).code, 1, 'the pre-foundation refusal holds without git too');
});

test('an app from before the foundation: src/ without a package.json is reported, not refused (the check did not exist for it)', { skip: !HAVE_SH }, async (t) => {
  const dir = await fixture(t, { 'src/main.py': 'print(1)\n' });
  for (const p of ['quick', 'mvp', 'full']) {
    const r = runGate(dir, { ...LEGACY, MOCK2_GATE_PROFILE: p });
    assert.equal(r.code, 0, `${p}: ${r.out}`);
    assert.match(r.out, /WARNING \(advisory\) — src\/ exists but there is no package\.json[^\n]*created before the application foundation/);
    assert.equal(runGate(dir, { MOCK2_FOUNDATION: '1', MOCK2_GATE_PROFILE: p }).code, 1, `${p} on the foundation`);
  }
});

test('the adapters rule (rule 5) is for projects on the foundation only, as the host says — not as a file in the repository says', { skip: !HAVE_SH }, async (t) => {
  const s3 = "import { S3Client } from '@aws-sdk/client-s3';\n";
  // The host says "before the foundation": a copied foundation CLI does not bring rule 5 with it.
  const legacy = await fixture(t, { ...ON_FOUNDATION, 'package.json': FOUNDATION_PKG, 'src/files.ts': s3 });
  for (const p of ['quick', 'mvp', 'full']) {
    const r = runGate(legacy, { ...LEGACY, MOCK2_GATE_PROFILE: p });
    assert.equal(r.code, 0, `${p}: ${r.out}`);
    assert.doesNotMatch(r.out, /rule 5/);
  }
  // The host says "on the foundation": deleting the CLI does not switch rule 5 off.
  const noMarker = await fixture(t, { 'package.json': FOUNDATION_PKG, 'src/files.ts': s3 });
  for (const p of ['quick', 'mvp', 'full']) {
    const r = runGate(noMarker, { MOCK2_FOUNDATION: '1', MOCK2_GATE_PROFILE: p });
    assert.equal(r.code, 1, `${p}: ${r.out}`);
    assert.match(r.out, /only through the foundation adapters \(constitution §2 rule 5\)[^\n]*src\/files\.ts:1 imports @aws-sdk\/client-s3/);
  }
  // Run by hand (no MOCK2_FOUNDATION): the marker decides, as before.
  assert.equal(runGate(legacy).code, 1);
  assert.equal(runGate(noMarker).code, 0);
  // Only the exact values count; anything else is the by-hand behaviour, never "before the foundation".
  const engine = await fixture(t, { 'package.json': JSON.stringify({ name: 'a', devDependencies: { sqlite3: '5' } }), 'src/index.ts': 'export {};\n' });
  for (const v of ['', 'no', 'false', '00', ' 0']) assert.equal(runGate(engine, { MOCK2_FOUNDATION: v, MOCK2_GATE_PROFILE: 'quick' }).code, 1, JSON.stringify(v));
});
