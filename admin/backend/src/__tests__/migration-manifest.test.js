// lib/migration/manifest.js — the inventory document and everything derived
// from it. The load-bearing test here is the refusal: a manifest that
// carries a secret VALUE must never enter ProxyPilot, whatever the agent
// sending it believes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_SCHEMA, validateManifest, suggestedRoutes, observedEgress, databasePlan,
  manifestSummary, manifestConcerns, routableName, upstreamPort, appDirectories, DEFAULT_RSYNC_EXCLUDES,
  capacityNeeds, capacityVerdict,
} from '../lib/migration/manifest.js';

const base = (over = {}) => ({
  schema: MANIFEST_SCHEMA,
  collected_at: '2026-09-19T10:00:00Z',
  agent_version: 'test',
  source: { hostname: 'old-web01', kind: 'vm', arch: 'amd64', cpus: 4, memory_bytes: 8 * 1024 ** 3, addresses: ['10.0.0.5', '203.0.113.9'], root_used_bytes: 12 * 1024 ** 3 },
  os: { id: 'debian', version_id: '12', pretty_name: 'Debian GNU/Linux 12 (bookworm)', kernel: '6.1.0', init: 'systemd' },
  units: [{ name: 'myapp.service', state: 'running', exec: '/usr/bin/node /srv/myapp/server.js', working_directory: '/srv/myapp', ports: [{ proto: 'tcp', port: 3000 }] }],
  listening: [{ proto: 'tcp', address: '127.0.0.1', port: 3000, process: 'node', unit: 'myapp.service' }, { proto: 'tcp', address: '0.0.0.0', port: 443, process: 'nginx' }],
  vhosts: [{ server: 'nginx', file: '/etc/nginx/sites-enabled/app', tls: true, server_names: ['app.example.com', 'www.app.example.com'], listen: ['443 ssl'], upstreams: ['http://127.0.0.1:3000'] }],
  databases: [{ engine: 'postgres', version: '15.6', port: 5432, running: true, databases: [{ name: 'appdb', size_bytes: 1024 ** 3 }, { name: 'postgres', size_bytes: 8 }] }],
  cron: [{ source: '/etc/cron.d/app', user: 'root', schedule: '0 3 * * *', command: '/srv/myapp/bin/nightly' }],
  env_files: [{ path: '/srv/myapp/.env', keys: ['DATABASE_URL', 'STRIPE_SECRET_KEY'], size_bytes: 210 }],
  outbound: [
    { host: 'api.stripe.com', port: 443, proto: 'tcp', evidence: 'conntrack' },
    { host: 'api.stripe.com', port: 443, proto: 'tcp', evidence: 'unit' },
    { host: '10.0.0.7', port: 5432, proto: 'tcp', evidence: 'conntrack' },
    { host: '8.8.8.8', port: 53, proto: 'udp', evidence: 'resolv' },
  ],
  app_dirs: [{ path: '/srv/myapp', size_bytes: 400 * 1024 ** 2, kind: 'node', unit: 'myapp.service' }, { path: '/var/www/static', size_bytes: 900 * 1024 ** 2, kind: 'static' }],
  ...over,
});

