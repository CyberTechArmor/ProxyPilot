// lib/migration/plan.js and token.js — the target spec, the transports, the
// phase machine, the pasted command, the checklist, and the token rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTarget, guestConfig, installCommand, installCommandTwoStep, CHECKLIST,
  checklistFor, checklistComplete, checklistProgress, transferProgress, canAdvance, nextStatus, PHASE_IDS,
} from '../lib/migration/plan.js';
import {
  mintMigrationToken, parseToken, verifyToken, tokenState, formatPin, parsePin, sha256,
  DEFAULT_TTL_SECONDS, MIN_TTL_SECONDS, MAX_TTL_SECONDS,
} from '../lib/migration/token.js';

test('validateTarget: the transport follows from the mode and the source, and every bad input is named', () => {
  assert.match(validateTarget({}).error, /mode must be one of/);
  assert.match(validateTarget({ mode: 'application', name: 'Bad Name' }).error, /^name:/);
  assert.match(validateTarget({ mode: 'whole-machine', name: 'web', type: 'nas' }).error, /type must be/);

  // whole-machine: incus-migrate by default, rootfs-tar for a Proxmox LXC.
  assert.equal(validateTarget({ mode: 'whole-machine', name: 'web' }).spec.transport, 'incus-migrate');
  assert.equal(validateTarget({ mode: 'whole-machine', name: 'web', source_kind: 'proxmox-lxc' }).spec.transport, 'rootfs-tar');
  assert.equal(validateTarget({ mode: 'whole-machine', name: 'web', source_kind: 'lxc' }).spec.transport, 'rootfs-tar');
  assert.equal(validateTarget({ mode: 'whole-machine', name: 'web', source_kind: 'physical' }).spec.transport, 'incus-migrate');
  // application is always file-sync, and a caller cannot mix them up.
  assert.equal(validateTarget({ mode: 'application', name: 'web', app_dirs: ['/srv/a'] }).spec.transport, 'file-sync');
  assert.match(validateTarget({ mode: 'application', name: 'web', transport: 'incus-migrate' }).error, /always transports with file-sync/);
  assert.match(validateTarget({ mode: 'whole-machine', name: 'web', transport: 'file-sync' }).error, /incus-migrate, or rootfs-tar/);
  assert.match(validateTarget({ mode: 'whole-machine', name: 'web', type: 'virtual-machine', transport: 'rootfs-tar', disk_gb: 40 }).error, /rootfs-tar imports a container/);

  // A VM needs a disk up front — the disk is created before the stream starts.
  assert.match(validateTarget({ mode: 'whole-machine', name: 'web', type: 'virtual-machine' }).error, /disk_gb is required for a virtual machine/);
  assert.equal(validateTarget({ mode: 'whole-machine', name: 'web', type: 'virtual-machine', disk_gb: 40 }).spec.disk_gb, 40);

  assert.match(validateTarget({ mode: 'whole-machine', name: 'web', cpu: 0 }).error, /^cpu:/);
  assert.match(validateTarget({ mode: 'whole-machine', name: 'web', memory_gb: 0.1 }).error, /^memory_gb:/);
  assert.match(validateTarget({ mode: 'whole-machine', name: 'web', pool: 'bad pool' }).error, /^pool:/);

  // Application mode's directories: absolute, never / and never a traversal.
  assert.match(validateTarget({ mode: 'application', name: 'a', app_dirs: ['srv/app'] }).error, /is not an absolute path/);
  assert.match(validateTarget({ mode: 'application', name: 'a', app_dirs: ['/'] }).error, /is refused/);
  assert.match(validateTarget({ mode: 'application', name: 'a', app_dirs: ['/srv/../etc'] }).error, /is refused/);
  const app = validateTarget({ mode: 'application', name: 'a', app_dirs: ['/srv/app/'], excludes: ['*.mp4'], database: 'postgres', service_name: 'app.service' }).spec;
  assert.deepEqual(app.app.dirs, ['/srv/app']);
  assert.ok(app.app.excludes.includes('*.mp4') && app.app.excludes.includes('node_modules/'), 'operator excludes are added to the defaults, not instead of them');
  assert.equal(app.app.database, 'postgres');
  assert.equal(app.app.image, 'images:debian/13');
  assert.match(validateTarget({ mode: 'application', name: 'a', database: 'oracle' }).error, /database must be/);

  // Defaults that matter: the guest does not autostart, and the transfer waits.
  const spec = validateTarget({ mode: 'whole-machine', name: 'web' }).spec;
  assert.equal(spec.auto_transfer, false);
  assert.equal(spec.keep_agent, false);
  assert.equal(spec.install_tools, true, 'the agent may install zstd on the source unless told otherwise');
  assert.equal(validateTarget({ mode: 'whole-machine', name: 'web', install_tools: false }).spec.install_tools, false);
  assert.equal(spec.freeze, 'stop');
});

