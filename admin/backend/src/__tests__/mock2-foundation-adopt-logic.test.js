// Application foundation ADOPTION — the pure half (mock2/foundation-adopt-logic.js):
//   * the twelve steps, ids and snapshot names;
//   * package.json: a pre-foundation scaffold merges into exactly the entries a
//     NEW foundation app has; idempotent; unknown shapes refused;
//   * facts → blockers (each with a plain next step), warnings, the plan shape
//     the dashboard builds against, and the token (what the plan IS, not its
//     sizes);
//   * the guest scripts, run for real where the sandbox can (the probe, the
//     environment rewrite, the platform commit against a scratch repository);
//   * the run's projection: exact keys, rollback / resume availability.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import * as L from '../mock2/foundation-adopt-logic.js';
import { buildScaffoldFiles, scaffoldFoundationFiles } from '../mock2/scaffold.js';
import { FOUNDATION_DEPENDENCIES, FOUNDATION_NODE_IMPORT } from '../mock2/scaffold-foundation.js';
import { FOUNDATION_GUEST_CONFIG } from '../mock2/foundation-stack-logic.js';
import { SNAPSHOT_NAME_RE } from '../lib/setup-engine/lifecycle-logic.js';
import { buildSeedPayload } from '../mock2/seed-tar.js';

const ID = 'fa_0123456789abcdef';

// A package.json as the scaffold wrote it before the foundation (v7): the new
// scaffold's file with the foundation entries taken out again.
function legacyPackageJson() {
  const pkg = JSON.parse(buildScaffoldFiles({ name: 'Demo' }).find((f) => f.path === 'package.json').content);
  pkg.scripts.start = pkg.scripts.start.replace(` ${FOUNDATION_NODE_IMPORT}`, '');
  pkg.scripts.dev = pkg.scripts.dev.replace(` ${FOUNDATION_NODE_IMPORT}`, '');
  delete pkg.scripts.foundation;
  delete pkg.imports;
  for (const k of Object.keys(FOUNDATION_DEPENDENCIES)) delete pkg.dependencies[k];
  return `${JSON.stringify(pkg, null, 2)}\n`;
}
const newPackage = () => JSON.parse(buildScaffoldFiles({ name: 'Demo' }).find((f) => f.path === 'package.json').content);

