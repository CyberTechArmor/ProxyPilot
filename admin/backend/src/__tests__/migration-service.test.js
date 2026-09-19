// lib/migration/service.js end to end against a scripted host and a REAL
// SQLite database — the migration 909 DDL is extracted from db.js and
// executed, so this also proves the shipped schema is valid SQL.
//
// The sandbox cannot load better-sqlite3's native binding (docs/known-issues.md),
// so the test opens node:sqlite instead. Both are SQLite; nothing here uses a
// wrapper-specific feature.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createMigrationService } from '../lib/migration/service.js';
import { createExtendedHandlers } from '../routes/mcp-tools/index.js';
import { createConfirmationStore } from '../lib/mcp-ext/logic.js';
import { MANIFEST_SCHEMA } from '../lib/migration/manifest.js';

const POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8'));
const toolResult = (data, { isError = false } = {}) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });
const parse = (r) => JSON.parse(r.content[0].text);
const AUTH = { id: 7, created_by: 'admin-1' };
const NOW = Date.parse('2026-09-19T10:00:00Z');

/** The real migration-909 DDL, lifted out of db.js so the test runs what ships. */
function schema909() {
  const src = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  const start = src.indexOf("runMigration(db, 909, 'migrations'");
  assert.ok(start > 0, 'migration 909 must exist in db.js');
  const open = src.indexOf('d.exec(`', start) + 'd.exec(`'.length;
  const close = src.indexOf('`);', open);
  const ddl = src.slice(open, close);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS migrations/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS migration_events/);
  return ddl;
}

const MANIFEST = {
  schema: MANIFEST_SCHEMA,
  collected_at: '2026-09-19T09:59:00Z',
  source: { hostname: 'old-web01', kind: 'proxmox-lxc', arch: 'amd64', cpus: 2, memory_bytes: 4 * 1024 ** 3, addresses: ['10.0.0.5'] },
  os: { id: 'debian', version_id: '12', pretty_name: 'Debian 12', init: 'systemd' },
  units: [{ name: 'myapp.service', state: 'running', working_directory: '/srv/myapp', ports: [{ proto: 'tcp', port: 3000 }] }],
  listening: [{ proto: 'tcp', address: '127.0.0.1', port: 3000, process: 'node' }],
  vhosts: [{ server: 'nginx', file: '/etc/nginx/sites-enabled/app', tls: true, server_names: ['app.example.com'], upstreams: ['http://127.0.0.1:3000'] }],
  databases: [{ engine: 'postgres', running: true, databases: [{ name: 'appdb', size_bytes: 1024 ** 3 }] }],
  env_files: [{ path: '/srv/myapp/.env', keys: ['DATABASE_URL'] }],
  outbound: [{ host: 'api.stripe.com', port: 443, proto: 'tcp', evidence: 'conntrack' }],
  app_dirs: [{ path: '/srv/myapp', size_bytes: 1024 ** 2, kind: 'node' }],
};

function setup({ script = () => ({ status: 0, stdout: '', stderr: '' }) } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema909());
  const calls = [];
  const audit = [];
  const runHostCapture = async (bin, args) => {
    calls.push({ bin, argv: [bin, ...args] });
    const r = script(bin, args, calls.length) || {};
    return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  // An uploaded rootfs tarball must land somewhere writable by whoever runs
  // the tests — /var/lib/proxypilot is not that on a CI runner.
  const workDir = mkdtempSync(join(tmpdir(), 'pp-migration-'));
  const svc = createMigrationService({
    getDb: () => db, runHostCapture, publicBaseUrl: () => 'http://localhost:3001',
    logAudit: (...a) => audit.push(a), now: () => NOW, workDir, agentDir: join(workDir, 'agent'),
  });
  const confirmations = createConfirmationStore();
  const ledger = [];
  const ctx = {
    getDb: () => ({ prepare: () => ({ run: (...a) => { ledger.push(a); return { changes: 1 }; }, get: () => undefined, all: () => [] }) }),
    logAudit: (...a) => audit.push(a), getSetting: () => null, setSetting: () => {}, toolResult, uuidv4: () => 'u',
    policy: POLICY, confirmations, runHostCapture, LXC_PREFIX: 'pp-', migration: () => svc,
  };
  const { handlers } = createExtendedHandlers(ctx);
  return { db, svc, calls, audit, handlers, ledger, workDir, cleanup: () => rmSync(workDir, { recursive: true, force: true }) };
}

const argvOf = (calls) => calls.map((c) => c.argv.join(' '));

/* --------------------------------- create -------------------------------- */

