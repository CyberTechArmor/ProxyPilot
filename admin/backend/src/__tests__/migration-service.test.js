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

/**
 * The columns migrations 910 and 911 add, read out of db.js the same way, so
 * the test runs the shipped list rather than a copy that can drift. Both are
 * JS (a PRAGMA loop and a single guarded ALTER), so what is lifted is the
 * column names and types they mention.
 */
function schemaAlters(version, marker, least) {
  const src = readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  const start = src.indexOf(`runMigration(db, ${version}, '${marker}'`);
  assert.ok(start > 0, `migration ${version} must exist in db.js`);
  const body = src.slice(start, src.indexOf('\n  });', start));
  const cols = [
    ...[...body.matchAll(/\['([a-z_]+)', '([A-Z]+)'\]/g)].map((m) => [m[1], m[2]]),
    ...[...body.matchAll(/ADD COLUMN (\w+) ([A-Z]+)/g)].map((m) => [m[1], m[2]]),
  ];
  const uniq = [...new Map(cols).entries()];
  assert.ok(uniq.length >= least, `migration ${version} must add its columns`);
  return uniq.map(([col, type]) => `ALTER TABLE migrations ADD COLUMN ${col} ${type};`).join('\n');
}
const schema910 = () => schemaAlters(910, 'migration_token_lifecycle', 3);
const schema911 = () => schemaAlters(911, 'migration_capacity', 1);

/**
 * The two route tables cleanup consults before it will delete a guest. They
 * live in other migrations; only the shape this query needs is recreated.
 */
const ROUTE_TABLES = `
  CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY, lxc_container_name TEXT);
  CREATE TABLE IF NOT EXISTS service_http_routes (id INTEGER PRIMARY KEY, service_id INTEGER, domain TEXT);
`;

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
  db.exec(schema910());
  db.exec(schema911());
  db.exec(ROUTE_TABLES);
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

  const bad = await svc.recordManifest(row, { ...MANIFEST, env_files: [{ path: '/srv/.env', keys: ['A'], values: ['sk_live_x'] }] });
  assert.match(bad.error, /never accepts secret VALUES/);
  assert.equal(svc.rowById(row.id).manifest_at, null, 'a refused manifest is not stored');
  assert.ok(svc.listEvents(row.id).some((e) => e.kind === 'error' && /VALUES/.test(e.message)), 'and the refusal is in the log');

  const good = await svc.recordManifest(row, MANIFEST);
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
  assert.equal((await svc.recordManifest(autoRow, MANIFEST)).auto_approved, true);
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

  await svc.recordManifest(row, MANIFEST);
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
  await closed.svc.recordManifest(closed.svc.rowById(c.migration.id), MANIFEST);
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
  await open.svc.recordManifest(open.svc.rowById(o.migration.id), MANIFEST);
  await open.svc.approveTransfer(o.migration.id, { actor: 'a' });
  const job = await open.svc.agentJob(open.svc.rowById(o.migration.id));
  assert.equal(job.transport, 'incus-migrate');
  assert.equal(job.incus.url, 'https://localhost:8443');
  assert.equal(job.incus.token, 'eyJjbGllbnRfbmFtZSI6');
  assert.equal(job.incus.fingerprint, 'abc123def456abc1');
  // Positional order, as an operator would type it: URL, accept the
  // fingerprint, THEN the authentication mechanism, THEN the token. 6.0.4 asks
  // in that order and the old script answered the menu with the token.
  // This one asked for a 40 GB disk, so the overrides menu is answered 4
  // (change the pool or size) and then 1 (begin) — the extra trip.
  assert.deepEqual(job.incus.answers.lines, [
    'https://localhost:8443', 'y', '1', 'eyJjbGllbnRfbmFtZSI6', '2', 'pp-vm1', '/dev/sda', 'no',
    '4', '', 'yes', '40GiB', '1',
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
    ['The local Incus server is the target [default=yes]: ', 'local server is the target'],
    ['Project to create the instance in [default=default]: ', 'project'],
    ['Does the VM support UEFI booting? [default=yes]: ', 'UEFI boot'],
    ['Does the VM support UEFI Secure Boot? [default=yes]: ', 'UEFI secure boot'],
    ['Please provide the storage pool to use: ', 'storage pool'],
    ['Do you want to change the storage size? [default=no]: ', 'change the storage size'],
    ['Please specify the storage size: ', 'storage size'],
  ];
  for (const [prompt, label] of prompts) {
    const hit = job.incus.answers.rules.filter((r) => new RegExp(r.when, 'i').test(prompt));
    assert.equal(hit.length, 1, `${JSON.stringify(prompt)} should match exactly one rule, matched ${hit.map((h) => h.label).join(', ') || 'none'}`);
    assert.equal(hit[0].label, label);
  }
  // The overrides prompt is the one that matches TWO rules, deliberately: the
  // agent takes them in order, so the first ask changes the pool/size and the
  // second begins the migration.
  const menu = job.incus.answers.rules.filter((r) => new RegExp(r.when, 'i').test('Please pick one of the options above [default=1]: '));
  assert.deepEqual(menu.map((r) => [r.label, r.send, r.max]), [
    ['change the storage pool or size', '4', 1],
    ['begin the migration', '1', 2],
  ]);
  assert.equal(job.incus.answers.rules.find((r) => r.label === 'storage size').send, '40GiB');
});