// Facts of a clean legacy project that can be adopted.
function cleanFacts(over = {}) {
  const base = {
    project: { id: 7, lifecycle: 'active', container_name: 'm2-7', foundation_version: null },
    adoption: null,
    lock: { holder: null },
    busy: { deploy: false, setupLease: false, baseAppDeploying: false, provisioning: false },
    instance: { type: 'container', status: 'Running', config: {}, snapshots: [], customVolumes: 0 },
    components: { secretKeys: ['AUTH_MASTER_SECRET', 'SESSION_SECRET', 'SMTP_PASSWORD'] },
    guest: {
      complete: true,
      pkg: { present: true, text: legacyPackageJson() },
      manifest: true, foundationDir: false, stackPresent: false,
      git: { head: 'a'.repeat(40), remote: 'a'.repeat(40), remoteInHead: true, ahead: 0, dirty: [] },
      envKeys: ['AUTH_MASTER_SECRET', 'DATABASE_URL', 'PATH', 'SESSION_SECRET'],
      diskFreeBytes: 40 * 1024 ** 3,
      engineHits: [], s3Direct: [],
      native: { state: 'ok', sizeBytes: 120 * 1024 ** 2, tables: ['public.health_checks', 'public.users'] },
    },
  };
  return deepMerge(base, over);
}
function deepMerge(a, b) {
  if (b === undefined) return a;
  if (b === null || typeof b !== 'object' || Array.isArray(b) || a === null || typeof a !== 'object' || Array.isArray(a)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = deepMerge(a[k], v);
  return out;
}
const codes = (facts) => L.adoptionBlockers(facts).map((b) => b.code);

test('the twelve steps, in order, each with a summary and a retry class', () => {
  assert.deepEqual(L.STEP_NAMES, ['snapshot', 'stop_app', 'dump_database', 'stop_native_database', 'docker_ready', 'install_runtime', 'start_foundation', 'restore_database', 'move_secrets', 'install_foundation_module', 'deploy', 'done']);
  for (const s of L.ADOPT_STEPS) {
    assert.ok(s.summary.length > 20, s.name);
    assert.ok(['safe', 'checked'].includes(s.retry), s.name);
  }
  assert.equal(L.stepRetry('restore_database'), 'checked', 'the restore re-checks its target first');
  assert.equal(L.stepIndex('deploy'), 10);
});

test('ids, snapshot names and the dump directory are what Incus and the guest accept', () => {
  assert.equal(L.newAdoptionId('0123456789ABCDEF99'), ID);
  assert.throws(() => L.newAdoptionId('abc'), /16 hex/);
  assert.equal(L.snapshotNameFor(ID), `pre-foundation-${ID}`);
  assert.match(L.snapshotNameFor(ID), SNAPSHOT_NAME_RE);
  assert.match(L.preRollbackSnapshotNameFor(ID), SNAPSHOT_NAME_RE);
  assert.equal(L.dumpDirFor(ID), `/var/lib/mock2-adopt/${ID}`);
  for (const bad of ['', 'fa_xyz', '../x', 'fa_0123456789abcdef; rm -rf /']) assert.throws(() => L.snapshotNameFor(bad), /invalid adoption id/);
});

test('package.json: a pre-foundation scaffold gets exactly the entries a new foundation app has; idempotent', () => {
  const merged = L.mergeFoundationPackageJson(legacyPackageJson());
  assert.equal(merged.ok, true, merged.error);
  assert.equal(merged.changed, true);
  const got = JSON.parse(merged.content);
  const want = newPackage();
  assert.equal(got.scripts.start, want.scripts.start);
  assert.equal(got.scripts.dev, want.scripts.dev);
  assert.equal(got.scripts.foundation, want.scripts.foundation);
  assert.deepEqual(got.imports, want.imports);
  assert.deepEqual(Object.fromEntries(Object.entries(got.dependencies).sort()), Object.fromEntries(Object.entries(want.dependencies).sort()));
  assert.deepEqual(got.devDependencies, want.devDependencies, 'nothing else changes');
  const again = L.mergeFoundationPackageJson(merged.content);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false, 'a second merge changes nothing');
  assert.equal(again.content, merged.content);
  // A new foundation app's own package.json is already complete.
  assert.equal(L.mergeFoundationPackageJson(JSON.stringify(want)).changed, false);
});

test('package.json: shapes the platform cannot take are refused with the reason', () => {
  const pkg = (scripts, extra = {}) => JSON.stringify({ scripts, dependencies: { pg: '^8' }, ...extra });
  assert.match(L.mergeFoundationPackageJson('{nope').error, /not valid JSON/);
  assert.match(L.mergeFoundationPackageJson(pkg({})).error, /no "start" script/);
  assert.match(L.mergeFoundationPackageJson(pkg({ start: 'bun run dist/server.js' })).error, /"start" script .* must start with "node "/);
  assert.match(L.mergeFoundationPackageJson(pkg({ start: 'node a.js', dev: 'nodemon src/x.ts' })).error, /"dev" script/);
  assert.match(L.mergeFoundationPackageJson(pkg({ start: 'node a.js', foundation: 'echo hi' })).error, /already has a "foundation" script/);
  assert.match(L.mergeFoundationPackageJson(pkg({ start: 'node a.js' }, { imports: { '#foundation': './lib/x.js' } })).error, /owns that alias/);
  const ok = L.mergeFoundationPackageJson(pkg({ start: 'node --enable-source-maps dist/server.js', dev: 'tsx src/server.ts' }));
  assert.equal(JSON.parse(ok.content).scripts.start, `node ${FOUNDATION_NODE_IMPORT} --enable-source-maps dist/server.js`);
  assert.equal(JSON.parse(ok.content).scripts.dev, `tsx ${FOUNDATION_NODE_IMPORT} src/server.ts`);
  // An existing dependency version wins.
  const pinned = L.mergeFoundationPackageJson(pkg({ start: 'node a.js' }, { dependencies: { pg: '^8', '@aws-sdk/client-s3': '3.0.0' } }));
  assert.equal(JSON.parse(pinned.content).dependencies['@aws-sdk/client-s3'], '3.0.0');
});

