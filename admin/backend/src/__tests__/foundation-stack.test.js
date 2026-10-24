// Foundation guest stack — pure logic (foundation-stack-logic.js), the exec
// module driven by a scripted fake guest (foundation-stack.js), and the
// wiring into provisioning, the setup script, the MCP SQL tools, the smoke DB
// connector and the e2e server. Native-free: no Docker, no Incus, no SQLite.
// The real stack is proven by foundation-stack.docker.test.js (FOUNDATION_E2E=1).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STACK, FOUNDATION_SCHEMA_SQL, FOUNDATION_DATABASE_URL, generateMasterKey } from '../mock2/foundation-contract.js';
import * as L from '../mock2/foundation-stack-logic.js';
import { mcpGuestCreateOptions } from '../lib/mcp-logic.js';
import * as S from '../mock2/foundation-stack.js';
import { buildContainerSetupScript } from '../mock2/template.js';
import { smokeScratchDbScript } from '../mock2/smoke.js';
import { e2eServerMjs } from '../mock2/scaffold-e2e.js';

const sh = (script, { input = null, args = [], shell = 'sh' } = {}) => spawnSync(shell, ['-c', script, 'sh', ...args], { input: input ?? undefined, encoding: 'utf8' });
const syntaxOk = (script, shell = 'sh') => spawnSync(shell, ['-n', '-c', script], { encoding: 'utf8' });

// ---------------------------------------------------------------- guest config

test('foundation guests get exactly the docker_ready security config of create_lxc_container', () => {
  const dockerReady = Object.fromEntries(Object.entries(mcpGuestCreateOptions({ docker_ready: true }).config).filter(([k]) => k.startsWith('security.')));
  assert.deepEqual({ ...L.FOUNDATION_GUEST_CONFIG }, dockerReady);
  for (const k of ['security.nesting', 'security.syscalls.intercept.mknod', 'security.syscalls.intercept.setxattr']) assert.equal(L.FOUNDATION_GUEST_CONFIG[k], 'true');
  assert.equal(L.FOUNDATION_GUEST_CONFIG['security.privileged'], undefined, 'a foundation guest must never be privileged');
  const args = L.foundationLaunchConfigArgs();
  assert.equal(args.filter((a) => a === '-c').length, Object.keys(dockerReady).length);
  assert.ok(args.includes('security.nesting=true'));
});

test('isFoundationProject reads projects.foundation_version defensively', () => {
  assert.equal(L.isFoundationProject(null), false);
  assert.equal(L.isFoundationProject({ id: 1 }), false, 'a row from before the column exists');
  assert.equal(L.isFoundationProject({ foundation_version: null }), false);
  assert.equal(L.isFoundationProject({ foundation_version: '' }), false);
  assert.equal(L.isFoundationProject({ foundation_version: 'mock2-foundation-v1' }), true);
});

// ------------------------------------------------------------------- compose

test('compose: three services pinned to the contract tags (by digest), restart unless-stopped', () => {
  const m = L.buildFoundationComposeModel();
  assert.deepEqual(Object.keys(m.services), [STACK.postgres.service, STACK.storage.service, STACK.embeddings.service]);
  for (const [key, svc] of [['postgres', 'postgres'], ['storage', 'storage'], ['embeddings', 'embeddings']]) {
    const s = m.services[svc];
    assert.ok(s.image.startsWith(`${STACK[key].image}@sha256:`), `${svc} image ${s.image} is not ${STACK[key].image} pinned by digest`);
    assert.match(s.image, /@sha256:[0-9a-f]{64}$/);
    assert.equal(s.restart, 'unless-stopped');
    assert.ok(s.mem_limit, `${svc} has no memory limit`);
    assert.ok(s.healthcheck?.test?.length, `${svc} has no healthcheck`);
    assert.equal(s.logging.driver, 'local');
  }
  assert.equal(m.name, STACK.composeProject);
  assert.deepEqual(Object.keys(m.volumes), [STACK.postgres.volume, STACK.storage.volume, STACK.embeddings.volume]);
  for (const [k, v] of Object.entries(m.volumes)) assert.equal(v.name, k, 'platform volumes carry their contract names');
});

test('compose: postgres has no TCP — no network, no ports, listen_addresses empty, socket bind-mounted', () => {
  const pg = L.buildFoundationComposeModel().services.postgres;
  assert.equal(pg.network_mode, 'none');
  assert.equal(pg.ports, undefined);
  assert.ok(pg.command.includes('listen_addresses='));
  assert.ok(pg.command.includes('hba_file=/etc/mock2/pg_hba.conf'));
  assert.ok(pg.command.includes('ident_file=/etc/mock2/pg_ident.conf'));
  assert.ok(pg.volumes.includes(`${STACK.postgres.socketDir}:/var/run/postgresql`));
  assert.ok(pg.volumes.includes(`${STACK.postgres.volume}:/var/lib/postgresql`), 'PG 18 images keep data under /var/lib/postgresql');
  assert.equal(pg.environment.POSTGRES_PASSWORD, undefined);
});

