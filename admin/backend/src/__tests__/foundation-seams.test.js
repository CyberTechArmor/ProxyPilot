// Application foundation — the SEAMS between the modules six agents built in
// parallel (integration, 2026-10). Each test pins one place where a caller
// assumed something about a callee it did not write:
//   * provision.js → foundation-store.js: the provisioning inputs are a plain
//     value; syncFoundationToApp resolves { ok:false, error } and never throws;
//     provision checks `.ok` and fails visibly;
//   * the S3 identities the store generates pass the stack's credential rules;
//   * every foundation-stack.js function the store/service/provision call
//     exists, and answers the shape the caller reads;
//   * the generated app CLI's JSON (health / storage-test / embeddings-test,
//     run for real against a missing database) is what the host parses;
//   * job progress keys: app runtime → host projection → dashboard panel;
//   * the legacy in-guest Postgres paths (deploy data guard, restores,
//     checkpoint snapshots, app access, e2e server, review seeder, manifest,
//     repair deps, setup script) take the foundation path on a foundation guest.
// No Docker: the guest is scripted (helpers/foundation-world.js) or replaced
// at the stack's own exec seam.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { installFoundationHooks, freshMock2Db, addProject, scriptedStack, world } from './helpers/foundation-world.js';
import { FOUNDATION_DATABASE_URL, FOUNDATION_CLI, STACK } from '../mock2/foundation-contract.js';
import * as stackLogic from '../mock2/foundation-stack-logic.js';
import { interpretCliTest, parseHealthOutput, projectJob, CODES } from '../mock2/foundation-logic.js';

process.env.TOTP_ENCRYPTION_KEY = 'c'.repeat(64);
installFoundationHooks();
const store = await import('../mock2/foundation-store.js');
const service = await import('../mock2/foundation-service.js');
// The REAL stack exec module (the hooks replace it only for mock2/ importers).
const realStack = await import('../mock2/foundation-stack.js');
const panel = await import('../../../frontend/src/components/mock2/foundation-panel-logic.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..', '..');
const src = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

function project(id = 1) {
  service.resetFoundationServiceCaches();
  const db = freshMock2Db();
  addProject(db, { id });
  return { db, ...scriptedStack() };
}

// ---- provision.js → foundation-store.js ------------------------------------