test('the answer script: a pool lands the guest where the operator asked, and no pool skips the menu trip', async () => {
  const mk = (input) => setup({ script: (bin, args) => {
    if (args[0] === 'config' && args[1] === 'get') return { status: 0, stdout: '10.0.0.1:8443\n' };
    if (args[0] === 'config' && args[1] === 'trust' && args[2] === 'add') return { status: 0, stdout: 'tok' };
    if (args[0] === 'info') return { status: 0, stdout: 'certificate_fingerprint: abc123\n' };
    return { status: 1 };
  } });

  // With a pool: menu → 4 → the pool → no size change → menu → 1.
  const a = mk();
  const withPool = await a.svc.createMigration({ input: { mode: 'whole-machine', name: 'onzfs', transport: 'incus-migrate', source_kind: 'lxc', pool: 'Storage' } });
  await a.svc.recordManifest(a.svc.rowById(withPool.migration.id), MANIFEST);
  await a.svc.approveTransfer(withPool.migration.id, { actor: 'a', override: true });
  const poolJob = await a.svc.agentJob(a.svc.rowById(withPool.migration.id));
  const poolRules = Object.fromEntries(poolJob.incus.answers.rules.map((r) => [r.label, r.send]));
  assert.equal(poolRules['storage pool'], 'Storage', 'the pool the operator asked for reaches incus-migrate');
  assert.equal(poolRules['change the storage size'], 'no', 'no disk_gb means the size question is declined');
  assert.ok(!('storage size' in poolRules));
  assert.deepEqual(poolJob.incus.answers.lines.slice(-4), ['4', 'Storage', 'no', '1']);

  // Without one: there is no rule 4 at all, so the first menu ask begins.
  const b = mk();
  const plain = await b.svc.createMigration({ input: { mode: 'whole-machine', name: 'plain', transport: 'incus-migrate', source_kind: 'lxc' } });
  await b.svc.recordManifest(b.svc.rowById(plain.migration.id), MANIFEST);
  await b.svc.approveTransfer(plain.migration.id, { actor: 'a', override: true });
  const plainJob = await b.svc.agentJob(b.svc.rowById(plain.migration.id));
  const menu = plainJob.incus.answers.rules.filter((r) => new RegExp(r.when, 'i').test('Please pick one of the options above [default=1]: '));
  assert.deepEqual(menu.map((r) => r.send), ['1'], 'nothing to override, so the first ask starts the transfer');
  assert.equal(plainJob.incus.answers.lines.at(-1), '1');
  assert.ok(!plainJob.incus.answers.rules.some((r) => r.label === 'storage pool'));
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
  await svc.recordManifest(svc.rowById(id), MANIFEST);
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
  await broken.svc.recordManifest(broken.svc.rowById(r.migration.id), MANIFEST);
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
  await stale.svc.recordManifest(stale.svc.rowById(r2.migration.id), MANIFEST);
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
  await svc.recordManifest(svc.rowById(id), MANIFEST);
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
  // Decompressed on the HOST and piped in as a plain tar: the guest is a
  // fresh minimal image that may not have the zstd binary tar shells out to.
  // These nine bytes are not compressed, so the sniffer answers `cat`.
  const unpack = argvOf(calls).find((c) => c.includes('incus exec') && c.includes('tar -xf'));
  assert.match(unpack, /cat "\$2" \| incus exec "\$1" -- tar -xf - -C \/ sh pp-app/);

  // So does the dump, restored by the guest's own engine.
  const dump = await svc.receiveArtifact(svc.rowById(id), Readable.from([Buffer.from('pgdump')]), { kind: 'dbdump', name: 'postgres:appdb' });
  assert.equal(dump.kind, 'dbdump');
  const restore = argvOf(calls).find((c) => c.includes('pg_restore'));
  assert.match(restore, /cat "\$2" \| incus exec/);
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
  await svc.recordManifest(svc.rowById(id), MANIFEST);
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
  await svc.recordManifest(svc.rowById(id), {
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
  await svc.recordManifest(svc.rowById(id), MANIFEST);
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

/* -------------------------------- capacity -------------------------------- */

const GiB = 1024 ** 3;

/** A host whose pool and staging disk have exactly the room we say. */
const withSpace = ({ poolFree, poolTotal = 2000 * GiB, stagingFree, pools = [{ name: 'default', driver: 'dir' }, { name: 'Storage', driver: 'zfs' }], defaultPool = 'default' }) => ({
  script: (bin, args) => {
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return { status: 1 };
    if (bin === 'incus' && args[0] === 'query' && args[1] === '/1.0/profiles/default') {
      return { status: 0, stdout: JSON.stringify({ devices: { root: { type: 'disk', path: '/', pool: defaultPool } } }) };
    }
    if (bin === 'incus' && args[0] === 'query' && String(args[1]).includes('/resources')) {
      return { status: 0, stdout: JSON.stringify({ space: { total: poolTotal, used: poolTotal - poolFree } }) };
    }
    if (bin === 'incus' && args[0] === 'storage' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(pools) };
    if (bin === 'df') return { status: 0, stdout: `Avail\n${stagingFree}\n` };
    return { status: 0 };
  },
});

/** 400 GiB of source, which is what the shared MANIFEST does not carry. */
const BIG = { ...MANIFEST, source: { ...MANIFEST.source, root_used_bytes: 400 * GiB } };

test('capacity: measured when the inventory lands, against the pool the migration actually targets', async () => {
  const { svc, calls } = setup(withSpace({ poolFree: 900 * GiB, stagingFree: 900 * GiB }));
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc', pool: 'Storage' } });
  await svc.recordManifest(svc.rowById(r.migration.id), BIG);

  const v = svc.view(svc.rowById(r.migration.id));
  assert.equal(v.capacity.pool.name, 'Storage', 'the pool the spec named, not the profile default');
  assert.equal(v.capacity.pool.free_bytes, 900 * GiB);
  assert.equal(v.capacity.needs.pool_bytes, 400 * GiB);
  assert.equal(v.capacity.needs.staging_bytes, 200 * GiB, 'a rootfs tarball is estimated at half');
  assert.equal(v.capacity.fits, true);
  assert.ok(!v.concerns.some((c) => c.id.startsWith('capacity')), 'room to spare says nothing');
  assert.ok(argvOf(calls).some((c) => c === 'incus query /1.0/storage-pools/Storage/resources'));

  // With no pool named it asks the default profile what new guests inherit.
  const d = setup(withSpace({ poolFree: 900 * GiB, stagingFree: 900 * GiB, defaultPool: 'default' }));
  const r2 = await d.svc.createMigration({ input: { mode: 'whole-machine', name: 'web2', source_kind: 'proxmox-lxc' } });
  await d.svc.recordManifest(d.svc.rowById(r2.migration.id), BIG);
  assert.equal(d.svc.view(d.svc.rowById(r2.migration.id)).capacity.pool.name, 'default');
  d.cleanup();
});

test('capacity: a transfer that will not fit is refused at the approval, and the override is deliberate', async () => {
  const { svc, audit } = setup(withSpace({ poolFree: 100 * GiB, stagingFree: 900 * GiB }));
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc', pool: 'Storage' } });
  const id = r.migration.id;
  await svc.recordManifest(svc.rowById(id), BIG);

  const v = svc.view(svc.rowById(id));
  assert.equal(v.capacity.fits, false);
  assert.equal(v.concerns[0].level, 'block');
  assert.match(v.concerns[0].text, /400\.0 GiB is coming and Storage has 100\.0 GiB free/);

  const refused = await svc.approveTransfer(id, { actor: 'admin-1' });
  assert.match(refused.error, /will not fit/);
  assert.equal(refused.concerns[0].id, 'capacity-pool');
  assert.ok(refused.capacity, 'the refusal carries the numbers it judged on');
  assert.equal(svc.rowById(id).approved_at, null, 'nothing was approved');

  // The operator who knows better can say so, and it is recorded.
  const ok = await svc.approveTransfer(id, { actor: 'admin-1', override: true });
  assert.equal(ok.error, undefined);
  assert.equal(svc.rowById(id).status, 'running');
  assert.ok(svc.listEvents(id).some((e) => /approved over 1 blocking concern/.test(e.message)));
  assert.ok(audit.some((a) => a[1] === 'MIGRATION_APPROVE'));
});

test('capacity: re-measured at approval, because the pool may have filled since the inventory', async () => {
  let free = 900 * GiB;
  const { svc } = setup({ script: (bin, args) => {
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return { status: 1 };
    if (bin === 'incus' && args[0] === 'query' && String(args[1]).includes('/resources')) return { status: 0, stdout: JSON.stringify({ space: { total: 2000 * GiB, used: 2000 * GiB - free } }) };
    if (bin === 'incus' && args[0] === 'query') return { status: 0, stdout: JSON.stringify({ devices: { root: { pool: 'default' } } }) };
    if (bin === 'df') return { status: 0, stdout: `Avail\n${900 * GiB}\n` };
    return { status: 0 };
  } });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  await svc.recordManifest(svc.rowById(r.migration.id), BIG);
  assert.equal(svc.view(svc.rowById(r.migration.id)).capacity.fits, true);

  free = 50 * GiB;   // something else ate the pool in the meantime
  const refused = await svc.approveTransfer(r.migration.id, { actor: 'a' });
  assert.match(refused.error, /will not fit/);
  assert.equal(svc.view(svc.rowById(r.migration.id)).capacity.pool.free_bytes, 50 * GiB, 'the stored verdict is the fresh one');
});

test('a free-space figure that cannot be read is unknown, never zero', async () => {
  // A df that prints something unexpected once made every migration refuse
  // with "0.0 GiB free" — not knowing is a warning, not a block.
  const { svc } = setup({ script: (bin, args) => {
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return { status: 1 };
    if (bin === 'df') return { status: 0, stdout: 'Avail\n' };
    return { status: 0 };
  } });
  const staging = await svc.stagingSpace();
  assert.equal(staging.free_bytes, null);
  assert.match(staging.error, /could not read a free-space figure/);

  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  await svc.recordManifest(svc.rowById(r.migration.id), BIG);
  const v = svc.view(svc.rowById(r.migration.id));
  assert.equal(v.capacity.fits, true, 'unknown does not block');
  assert.ok(v.concerns.every((c) => c.level !== 'block'));
  assert.ok(v.concerns.some((c) => c.id === 'capacity-staging-unknown'));
  assert.equal((await svc.approveTransfer(r.migration.id, { actor: 'a' })).error, undefined);
});

test('preflight names every pool, its free space and which one new guests land in', async () => {
  const { svc } = setup(withSpace({ poolFree: 900 * GiB, stagingFree: 700 * GiB, defaultPool: 'Storage' }));
  const pf = await svc.preflight();
  assert.deepEqual(pf.storage.pools.map((p) => p.name), ['default', 'Storage']);
  assert.equal(pf.storage.default_pool, 'Storage');
  assert.equal(pf.storage.pools.find((p) => p.name === 'Storage').default, true);
  assert.equal(pf.storage.staging.free_bytes, 700 * GiB);
  const check = pf.checks.find((c) => c.id === 'storage');
  assert.equal(check.status, 'pass');
  assert.match(check.detail, /Storage \(default\): 900 GiB free/);
  assert.match(check.detail, /staging on .* 700 GiB free/);
});

/* --------------------------- tokens and cleanup -------------------------- */

// `incus config show` must FAIL for a whole-machine create: a guest that
// already exists is refused, and the default script succeeds at everything.
const NO_GUEST = { script: (bin, args) => (bin === 'incus' && args[0] === 'config' && args[1] === 'show' ? { status: 1 } : { status: 0 }) };

test('the token has no clock by default: it ends with the migration, or when it is revoked', async () => {
  const { svc, db } = setup(NO_GUEST);
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  const id = r.migration.id;
  assert.equal(r.expires_at, null, 'no TTL was asked for, so there is no expiry date');
  assert.match(r.note, /does not expire on a clock/);

  // A year later it still works: what ends it is the migration, not the wall.
  const far = { ...svc.rowById(id) };
  assert.equal(svc.authenticate(r.token, { claimant: 'run-1' }).error, undefined);
  assert.equal(svc.view(svc.rowById(id)).token.state, 'active');

  // An operator can still ask for one, and it is honoured.
  const ttl = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web2', source_kind: 'proxmox-lxc' }, ttlSeconds: 900 });
  assert.equal(ttl.expires_at, new Date(NOW + 900_000).toISOString());
  assert.match(ttl.note, /it expires at/);
  assert.equal(svc.view(svc.rowById(ttl.migration.id)).token.state, 'unclaimed');
  // …and a TTL in the past is what "expired" means.
  db.prepare('UPDATE migrations SET token_expires_at = ? WHERE id = ?').run(new Date(NOW - 1000).toISOString(), ttl.migration.id);
  assert.equal(svc.view(svc.rowById(ttl.migration.id)).token.state, 'expired');
  assert.match(svc.authenticate(ttl.token, { claimant: 'x' }).error, /expired/);
  assert.ok(far);
});

test('revoking a token kills it without touching the migration, and the list says which are still out there', async () => {
  const { svc } = setup(NO_GUEST);
  const a = await svc.createMigration({ input: { mode: 'whole-machine', name: 'one', source_kind: 'proxmox-lxc' } });
  const b = await svc.createMigration({ input: { mode: 'whole-machine', name: 'two', source_kind: 'proxmox-lxc' } });
  svc.authenticate(b.token, { claimant: 'run-b', ip: '10.0.0.9' });

  let list = svc.listTokens();
  assert.equal(list.tokens.length, 2);
  assert.equal(list.usable, 2, 'both are live');
  assert.deepEqual(list.counts, { unclaimed: 1, active: 1 });
  const bRow = list.tokens.find((t) => t.migration_id === b.migration.id);
  assert.equal(bRow.source_ip, '10.0.0.9');
  assert.ok(list.tokens.every((t) => !JSON.stringify(t).includes(a.token)), 'a listing never carries a secret');

  const out = svc.revokeToken(a.migration.id, { actor: 'admin-1' });
  assert.equal(out.revoked, true);
  assert.equal(out.token.state, 'revoked');
  assert.match(out.note, /migration is untouched/);
  assert.equal(svc.rowById(a.migration.id).status, 'created', 'the migration itself carries on');
  assert.match(svc.authenticate(a.token, { claimant: 'run-a' }).error, /revoked/);
  assert.match(svc.revokeToken(a.migration.id, {}).error, /already revoked/);

  list = svc.listTokens();
  assert.equal(list.usable, 1);
  assert.equal(list.tokens.find((t) => t.migration_id === a.migration.id).state, 'revoked');
  assert.equal(svc.listTokens({ state: 'revoked' }).tokens.length, 1);

  // A finished migration's token is spent, whether or not anyone revoked it.
  await svc.cancelMigration(b.migration.id, { actor: 'admin-1' });
  assert.equal(svc.listTokens().tokens.find((t) => t.migration_id === b.migration.id).state, 'spent');
  assert.equal(svc.listTokens().usable, 0);
});

test('cleanup: refuses a live migration, an adopted guest and a published one; deletes what this migration made', async () => {
  const seen = [];
  // The guest must NOT exist when the migration is created and must exist
  // when it is cleaned up — which is the real sequence.
  let guestExists = false;
  const { svc, db, audit } = setup({ script: (bin, args) => {
    seen.push([bin, ...args].join(' '));
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return guestExists ? { status: 0, stdout: 'config: {}' } : { status: 1 };
    if (bin === 'incus' && args[0] === 'list') return { status: 0, stdout: 'RUNNING\n' };
    return { status: 0 };
  } });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  const id = r.migration.id;
  guestExists = true;

  // Still running: cancel it first.
  assert.match((await svc.cleanupMigration(id, { deleteGuest: true })).error, /cancel it first/);
  await svc.cancelMigration(id, { actor: 'admin-1' });

  assert.match((await svc.cleanupMigration(id, {})).error, /nothing to do/);

  // A guest ProxyPilot adopted rather than created is never ours to delete.
  db.prepare('UPDATE migrations SET guest_created = 0 WHERE id = ?').run(id);
  assert.match((await svc.cleanupMigration(id, { deleteGuest: true })).error, /NOT created by this migration/);
  db.prepare('UPDATE migrations SET guest_created = 1 WHERE id = ?').run(id);

  // A guest serving traffic goes through delete_lxc_container, which unpublishes.
  db.prepare('INSERT INTO services (id, lxc_container_name) VALUES (1, ?)').run('pp-web');
  db.prepare('INSERT INTO service_http_routes (id, service_id, domain) VALUES (1, 1, ?)').run('app.example.com');
  const published = await svc.cleanupMigration(id, { deleteGuest: true });
  assert.match(published.error, /app\.example\.com/);
  assert.match(published.error, /delete_lxc_container/);
  db.prepare('DELETE FROM service_http_routes').run();

  // The dry run is the dialog's preview and touches nothing.
  const before = seen.length;
  const plan = await svc.cleanupMigration(id, { deleteGuest: true, removeRecord: true, dryRun: true });
  assert.equal(plan.dry_run, true);
  assert.equal(plan.would.delete_guest, true);
  assert.equal(plan.would.remove_record, true);
  assert.equal(plan.would.guest.status, 'RUNNING');
  assert.ok(!seen.slice(before).some((c) => /incus delete/.test(c)), 'a dry run deletes nothing');

  const done = await svc.cleanupMigration(id, { deleteGuest: true, removeRecord: true, force: true, actor: 'admin-1' });
  assert.equal(done.guest_deleted, true);
  assert.equal(done.record_removed, true);
  assert.equal(done.export, null, 'no export unless asked — the source is still standing');
  assert.ok(seen.includes('incus stop pp-web --force'), 'a running guest is stopped first');
  assert.ok(seen.includes('incus delete pp-web'));
  assert.equal(svc.rowById(id), null, 'the record is gone');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM migration_events WHERE migration_id = ?').get(id).n, 0, 'and so is its log');
  assert.ok(audit.some((a) => a[1] === 'MIGRATION_CLEANUP'));
});

test('cleanup: deleting the guest can leave the record, and a missing guest is not a silent success', async () => {
  const { svc, db } = setup({ script: (bin, args) => {
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return { status: 1, stderr: 'not found' };
    return { status: 0 };
  } });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'gone', source_kind: 'proxmox-lxc' } });
  await svc.cancelMigration(r.migration.id, { actor: 'a' });
  db.prepare('UPDATE migrations SET guest_created = 1 WHERE id = ?').run(r.migration.id);
  assert.match((await svc.cleanupMigration(r.migration.id, { deleteGuest: true })).error, /does not exist/);

  // …but asked to remove the record as well, a vanished guest is no obstacle.
  const done = await svc.cleanupMigration(r.migration.id, { deleteGuest: true, removeRecord: true });
  assert.equal(done.guest_deleted, false);
  assert.equal(done.record_removed, true);
  assert.equal(svc.rowById(r.migration.id), null);
});

test('cleanup refuses when it cannot tell whether a route points at the guest', async () => {
  let guestExists = false;
  const { svc, db } = setup({ script: (bin, args) => (bin === 'incus' && args[0] === 'config' && args[1] === 'show' && !guestExists ? { status: 1 } : { status: 0, stdout: 'config: {}' }) });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  await svc.cancelMigration(r.migration.id, { actor: 'a' });
  db.prepare('UPDATE migrations SET guest_created = 1 WHERE id = ?').run(r.migration.id);
  guestExists = true;
  db.exec('DROP TABLE service_http_routes');
  const out = await svc.cleanupMigration(r.migration.id, { deleteGuest: true });
  assert.match(out.error, /could not check whether a route points at/);
  assert.match(out.error, /refusing/);
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
  await svc.recordManifest(svc.rowById(id), { ...MANIFEST, app_dirs: [] });
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

test('MCP: cleanup is confirm-gated and dry-runnable, and the token tools carry no secret', async () => {
  let guestExists = false;
  const seen = [];
  const { svc, handlers } = setup({ script: (bin, args) => {
    seen.push([bin, ...args].join(' '));
    if (bin === 'incus' && args[0] === 'config' && args[1] === 'show') return guestExists ? { status: 0, stdout: 'config: {}' } : { status: 1 };
    if (bin === 'incus' && args[0] === 'list') return { status: 0, stdout: 'STOPPED\n' };
    return { status: 0 };
  } });
  const r = await svc.createMigration({ input: { mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' } });
  const id = r.migration.id;
  guestExists = true;

  // The tokens reader shows state, never a secret.
  const tokens = parse(await handlers.list_migration_tokens({}, AUTH));
  assert.equal(tokens.tokens.length, 1);
  assert.equal(tokens.tokens[0].state, 'unclaimed');
  assert.ok(!JSON.stringify(tokens).includes(r.token), 'the plaintext token is never returned again');

  // Revoking is gated, and the dry run says what it would do.
  const unconfirmed = await handlers.revoke_migration_token({ id }, AUTH);
  assert.equal(unconfirmed.isError, true);
  assert.match(unconfirmed.content[0].text, /Confirm with the user/);
  assert.equal(parse(await handlers.revoke_migration_token({ id, dry_run: true }, AUTH)).would.would, 'refuse every later call presenting this token');
  assert.equal(svc.view(svc.rowById(id)).token.state, 'unclaimed', 'the dry run changed nothing');
  assert.equal(parse(await handlers.revoke_migration_token({ id, confirm: true }, AUTH)).token.state, 'revoked');

  // Cleanup refuses a live migration through the tool surface too.
  const live = await handlers.cleanup_migration({ id, delete_guest: true, confirm: true }, AUTH);
  assert.equal(live.isError, true);
  assert.match(live.content[0].text, /cancel it first/);

  await svc.cancelMigration(id, { actor: 'admin-1' });
  const before = seen.length;
  const preview = parse(await handlers.cleanup_migration({ id, delete_guest: true, dry_run: true }, AUTH));
  assert.equal(preview.dry_run, true);
  assert.equal(preview.would.target, 'pp-web');
  assert.ok(!seen.slice(before).some((c) => /incus delete/.test(c)));

  const gated = await handlers.cleanup_migration({ id, delete_guest: true }, AUTH);
  assert.equal(gated.isError, true);
  assert.match(gated.content[0].text, /DELETES the guest pp-web/);

  const done = parse(await handlers.cleanup_migration({ id, delete_guest: true, confirm: true }, AUTH));
  assert.equal(done.guest_deleted, true);
  assert.equal(done.record_removed, false, 'the record is only removed when asked');
  assert.ok(seen.includes('incus delete pp-web'));
  assert.ok(svc.rowById(id), 'the migration stays as the record of what happened');
});