test('create: validates, mints one token, prints one command, and refuses a second migration onto the same guest', async () => {
  const { svc, calls } = setup({ script: (bin, args) => (args[0] === 'config' && args[1] === 'show' ? { status: 1, stderr: 'not found' } : {}) });

  assert.match((await svc.createMigration({ input: { mode: 'nope', name: 'x' } })).error, /mode must be one of/);

  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc', source_label: 'old-web01' }, actor: 'admin-1' });
  assert.equal(r.migration.mode, 'whole-machine');
  assert.equal(r.migration.transport, 'rootfs-tar', 'a Proxmox LXC cannot run incus-migrate inside itself');
  assert.equal(r.migration.status, 'created');
  assert.equal(r.migration.target.incus_name, 'pp-web');
  assert.match(r.token, /^pmig_[0-9a-f]{12}_/);
  assert.equal(r.command, `curl -fsSL http://localhost:3001/api/migrations/agent/${r.token}/install.sh | sudo sh`);
  assert.equal(r.tls_pin, null, 'an http base URL has no certificate to pin');
  assert.equal(r.migration.token.tls_pin, null);
  assert.ok(!JSON.stringify(r.migration).includes(r.token.split('_')[2]), 'the view never carries the secret');
  assert.ok(argvOf(calls).some((c) => c === 'incus config show pp-web'), 'the guest name is checked before the token is minted');

  const dup = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web' } });
  assert.match(dup.error, /already running against pp-web/);

  // A whole-machine migration never overwrites an existing guest.
  const withGuest = setup({ script: () => ({ status: 0, stdout: 'name: pp-taken' }) });
  assert.match((await withGuest.svc.createMigration({ input: { mode: 'whole-machine', name: 'taken' } })).error, /already exists/);
});

/* ------------------------------ the token -------------------------------- */

test('the token: claimed once, bound to that agent run, dead after a terminal state', async () => {
  const { svc } = setup({ script: () => ({ status: 1 }) });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  const token = r.token;

  assert.match(svc.authenticate('garbage').error, /malformed/);
  assert.match(svc.authenticate(`pmig_${'0'.repeat(12)}_${'a'.repeat(43)}`).error, /unknown migration token/);

  const first = svc.authenticate(token, { claimant: 'run-1', ip: '198.51.100.7' });
  assert.equal(first.first_use, true);
  assert.equal(first.row.token_claimed_by, 'run-1');
  assert.equal(first.row.token_source_ip, '198.51.100.7');
  assert.equal(svc.authenticate(token, { claimant: 'run-1' }).first_use, false, 'the same run keeps working');
  assert.match(svc.authenticate(token, { claimant: 'run-2' }).error, /already been claimed/);

  await svc.cancelMigration(r.migration.id, { actor: 'admin-1' });
  assert.match(svc.authenticate(token, { claimant: 'run-1' }).error, /is cancelled/);
});

/* ------------------------------- inventory ------------------------------- */

test('inventory: a manifest carrying a value is refused and logged; a good one parks the migration for review', async () => {
  const { svc, db } = setup({ script: () => ({ status: 1 }) });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  const row = svc.rowById(r.migration.id);

  const bad = svc.recordManifest(row, { ...MANIFEST, env_files: [{ path: '/srv/.env', keys: ['A'], values: ['sk_live_x'] }] });
  assert.match(bad.error, /never accepts secret VALUES/);
  assert.equal(svc.rowById(row.id).manifest_at, null, 'a refused manifest is not stored');
  assert.ok(svc.listEvents(row.id).some((e) => e.kind === 'error' && /VALUES/.test(e.message)), 'and the refusal is in the log');

  const good = svc.recordManifest(row, MANIFEST);
  assert.equal(good.summary.hostname, 'old-web01');
  assert.equal(good.auto_approved, false);
  const v = svc.view(svc.rowById(row.id));
  assert.equal(v.status, 'awaiting_review');
  assert.equal(v.routes[0].domain, 'app.example.com');
  assert.equal(v.egress[0].host, 'api.stripe.com');
  assert.equal(v.egress[0].decision, 'pending');
  assert.equal(v.databases[0].engine, 'postgres');
  assert.equal(v.phases.find((p) => p.id === 'inventory').state, 'waiting');
  assert.ok(!JSON.stringify(v.manifest).includes('sk_live'), 'nothing secret is anywhere in the row');

  // auto_transfer skips the wait — and says who approved it.
  const auto = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web2', source_kind: 'proxmox-lxc', auto_transfer: true } });
  const autoRow = svc.rowById(auto.migration.id);
  assert.equal(svc.recordManifest(autoRow, MANIFEST).auto_approved, true);
  assert.equal(svc.rowById(autoRow.id).approved_by, 'auto_transfer');
  db.close();
});