test('provision → store: the provisioning inputs are a plain value, syncFoundationToApp never throws, provision checks .ok', async () => {
  project();
  const inputs = store.getFoundationProvisionInputs(1);
  assert.equal(typeof inputs?.then, 'undefined', 'synchronous: provision may await it, but it is a value');
  assert.ok(inputs.masterKey && inputs.storageCredentials?.app && inputs.storageCredentials?.admin && inputs.features?.storage);

  world.stack.foundationPsql = async () => { throw new Error('incus exec failed'); };
  const thrown = await store.syncFoundationToApp(1);
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /incus exec failed/);
  const g = scriptedStack(); g.guest.failSync = true;
  const refused = await store.syncFoundationToApp(1);
  assert.deepEqual(Object.keys(refused).sort(), ['error', 'ok']);
  assert.equal(refused.ok, false);
  assert.equal((await store.syncFoundationToApp(999)).ok, false, 'an unknown project is an answer, not a throw');

  const prov = await src('mock2/provision.js');
  assert.match(prov, /if \(r && r\.ok === false\) return \{ ok: false, error: r\.error/, 'syncToApp reads .ok');
  assert.match(prov, /if \(!sync\.ok\) return \{ ok: false, error: `application foundation: syncing/, 'and provisioning fails on it');
  assert.match(prov, /inputs = await loaded\.store\.getFoundationProvisionInputs\(projectId\)/);
});

test('the S3 identities the store generates satisfy the stack\'s credential rules (app ≠ admin), every time', () => {
  project();
  for (let id = 2; id < 42; id += 1) {
    addProject(world.db, { id });
    const { storageCredentials: { app, admin } } = store.getFoundationProvisionInputs(id);
    assert.equal(stackLogic.storageCredentialError(app, 'app'), null, JSON.stringify(app));
    assert.equal(stackLogic.storageCredentialError(admin, 'admin'), null);
    assert.match(app.accessKeyId, /^[A-Za-z0-9]{12,128}$/);
    assert.match(app.secretAccessKey, /^[A-Za-z0-9+/=._-]{16,128}$/);
    assert.notEqual(app.accessKeyId, admin.accessKeyId);
    assert.deepEqual(store.getFoundationProvisionInputs(id).storageCredentials, { app, admin }, 'stable after the first call');
  }
});

// ---- foundation-stack.js: what the callers import, and what it answers -------

test('every foundation-stack.js function the store, service and provision use is exported (and stubbed by the test world)', async () => {
  const used = new Set();
  for (const rel of ['mock2/foundation-store.js', 'mock2/foundation-service.js']) {
    for (const m of (await src(rel)).matchAll(/const \{ ([^}]+) \} = await stack\(\)/g)) for (const n of m[1].split(',')) used.add(n.trim());
  }
  const prov = await src('mock2/provision.js');
  const provImport = prov.match(/import \{([^}]+)\} from '\.\/foundation-stack\.js';/);
  assert.ok(provImport, 'provision imports the stack statically');
  for (const n of provImport[1].split(',')) used.add(n.trim());
  assert.ok(used.size >= 7, [...used].join(', '));
  const world = await src('__tests__/helpers/foundation-world.js');
  for (const name of used) {
    assert.equal(typeof realStack[name], 'function', `foundation-stack.js exports ${name}`);
    if (['foundationPsql', 'setFoundationService', 'bundledStorageObjectCount', 'foundationCli', 'runFoundationJobDetached'].includes(name)) {
      assert.match(world, new RegExp(`export const ${name} =`), `the scripted world stubs ${name}`);
    }
  }
});

test('foundation-stack.js answers the shapes its callers read', async (t) => {
  let next = { code: 0, stdout: '', stderr: '' };
  const sent = [];
  realStack._setFoundationGuestExecForTests(async (container, argv, opts) => { sent.push({ container, argv, opts }); return next; });
  t.after(() => realStack._setFoundationGuestExecForTests());

  next = { code: 2, stdout: '{"ok":false}', stderr: 'x' };
  assert.deepEqual(await realStack.foundationCli('m2-p1', ['health', '--json']), next, 'foundationCli → { code, stdout, stderr } as the guest said');
  assert.deepEqual(sent.at(-1).argv.slice(-3), ['/srv/app', 'health', '--json'], 'arguments stay positional');

  const admin = { accessKeyId: 'ADMINKEY0001', secretAccessKey: 's'.repeat(20) };
  next = { code: 0, stdout: 'COUNT:7\n', stderr: '' };
  assert.equal(await realStack.bundledStorageObjectCount('m2-p1', admin), 7);
  assert.equal(sent.at(-1).opts.input, `${admin.accessKeyId}\n${admin.secretAccessKey}\n`, 'the admin key goes on stdin, never argv');
  assert.ok(!sent.at(-1).argv.join(' ').includes(admin.secretAccessKey));
  next = { code: 0, stdout: 'COUNT:error:http-403\n', stderr: '' };
  assert.equal(await realStack.bundledStorageObjectCount('m2-p1', admin), null, 'cannot tell → null, never 0');
  const calls = sent.length;
  assert.equal(await realStack.bundledStorageObjectCount('m2-p1', { accessKeyId: 'x', secretAccessKey: 'y' }), null);
  assert.equal(sent.length, calls, 'bad credentials never reach the guest');

  next = { code: 1, stdout: '', stderr: 'Failed to start transient service unit: Unit mock2-foundation-job-fj_abcdefgh.service already exists.' };
  assert.deepEqual(await realStack.runFoundationJobDetached('m2-p1', 'fj_abcdefgh'), { ok: false, unit: 'mock2-foundation-job-fj_abcdefgh', alreadyRunning: true, error: `starting mock2-foundation-job-fj_abcdefgh failed: ${next.stderr}` });
  next = { code: 69, stdout: '', stderr: 'NONODE' };
  const nonode = await realStack.runFoundationJobDetached('m2-p1', 'fj_abcdefgh');
  assert.equal(nonode.ok, false);
  assert.equal(nonode.alreadyRunning, false);
  next = { code: 0, stdout: '', stderr: '' };
  assert.deepEqual(await realStack.runFoundationJobDetached('m2-p1', 'fj_abcdefgh'), { ok: true, unit: 'mock2-foundation-job-fj_abcdefgh', error: null });

  next = { code: 1, stdout: '', stderr: 'no such service' };
  const stop = await realStack.setFoundationService('m2-p1', 'storage', 'stop');
  assert.equal(stop.ok, false);
  assert.match(stop.error, /docker compose stop storage failed/);
  assert.equal((await realStack.setFoundationService('m2-p1', 'postgres', 'stop')).ok, false, 'postgres is never stopped');
});

test('the service reads runFoundationJobDetached\'s { ok:false } as "not started" (it does not throw), and "already exists" as running', async () => {
  const startCopy = async (answer) => {
    const g = project();
    g.guest.objectCount = 3;
    store.getFoundationProvisionInputs(1);
    g.stack.runFoundationJobDetached = async (c, jobId) => { g.calls.detached.push({ jobId }); return answer; };
    const r = await service.featureAction(1, 'storage', {
      action: 'switch', provider: 'external', mode: 'copy',
      config: { endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'app-files', region: 'auto' },
      credentials: { access_key_id: 'AKIAR2EXAMPLE0000001', secret_access_key: 'r2-secret-0123456789abcdefghij' },
    });
    return { r, g };
  };
  const failed = await startCopy({ ok: false, unit: 'mock2-foundation-job-x', alreadyRunning: false, error: 'starting mock2-foundation-job-x failed: NONODE' });
  assert.equal(failed.r.ok, false);
  assert.equal(failed.r.code, CODES.FOUNDATION_UNAVAILABLE);
  const job = store.listJobs(1, 1)[0];
  assert.equal(job.state, 'failed', 'a job whose unit never started is not left queued for the stale-job relaunch');
  assert.match(job.error, /could not be started in the guest: .*NONODE/);
  assert.equal(store.readFeatureRows(1).storage.pending.job_id, null);

  const running = await startCopy({ ok: false, unit: 'mock2-foundation-job-x', alreadyRunning: true, error: 'already exists' });
  assert.equal(running.r.ok, true, JSON.stringify(running.r));
  assert.equal(store.getJob(running.r.job.id).state, 'queued');
  // The running job is refused for a second switch, and the refusal names it.
  const again = await service.featureAction(1, 'storage', { action: 'off' });
  assert.equal(again.code, CODES.FOUNDATION_JOB_RUNNING);
  assert.equal(again.job_id, running.r.job.id, 'FOUNDATION_JOB_RUNNING carries job_id');
  service.resetFoundationServiceCaches();
});

// ---- the app CLI's JSON → the host's parsers ---------------------------------

function materializeFoundation() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-seams-'));
  return import('../mock2/scaffold.js').then(({ scaffoldFoundationFiles }) => {
    for (const f of scaffoldFoundationFiles()) {
      const p = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content);
    }
    fs.symlinkSync(path.join(BACKEND, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    return dir;
  });
}

test('the generated CLI against a missing database: health / storage-test / embeddings-test JSON is what the host parses', async (t) => {
  const dir = await materializeFoundation();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (args) => {
    const r = spawnSync(process.execPath, [FOUNDATION_CLI, ...args], {
      cwd: dir, encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgres:///app?host=/nonexistent/mock2-seams&user=app', FOUNDATION_DB_RETRY_MS: '200' },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const health = run(['health', '--json']);
  assert.equal(health.code, 2);
  const rows = parseHealthOutput(health.stdout);
  assert.deepEqual(rows.map((r) => [r.component, r.status]), [['database', 'unavailable'], ['storage', 'unavailable'], ['embeddings', 'unavailable']]);
  assert.match(rows[0].detail.message, /socket \/nonexistent\/mock2-seams/);
  assert.equal(rows[0].detail.reason, 'DATABASE_UNREACHABLE');
  for (const cmd of ['storage-test', 'embeddings-test']) {
    const r = run([cmd, '--pending', '--json']);
    assert.equal(r.code, 2, `${cmd}: ${r.stdout}${r.stderr}`);
    const v = interpretCliTest(r);
    assert.equal(v.ok, false);
    assert.equal(v.status, 'unavailable', `${cmd}: an unreachable database is unavailable, never ready`);
    assert.match(v.detail.message, /Could not connect to the application database/);
  }
});

// ---- job progress: app runtime → host projection → dashboard panel ------------

test('job progress keys: what the app runtime writes is what the host projects and the panel renders', async () => {
  const { buildFoundationFiles } = await import('../mock2/scaffold-foundation.js');
  const jobs = buildFoundationFiles({ composeYaml: 'services: {}\n' }).find((f) => f.path === 'foundation/runtime/jobs.mjs').content;
  const written = new Set([...jobs.matchAll(/(?:ctx\.progress|\bp)\.([a-z_]+)\s*(?:=|\+=|-=)/g)].map((m) => m[1]));
  for (const k of ['objects_total', 'objects_done', 'bytes_done', 'bytes_total', 'failed', 'phase', 'pass', 'passes', 'converged', 'items_total', 'items_done']) {
    assert.ok(written.has(k), `the runtime writes progress.${k} (${[...written].join(', ')})`);
  }
  const phases = new Set([...jobs.matchAll(/ctx\.progress\.phase = '([a-z]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...phases].sort(), ['copying', 'done', 'embedding', 'listing', 'validating']);

  const row = (kind, progress, state = 'running') => ({ id: 'fj_seams0001', kind, state, params_json: '{}', progress_json: JSON.stringify(progress), created_at: 't', updated_at: 't' });
  const copy = panel.jobView(projectJob(row('storage_migrate', { phase: 'copying', pass: 2, passes: 2, objects_total: 40, objects_done: 10, bytes_done: 2048, bytes_total: 8192, failed: 0, converged: false })));
  assert.equal(copy.feature, 'storage');
  assert.equal(copy.percent, 25);
  assert.equal(copy.progressText, '10 of 40 files · 2.0 KB of 8.0 KB');
  const reembed = panel.jobView(projectJob(row('reembed', { phase: 'validating', items_total: 30, items_done: 30, validation: { passed: true } })));
  assert.equal(reembed.feature, 'embeddings');
  assert.equal(reembed.percent, 100);
  assert.equal(reembed.phaseText, 'Checking the new index');
  assert.equal(panel.jobView(projectJob(row('storage_migrate', { phase: 'promoting' }))).phaseText, 'Switching over', 'the host\'s own phase');
  assert.equal(projectJob(row('reembed', { validation: { passed: true } })).progress.validation, undefined, 'objects never reach the projection');
});

test('GET /foundation carries storage.object_count (the last count the host took) and embeddings.index — read by the panel', async () => {
  const g = project();
  store.getFoundationProvisionInputs(1);
  g.guest.activeIndex = { id: 'ix_seams01', provider: 'local', model: STACK.embeddings.model, dimensions: 384, metric: 'cosine', item_count: 12 };
  let f = await service.getFoundation(1);
  assert.equal(f.storage.object_count, undefined, 'never counted → not reported (no listing on a GET)');
  assert.deepEqual(f.embeddings.index, { id: 'ix_seams01', state: 'active', provider: 'local', model: STACK.embeddings.model, dimensions: 384, item_count: 12 });
  assert.equal(g.calls.counts.length, 0);
  g.guest.objectCount = 5;
  const refused = await service.featureAction(1, 'storage', { action: 'off' });
  assert.equal(refused.code, CODES.STORAGE_HAS_OBJECTS);
  assert.equal(refused.object_count, 5);
  service.resetFoundationServiceCaches();
  f = await service.getFoundation(1);
  assert.equal(f.storage.object_count, 5);
  assert.ok(f.storage.object_count_checked_at);
  assert.equal(panel.storageView(f.storage).objects, 5);
  assert.equal(panel.indexOf(f.embeddings).items, 12);
  assert.equal(panel.refusalOf({ status: 409, ...refused }).objects, 5);
  // POST /foundation/health answers the GET shape, index included.
  const h = await service.runHealth(1);
  assert.deepEqual(h.foundation.embeddings.index?.id, 'ix_seams01');
  assert.deepEqual(Object.keys(h.foundation).sort(), Object.keys(f).sort());
  service.resetFoundationServiceCaches();
});

// ---- legacy in-guest Postgres paths on a foundation guest --------------------

const PREFIX = stackLogic.foundationPgExecPrefix();

test('deploy: the pre-migration data guard (the protected dump) runs in the stack\'s postgres service; the unit and the build steps get the socket URL', async () => {
  const { protectedCopiesScript } = await import('../lib/setup-engine/guest-probes.js');
  const f = protectedCopiesScript('job-1', { foundation: true });
  assert.ok(f.includes(`${PREFIX} pg_dump -U postgres --clean --if-exists app > "$f.tmp"`));
  assert.doesNotMatch(f, /su - postgres/);
  assert.match(f, /DBDUMP:none:no docker for the foundation stack/);
  assert.match(protectedCopiesScript('job-1'), /su - postgres -c "pg_dump --clean --if-exists app"/, 'native unchanged');
  const op = await src('lib/setup-engine/deploy-op.js');
  assert.match(op, /protectedCopiesScript\(jobId, \{ [^}]*foundation: !!p\.foundation \}\)/);
  assert.match(op, /const foundationEnv = p\.foundation \? `export DATABASE_URL='\$\{FOUNDATION_DATABASE_URL\}'\\n` : '';/, 'install / migrate / build see DATABASE_URL');
  assert.match(op, /buildDevServiceUnit\(\{ appDir, webPort, execStart, foundation: !!p\.foundation \}\)/);
  const { buildDevServiceUnit } = await import('../mock2/deploy-logic.js');
  assert.ok(buildDevServiceUnit({ execStart: '/usr/bin/node x', foundation: true }).split('\n').includes(`Environment=DATABASE_URL=${FOUNDATION_DATABASE_URL}`));
});

test('restore_project_db: the restore job drives the stack\'s postgres service; the flag is validated and planned', async () => {
  const rl = await import('../lib/setup-engine/restore-logic.js');
  const ins = rl.inspectScript({ dumpName: 'app-x.sql', foundation: true });
  assert.ok(ins.includes(`v=$(${PREFIX} psql -U postgres -X -tAc 'show server_version'`));
  const prot = rl.protectScript('job-2', { foundation: true });
  assert.ok(prot.includes(`${PREFIX} pg_dump -U postgres --clean --if-exists app > "$f.tmp"`));
  const res = rl.restoreScript({ dumpName: 'app-x.sql', foundation: true });
  assert.ok(res.includes(`out=$(${PREFIX} psql -U postgres -X -v ON_ERROR_STOP=0 -q -d app < "$T" 2>&1)`));
  for (const s of [ins, prot, res]) assert.doesNotMatch(s, /su - postgres/);
  for (const s of [rl.inspectScript({ dumpName: 'app-x.sql' }), rl.protectScript('job-2'), rl.restoreScript({ dumpName: 'app-x.sql' })]) assert.match(s, /su - postgres/, 'native unchanged');
  const { resolveRestoreDbPlan } = await import('../lib/setup-engine/restore-db-op.js');
  assert.equal(resolveRestoreDbPlan({ foundation: true }).foundation, true);
  assert.equal(resolveRestoreDbPlan({ foundation: 'yes' }).foundation, false);
  const { validateRunnerJob } = await import('../lib/setup-engine/logic.js');
  const job = (params) => ({ kind: 'restore_db', app: 'm2-p1', plan_json: JSON.stringify({ params: { container: 'm2-p1', dump: { name: 'app-x.sql' }, ...params } }) });
  assert.match(String(validateRunnerJob(job({ foundation: 'yes' })).reason), /foundation must be a boolean/);
  assert.equal(validateRunnerJob(job({ foundation: true })).ok, true);
  const ops = await src('mock2/ops.js');
  assert.match(ops, /\.\.\.\(foundation \? \{ foundation: true \} : \{\}\)/);
  assert.match(ops, /\.\.\.\(foundation \? \{ database: 'foundation_stack' \} : \{\}\)/, 'the confirmation digest covers it');
  // A database or snapshot restore brings back the platform-held rows of its
  // own time; both re-sync them from mock2.db afterwards.
  assert.match(ops, /out\.foundationSync = await resyncFoundation\(refs\.projectId\);\n  \}\n  return out;/);
  assert.match(ops, /if \(refs\.foundation && out\?\.ok && !detach && !out\.submitted\) out\.foundationSync = await resyncFoundation\(refs\.projectId\);/);
});

test('build checkpoints, app access, the review seeder and the e2e server take the foundation path', async () => {
  const { buildDbSnapshotScript, buildRestoreScript } = await import('../mock2/restore-logic.js');
  const snap = buildDbSnapshotScript({ foundation: true });
  assert.ok(snap.includes(stackLogic.foundationCheckpointDumpCommand()));
  for (const t of stackLogic.CHECKPOINT_EXCLUDED_TABLES) assert.ok(snap.includes(`--exclude-table=${t}`), `${t} is never committed`);
  assert.ok(stackLogic.CHECKPOINT_EXCLUDED_TABLES.includes('mock2_foundation.secrets'));
  assert.doesNotMatch(snap, /su - postgres/);
  assert.doesNotMatch(buildRestoreScript({ commitSha: 'abcdef1', foundation: true }), /su - postgres/);
  assert.match(buildDbSnapshotScript(), /su - postgres -c "pg_dump --clean --if-exists app"/, 'native unchanged');
  for (const [rel, re] of [['mock2/runner.js', /buildDbSnapshotScript\(\{ appDir: APP_DIR, foundation: isFoundationProject\(project\) \}\)/], ['mock2/routes.js', /buildRestoreScript\(\{\n\s+foundation: isFoundationProject\(project\),/], ['routes/mcp-tools/project-config.js', /buildDbSnapshotScript\(\{ appDir: M2_APP_DIR, foundation: !!\(await foundationStackLogic\(p\.project\)\) \}\)/]]) {
    assert.match(await src(rel), re, rel);
  }

  const access = await import('../mock2/app-access-logic.js');
  for (const s of [access.accessStateScript({ foundation: true }), access.freeFirstAdminSlotScript({ foundation: true })]) {
    assert.ok(s.includes(`${PREFIX} psql -U postgres -X -tA`));
    assert.doesNotMatch(s, /su - postgres/);
  }
  assert.match(await src('mock2/app-access.js'), /accessStateScript\(\{ port, foundation: isFoundationProject\(project\) \}\)/);

  const { seedFixtureUserScript } = await import('../mock2/review-account-logic.js');
  assert.ok(seedFixtureUserScript({ email: 'r@fixture.invalid', password: 'p'.repeat(16) })
    .includes(`(fs.existsSync("${FOUNDATION_CLI}") ? "${FOUNDATION_DATABASE_URL}" : "postgres://app:app@127.0.0.1:5432/app")`));
});

test('seed and repair: the manifest declares no database port, the S3 SDKs return only to foundation apps, the native role exists only on the legacy path', async () => {
  const { defaultManifest, parseManifestWebPort, buildContainerSetupScript } = await import('../mock2/template.js');
  const m = defaultManifest({ webPort: 3000 });
  assert.doesNotMatch(m, /postgres: 5432/);
  assert.ok(m.includes(`DATABASE_URL=${FOUNDATION_DATABASE_URL}`));
  assert.equal(parseManifestWebPort(m), 3000);
  assert.match(defaultManifest({ webPort: 3000, foundation: false }), /postgres: 5432/);

  const { scaffoldRepairDependencies, SCAFFOLD_DEPENDENCIES } = await import('../mock2/scaffold.js');
  const { FOUNDATION_DEPENDENCIES } = await import('../mock2/scaffold-foundation.js');
  assert.equal(scaffoldRepairDependencies(), SCAFFOLD_DEPENDENCIES);
  for (const dep of Object.keys(FOUNDATION_DEPENDENCIES)) {
    assert.equal(SCAFFOLD_DEPENDENCIES.dependencies[dep], undefined, `${dep} is not in the every-project repair set`);
    assert.equal(scaffoldRepairDependencies({ foundation: true }).dependencies[dep], FOUNDATION_DEPENDENCIES[dep]);
  }
  const ci = await src('mock2/component-install.js');
  assert.match(ci, /const foundation = \(await execInContainer\(containerName, `test -f '\$\{FOUNDATION_CLI\}'`\)/);
  assert.match(ci, /Object\.entries\(scaffoldRepairDependencies\(\{ foundation \}\)\)/);

  const native = buildContainerSetupScript({});
  const fnd = buildContainerSetupScript({ foundation: true });
  assert.match(native, /CREATE ROLE app LOGIN PASSWORD 'app'/);
  assert.doesNotMatch(fnd, /CREATE ROLE|PASSWORD 'app'|su - postgres|apt-get install -y --no-install-recommends postgresql \|\|/);
  assert.match(fnd, /docker\.io docker-compose postgresql-client/);
});
