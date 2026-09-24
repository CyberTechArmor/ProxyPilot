import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { profileIsolationError, guestIsolation, sizeBytes } from '../lib/guest-isolation.js';
import { validateLifecycleParams, lifecycleArgv } from '../lib/setup-engine/lifecycle-logic.js';
import { runConfigOperation } from '../lib/setup-engine/config-op.js';
import { migrateEditorKeyLifecycle, editorAuthorityError } from '../lib/editor-key-lifecycle.js';
import { networkConfigArgv } from '../lib/incus-network-policy.js';
import { validateTarget } from '../lib/migration/plan.js';
import { READER_PYTHON, READER_QUERY_SCRIPT } from '../lib/project-sql-reader.js';
import { VM_DISK_SCRIPT } from '../lib/setup-engine/vm-disk-growth.js';

test('launch refuses privileged/raw settings and unsafe inherited profiles', () => {
  const base = { container: 'pp-test', image: 'images:debian/13' };
  for (const config of [{ 'security.privileged': 'true' }, { 'raw.lxc': 'lxc.apparmor.profile=unconfined' }]) {
    assert.equal(validateLifecycleParams('instance_create', { ...base, config }).ok, false);
    assert.throws(() => lifecycleArgv('instance_create', { ...base, config }));
  }
  assert.ok(lifecycleArgv('instance_create', base).includes('security.privileged=false'));
  const vm = lifecycleArgv('instance_create', { ...base, vm: true, rootSize: '100GiB' });
  assert.ok(vm.includes('--vm')); assert.ok(vm.includes('root,size=100GiB'));
  assert.equal(vm.some(v => v.startsWith('security.')), false);
  assert.match(profileIsolationError({ config: { 'security.privileged': 'true' }, devices: {} }), /Privileged/);
  assert.match(profileIsolationError({ config: {}, devices: { host: { type: 'disk', path: '/host', source: '/' } } }), /host mounts/);
  assert.equal(profileIsolationError({ config: {}, devices: { root: { type: 'disk', path: '/', pool: 'default' } } }), null);
  assert.equal(guestIsolation({ expanded_config: { 'security.privileged': 'true' } }).migration_required, true);
  assert.equal(guestIsolation({ type: 'virtual-machine' }).boundary, 'guest-kernel');
});

test('container to VM migration requires application mode, not a rootfs-to-disk relabel', () => {
  const base = { name: 'replacement', type: 'virtual-machine', source_kind: 'lxc', disk_gb: 100 };
  assert.match(validateTarget({ ...base, mode: 'whole-machine' }).error, /bootable VM disk/);
  assert.equal(validateTarget({ ...base, mode: 'application', app_dirs: ['/srv/app'] }).spec.type, 'virtual-machine');
});

test('network settings are typed argv and the whole batch validates before use', () => {
  assert.deepEqual(networkConfigArgv('incusbr0', { 'ipv4.address': '10.9.0.1/24', 'ipv4.nat': 'true' }), [
    ['network','set','incusbr0','ipv4.address','10.9.0.1/24'], ['network','set','incusbr0','ipv4.nat','true'],
  ]);
  for (const value of ['auto;id', '$(id)', 'auto\ntrue', '10.9.0.1/99']) assert.throws(() => networkConfigArgv('incusbr0', { 'ipv4.address': value }));
  assert.throws(() => networkConfigArgv('incusbr0', { 'ipv4.nat': 'true', 'raw.dnsmasq': 'anything' }));
});