test('guestConfig: nesting only when asked, and never autostart on import', () => {
  const plain = guestConfig(validateTarget({ mode: 'whole-machine', name: 'web' }).spec);
  assert.equal(plain.incus_name, 'pp-web');
  assert.equal(plain.config['boot.autostart'], 'false');
  assert.equal(plain.config['security.nesting'], undefined);
  const nested = guestConfig(validateTarget({ mode: 'whole-machine', name: 'web', nested: true }).spec);
  assert.equal(nested.config['security.nesting'], 'true');
  assert.equal(nested.config['security.syscalls.intercept.bpf.devices'], 'true');
});

test('the pasted command is one line, and the two-step form is the same thing readable', () => {
  const cmd = installCommand({ baseUrl: 'https://edge.example.com/', token: 'pmig_abc_xyz' });
  assert.equal(cmd, 'curl -fsSL https://edge.example.com/api/migrations/agent/pmig_abc_xyz/install.sh | sudo sh');
  assert.equal(cmd.split('\n').length, 1);
  const steps = installCommandTwoStep({ baseUrl: 'https://edge.example.com', token: 'pmig_abc_xyz' });
  assert.equal(steps.length, 3);
  assert.match(steps[1], /less /);
});

test('the checklist is per mode, and completion means every required step', () => {
  const whole = checklistFor('whole-machine');
  const app = checklistFor('application');
  assert.ok(!whole.some((s) => s.id === 'final_delta_sync'), 'a whole-machine move has no delta sync');
  assert.ok(app.some((s) => s.id === 'final_delta_sync'));
  assert.equal(app.length, whole.length + 1);
  for (const s of CHECKLIST) assert.ok(s.title && s.detail && s.tool, `${s.id} needs a title, a detail and the tool that does it`);

  let state = {};
  assert.equal(checklistComplete('whole-machine', state), false);
  for (const s of whole) state[s.id] = { at: '2026-09-19T10:00:00Z', by: 'admin' };
  assert.equal(checklistComplete('whole-machine', state), true);
  assert.equal(checklistComplete('application', state), false, 'the same state is NOT complete for application mode');
  const p = checklistProgress('whole-machine', { snapshot_pre_cutover: { at: 'x' } });
  assert.equal(p.done, 1);
  assert.ok(p.remaining.includes('route_created'));
  assert.equal(checklistFor('whole-machine', { route_created: { at: 'x', by: 'admin-1', note: 'app.example.com' } }).find((s) => s.id === 'route_created').note, 'app.example.com');
});

test('transferProgress: the rate is the recent rate, and a stall reads as a stall', () => {
  const t0 = Date.parse('2026-09-19T10:00:00Z');
  const empty = transferProgress({ samples: [], now: t0 });
  assert.equal(empty.bytes, 0); assert.equal(empty.rate_bps, null);

  // 100 MB in the first 10 s, then 10 MB in the last 10 s: the rate must
  // describe now, not the fast start.
  const samples = [
    { at: t0, bytes: 0 },
    { at: t0 + 10_000, bytes: 100 * 1024 ** 2 },
    { at: t0 + 20_000, bytes: 110 * 1024 ** 2 },
  ];
  const p = transferProgress({ samples, total_bytes: 220 * 1024 ** 2, now: t0 + 20_000, windowMs: 10_000 });
  assert.equal(p.bytes, 110 * 1024 ** 2);
  assert.equal(p.percent, 50);
  assert.equal(p.rate_bps, 1024 ** 2, 'measured over the last window (10 MiB in 10 s), not the fast start');
  assert.equal(p.eta_seconds, 110);
  assert.equal(p.stalled, false);
  assert.equal(transferProgress({ samples, total_bytes: null, now: t0 + 300_000, windowMs: 60_000 }).stalled, true);
});

test('the phase machine only moves forward, and status follows the phase', () => {
  assert.ok(canAdvance('inventory', 'transfer'));
  assert.ok(canAdvance('transfer', 'transfer'), 'a repeated event is not a rewind');
  assert.equal(canAdvance('cutover', 'inventory'), false, 'a replayed event cannot pull a finished run back');
  assert.equal(canAdvance('inventory', 'nonsense'), false);
  assert.deepEqual(PHASE_IDS, ['inventory', 'transfer', 'import', 'post-import', 'cutover']);
  assert.equal(nextStatus({ status: 'running', phase: 'inventory', manifestReceived: true }), 'awaiting_review');
  assert.equal(nextStatus({ status: 'running', phase: 'inventory', manifestReceived: true, approved: true }), 'running');
  assert.equal(nextStatus({ status: 'running', phase: 'post-import' }), 'ready');
  assert.equal(nextStatus({ status: 'cancelled', phase: 'transfer' }), 'cancelled', 'a terminal status is terminal');
});