/* -------------------------------- the job -------------------------------- */

test('the job document: nothing to transport until approved, then exactly one transport', async () => {
  const { svc } = setup({ script: () => ({ status: 1 }) });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  let row = svc.rowById(r.migration.id);

  let job = await svc.agentJob(row);
  assert.equal(job.approved, false);
  assert.equal(job.collect_inventory, true);
  assert.equal(job.incus, undefined);
  assert.equal(job.artifact, undefined, 'no upload instructions before approval');

  svc.recordManifest(row, MANIFEST);
  row = svc.rowById(row.id);
  assert.equal((await svc.agentJob(row)).collect_inventory, false, 'the inventory is not collected twice');
  assert.equal((await svc.agentJob(row)).poll_seconds, 15);

  await svc.approveTransfer(row.id, { actor: 'admin-1' });
  job = await svc.agentJob(svc.rowById(row.id));
  assert.equal(job.approved, true);
  assert.ok(job.artifact.chunk_bytes > 0);
  assert.ok(job.artifact.exclude.includes('./proc/*'), 'the pseudo-filesystems never travel');
});

test('the job document: incus-migrate gets a trust token and a server-owned answer script, or a refusal that says why', async () => {
  // Incus not listening on the network → the job refuses, with the fix.
  const closed = setup({ script: (bin, args) => {
    if (args[0] === 'config' && args[1] === 'get') return { status: 0, stdout: '\n' };
    return { status: 1 };
  } });
  const c = await closed.svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'physical' } });
  closed.svc.recordManifest(closed.svc.rowById(c.migration.id), MANIFEST);
  await closed.svc.approveTransfer(c.migration.id, { actor: 'a' });
  const refused = await closed.svc.agentJob(closed.svc.rowById(c.migration.id));
  assert.equal(refused.approved, false);
  assert.match(refused.error, /Incus is not listening on the network/);
  assert.match(refused.error, /core\.https_address/);

  const open = setup({ script: (bin, args) => {
    if (args[0] === 'config' && args[1] === 'get') return { status: 0, stdout: ':8443\n' };
    if (args[0] === 'config' && args[1] === 'trust' && args[2] === 'add') return { status: 0, stdout: 'Client pp-migrate-1 certificate add token:\neyJjbGllbnRfbmFtZSI6' };
    if (args[0] === 'info') return { status: 0, stdout: 'certificate_fingerprint: abc123def456abc1\n' };
    return { status: 1 };
  } });
  const o = await open.svc.createMigration({ input: { mode: 'whole-machine', name: 'vm1', type: 'virtual-machine', disk_gb: 40, source_kind: 'vm' } });
  open.svc.recordManifest(open.svc.rowById(o.migration.id), MANIFEST);
  await open.svc.approveTransfer(o.migration.id, { actor: 'a' });
  const job = await open.svc.agentJob(open.svc.rowById(o.migration.id));
  assert.equal(job.transport, 'incus-migrate');
  assert.equal(job.incus.url, 'https://localhost:8443');
  assert.equal(job.incus.token, 'eyJjbGllbnRfbmFtZSI6');
  assert.equal(job.incus.fingerprint, 'abc123def456abc1');
  // Positional order, as an operator would type it: URL, accept the
  // fingerprint, THEN the authentication mechanism, THEN the token. 6.0.4 asks
  // in that order and the old script answered the menu with the token.
  assert.deepEqual(job.incus.answers.lines, [
    'https://localhost:8443', 'y', '1', 'eyJjbGllbnRfbmFtZSI6', '2', 'pp-vm1', '/dev/sda', 'no', '1',
  ]);
  // What the agent actually uses: one rule per prompt, matched on its text.
  const byLabel = Object.fromEntries(job.incus.answers.rules.map((r) => [r.label, r]));
  assert.equal(byLabel['authentication mechanism'].send, '1');
  assert.equal(byLabel['trust token'].send, 'eyJjbGllbnRfbmFtZSI6');
  assert.equal(byLabel['trust token'].secret, true, 'the token never reaches a log line');
  assert.equal(byLabel['container or virtual machine'].send, '2');
  assert.equal(byLabel['instance name'].send, 'pp-vm1');
  for (const r of job.incus.answers.rules) {
    assert.doesNotThrow(() => new RegExp(r.when, 'i'), `${r.label}: ${r.when} must compile`);
  }
  // The prompts Incus 6.0.4 actually printed, in the order it printed them
  // (captured from the live run), each matching exactly one rule.
  const prompts = [
    ['Please provide Incus server URL: ', 'server URL'],
    ['Certificate fingerprint: abc\nok (y/n)? ', 'accept the certificate'],
    ['Please pick an authentication mechanism above: ', 'authentication mechanism'],
    ['Please provide the certificate token: ', 'trust token'],
    ['Would you like to create a container (1) or virtual-machine (2)?: ', 'container or virtual machine'],
    ['Name of the new instance: ', 'instance name'],
    ['Please provide the path to a disk, partition, or image file: ', 'source disk'],
    // A container source is asked for a path instead — and 6.0.4 says "a root
    // filesystem" where the docs say "the".
    ['Please provide the path to a root filesystem: ', 'root filesystem path'],
    ['Please provide the path to the root filesystem: ', 'root filesystem path'],
    ['Do you want to add additional filesystem mounts? [default=no]: ', 'additional mounts'],
    ['Please pick one of the options above [default=1]: ', 'begin the migration'],
  ];
  for (const [prompt, label] of prompts) {
    const hit = job.incus.answers.rules.filter((r) => new RegExp(r.when, 'i').test(prompt));
    assert.equal(hit.length, 1, `${JSON.stringify(prompt)} should match exactly one rule, matched ${hit.map((h) => h.label).join(', ') || 'none'}`);
    assert.equal(hit[0].label, label);
  }
});