test('editor key migration preserves secrets but makes legacy authority finite', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE lxc_editor_keys(id INTEGER PRIMARY KEY, created_by TEXT, token_hash TEXT, revoked_at TEXT); INSERT INTO lxc_editor_keys VALUES(1,'a','unchanged',NULL)");
  migrateEditorKeyLifecycle(db);
  const key = db.prepare('SELECT * FROM lxc_editor_keys').get();
  assert.equal(key.token_hash, 'unchanged');
  assert.ok(Date.parse(key.expires_at) > Date.now());
  assert.ok(Date.parse(key.expires_at) <= Date.now() + 31 * 86400000);
  assert.equal(editorAuthorityError(key, { role: 'admin' }), null);
  assert.ok(editorAuthorityError(key, { role: 'user' }));
  assert.ok(editorAuthorityError({ ...key, expires_at: null }, { role: 'admin' }));
  db.close();
});

test('SQLite timestamps have the same security meaning in every host timezone', () => {
  const url = new URL('../lib/utc-time.js', import.meta.url).href;
  for (const TZ of ['UTC', 'Asia/Seoul', 'America/Los_Angeles']) {
    const r = spawnSync(process.execPath, ['--input-type=module','-e', `import {utcTimestamp} from ${JSON.stringify(url)}; process.stdout.write(String(utcTimestamp('2026-09-24 12:34:56')));`], { env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(r.status, 0); assert.equal(Number(r.stdout), Date.parse('2026-09-24T12:34:56Z'));
  }
});

function diskHost({ unsupported = false, space = 1e12 } = {}) {
  const calls = [];
  const instance = { name: 'pp-vm', type: 'virtual-machine', status: 'Running', config: {}, devices: { root: { type: 'disk', path: '/', pool: 'default', size: '100GB' } } };
  let facts = { disk_bytes: 100e9, partition_bytes: 99e9, fs_bytes: 98e9 };
  return { calls, exec: { host: async argv => {
    calls.push(argv);
    if (argv[1] === 'list') return { code: 0, stdout: JSON.stringify([instance]) };
    if (argv[1] === 'query') return { code: 0, stdout: JSON.stringify({ space: { total: 1e12, used: 1e12 - space } }) };
    if (argv[1] === 'exec') {
      if (unsupported) return { code: 1, stderr: 'Unsupported root layout' };
      if (argv.at(-1) === 'grow') facts = { disk_bytes: 120e9, partition_bytes: 119e9, fs_bytes: 118e9 };
      return { code: 0, stdout: JSON.stringify(facts) };
    }
    if (argv[1] === 'config' && argv[3] === 'override') {
      instance.devices.root.size = argv.at(-1).split('=')[1]; facts.disk_bytes = sizeBytes(instance.devices.root.size);
      return { code: 0, stdout: '' };
    }
    throw new Error(`Unexpected operation ${argv.slice(0,4).join(' ')}`);
  } } };
}
test('VM disk growth expands the virtual disk and verifies partition/filesystem in the durable operation', async () => {
  const host = diskHost();
  const r = await runConfigOperation({ kind: 'config_set', params: { container: 'pp-vm', rootSize: '120GB' }, exec: host.exec });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(host.calls.some(a => a[1] === 'config'));
  assert.ok(host.calls.some(a => a[1] === 'exec' && a.at(-1) === 'grow'));
});
test('shrink, unknown layout and insufficient pool reserve are refused before any disk write', async () => {
  for (const [options, rootSize] of [[{}, '50GB'], [{ unsupported: true }, '120GB'], [{ space: 20e9 }, '120GB']]) {
    const host = diskHost(options);
    const r = await runConfigOperation({ kind: 'config_set', params: { container: 'pp-vm', rootSize }, exec: host.exec });
    assert.equal(r.ok, false); assert.equal(r.refused, true);
    assert.equal(host.calls.some(a => a[1] === 'config' || a.at(-1) === 'grow'), false);
  }
});
test('generated guest programs parse and SQL never enters a command string', () => {
  for (const script of [READER_PYTHON, VM_DISK_SCRIPT]) {
    const r = spawnSync('python3', ['-c','import ast,sys; ast.parse(sys.stdin.read())'], { input: script, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const r = spawnSync('sh', ['-n'], { input: READER_QUERY_SCRIPT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