test('tokens: single-use, scoped, ended by use rather than by a clock — and only the hash is storable', () => {
  const now = Date.parse('2026-09-19T10:00:00Z');
  const m = mintMigrationToken({ now });
  assert.match(m.token, /^pmig_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  // The default is NO expiry: a migration is planned work, and a token that
  // dies while the operator is still reading the inventory buys nothing. What
  // ends it is the migration finishing, or a revoke.
  assert.equal(DEFAULT_TTL_SECONDS, null);
  assert.equal(m.ttl_seconds, null);
  assert.equal(m.expires_at, null);
  assert.notEqual(m.token_hash, m.token, 'the stored hash is not the token');
  assert.equal(m.token_hash, sha256(parseToken(m.token).secret), 'the secret is base64url and may contain an underscore — parse it, never split it');
  assert.equal(mintMigrationToken({ ttlSeconds: 5, now }).ttl_seconds, MIN_TTL_SECONDS, 'a too-short TTL is clamped, not accepted');
  assert.equal(mintMigrationToken({ ttlSeconds: 99999999, now }).ttl_seconds, MAX_TTL_SECONDS);
  assert.equal(parseToken('nope'), null);
  assert.equal(parseToken(m.token).token_id, m.token_id);

  const row = { token_id: m.token_id, token_hash: m.token_hash, token_expires_at: m.expires_at, status: 'created', token_claimed_by: null };
  // No expiry means no expiry: a year on, the migration is what decides.
  assert.ok(verifyToken(row, m.token, { now: now + 365 * 24 * 3600 * 1000 }).ok);
  assert.equal(verifyToken(row, m.token, { now, claimant: 'run-1' }).first_use, true);
  assert.match(verifyToken(row, 'pmig_deadbeefcafe_' + 'a'.repeat(43), { now }).error, /unknown migration token/);
  assert.match(verifyToken(null, m.token, { now }).error, /unknown migration token/);
  assert.match(verifyToken(row, 'garbage', { now }).error, /malformed/);

  // A second agent run cannot take over a claimed token.
  const claimed = { ...row, token_claimed_by: 'run-1' };
  assert.ok(verifyToken(claimed, m.token, { now, claimant: 'run-1' }).ok);
  assert.match(verifyToken(claimed, m.token, { now, claimant: 'run-2' }).error, /already been claimed/);

  // An expiry is available for anyone who wants one, and it is enforced.
  const ttl = mintMigrationToken({ ttlSeconds: 3600, now });
  assert.equal(ttl.expires_at, new Date(now + 3600_000).toISOString());
  const ttlRow = { ...row, token_id: ttl.token_id, token_hash: ttl.token_hash, token_expires_at: ttl.expires_at };
  assert.ok(verifyToken(ttlRow, ttl.token, { now: now + 3599_000 }).ok);
  assert.match(verifyToken(ttlRow, ttl.token, { now: now + 3601_000 }).error, /expired/);

  // Revoked beats everything short of a bad secret.
  assert.match(verifyToken({ ...row, token_revoked_at: '2026-09-19T10:05:00Z' }, m.token, { now }).error, /revoked/);
  assert.equal(verifyToken({ ...row, token_revoked_at: '2026-09-19T10:05:00Z' }, 'garbage', { now }).code, 'bad_token');

  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.match(verifyToken({ ...row, status }, m.token, { now }).error, new RegExp(`is ${status}`));
  }

  // tokenState is what the operator's list reads.
  assert.equal(tokenState({ ...row, status: 'created' }, { now }).state, 'unclaimed');
  assert.equal(tokenState({ ...row, status: 'created' }, { now }).usable, true);
  assert.equal(tokenState({ ...row, status: 'running', token_claimed_by: 'run-1' }, { now }).state, 'active');
  assert.equal(tokenState({ ...row, status: 'completed' }, { now }).state, 'spent');
  assert.equal(tokenState({ ...row, token_revoked_at: '2026-09-19T10:05:00Z', token_revoked_by: 'admin-1' }, { now }).state, 'revoked');
  assert.match(tokenState({ ...row, token_revoked_at: '2026-09-19T10:05:00Z', token_revoked_by: 'admin-1' }, { now }).reason, /admin-1/);
  assert.equal(tokenState({ ...ttlRow, status: 'created' }, { now: now + 3601_000 }).state, 'expired');
  assert.equal(tokenState({ ...row, status: 'created' }, { now }).expires_at, null, 'an absent expiry is null, never an Invalid Date');

  assert.equal(formatPin('AB'.repeat(32)), `sha256:${'ab'.repeat(32)}`);
  assert.equal(formatPin('short'), null);
  assert.equal(parsePin(`sha256:${'ab'.repeat(32)}`), 'ab'.repeat(32));
  assert.equal(parsePin('sha1:xx'), null);
});