test('validateManifest: the schema is pinned, and a manifest carrying a VALUE is refused wherever it hides it', () => {
  assert.match(validateManifest('{').error, /not JSON/);
  assert.match(validateManifest({ schema: 'other' }).error, /schema must be proxypilot-migration-manifest@1/);
  assert.ok(validateManifest(base()).manifest);
  assert.ok(validateManifest(JSON.stringify(base())).manifest, 'a JSON string is accepted too');

  // The forbidden-key sweep, at every depth and inside arrays.
  for (const bad of [
    { ...base(), env_files: [{ path: '/srv/.env', keys: ['A'], values: ['sk_live_1'] }] },
    { ...base(), env_files: [{ path: '/srv/.env', keys: ['A'], value: 'sk_live_1' }] },
    { ...base(), databases: [{ engine: 'postgres', password: 'hunter2' }] },
    { ...base(), units: [{ name: 'a.service', detail: { nested: { secret: 'x' } } }] },
    { ...base(), notes: [], contents: 'the whole file' },
  ]) {
    const r = validateManifest(bad);
    assert.match(r.error, /never accepts secret VALUES|only path, keys/, `should have been refused: ${JSON.stringify(bad).slice(0, 80)}`);
  }

  // A key that is really a KEY=value line is a value in disguise.
  assert.match(validateManifest({ ...base(), env_files: [{ path: '/srv/.env', keys: ['DATABASE_URL=postgres://u:p@h/db'] }] }).error, /not a bare KEY name/);
  // An unexpected property on an env_files entry is refused by name.
  assert.match(validateManifest({ ...base(), env_files: [{ path: '/a', keys: [], sample: 'x' }] }).error, /carries sample/);
  // A well-formed entry survives normalization intact.
  assert.deepEqual(validateManifest(base()).manifest.env_files[0].keys, ['DATABASE_URL', 'STRIPE_SECRET_KEY']);
});

test('validateManifest: normalization fills every field, clamps the unbounded and keeps the shape stable', () => {
  const { manifest } = validateManifest({ schema: MANIFEST_SCHEMA });
  for (const k of ['disks', 'mounts', 'units', 'listening', 'vhosts', 'databases', 'cron', 'tls', 'env_files', 'outbound', 'app_dirs', 'warnings', 'notes']) {
    assert.deepEqual(manifest[k], [], `${k} defaults to an empty array`);
  }
  assert.equal(manifest.docker.present, false);
  assert.equal(manifest.source.kind, 'unknown');
  const many = validateManifest({ schema: MANIFEST_SCHEMA, outbound: Array.from({ length: 900 }, (_, i) => ({ host: `h${i}.example.com`, port: 443 })) });
  assert.equal(many.manifest.outbound.length, 512, 'a hostile payload cannot grow the row without bound');
});

test('derivations: routes from vhosts, egress without the internal noise, the database plan, the app dirs', () => {
  const { manifest } = validateManifest(base());

  const routes = suggestedRoutes(manifest);
  assert.deepEqual(routes.map((r) => r.domain), ['app.example.com', 'www.app.example.com']);
  assert.equal(routes[0].upstream_port, 3000, 'the proxy target is the port the app will listen on in the guest');
  assert.equal(routes[0].tls, true);
  assert.equal(routableName('_'), null);
  assert.equal(routableName('localhost'), null);
  assert.equal(routableName('203.0.113.4'), null);
  assert.equal(routableName('*.example.com'), 'example.com');
  assert.equal(upstreamPort({ upstreams: ['http://unix:/run/app.sock'] }), null);

  const egress = observedEgress(manifest);
  const stripe = egress.find((e) => e.host === 'api.stripe.com');
  assert.deepEqual(stripe.evidence, ['conntrack', 'unit']);
  assert.equal(stripe.service, 'https');
  assert.equal(stripe.internal, false);
  assert.equal(egress[0].host, 'api.stripe.com', 'the most-corroborated host sorts first');
  assert.equal(egress.find((e) => e.host === '10.0.0.7').internal, true, 'RFC1918 peers are inside the old machine');
  assert.equal(egress.find((e) => e.host === '8.8.8.8').service, 'dns');

  const dbs = databasePlan(manifest);
  assert.equal(dbs.length, 1);
  assert.deepEqual(dbs[0].databases, ['appdb'], 'template and system databases are not dumped');
  assert.match(dbs[0].dump, /pg_dump --format=custom/);
  const sqlite = databasePlan(validateManifest({ schema: MANIFEST_SCHEMA, databases: [{ engine: 'sqlite', paths: ['/srv/app/app.db'] }] }).manifest);
  assert.equal(sqlite[0].kind, 'file');

  assert.deepEqual(appDirectories(manifest).map((d) => d.path), ['/var/www/static', '/srv/myapp'], 'biggest first');
  assert.ok(DEFAULT_RSYNC_EXCLUDES.includes('node_modules/'));
});