test('a clean legacy project has no blockers; the plan has the API shape and names only', () => {
  const facts = cleanFacts();
  assert.deepEqual(L.adoptionBlockers(facts), []);
  const plan = L.buildAdoptionPlan(facts);
  assert.deepEqual(Object.keys(plan).sort(), ['database', 'disk', 'downtime', 'features', 'secrets_to_move', 'steps', 'warnings']);
  assert.deepEqual(plan.steps.map((s) => Object.keys(s).sort()), L.STEP_NAMES.map(() => ['label', 'name', 'summary']));
  assert.deepEqual(plan.database, { size_bytes: 120 * 1024 ** 2, tables: 2 });
  assert.deepEqual(plan.disk, { free_bytes: 40 * 1024 ** 3, needed_bytes: 2 * 120 * 1024 ** 2 + L.IMAGE_ALLOWANCE_BYTES });
  assert.deepEqual(plan.secrets_to_move, ['AUTH_MASTER_SECRET', 'SESSION_SECRET'], 'installed component secrets present in the environment — SMTP_PASSWORD is not there');
  assert.deepEqual(plan.features, { storage: 'on', embeddings: 'on' });
  assert.match(plan.downtime, /^About \d+–\d+ minutes\. The app stops at step 2/);
  assert.match(plan.downtime, /120 MB/);
  const w = plan.warnings.map((x) => x.code);
  for (const c of ['LOCAL_EMBEDDINGS', 'DATABASE_URL_REMOVED', 'ROLLBACK_RESTORES_SNAPSHOT', 'OLD_DATABASE_KEPT']) assert.ok(w.includes(c), c);
  for (const x of plan.warnings) assert.deepEqual(Object.keys(x).sort(), ['code', 'message']);
});