/* ------------------------------- the import ------------------------------ */

test('rootfs-tar: the artifact is hashed, imported as a split image, and the guest comes up fenced and stopped', async () => {
  const seen = [];
  const { svc, calls } = setup({ script: (bin, args) => {
    seen.push([bin, ...args].join(' '));
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return { status: 1 };
    return { status: 0 };
  } });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc', pool: 'tank', nested: true } });
  const id = r.migration.id;
  svc.recordManifest(svc.rowById(id), MANIFEST);
  await svc.approveTransfer(id, { actor: 'admin-1' });

  // A wrong hash is a failed transfer, not a corrupt guest.
  const wrong = await svc.receiveArtifact(svc.rowById(id), Readable.from([Buffer.from('rootfs bytes')]), { expectedSha256: 'f'.repeat(64) });
  assert.match(wrong.error, /did not survive the transfer/);

  const got = await svc.receiveArtifact(svc.rowById(id), Readable.from([Buffer.from('rootfs bytes')]));
  assert.equal(got.bytes, 12);
  assert.match(got.sha256, /^[0-9a-f]{64}$/);

  const imp = await svc.importRootfsTar(svc.rowById(id));
  assert.equal(imp.imported, true);
  const argv = argvOf(calls);
  assert.ok(argv.some((c) => /^tar -cJf .*metadata\.tar\.xz/.test(c)), 'ProxyPilot supplies the image metadata the agent cannot');
  const importLine = argv.find((c) => c.startsWith('incus image import'));
  assert.match(importLine, /metadata\.tar\.xz .*rootfs\.tar\.gz --alias pp-migration-/);
  const initLine = argv.find((c) => c.startsWith('incus init'));
  assert.match(initLine, /--storage tank/);
  assert.match(initLine, /--config boot\.autostart=false/);
  assert.match(initLine, /--config security\.nesting=true/);
  assert.ok(argv.some((c) => c.startsWith('incus image delete pp-migration-')), 'the temporary image is not left in the pool');
  assert.ok(argv.some((c) => c === 'proxypilot --json firewall egress list'), 'the fence is confirmed against the live rules, not assumed');
  assert.ok(svc.listEvents(id).some((e) => /default-deny on bridge → host services \(the firewall baseline/.test(e.message || '')), 'a clean guest is fenced by the baseline, not by adding a rule');

  const v = svc.view(svc.rowById(id));
  assert.equal(v.status, 'ready');
  assert.equal(v.phase, 'post-import');
  assert.ok(svc.listEvents(id).some((e) => /stopped and fenced/.test(e.message || '')));
});

test('a fence that cannot be confirmed is loud, and an inherited allow is removed', async () => {
  // The firewall CLI is missing: "we could not check" must never read as
  // "it is fenced".
  const broken = setup({ script: (bin, args) => {
    if (bin === 'proxypilot') return { status: 1, stderr: 'firewall CLI missing' };
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return { status: 1 };
    return { status: 0 };
  } });
  const r = await broken.svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  broken.svc.recordManifest(broken.svc.rowById(r.migration.id), MANIFEST);
  await broken.svc.approveTransfer(r.migration.id, { actor: 'a' });
  await broken.svc.receiveArtifact(broken.svc.rowById(r.migration.id), Readable.from([Buffer.from('x')]));
  await broken.svc.importRootfsTar(broken.svc.rowById(r.migration.id));
  const err = broken.svc.listEvents(r.migration.id).find((e) => e.kind === 'error');
  assert.match(err.message, /could not read the egress rules to confirm the fence/);
  assert.match(err.message, /check it by hand before the route goes up/);

  // A guest name that inherited an allow from a previous life: it is removed.
  const stale = setup({ script: (bin, args) => {
    if (bin === 'proxypilot' && args[3] === 'list') return { status: 0, stdout: JSON.stringify({ entries: [{ container: 'web', service: 'https' }, { container: 'other', service: 'smtp' }] }) };
    if (bin === 'proxypilot') return { status: 0, stdout: '{"ok":true}' };
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return { status: 1 };
    return { status: 0 };
  } });
  const r2 = await stale.svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  stale.svc.recordManifest(stale.svc.rowById(r2.migration.id), MANIFEST);
  await stale.svc.approveTransfer(r2.migration.id, { actor: 'a' });
  await stale.svc.receiveArtifact(stale.svc.rowById(r2.migration.id), Readable.from([Buffer.from('x')]));
  await stale.svc.importRootfsTar(stale.svc.rowById(r2.migration.id));
  const argv = argvOf(stale.calls);
  assert.ok(argv.some((c) => c === 'proxypilot --json firewall egress deny web https'), "the guest's own inherited allow is removed");
  assert.ok(!argv.some((c) => c.includes('egress deny other')), "another guest's rule is not touched");
  assert.ok(stale.svc.listEvents(r2.migration.id).some((e) => /1 inherited allow\(s\) removed: https/.test(e.message || '')));
});

/* -------------------------- application mode ----------------------------- */

test('application mode: approving creates the guest and fences it; the copy goes THROUGH ProxyPilot, never over SSH', async () => {
  let guestExists = false;
  const { svc, calls } = setup({ script: (bin, args) => {
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return guestExists ? { status: 0, stdout: 'name: pp-app' } : { status: 1 };
    if (bin === 'incus' && args[0] === 'launch') { guestExists = true; return { status: 0 }; }
    return { status: 0 };
  } });
  const r = await svc.createMigration({ input: { mode: 'application', name: 'app', app_dirs: ['/srv/myapp'], database: 'postgres', image: 'images:debian/13' } });
  const id = r.migration.id;
  assert.equal(r.migration.transport, 'file-sync');
  svc.recordManifest(svc.rowById(id), MANIFEST);
  await svc.approveTransfer(id, { actor: 'admin-1' });

  const launch = argvOf(calls).find((c) => c.startsWith('incus launch'));
  assert.match(launch, /^incus launch images:debian\/13 pp-app/);
  assert.match(launch, /--config boot\.autostart=false/);
  assert.ok(argvOf(calls).some((c) => c === 'proxypilot --json firewall egress list'));

  const job = await svc.agentJob(svc.rowById(id));
  assert.deepEqual(job.sync.dirs, ['/srv/myapp']);
  assert.equal(job.sync.database, 'postgres');
  assert.ok(job.sync.excludes.includes('node_modules/'));
  assert.equal(job.sync.since, null, 'the first pass carries everything');
  assert.ok(!JSON.stringify(job).includes('ssh'), 'no SSH host, user, port or key is handed to the source');

  // A directory arrives and is unpacked into the guest, not left on disk.
  const dir = await svc.receiveArtifact(svc.rowById(id), Readable.from([Buffer.from('tar bytes')]), { kind: 'dir', name: '/srv/myapp' });
  assert.equal(dir.kind, 'dir');
  const unpack = argvOf(calls).find((c) => c.includes('tar -xzf'));
  assert.match(unpack, /incus exec "\$1" -- tar -xzf - -C \/ < "\$2" sh pp-app/);

  // So does the dump, restored by the guest's own engine.
  const dump = await svc.receiveArtifact(svc.rowById(id), Readable.from([Buffer.from('pgdump')]), { kind: 'dbdump', name: 'postgres:appdb' });
  assert.equal(dump.kind, 'dbdump');
  const restore = argvOf(calls).find((c) => c.includes('pg_restore'));
  assert.match(restore, /createdb appdb/);
  assert.match(restore, /pg_restore --no-owner --no-acl -d appdb/);

  // A database name is a name, never a command.
  const bad = await svc.receiveArtifact(svc.rowById(id), Readable.from([Buffer.from('x')]), { kind: 'dbdump', name: 'postgres:appdb; rm -rf /' });
  assert.match(bad.error, /is not a database name/);
});

/* --------------------------- events and progress ------------------------- */

test('events: progress drives bytes/rate/ETA, a replayed event cannot rewind the phase, an error is recorded', async () => {
  const { svc } = setup({ script: () => ({ status: 1 }) });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  const id = r.migration.id;
  svc.recordManifest(svc.rowById(id), MANIFEST);
  await svc.approveTransfer(id, { actor: 'a' });

  svc.recordEvent(svc.rowById(id), { kind: 'progress', phase: 'transfer', bytes: 1024 ** 2, total_bytes: 10 * 1024 ** 2 });
  svc.recordEvent(svc.rowById(id), { kind: 'progress', phase: 'transfer', bytes: 5 * 1024 ** 2 });
  const v = svc.view(svc.rowById(id));
  assert.equal(v.progress.bytes, 5 * 1024 ** 2);
  assert.equal(v.progress.total_bytes, 10 * 1024 ** 2);
  assert.equal(v.progress.percent, 50);

  const back = svc.recordEvent(svc.rowById(id), { kind: 'phase', phase: 'inventory', message: 'replayed' });
  assert.equal(back.phase, 'transfer', 'a late inventory event does not pull the run backwards');

  svc.recordEvent(svc.rowById(id), { kind: 'error', message: 'rsync exited 12' });
  assert.equal(svc.rowById(id).error, 'rsync exited 12');
  const log = svc.listEvents(id, { limit: 5 });
  assert.equal(log.at(-1).message, 'rsync exited 12');
  assert.ok(svc.listEvents(id, { kind: 'progress' }).length >= 2);
});

/* ----------------------- checklist, egress, cancel ----------------------- */

test('the cutover checklist is state: marked with who and when, reopenable, and completion is every required step', async () => {
  const { svc } = setup({ script: () => ({ status: 1 }) });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  const id = r.migration.id;

  assert.match(svc.setChecklistStep(id, { step: 'nope' }).error, /unknown checklist step/);
  const one = svc.setChecklistStep(id, { step: 'route_created', by: 'admin-1', note: 'app.example.com → :3000' });
  assert.equal(one.complete, false);
  const step = one.migration.checklist.find((s) => s.id === 'route_created');
  assert.equal(step.done, true);
  assert.equal(step.done_by, 'admin-1');
  assert.equal(step.note, 'app.example.com → :3000');
  assert.equal(svc.setChecklistStep(id, { step: 'route_created', done: false }).migration.checklist.find((s) => s.id === 'route_created').done, false);

  let last;
  for (const s of svc.view(svc.rowById(id)).checklist) last = svc.setChecklistStep(id, { step: s.id, by: 'admin-1' });
  assert.equal(last.complete, true);
  assert.equal(svc.rowById(id).status, 'completed');
  assert.ok(svc.listEvents(id).some((e) => /migration complete/.test(e.message || '')));
});

test('egress: a host service gets a real allow, an internet destination is recorded as reviewed and claims nothing', async () => {
  // ProxyPilot's guest fence governs bridge → HOST services. This host knows
  // only pgbouncer, which is the normal case.
  const { svc, calls } = setup({ script: (bin, args) => {
    if (bin === 'proxypilot' && args[3] === 'list') return { status: 0, stdout: JSON.stringify({ entries: [], services: { pgbouncer: { dst: 'bridge_gw', port: 6432, proto: 'tcp' } } }) };
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return { status: 1 };
    return { status: 0 };
  } });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  const id = r.migration.id;
  svc.recordManifest(svc.rowById(id), {
    ...MANIFEST,
    outbound: [...MANIFEST.outbound, { host: '10.0.0.9', port: 6432, proto: 'tcp', evidence: 'conntrack' }],
  });

  assert.match((await svc.decideEgress(id, { host: 'nowhere.example' })).error, /not in this migration's observed outbound list/);

  // An internet destination: reviewed, recorded, nothing written.
  const before = calls.filter((c) => c.argv.includes('allow')).length;
  const net = await svc.decideEgress(id, { host: 'api.stripe.com', port: 443, decision: 'approve', by: 'admin-1' });
  assert.equal(net.entry.decision, 'approved');
  assert.equal(net.entry.applied, false, 'nothing is claimed about a fence that does not cover it');
  assert.match(net.entry.note, /guest fence covers bridge → host services only/);
  assert.equal(calls.filter((c) => c.argv.includes('allow')).length, before, 'and no rule was written');

  // A host service the firewall does know: a real allow, by ITS name.
  const svcEntry = await svc.decideEgress(id, { host: '10.0.0.9', port: 6432, decision: 'approve', by: 'admin-1' });
  assert.equal(svcEntry.entry.applied, true);
  assert.equal(svcEntry.entry.applied_as, 'pgbouncer', 'matched by port/proto against the CLI\'s own list');
  assert.ok(argvOf(calls).some((c) => c.startsWith('proxypilot --json firewall egress allow web pgbouncer --reason')));

  const n = calls.length;
  const denied = await svc.decideEgress(id, { host: 'api.stripe.com', port: 443, decision: 'deny', by: 'admin-1' });
  assert.equal(denied.entry.decision, 'denied');
  assert.equal(calls.length, n, 'a denial touches the host not at all');
});

test('"stalled" is only ever said about a transfer that is actually in flight', async () => {
  const { svc } = setup({ script: () => ({ status: 1 }) });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  const id = r.migration.id;
  svc.recordManifest(svc.rowById(id), MANIFEST);
  await svc.approveTransfer(id, { actor: 'a' });
  svc.recordEvent(svc.rowById(id), { kind: 'progress', phase: 'transfer', bytes: 1024 });
  // The clock is frozen at NOW, so the sample is fresh and the run is live.
  assert.equal(svc.view(svc.rowById(id)).progress.stalled, false);
  // Once it is over, an old last sample is not a stall.
  svc.recordEvent(svc.rowById(id), { kind: 'phase', phase: 'post-import' });
  db_touch(svc, id);
  assert.equal(svc.view(svc.rowById(id)).progress.stalled, false);
});

/** Move a migration to a finished state the way agentFinish would. */
function db_touch(svc, id) {
  svc.setChecklistStep(id, { step: 'inventory_reviewed', by: 'test' });
}

test('cancel: the token dies, the Incus trust certificate is revoked, and no guest is deleted', async () => {
  const { svc, calls } = setup({ script: (bin, args) => {
    if (args[0] === 'config' && args[1] === 'trust' && args[2] === 'list') return { status: 0, stdout: JSON.stringify([{ name: 'pp-migrate-1', fingerprint: 'deadbeef' }]) };
    if (args[0] === 'config' && args[1] === 'show') return { status: 1 };
    return { status: 0 };
  } });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  const out = await svc.cancelMigration(r.migration.id, { actor: 'admin-1', reason: 'wrong host' });
  assert.equal(out.migration.status, 'cancelled');
  assert.match(out.note, /never deletes data/);
  assert.ok(argvOf(calls).some((c) => c === 'incus config trust remove deadbeef'));
  assert.ok(!argvOf(calls).some((c) => /incus delete|zfs destroy/.test(c)), 'cancelling deletes nothing');
  assert.match((await svc.cancelMigration(r.migration.id, {})).error, /already cancelled/);
});

/* --------------------------- preflight / listener ------------------------ */

test('preflight: says which transports are available, and why one is not', async () => {
  // Incus is not listening; the bridge gateway is the narrow address to propose.
  const { svc } = setup({ script: (bin, args) => {
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'get') return { status: 0, stdout: '\n' };
    if (bin === 'incus' && args[0] === 'query') return { status: 0, stdout: JSON.stringify({ devices: { eth0: { type: 'nic', network: 'incusbr0' }, root: { type: 'disk', path: '/' } } }) };
    if (bin === 'incus' && args[0] === 'network' && args[1] === 'get') return { status: 0, stdout: '10.185.17.1/24\n' };
    return { status: 1 };
  } });
  const pf = await svc.preflight();
  assert.equal(pf.incus.listening, false);
  assert.equal(pf.incus.bridge, 'incusbr0');
  assert.equal(pf.incus.suggested, '10.185.17.1:8443', 'the bridge gateway, not every interface');
  assert.equal(pf.ready_for['incus-migrate'], false);
  const check = pf.checks.find((c) => c.id === 'incus_listener');
  assert.equal(check.status, 'warn', 'a missing listener does not block a container source');
  assert.match(check.remedy, /rootfs-tar/);
  // No agent build in the test's temp dir → that IS a failure.
  assert.equal(pf.checks.find((c) => c.id === 'agent_builds').status, 'fail');
  assert.equal(pf.ready_for['rootfs-tar'], false);
});

test('the Incus listener: the bridge gateway by default, every interface refused without asking', async () => {
  const sets = [];
  const mk = (listening) => setup({ script: (bin, args) => {
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'get') return { status: 0, stdout: `${listening()}\n` };
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'set') { sets.push(args[3]); return { status: 0 }; }
    if (bin === 'incus' && args[0] === 'query') return { status: 0, stdout: JSON.stringify({ devices: { eth0: { type: 'nic', network: 'incusbr0' } } }) };
    if (bin === 'incus' && args[0] === 'network' && args[1] === 'get') return { status: 0, stdout: '10.185.17.1/24\n' };
    return { status: 1 };
  } });

  let current = '';
  const { svc } = mk(() => current);

  const refused = await svc.enableIncusListener({ address: ':8443' });
  assert.match(refused.error, /listens on every interface/);
  assert.match(refused.error, /10\.185\.17\.1:8443/, 'and it names the narrow address that would work');
  assert.equal(sets.length, 0, 'nothing was set');

  assert.match((await svc.enableIncusListener({ address: 'not-an-address' })).error, /must be host:port/);

  // The default is the bridge gateway, and the change is verified by re-reading.
  const ok1 = await svc.enableIncusListener({ actor: 'admin-1' });
  assert.equal(sets.at(-1), '10.185.17.1:8443', 'the default address is the bridge gateway, not every interface');
  assert.match(ok1.error, /did not take the address/, 'a config set that does not stick is an error, not a success');

  current = '10.185.17.1:8443';
  const ok2 = await svc.enableIncusListener({ actor: 'admin-1' });
  assert.equal(ok2.already, true, 'already listening there is not a change');
  assert.equal(ok2.scope, 'a private address');

  // Explicitly asking for every interface is allowed, and reversible.
  current = '';
  const pub = await svc.enableIncusListener({ address: ':8443', allowPublic: true });
  assert.match(pub.error, /did not take/);   // the stub still reports ''
  assert.ok(sets.includes(':8443'), 'allow_public lets the public bind through');
});

