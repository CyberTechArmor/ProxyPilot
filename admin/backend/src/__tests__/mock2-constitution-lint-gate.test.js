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