test('blockers: each refusal is { code, message } with a next step', () => {
  const cases = [
    [{ project: { foundation_version: 'mock2-foundation-v1' } }, 'NOT_LEGACY_PROJECT'],
    [{ project: { lifecycle: 'stopped' } }, 'NOT_ONLINE'],
    [{ project: { container_name: null } }, 'NOT_ONLINE'],
    [{ instance: { status: 'Stopped' } }, 'NOT_ONLINE'],
    [{ lock: { holder: { type: 'cycle', id: 4 } } }, 'CHECKOUT_LOCK_HELD'],
    [{ busy: { deploy: true } }, 'DEPLOY_RUNNING'],
    [{ busy: { baseAppDeploying: true } }, 'DEPLOY_RUNNING'],
    [{ busy: { provisioning: true } }, 'DEPLOY_RUNNING'],
    [{ adoption: { state: 'running', step: 'deploy' } }, 'ADOPTION_RUNNING'],
    [{ adoption: { state: 'rolling_back', step: 'deploy' } }, 'ADOPTION_RUNNING'],
    [{ adoption: { state: 'failed', step: 'restore_database' } }, 'ADOPTION_UNFINISHED'],
    [{ instance: null }, 'GUEST_UNREACHABLE'],
    [{ guest: { complete: false } }, 'GUEST_UNREACHABLE'],
    [{ instance: { type: 'virtual-machine' } }, 'GUEST_NOT_CONTAINER'],
    [{ instance: { customVolumes: 2 } }, 'GUEST_HAS_CUSTOM_VOLUMES'],
    [{ guest: { pkg: { present: false, text: null } } }, 'NOT_MOCK2_APP'],
    [{ guest: { pkg: { text: '{oops' } } }, 'NOT_MOCK2_APP'],
    [{ guest: { pkg: { text: JSON.stringify({ scripts: { start: 'node a.js' }, dependencies: {} }) } } }, 'NOT_MOCK2_APP'],
    [{ guest: { pkg: { text: JSON.stringify({ scripts: { start: 'deno run a.ts' }, dependencies: { pg: '^8' } }) } } }, 'NOT_MOCK2_APP'],
    [{ guest: { manifest: false } }, 'NOT_MOCK2_APP'],
    [{ guest: { git: { head: null } } }, 'NOT_MOCK2_APP'],
    [{ guest: { pkg: { text: JSON.stringify({ scripts: { start: 'node a.js' }, dependencies: { pg: '^8', 'better-sqlite3': '^11' } }) } } }, 'APP_USES_SQLITE'],
    [{ guest: { engineHits: [{ path: 'src/db.ts', line: 3, name: 'node:sqlite', engine: 'SQLite', family: 'sqlite', key: 'spec:node:sqlite' }] } }, 'APP_USES_SQLITE'],
    [{ guest: { engineHits: [{ path: 'src/db.ts', line: 3, name: 'mongoose', engine: 'MongoDB', family: 'other', key: 'spec:mongoose' }] } }, 'APP_USES_OTHER_ENGINE'],
    [{ guest: { native: { state: 'no_database', sizeBytes: null, tables: [] } } }, 'NO_NATIVE_DATABASE'],
    [{ guest: { native: { state: 'unreachable', sizeBytes: null, tables: [] } } }, 'NO_NATIVE_DATABASE'],
    [{ guest: { native: { state: 'no_server', sizeBytes: null, tables: [] } } }, 'NO_NATIVE_DATABASE'],
    [{ guest: { diskFreeBytes: 2 * 1024 ** 3 } }, 'NOT_ENOUGH_DISK'],
    [{ guest: { diskFreeBytes: null } }, 'NOT_ENOUGH_DISK'],
    [{ guest: { git: { remoteInHead: false } } }, 'REPO_DIVERGED'],
    [{ guest: { git: { dirty: ['package.json'] } } }, 'PACKAGE_JSON_UNCOMMITTED'],
    [{ guest: { foundationDir: true } }, 'FOUNDATION_DIR_PRESENT'],
    [{ guest: { stackPresent: true } }, 'FOUNDATION_STACK_PRESENT'],
    [{ components: { secretKeys: ['lower_case_key'] }, guest: { envKeys: ['lower_case_key'] } }, 'SECRET_NAME_UNSUPPORTED'],
  ];
  for (const [over, code] of cases) {
    const list = L.adoptionBlockers(cleanFacts(over));
    const hit = list.find((b) => b.code === code);
    assert.ok(hit, `${code} for ${JSON.stringify(over).slice(0, 120)} (got ${list.map((b) => b.code).join(', ') || 'none'})`);
    assert.deepEqual(Object.keys(hit).sort(), ['code', 'message', 'next_step']);
    assert.match(hit.next_step, /\.$/, `${code} names a next step`);
    assert.ok(hit.message.endsWith(hit.next_step), `${code}: the message ends with the next step`);
  }
  // SQLite: says how to move data access first.
  const sqlite = L.adoptionBlockers(cleanFacts({ guest: { pkg: { text: JSON.stringify({ scripts: { start: 'node a.js' }, dependencies: { pg: '^8', sqlite3: '^5' } }) } } })).find((b) => b.code === 'APP_USES_SQLITE');
  assert.match(sqlite.next_step, /^Move that data access to PostgreSQL .* in a build, deploy it, then plan again\.$/);
  // A project that is not online is not probed: only the host-side blockers.
  assert.deepEqual(codes(cleanFacts({ project: { lifecycle: 'archived' }, guest: null, instance: undefined })), ['NOT_ONLINE']);
  assert.deepEqual(codes(cleanFacts({ project: { foundation_version: 'mock2-foundation-v1' }, guest: null })), ['NOT_LEGACY_PROJECT']);
});

test('warnings: direct S3 clients, uncommitted work and unpushed commits are named', () => {
  const w = L.adoptionWarnings(cleanFacts({ guest: { s3Direct: [{ path: 'src/files.ts', line: 2, name: '@aws-sdk/client-s3' }], git: { dirty: ['src/a.ts', 'src/b.ts'], ahead: 2 } } }));
  const by = Object.fromEntries(w.map((x) => [x.code, x.message]));
  assert.match(by.DIRECT_S3_CLIENT, /src\/files\.ts:2/);
  assert.match(by.DIRTY_WORKTREE, /2 uncommitted change\(s\)/);
  assert.match(by.UNPUSHED_COMMITS, /2 commit\(s\)/);
});