test('manifestSummary and manifestConcerns: the short read, and what stops an approval', () => {
  const { manifest } = validateManifest(base());
  const s = manifestSummary(manifest);
  assert.equal(s.hostname, 'old-web01');
  assert.equal(s.counts.env_keys, 2);
  assert.equal(s.counts.routes, 2);
  assert.equal(s.counts.egress, 2, 'internal peers are not offered as egress grants');
  assert.equal(s.dockerized, false);
  assert.deepEqual(s.top_ports.map((p) => p.port), [3000, 443]);

  assert.deepEqual(manifestConcerns(manifest, { mode: 'whole-machine' }), [], 'a clean source raises nothing');

  const noDirs = validateManifest({ ...base(), app_dirs: [] }).manifest;
  const c = manifestConcerns(noDirs, { mode: 'application' });
  assert.equal(c.find((x) => x.id === 'no-app-dirs').level, 'block');

  const dockerized = validateManifest({ ...base(), docker: { present: true, containers: [{ name: 'web', image: 'nginx' }] } }).manifest;
  assert.match(manifestConcerns(dockerized, { mode: 'application' }).find((x) => x.id === 'dockerized').text, /nested guest is the faster path/);

  const noVhost = validateManifest({ ...base(), vhosts: [] }).manifest;
  assert.ok(manifestConcerns(noVhost, { mode: 'whole-machine' }).some((x) => x.id === 'no-vhost'));

  const sysv = validateManifest({ ...base(), os: { id: 'alpine', init: 'openrc' } }).manifest;
  assert.ok(manifestConcerns(sysv, { mode: 'whole-machine' }).some((x) => x.id === 'init'));

  const big = validateManifest({ ...base(), mounts: [{ target: '/data', used_bytes: 900 * 1024 ** 3 }] }).manifest;
  assert.match(manifestConcerns(big, { mode: 'whole-machine' }).find((x) => x.id === 'big-mount:/data').text, /900 GiB/);
});

/* ------------------------------- capacity -------------------------------- */

const GiB = 1024 ** 3;

test('capacity: what a migration will actually put where', () => {
  const whole = {
    source: { root_used_bytes: 300 * GiB },
    mounts: [
      { target: '/', used_bytes: 300 * GiB },
      { target: '/proc', used_bytes: 1 },
      { target: '/data', used_bytes: 900 * GiB },
    ],
  };

  // Whole-machine through the tarball: the guest pays for the rootfs, and
  // ProxyPilot's own disk pays for the compressed artifact in flight.
  const tar = capacityNeeds(whole, { mode: 'whole-machine', transport: 'rootfs-tar' });
  assert.equal(tar.pool_bytes, 300 * GiB);
  assert.equal(tar.staging_bytes, 150 * GiB);
  // A separate mount is NAMED but not counted: --one-file-system leaves it behind.
  const dataPart = tar.parts.find((p) => p.what.startsWith('/data'));
  assert.ok(dataPart, '/data is reported');
  assert.equal(dataPart.bytes, 0);
  assert.match(dataPart.what, /NOT carried/);
  assert.ok(!tar.parts.some((p) => p.what.startsWith('/proc')), 'pseudo-filesystems are not mentioned at all');

  // incus-migrate stages nothing: it streams into Incus.
  assert.equal(capacityNeeds(whole, { mode: 'whole-machine', transport: 'incus-migrate' }).staging_bytes, 0);
  assert.match(capacityNeeds(whole, { mode: 'whole-machine', transport: 'incus-migrate' }).staging_note, /straight into Incus/);

  // Application mode carries the directories, and a database twice — the dump
  // lands in the guest and is restored beside it.
  const app = capacityNeeds({
    app_dirs: [{ path: '/srv/app', size_bytes: 4 * GiB, kind: 'node' }],
    databases: [{ engine: 'postgres', running: true, databases: [{ name: 'appdb', size_bytes: 10 * GiB }] }],
  }, { mode: 'application', transport: 'file-sync' });
  assert.equal(app.pool_bytes, 24 * GiB);
  assert.equal(app.staging_bytes, 12 * GiB);
});