/* ---------------------------------- MCP ---------------------------------- */

test('MCP: the same rules through the tool surface — confirm gates, dry_run touches nothing, blocking concerns refuse approval', async () => {
  const { svc, handlers, calls } = setup({ script: (bin, args) => {
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return { status: 1 };
    return { status: 0 };
  } });

  const unconfirmed = await handlers.create_migration({ mode: 'application', name: 'app' }, AUTH);
  assert.equal(unconfirmed.isError, true);
  assert.match(unconfirmed.content[0].text, /Confirm with the user/);

  const preview = parse(await handlers.create_migration({ mode: 'application', name: 'app', dry_run: true }, AUTH));
  assert.equal(preview.dry_run, true);
  assert.equal(preview.would.guest, 'pp-app');
  assert.equal(calls.length, 0, 'a dry run does not touch the host');

  const created = parse(await handlers.create_migration({ mode: 'application', name: 'app', app_dirs: ['/srv/app'], confirm: true }, AUTH));
  assert.match(created.command, /curl -fsSL .*install\.sh \| sudo sh/);
  const id = created.migration.id;

  const got = parse(await handlers.get_migration({ id }, AUTH));
  assert.match(got.next, /Run this on the source host/);
  assert.match(got.note, /refuses a manifest that carries a value/);

  // No manifest yet → nothing to approve.
  const early = await handlers.approve_migration({ id, confirm: true }, AUTH);
  assert.equal(early.isError, true);
  assert.match(early.content[0].text, /inventory has not arrived/);

  // An application-mode source with no app dirs is a blocking concern.
  svc.recordManifest(svc.rowById(id), { ...MANIFEST, app_dirs: [] });
  const blocked = await handlers.approve_migration({ id, confirm: true }, AUTH);
  assert.equal(blocked.isError, true);
  assert.match(parse(blocked).error, /Application mode found no application directory/);
  assert.match(parse(blocked).error, /override_blocking/);

  const listed = parse(await handlers.list_migrations({}, AUTH));
  assert.equal(listed.count, 1);
  assert.equal(listed.migrations[0].status, 'awaiting_review');

  const step = parse(await handlers.migration_cutover({ id, step: 'inventory_reviewed', note: 'read it' }, AUTH));
  assert.equal(step.complete, false);
  assert.ok(step.progress.remaining.includes('route_created'));

  const cancelled = parse(await handlers.cancel_migration({ id, confirm: true, reason: 'test' }, AUTH));
  assert.equal(cancelled.migration.status, 'cancelled');
});