test('the plan token is what the plan IS: commits, tables, secrets, guest settings — not its sizes', () => {
  const t = L.planTokenOf(cleanFacts());
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(L.planTokenOf(cleanFacts()), t, 'stable');
  assert.equal(L.planTokenOf(cleanFacts({ guest: { diskFreeBytes: 1, native: { sizeBytes: 999 } } })), t, 'free space and size move while the app runs');
  for (const over of [
    { guest: { git: { head: 'b'.repeat(40) } } },
    { guest: { git: { remote: 'c'.repeat(40) } } },
    { guest: { native: { tables: ['public.users'] } } },
    { guest: { envKeys: ['AUTH_MASTER_SECRET'] } },
    { components: { secretKeys: ['AUTH_MASTER_SECRET', 'SESSION_SECRET', 'NEW_KEY'] }, guest: { envKeys: ['AUTH_MASTER_SECRET', 'SESSION_SECRET', 'NEW_KEY'] } },
    { instance: { config: { 'security.nesting': 'true' } } },
    { project: { container_name: 'm2-8' } },
  ]) assert.notEqual(L.planTokenOf(cleanFacts(over)), t, JSON.stringify(over));
  assert.equal(L.tokensEqual(t, t), true);
  assert.equal(L.tokensEqual(t, t.toUpperCase()), false);
  assert.equal(L.tokensEqual('', ''), false);
  assert.equal(L.tokensEqual(undefined, undefined), false);
});

test('counts: parsed with an end marker, compared exactly, described with table names', () => {
  const out = 'ADOPT_COUNT:public.users\t3\nADOPT_COUNT:"weird.schema".t\t0\nADOPT_COUNT_DONE\n';
  assert.deepEqual(L.parseCounts(out), { complete: true, counts: { 'public.users': 3, '"weird.schema".t': 0 } });
  assert.equal(L.parseCounts('ADOPT_COUNT:public.users\t3\n').complete, false, 'cut off = incomplete');
  assert.deepEqual(L.compareCounts({ a: 1, b: 2 }, { a: 1, b: 2 }), { ok: true, mismatches: [] });
  const cmp = L.compareCounts({ a: 1, b: 2 }, { a: 1, b: 3, c: 0 });
  assert.equal(cmp.ok, false);
  assert.deepEqual(cmp.mismatches, [{ table: 'b', expected: 2, actual: 3 }, { table: 'c', expected: null, actual: 0 }]);
  assert.equal(L.describeMismatches(cmp.mismatches), 'b: dump 2 rows, foundation 3 rows; c: dump has no such table, foundation 0 rows');
  assert.equal(L.totalRows({ a: 2, b: 5 }), 7);
  assert.equal(L.parseNotAppOwned('ADOPT_NOT_APP_OWNED:0\n'), 0);
  assert.equal(L.parseNotAppOwned('nothing'), null);
});