test('compose: storage and embeddings are published on 127.0.0.1 only, at the contract ports', () => {
  const m = L.buildFoundationComposeModel();
  assert.deepEqual(m.services.storage.ports, [`127.0.0.1:${STACK.storage.port}:8333`]);
  assert.deepEqual(m.services.embeddings.ports, [`127.0.0.1:${STACK.embeddings.port}:80`]);
  const cmd = m.services.storage.command;
  assert.ok(cmd.includes('-ip.bind=127.0.0.1'), 'SeaweedFS internals must bind loopback inside the container');
  assert.ok(cmd.includes('-s3') && cmd.includes('-filer'));
  assert.ok(cmd.includes('-s3.port.iceberg=0') && cmd.includes('-s3.port.lance=0'), 'extra listeners are off');
  assert.deepEqual(m.services.embeddings.command.slice(0, 2), ['--model-id', STACK.embeddings.model]);
  assert.notDeepEqual(m.services.storage.networks, m.services.embeddings.networks, 'storage and embeddings are on separate networks');
  for (const yaml of [L.buildFoundationComposeYaml(), L.buildFoundationComposeYaml({ portable: true })]) {
    for (const line of yaml.split('\n').filter((l) => /^\s+- ".*:\d+:\d+"$/.test(l))) assert.match(line, /- "127\.0\.0\.1:/, line);
  }
});

test('compose: no secret anywhere in the generated files', () => {
  for (const portable of [false, true]) {
    const yaml = L.buildFoundationComposeYaml({ portable }).split('\n').filter((l) => !l.startsWith('#')).join('\n');
    assert.doesNotMatch(yaml, /PASSWORD|PGPASSWORD|AWS_SECRET|AWS_ACCESS|ACCESS_KEY|SECRET_KEY|API_KEY|_TOKEN|secret/i);
    const model = L.buildFoundationComposeModel({ portable });
    for (const s of Object.values(model.services)) {
      for (const k of Object.keys(s.environment || {})) assert.doesNotMatch(k, /pass|secret|key|token/i, k);
    }
    for (const f of L.buildFoundationFiles({ portable })) {
      assert.doesNotMatch(f.content, /PASSWORD\s+'[^']+'|PASSWORD\s+"[^"]+"/i, `${f.path} sets a password`);
    }
  }
  // The portable header shows how to create identities, with placeholders only.
  const portable = L.buildFoundationComposeYaml({ portable: true });
  assert.ok(portable.includes('-access_key <id> -secret_key <secret>'));
});

test('compose: the YAML is the rendered model (a JSON-quoted subset Docker parses)', () => {
  const yaml = L.buildFoundationComposeYaml();
  assert.match(yaml, /^# Mock2 application foundation/);
  assert.match(yaml, /\nname: "mock2-foundation"\n/);
  assert.match(yaml, /\n {4}network_mode: "none"\n/);
  // Compose interpolation: a literal $ in a healthcheck is written $$.
  assert.ok(yaml.includes('$$PGDATA'));
  assert.doesNotMatch(yaml.replace(/\$\$/g, ''), /\$[^{]/);
});

test('compose: the portable copy keeps the design and is overridable from the environment', () => {
  const m = L.buildFoundationComposeModel({ portable: true });
  assert.equal(m.name, '${MOCK2_FOUNDATION_PROJECT:-mock2-foundation}');
  assert.ok(m.services.postgres.volumes.includes(`\${MOCK2_FOUNDATION_SOCKET_DIR:-${STACK.postgres.socketDir}}:/var/run/postgresql`));
  assert.equal(m.services.postgres.network_mode, 'none');
  for (const v of Object.values(m.volumes)) assert.equal(v.name, undefined, 'portable volumes are project-scoped');
  assert.deepEqual(m.services.storage.ports, ['127.0.0.1:${MOCK2_FOUNDATION_S3_PORT:-8333}:8333']);
  const paths = L.buildFoundationFiles({ portable: true }).map((f) => f.path);
  assert.deepEqual(paths, ['compose.yaml', 'postgres/pg_hba.conf', 'postgres/pg_ident.conf', 'postgres/entrypoint.sh', 'postgres/initdb/01-mock2-foundation.sql', 'postgres/initdb/99-mock2-seal.sh']);
});

// ------------------------------------------------------------- postgres files

test('pg_hba: one line — unix socket, peer, the mock2 map; no host line', () => {
  const lines = L.buildPgHbaConf().split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.deepEqual(lines.map((l) => l.trim().split(/\s+/)), [['local', 'all', 'all', 'peer', 'map=mock2']]);
});

test('pg_ident: only root is mapped at runtime; the init mapping is an include the seal script deletes', () => {
  const lines = L.buildPgIdentConf().split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/));
  assert.deepEqual(lines, [['mock2', 'root', 'app'], ['mock2', 'root', 'postgres'], ['include_if_exists', L.PG_INIT_IDENT]]);
  const ep = L.buildPgEntrypoint();
  assert.match(ep, /if \[ ! -s "\$\{PGDATA\}\/PG_VERSION" \]; then/);
  assert.match(ep, /printf 'mock2 postgres postgres\\n' > '\/run\/mock2-init\/pg_ident\.conf'/);
  assert.match(ep, /exec docker-entrypoint\.sh "\$@"/);
  assert.match(L.buildPgSealScript(), /rm -f '\/run\/mock2-init\/pg_ident\.conf'/);
  assert.equal(syntaxOk(ep, 'bash').status, 0, syntaxOk(ep, 'bash').stderr);
  assert.equal(syntaxOk(L.buildPgSealScript(), 'bash').status, 0);
});

test('init SQL: app role LOGIN CREATEDB without a password, database owned by app, the contract schema verbatim', () => {
  const sql = L.buildFoundationInitSql();
  assert.match(sql, /CREATE ROLE app LOGIN CREATEDB/);
  assert.match(sql, /ALTER ROLE app WITH LOGIN CREATEDB NOSUPERUSER PASSWORD NULL;/);
  assert.match(sql, /CREATE DATABASE app OWNER app/);
  assert.match(sql, /\\connect app\n/);
  assert.ok(sql.includes(FOUNDATION_SCHEMA_SQL.trim()), 'FOUNDATION_SCHEMA_SQL must be applied verbatim');
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS vector/);
  assert.doesNotMatch(sql, /PASSWORD '/);
  assert.equal(L.foundationEnsureSql(), sql, 'the init file and the bring-up apply the same SQL');
  assert.throws(() => L.buildFoundationInitSql({ role: 'app; DROP' }));
});

// ------------------------------------------------------------------ helpers

test('composeArgsError refuses every volume-deleting form and nothing else', () => {
  for (const a of [['down', '-v'], ['down', '--volumes'], ['down', '--volumes=true'], ['rm', '-v'], ['rm', '-sfv'], ['rm', '-f', '-v', 'storage'], ['volume', 'rm', 'x'], ['volumes']]) {
    assert.ok(L.composeArgsError(a), a.join(' '));
  }
  for (const a of [['ps', '--all', '--format', 'json'], ['up', '-d', 'storage'], ['stop', 'embeddings'], ['down'], ['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1'], ['logs', '--tail', '30', 'storage'], ['rm', '-f', 'embeddings']]) {
    assert.equal(L.composeArgsError(a), null, a.join(' '));
  }
  assert.ok(L.composeArgsError([]));
  assert.ok(L.composeArgsError(['ps', 'a\0b']));
});

test('wantedServices: postgres always; storage when on + bundled; embeddings when on + local', () => {
  assert.deepEqual(L.wantedServices(null), { postgres: true, storage: false, embeddings: false });
  assert.deepEqual(L.wantedServices({ storage: { state: 'on', provider: 'bundled' }, embeddings: { state: 'on', provider: 'local' } }), { postgres: true, storage: true, embeddings: true });
  assert.deepEqual(L.wantedServices({ storage: { state: 'on', provider: 'external' }, embeddings: { state: 'on', provider: 'openai' } }), { postgres: true, storage: false, embeddings: false });
  assert.deepEqual(L.wantedServices({ storage: { state: 'off', provider: 'bundled' }, embeddings: { state: 'off', provider: 'local' } }), { postgres: true, storage: false, embeddings: false });
});

test('interpretServiceStatus reads JSON lines and arrays; a missing service is absent', () => {
  const lines = '{"Service":"postgres","State":"running","Health":"healthy"}\n{"Service":"storage","State":"exited","Health":"","ExitCode":0}\n';
  assert.deepEqual(L.interpretServiceStatus(lines), [
    { service: 'postgres', state: 'running', health: 'healthy' },
    { service: 'storage', state: 'exited', health: 'none', exitCode: 0 },
    { service: 'embeddings', state: 'absent', health: 'none' },
  ]);
  const arr = JSON.stringify([{ Service: 'embeddings', State: 'running', Health: 'starting' }]);
  assert.equal(L.interpretServiceStatus(arr)[2].health, 'starting');
  assert.deepEqual(L.interpretServiceStatus('garbage').map((s) => s.state), ['absent', 'absent', 'absent']);
  const ready = L.servicesReady(L.interpretServiceStatus(lines), ['postgres']);
  assert.equal(ready.ready, true);
  const notReady = L.servicesReady(L.interpretServiceStatus(lines), ['postgres', 'storage']);
  assert.deepEqual(notReady, { ready: false, notReady: ['storage'], failed: ['storage'] });
});

test('parseDockerProbe: missing, daemon down, no Compose v2, ok, vfs warning', () => {
  assert.equal(L.parseDockerProbe('DOCKER:missing\n').ok, false);
  assert.match(L.parseDockerProbe('DOCKER:unreachable\nCOMPOSE:2.26.1\n').error, /daemon is not running/);
  assert.match(L.parseDockerProbe('DOCKER:26.1.5\nCOMPOSE:missing\n').error, /Compose v2/);
  assert.match(L.parseDockerProbe('DOCKER:26.1.5\nCOMPOSE:1.29.2\n').error, /Compose v2/);
  const ok = L.parseDockerProbe('DOCKER:26.1.5\nCOMPOSE:2.26.1\nDRIVER:overlay2\n');
  assert.equal(ok.ok, true); assert.equal(ok.warning, null);
  assert.match(L.parseDockerProbe('DOCKER:26.1.5\nCOMPOSE:v2.26.1\nDRIVER:vfs\n').warning, /vfs/);
});

test('storage identity result: refuses open storage and failed keys, never echoes a key', () => {
  const ok = 'OK:admin\nOK:app\nOK:bucket-created\nANON:403\nAPPKEY:200\nADMINKEY:200\n';
  assert.equal(L.parseStorageIdentity(ok, 0).ok, true);
  assert.match(L.parseStorageIdentity(ok.replace('ANON:403', 'ANON:200'), 0).error, /anonymous/);
  assert.match(L.parseStorageIdentity(ok.replace('APPKEY:200', 'APPKEY:403'), 0).error, /app S3 key/);
  assert.match(L.parseStorageIdentity('FAIL:configure-app\nerror: x\n', 1).error, /configure-app/);
  const script = L.storageIdentityScript();
  assert.match(script, /^IFS= read -r APP_AK; IFS= read -r APP_SK; IFS= read -r ADM_AK; IFS= read -r ADM_SK/);
  assert.doesNotMatch(script, /echo "\$(APP|ADM)_(AK|SK)"/);
  assert.match(script, /-delete -apply/, 'identities are re-created so a rotated key does not stay valid');
  assert.equal(syntaxOk(script).status, 0, syntaxOk(script).stderr);
});

test('the identity script never prints a key, even in its error output', () => {
  // A fake `weed` that fails and echoes its whole stdin (keys included), and a
  // fake curl: the script must report the failure without a key in it.
  const dir = mkdtempSync(join(tmpdir(), 'a3-weed-'));
  try {
    // Deletes succeed; a configure fails and echoes its command line (keys
    // included) plus an error line that quotes the secret.
    writeFileSync(join(dir, 'weed'), '#!/bin/sh\nin=$(cat)\ncase "$in" in *-delete*) exit 0;; esac\nprintf \'%s\\n\' "$in"\nprintf \'error: invalid value %s\\n\' "$(printf \'%s\' "$in" | sed -n \'s/.*-secret_key \\([^ ]*\\).*/\\1/p\')"\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(dir, 'curl'), '#!/bin/sh\necho 000\n', { mode: 0o755 });
    const keys = ['AKAPPKEY000000001', 'appSecretValue000000001', 'AKADMKEY000000001', 'admSecretValue000000001'];
    const r = spawnSync('sh', ['-c', L.storageIdentityScript()], { input: `${keys.join('\n')}\n`, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    assert.notEqual(r.status, 0);
    for (const k of keys) assert.ok(!`${r.stdout}${r.stderr}`.includes(k), `key ${k} printed`);
    assert.match(r.stdout, /^FAIL:configure-admin$/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('object count parse and script shape', () => {
  assert.equal(L.parseObjectCount('COUNT:1103\n'), 1103);
  assert.equal(L.parseObjectCount('COUNT:error:http-403\n'), null);
  assert.equal(L.parseObjectCount(''), null);
  const s = L.objectCountScript();
  assert.match(s, /^IFS= read -r AK; IFS= read -r SK/);
  assert.match(s, /continuation-token/);
  assert.equal(syntaxOk(s).status, 0, syntaxOk(s).stderr);
});

test('credential and master key validation', () => {
  assert.equal(L.storageCredentialError({ accessKeyId: 'AKIAEXAMPLE00001', secretAccessKey: 'abcDEF123/+=_-.xyz0000' }, 'app'), null);
  assert.ok(L.storageCredentialError({ accessKeyId: 'short', secretAccessKey: 'x'.repeat(20) }, 'app'));
  assert.ok(L.storageCredentialError({ accessKeyId: 'AKIAEXAMPLE00001', secretAccessKey: 'has space in it 0000' }, 'app'));
  assert.ok(L.storageCredentialError({ accessKeyId: 'AKIAEXAMPLE00001', secretAccessKey: 'quote"inside0000000' }, 'app'));
  assert.ok(L.storageCredentialError(null, 'admin'));
  assert.equal(L.masterKeyError(generateMasterKey()), null);
  assert.ok(L.masterKeyError('abc'));
  assert.ok(L.masterKeyError(Buffer.alloc(16).toString('base64')));
});

test('job unit names are strict; the job and CLI scripts quote the socket URL', () => {
  assert.equal(L.foundationJobUnit('job_01-ab'), 'mock2-foundation-job-job_01-ab');
  for (const bad of ['', '../x', 'a b', 'a;b', 'x'.repeat(65), '-lead']) assert.throws(() => L.foundationJobUnit(bad), bad);
  for (const s of [L.foundationJobScript(), L.foundationCliScript()]) {
    assert.equal(syntaxOk(s).status, 0, syntaxOk(s).stderr);
    assert.ok(s.includes(`'${FOUNDATION_DATABASE_URL}'`) || s.includes(`'--setenv=DATABASE_URL=${FOUNDATION_DATABASE_URL}'`), 'the & in the socket URL must be quoted');
  }
  assert.equal(L.foundationCliArgsError(['health', '--json']), null);
  assert.ok(L.foundationCliArgsError(['rm', '-rf']));
  assert.ok(L.foundationCliArgsError(['health', 'a\nb']));
});

test('every generated guest script is valid sh; the clone pipe is valid bash', () => {
  const layout = L.DEFAULT_LAYOUT;
  for (const [name, s] of Object.entries({
    probe: L.dockerProbeScript(), files: L.writeFilesScript(L.buildFoundationFiles(), layout), key: L.masterKeyScript(layout),
    sql: L.foundationReadOnlySqlScript(layout), dump: L.foundationDumpScript(layout),
  })) {
    const r = syntaxOk(s);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
  for (const [sf, tf] of [[true, true], [false, true], [true, false]]) {
    const pipe = L.clonePipeScript({ source: 'm2-1', target: 'm2-2', sourceFoundation: sf, targetFoundation: tf });
    assert.equal(syntaxOk(pipe, 'bash').status, 0);
    assert.match(pipe, /^set -o pipefail/);
    if (sf) for (const t of L.CLONE_EXCLUDED_TABLE_DATA) assert.ok(pipe.includes(`--exclude-table-data=${t}`));
  }
  assert.throws(() => L.clonePipeScript({ source: 'm2-1; rm -rf /', target: 'm2-2', sourceFoundation: true, targetFoundation: true }));
});

test('writeFilesScript is idempotent on disk; masterKeyScript writes 0600 and reports unchanged', () => {
  const base = mkdtempSync(join(tmpdir(), 'a3-files-'));
  try {
    const layout = L.resolveLayout({ dir: join(base, 'stack'), socketDir: join(base, 'sock'), keyFile: join(base, 'key', 'master.key') });
    const files = L.buildFoundationFiles({ layout });
    const first = L.parseWriteFiles(sh(L.writeFilesScript(files, layout)).stdout);
    assert.equal(first.wrote.length, files.length);
    const second = L.parseWriteFiles(sh(L.writeFilesScript(files, layout)).stdout);
    assert.equal(second.changed, false);
    assert.equal(second.same.length, files.length);
    assert.equal(readFileSync(join(base, 'stack', 'compose.yaml'), 'utf8'), files[0].content);
    assert.equal(statSync(join(base, 'stack', 'postgres', 'entrypoint.sh')).mode & 0o777, 0o755);
    const key = generateMasterKey();
    const k1 = L.parseMasterKey(sh(L.masterKeyScript(layout), { input: `${key}\n` }).stdout);
    assert.equal(k1.state, 'written'); assert.equal(k1.mode, '600');
    const k2 = L.parseMasterKey(sh(L.masterKeyScript(layout), { input: `${key}\n` }).stdout);
    assert.equal(k2.state, 'unchanged');
    assert.equal(readFileSync(layout.keyFile, 'utf8'), `${key}\n`);
    assert.equal(statSync(join(base, 'key')).mode & 0o777, 0o700);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('resolveLayout validates names, paths and the socket path length', () => {
  assert.equal(L.resolveLayout().composeFile, STACK.composeFile);
  assert.throws(() => L.resolveLayout({ composeProject: 'Bad Name' }));
  assert.throws(() => L.resolveLayout({ dir: '/opt/../etc' }));
  assert.throws(() => L.resolveLayout({ socketDir: `/${'x'.repeat(95)}` }));
  assert.throws(() => L.resolveLayout({ ports: { storage: 0 } }));
  assert.equal(L.foundationPgExecPrefix(), "'docker' 'compose' '-p' 'mock2-foundation' '-f' '/opt/mock2-foundation/compose.yaml' exec -T postgres");
});

// --------------------------------------------- exec module with a fake guest

function fakeGuest(overrides = {}) {
  const calls = [];
  const healthy = ['postgres', 'storage', 'embeddings'].map((s) => JSON.stringify({ Service: s, State: 'running', Health: 'healthy' })).join('\n');
  const respond = (argv, opts) => {
    const text = argv.join(' ');
    for (const [re, res] of Object.entries(overrides)) if (new RegExp(re).test(text)) return typeof res === 'function' ? res(argv, opts) : res;
    if (argv[0] === 'sh' && text.includes('DOCKER:')) return { code: 0, stdout: 'DOCKER:26.1.5\nCOMPOSE:2.26.1\nDRIVER:overlay2\n', stderr: '' };
    if (argv[0] === 'sh' && text.includes('KEY:')) return { code: 0, stdout: 'KEY:written\nMODE:600:root\n', stderr: '' };
    if (argv[0] === 'sh' && text.includes('WROTE:')) return { code: 0, stdout: 'WROTE:compose.yaml\n', stderr: '' };
    if (text.includes(' ps --all --format json')) return { code: 0, stdout: healthy, stderr: '' };
    if (text.includes(' psql ')) return { code: 0, stdout: opts?.input?.includes('pg_extension') ? '0.8.7\n7\n' : '', stderr: '' };
    if (text.includes('exec -T storage sh -c') && text.includes('s3.configure')) return { code: 0, stdout: 'OK:admin\nOK:app\nOK:bucket-created\nANON:403\nAPPKEY:200\nADMINKEY:200\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const exec = async (name, argv, opts = {}) => { calls.push({ name, argv, input: opts.input ?? null }); return respond(argv, opts); };
  return { exec, calls };
}
const CREDS = { app: { accessKeyId: 'AKAPPKEY000000001', secretAccessKey: 'appSecretValue000000001' }, admin: { accessKeyId: 'AKADMKEY000000001', secretAccessKey: 'admSecretValue000000001' } };
const FEATURES = { storage: { state: 'on', provider: 'bundled' }, embeddings: { state: 'off', provider: 'local' } };

test('bringUpFoundation: the step order, secrets only on stdin, embeddings off → stopped', async (t) => {
  const g = fakeGuest();
  S._setFoundationGuestExecForTests(g.exec);
  t.after(() => S._setFoundationGuestExecForTests());
  const key = generateMasterKey();
  const labels = [];
  const r = await S.bringUpFoundation({ containerName: 'm2-7', features: FEATURES, masterKey: key, storageCredentials: CREDS, onStep: (n) => labels.push(n) });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.steps.map((s) => s.name), ['docker', 'master-key', 'files', 'pull', 'up', 'healthy', 'schema', 'storage-identities', 'features']);
  assert.deepEqual(labels, r.steps.map((s) => s.name));
  const secrets = [key, ...Object.values(CREDS).flatMap((c) => [c.accessKeyId, c.secretAccessKey])];
  for (const c of g.calls) for (const s of secrets) assert.ok(!c.argv.join(' ').includes(s), `a secret is in argv: ${c.argv.slice(0, 6).join(' ')}`);
  const ident = g.calls.find((c) => c.argv.join(' ').includes('s3.configure'));
  assert.equal(ident.input, `${CREDS.app.accessKeyId}\n${CREDS.app.secretAccessKey}\n${CREDS.admin.accessKeyId}\n${CREDS.admin.secretAccessKey}\n`);
  assert.equal(g.calls.find((c) => c.argv.join(' ').includes('KEY:')).input, `${key}\n`);
  const up = g.calls.find((c) => c.argv.includes('up'));
  assert.deepEqual(up.argv.slice(-4), ['up', '-d', 'postgres', 'storage']);
  const stop = g.calls.find((c) => c.argv.includes('stop'));
  assert.deepEqual(stop.argv.slice(-2), ['stop', 'embeddings']);
  for (const c of g.calls) assert.ok(c.argv[0] === 'sh' || c.argv[0] === 'docker', c.argv[0]);
  for (const c of g.calls.filter((x) => x.argv[0] === 'docker')) assert.deepEqual(c.argv.slice(0, 6), ['docker', 'compose', '-p', 'mock2-foundation', '-f', '/opt/mock2-foundation/compose.yaml']);
  assert.ok(!JSON.stringify(r).includes(CREDS.app.secretAccessKey));
});

test('bringUpFoundation pulls only pinned images the guest does not have', async (t) => {
  t.after(() => S._setFoundationGuestExecForTests());
  const present = (argv) => ({ code: 0, stdout: argv.slice(4).map((r) => (r.includes('text-embeddings') ? `MISSING:${r}` : `PRESENT:${r}`)).join('\n'), stderr: '' });
  const g = fakeGuest({ 'PRESENT:': present });
  S._setFoundationGuestExecForTests(g.exec);
  const r = await S.bringUpFoundation({ containerName: 'm2-7', features: FEATURES, storageCredentials: CREDS });
  assert.equal(r.ok, true, r.error);
  const pulls = g.calls.filter((c) => c.argv.includes('pull'));
  assert.equal(pulls.length, 1, 'only the missing (embeddings, off) image is pulled, best-effort');
  assert.ok(pulls[0].argv.includes('--ignore-pull-failures'));
  assert.match(r.steps.find((s) => s.name === 'pull').detail, /all images already present/);
  const refs = g.calls.find((c) => c.argv.join(' ').includes('PRESENT:')).argv.slice(4);
  assert.deepEqual(refs, Object.values(L.FOUNDATION_IMAGES));
});

test('bringUpFoundation: every failure is reported at its step with an actionable message', async (t) => {
  t.after(() => S._setFoundationGuestExecForTests());
  const run = async (overrides) => {
    S._setFoundationGuestExecForTests(fakeGuest(overrides).exec);
    return S.bringUpFoundation({ containerName: 'm2-7', features: FEATURES, masterKey: generateMasterKey(), storageCredentials: CREDS });
  };
  let r = await run({ 'DOCKER:': { code: 0, stdout: 'DOCKER:missing\n', stderr: '' } });
  assert.equal(r.ok, false); assert.equal(r.steps.at(-1).name, 'docker'); assert.match(r.error, /docker\.io/);
  r = await run({ ' pull --quiet postgres storage': { code: 1, stdout: '', stderr: 'toomanyrequests' } });
  assert.equal(r.steps.at(-1).name, 'pull'); assert.match(r.error, /registr/);
  r = await run({ 's3.configure': { code: 0, stdout: 'OK:admin\nOK:app\nOK:bucket-exists\nANON:200\nAPPKEY:200\nADMINKEY:200\n', stderr: '' } });
  assert.equal(r.steps.at(-1).name, 'storage-identities'); assert.match(r.error, /anonymous/);
  r = await run({ ' psql ': { code: 3, stdout: '', stderr: 'ERROR: boom' } });
  assert.equal(r.steps.at(-1).name, 'schema'); assert.match(r.error, /boom/);
  const bad = await S.bringUpFoundation({ containerName: 'm2-7', features: FEATURES, storageCredentials: { app: CREDS.app, admin: CREDS.app } });
  assert.match(bad.error, /different access keys/);
});

test('foundationCompose refuses volume deletion before running anything; status and switches', async (t) => {
  const g = fakeGuest({ ' ps --all --format json': { code: 0, stdout: '{"Service":"postgres","State":"running","Health":"healthy"}\n', stderr: '' } });
  S._setFoundationGuestExecForTests(g.exec);
  t.after(() => S._setFoundationGuestExecForTests());
  const r = await S.foundationCompose('m2-7', ['down', '-v']);
  assert.equal(r.refused, true);
  assert.equal(g.calls.length, 0);
  const st = await S.foundationServiceStatus('m2-7');
  assert.deepEqual(st.map((s) => s.state), ['running', 'absent', 'absent']);
  assert.equal((await S.setFoundationService('m2-7', 'postgres', 'stop')).ok, false);
  assert.equal((await S.setFoundationService('m2-7', 'storage', 'start')).ok, true);
  assert.deepEqual(g.calls.at(-1).argv.slice(-4), ['up', '-d', '--no-deps', 'storage']);
  assert.equal((await S.setFoundationService('m2-7', 'nope', 'start')).ok, false);
  await S.foundationPsql('m2-7', 'SELECT 1;');
  assert.deepEqual(g.calls.at(-1).argv.slice(6), ['exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'app', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A']);
  assert.equal(g.calls.at(-1).input, 'SELECT 1;');
  const j = await S.runFoundationJobDetached('m2-7', 'job-1');
  assert.equal(j.unit, 'mock2-foundation-job-job-1');
  assert.deepEqual(g.calls.at(-1).argv.slice(-2), ['/srv/app', 'job-1']);
  assert.equal((await S.runFoundationJobDetached('m2-7', 'a;b')).ok, false);
  await S.foundationCli('m2-7', ['health', '--json']);
  assert.deepEqual(g.calls.at(-1).argv.slice(-3), ['/srv/app', 'health', '--json']);
  assert.equal((await S.foundationCli('m2-7', ['bogus'])).code, null);
  assert.equal(await S.bundledStorageObjectCount('m2-7', { accessKeyId: 'x', secretAccessKey: 'y' }), null);
});

// ------------------------------------------------------------------- wiring

test('setup script: native output unchanged; foundation installs Docker + Compose + psql client, fatally', () => {
  const native = buildContainerSetupScript({});
  assert.equal(buildContainerSetupScript({ foundation: false }), native);
  assert.match(native, /apt-get install -y --no-install-recommends postgresql \|\| echo/);
  assert.doesNotMatch(native, /docker/);
  const f = buildContainerSetupScript({ foundation: true });
  assert.match(f, /apt-get install -y --no-install-recommends docker\.io docker-compose postgresql-client; then/);
  assert.match(f, /exit 41/); assert.match(f, /exit 42/); assert.match(f, /exit 43/);
  assert.match(f, /docker compose version/);
  assert.doesNotMatch(f, /install -y --no-install-recommends postgresql \|\|/);
  assert.doesNotMatch(f, /su - postgres/);
  assert.doesNotMatch(f, /CREATE ROLE app LOGIN PASSWORD/);
  for (const s of [native, f]) assert.equal(syntaxOk(s).status, 0, syntaxOk(s).stderr);
  // Same script apart from the database segments.
  assert.equal(f.split('\n')[0], native.split('\n')[0]);
  assert.ok(f.includes('mock2-dev.service'));
});

test('smoke DB connector: the scratch DSN keeps a socket URL\'s query string (and works for TCP URLs)', () => {
  const line = smokeScratchDbScript().split('\n').find((l) => l.startsWith('SDSN='));
  for (const [dsn, want] of [
    ['postgres://app:app@127.0.0.1:5432/app', 'postgres://app:app@127.0.0.1:5432/smoke_mig_42'],
    [FOUNDATION_DATABASE_URL, FOUNDATION_DATABASE_URL.replace('///app?', '///smoke_mig_42?')],
  ]) {
    const r = sh(`DSN='${dsn}'; SMOKEDB=smoke_mig_42; ${line}; printf '%s' "$SDSN"`);
    assert.equal(r.stdout, want, r.stderr);
  }
  assert.match(smokeScratchDbScript(), /\[ -S '\/run\/mock2-foundation\/postgres\/\.s\.PGSQL\.5432' \]; then DSN='postgres:\/\/\/app\?host=\/run\/mock2-foundation\/postgres&user=app'/);
  assert.match(smokeScratchDbScript(), /NO_SCRATCH_DSN/);
});

test('e2e server: falls back to the foundation socket when DATABASE_URL is unset', () => {
  const s = e2eServerMjs();
  assert.ok(s.includes(`existsSync('${STACK.postgres.socketDir}/.s.PGSQL.5432') ? '${FOUNDATION_DATABASE_URL}'`));
  assert.ok(s.includes("'postgres://app:app@127.0.0.1:5432/app'"), 'the native default stays');
  // withDatabase keeps the socket query string.
  const u = new URL(FOUNDATION_DATABASE_URL); u.pathname = '/app_e2e';
  assert.equal(u.toString(), FOUNDATION_DATABASE_URL.replace('///app?', '///app_e2e?'));
});

test('provision wiring: Docker-ready launch, setup option and bring-up only for foundation projects, before the base app', async () => {
  const src = await readFile(new URL('../mock2/provision.js', import.meta.url), 'utf8');
  assert.match(src, /const foundation = isFoundationProject\(project\);/);
  assert.match(src, /const launchFlags = foundation \? ` \$\{foundationLaunchConfigArgs\(\)\.join\(' '\)\}` : '';/);
  assert.match(src, /incus launch \$\{image\} \$\{containerName\} --network \$\{bridgeName\}\$\{launchFlags\}/);
  assert.match(src, /\.\.\.\(foundation \? \{ foundation: true \} : \{\}\)/);
  const setupAt = src.indexOf('const pushSetup = await sh(');
  const foundationAt = src.indexOf('const f = await provisionFoundation(projectId, containerName);');
  const activeAt = src.indexOf("updateProject(projectId, { lifecycle: 'active'");
  const baseAppAt = src.indexOf("await deployBaseApp(getProject(projectId), { reason: 'provision'");
  assert.ok(setupAt > 0 && foundationAt > setupAt && activeAt > foundationAt && baseAppAt > activeAt, 'bring-up must run after setup and before activation and the base app');
  assert.match(src, /if \(!f\.ok\) return bail\(f\.error\);/, 'a foundation failure fails provisioning');
  assert.match(src, /await import\('\.\/foundation-store\.js'\)/);
  // The native clone pipe is unchanged.
  assert.ok(src.includes("`incus exec ${sourceContainerName} -- su - postgres -c 'pg_dump --clean --if-exists app' | incus exec ${containerName} -- su - postgres -c 'psql -q -v ON_ERROR_STOP=0 app' 2>&1 | tail -n 3`"));
});

test('MCP SQL tools: foundation projects use the stack; restore is refused for them', async () => {
  const src = await readFile(new URL('../routes/mcp-tools/project-config.js', import.meta.url), 'utf8');
  assert.match(src, /fstack \? fstack\.foundationReadOnlySqlScript\(\)/);
  assert.match(src, /fstack \? fstack\.foundationDumpScript\(\)/);
  assert.match(src, /restore_project_db does not support foundation projects yet/);
  const script = L.foundationReadOnlySqlScript();
  assert.match(script, /BEGIN READ ONLY/);
  assert.match(script, /statement_timeout = 30000/);
  assert.match(script, /exec -T postgres psql -X -v ON_ERROR_STOP=1 -U postgres -d app/);
});