test('capacity: the verdict blocks what will not fit, warns at the margin, and never passes on an unreadable pool', () => {
  const needs = capacityNeeds({ source: { root_used_bytes: 100 * GiB } }, { mode: 'whole-machine', transport: 'rootfs-tar' });

  const room = capacityVerdict({ needs, pool: 'Storage', poolFreeBytes: 900 * GiB, poolTotalBytes: 1000 * GiB, stagingFreeBytes: 500 * GiB, stagingPath: '/var/lib/proxypilot' });
  assert.equal(room.fits, true);
  assert.deepEqual(room.concerns, []);
  assert.equal(room.checks.find((c) => c.id === 'capacity-pool').status, 'pass');
  assert.match(room.checks.find((c) => c.id === 'capacity-pool').text, /100\.0 GiB .*Storage.* 900\.0 GiB free/);

  const tight = capacityVerdict({ needs, pool: 'Storage', poolFreeBytes: 105 * GiB, stagingFreeBytes: 500 * GiB });
  assert.equal(tight.fits, true, 'it does fit');
  assert.equal(tight.concerns[0].level, 'warn');
  assert.match(tight.concerns[0].text, /under 10% of the free space left over/);

  const full = capacityVerdict({ needs, pool: 'Storage', poolFreeBytes: 40 * GiB, stagingFreeBytes: 500 * GiB });
  assert.equal(full.fits, false);
  assert.equal(full.concerns[0].level, 'block');
  assert.match(full.concerns[0].text, /will not fit/);
  assert.match(full.concerns[0].remedy, /Pick a pool with room/);

  // The pool has room but ProxyPilot's own disk does not — a different block,
  // with the transport that avoids staging as the remedy.
  const noStage = capacityVerdict({ needs, pool: 'Storage', poolFreeBytes: 900 * GiB, stagingFreeBytes: 10 * GiB, stagingPath: '/var/lib/proxypilot' });
  assert.equal(noStage.fits, false);
  assert.equal(noStage.concerns[0].id, 'capacity-staging');
  assert.match(noStage.concerns[0].remedy, /incus-migrate/);

  // Unreadable is a warning, never a silent pass.
  const blind = capacityVerdict({ needs, pool: 'Storage', poolFreeBytes: null, stagingFreeBytes: null });
  assert.equal(blind.fits, true, 'not knowing is not a block');
  assert.equal(blind.concerns.length, 2);
  assert.ok(blind.concerns.every((c) => c.level === 'warn'));
  assert.match(blind.concerns[0].text, /Could not read how much space/);
});

test('capacity concerns lead the inventory review, and blocking beats everything else', () => {
  const man = { source: { root_used_bytes: 100 * GiB }, os: { id: 'debian', init: 'systemd' }, vhosts: [{ server: 'nginx', server_names: ['a.example.com'] }] };
  const capacity = capacityVerdict({
    needs: capacityNeeds(man, { mode: 'whole-machine', transport: 'rootfs-tar' }),
    pool: 'Storage', poolFreeBytes: 10 * GiB, stagingFreeBytes: 10 * GiB,
  });
  const concerns = manifestConcerns(man, { mode: 'whole-machine', capacity });
  assert.equal(concerns[0].level, 'block', 'the fit is the first thing the operator reads');
  assert.equal(concerns[0].id, 'capacity-pool');
  // Without a capacity verdict nothing is invented.
  assert.ok(!manifestConcerns(man, { mode: 'whole-machine' }).some((c) => c.id.startsWith('capacity')));
});