test('scripts: the dump is root-only, the restore runs as role app in one transaction inside the stack', () => {
  const dump = L.dumpScript(ID);
  assert.match(dump, /umask 077/);
  assert.match(dump, /chmod 700 "\$R" "\$D"/);
  assert.match(dump, /su - postgres -c 'pg_dump -Fc app' > "\$D\/app.dump.tmp"/);
  assert.match(dump, /pg_restore -l "\$D\/app.dump"/, 'the archive reads back before anything else changes');
  assert.match(L.dumpScript(ID, { native: { port: 5544 } }), /pg_dump -p 5544 -Fc app/);
  assert.throws(() => L.dumpScript(ID, { native: { port: 'x; rm' } }), /invalid native port/);
  const restore = L.restoreScript();
  assert.match(restore, /docker' 'compose' '-p' 'mock2-foundation' .* exec -T postgres sh -c/);
  assert.match(restore, /--no-owner --no-acl --role=app --single-transaction --exit-on-error/);
  assert.match(restore, /EXTENSION/);
  assert.doesNotMatch(L.stopNativeScript(), /rm |PGDATA|\/var\/lib\/postgresql/, 'the native data directory is never touched');
  for (const s of [L.adoptProbeScript(), L.stopAppScript(), L.dumpScript(ID), L.stopNativeScript(), L.restoreScript(), L.removeEnvironmentKeysScript(), L.moduleCommitScript()]) {
    const r = spawnSync('sh', ['-n', '-c', s], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});

test('Docker-ready config: the same five keys as new foundation guests; the rollback puts the originals back', () => {
  assert.deepEqual(L.configChanges({}).map((c) => c.key).sort(), Object.keys(FOUNDATION_GUEST_CONFIG).sort());
  assert.equal(Object.keys(FOUNDATION_GUEST_CONFIG).length, 5);
  assert.deepEqual(L.configChanges({ ...FOUNDATION_GUEST_CONFIG }), []);
  const original = { 'security.nesting': 'false' };
  const back = L.configRestore(original, { ...FOUNDATION_GUEST_CONFIG });
  assert.deepEqual(back.set, [{ key: 'security.nesting', value: 'false' }]);
  assert.deepEqual(back.unset.sort(), Object.keys(FOUNDATION_GUEST_CONFIG).filter((k) => k !== 'security.nesting').sort());
  assert.deepEqual(L.configRestore(original, original), { set: [], unset: [] });
});

test('the environment rewrite removes exactly the named lines and prints no value (real sh)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-env-'));
  try {
    const file = path.join(dir, 'environment');
    const text = 'PATH="/usr/bin"\nAUTH_MASTER_SECRET=planted-value-1\nexport SESSION_SECRET="planted-value-2"\nDATABASE_URL=postgres://app:app@127.0.0.1:5432/app\nKEEP_ME=1\n# AUTH_MASTER_SECRET=comment\n';
    fs.writeFileSync(file, text);
    const r = spawnSync('sh', ['-c', L.removeEnvironmentKeysScript({ file }), 'sh', 'AUTH_MASTER_SECRET', 'SESSION_SECRET', 'DATABASE_URL'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(L.parseEnvRemaining(r.stdout), 0);
    assert.equal(fs.readFileSync(file, 'utf8'), 'PATH="/usr/bin"\nKEEP_ME=1\n# AUTH_MASTER_SECRET=comment\n');
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '644');
    assert.doesNotMatch(r.stdout + r.stderr, /planted|postgres:\/\//);
    const bad = spawnSync('sh', ['-c', L.removeEnvironmentKeysScript({ file }), 'sh', 'X|.*'], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0, 'a key that is not an identifier is refused');
    assert.throws(() => L.removeEnvironmentKeysScript({ file: '/etc/../x' }), /invalid environment file/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-repo-'));
  const bare = path.join(dir, 'repo.git'); const app = path.join(dir, 'app');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', app]);
  execFileSync('git', ['-C', app, 'remote', 'add', 'origin', bare]);
  fs.writeFileSync(path.join(app, 'package.json'), legacyPackageJson());
  fs.mkdirSync(path.join(app, 'src'));
  fs.writeFileSync(path.join(app, 'src/server.ts'), 'export {};\n');
  fs.writeFileSync(path.join(app, 'mock2.yaml'), 'version: 1\nrun:\n  install: npm install\n  start: npm run start\n');
  const git = (...a) => execFileSync('git', ['-C', app, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('add', '-A'); git('commit', '-qm', 'seed'); git('push', '-q', 'origin', 'HEAD:main');
  return { dir, bare, app, git };
}

test('the probe reads a scratch app: package.json, the manifest, git state, engines, env KEY NAMES only (real sh)', () => {
  const { dir, app, git } = scratchRepo();
  try {
    fs.writeFileSync(path.join(app, 'src/files.ts'), "import { S3Client } from '@aws-sdk/client-s3';\nimport Database from 'better-sqlite3';\n");
    const r = spawnSync('sh', ['-c', L.adoptProbeScript({ appDir: app, native: { port: 1 } }), 'sh'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const g = L.parseProbe(r.stdout, { appDir: app });
    assert.equal(g.complete, true);
    assert.equal(g.pkg.present, true);
    assert.equal(g.pkg.text, legacyPackageJson());
    assert.equal(g.manifest, true);
    assert.equal(g.git.head, git('rev-parse', 'HEAD').trim());
    assert.equal(g.git.remote, g.git.head);
    assert.equal(g.git.remoteInHead, true);
    assert.deepEqual(g.git.dirty, ['src/files.ts']);
    assert.deepEqual(g.engineHits.map((h) => [h.path, h.line, h.name, h.family]), [['src/files.ts', 2, 'better-sqlite3', 'sqlite']]);
    assert.deepEqual(g.s3Direct, [{ path: 'src/files.ts', line: 1, name: '@aws-sdk/client-s3' }]);
    assert.ok(Number.isInteger(g.diskFreeBytes) && g.diskFreeBytes > 0);
    assert.notEqual(g.native.state, 'ok', 'no native server on port 1');
    assert.doesNotMatch(r.stdout, /^ENV_KEY:.*=/m, 'env lines contribute names only');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the platform commit carries exactly foundation/ and package.json, is pushed, and is idempotent (real git)', () => {
  const { dir, bare, app, git } = scratchRepo();
  try {
    fs.writeFileSync(path.join(app, 'src/unrelated.ts'), 'dirty();\n');
    const before = git('rev-parse', 'HEAD').trim();
    const merged = L.mergeFoundationPackageJson(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    const files = [...scaffoldFoundationFiles(), { path: 'package.json', content: merged.content }];
    const run = () => spawnSync('sh', ['-c', L.moduleCommitScript({ appDir: app }), 'sh'], { encoding: 'utf8', input: buildSeedPayload(files), env: { ...process.env, HOME: dir, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const r1 = run();
    assert.equal(r1.status, 0, r1.stderr);
    const c1 = L.parseModuleCommit(r1.stdout);
    assert.equal(c1.made, true);
    assert.equal(c1.pushed, true);
    assert.notEqual(c1.head, before);
    assert.equal(execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim(), c1.head, 'pushed to the bare repository');
    const changed = git('show', '--name-only', '--format=%s', c1.head).trim().split('\n');
    assert.equal(changed[0], L.ADOPT_COMMIT_MESSAGE);
    const paths = changed.slice(1).filter(Boolean);
    assert.ok(paths.includes('package.json'));
    assert.ok(paths.includes('foundation/bin/foundation.mjs'));
    assert.ok(paths.every((p) => p === 'package.json' || p.startsWith('foundation/')), paths.join(','));
    assert.equal(paths.length, scaffoldFoundationFiles().length + 1);
    assert.match(git('status', '--porcelain'), /src\/unrelated\.ts/, 'unrelated work is left as it was');
    assert.equal((fs.statSync(path.join(app, 'foundation/bin/foundation.mjs')).mode & 0o111) !== 0, true, 'the CLI keeps its mode');
    const r2 = run();
    const c2 = L.parseModuleCommit(r2.stdout);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(c2.made, false, 'a resume commits nothing new');
    assert.equal(c2.head, c1.head);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the projection: exact keys; rollback after a failure or a success; resume only when the step can run again', () => {
  const row = (over = {}) => ({ id: ID, project_id: 7, state: 'failed', step: 'deploy', steps_json: JSON.stringify(L.initialSteps()), data_json: '{}', error: 'deploy: x', resumable: 1, created_at: 't0', finished_at: 't1', ...over });
  const v = L.projectAdoption(row());
  assert.deepEqual(Object.keys(v).sort(), ['created_at', 'error', 'finished_at', 'id', 'resume_available', 'rollback_available', 'state', 'step', 'steps']);
  assert.deepEqual(v.steps.map((s) => Object.keys(s).sort()), L.STEP_NAMES.map(() => ['detail', 'finished_at', 'label', 'name', 'started_at', 'state']));
  assert.equal(v.rollback_available, true);
  assert.equal(v.resume_available, true);
  assert.equal(L.projectAdoption(row({ resumable: 0 })).resume_available, false);
  assert.equal(L.projectAdoption(row({ data_json: JSON.stringify({ rollback_attempted: true }) })).resume_available, false, 'after a rollback attempt only the rollback is offered');
  assert.equal(L.projectAdoption(row(), { running: true }).rollback_available, false);
  assert.equal(L.projectAdoption(row({ state: 'succeeded' })).rollback_available, true);
  assert.equal(L.projectAdoption(row({ state: 'succeeded' }), { repoMoved: true }).rollback_available, false);
  for (const state of ['running', 'rolling_back', 'rolled_back']) {
    assert.equal(L.projectAdoption(row({ state })).rollback_available, false, state);
    assert.equal(L.projectAdoption(row({ state })).resume_available, false, state);
  }
  assert.equal(L.projectAdoption(null), null);
});
