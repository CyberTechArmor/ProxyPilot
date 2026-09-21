// routes/migrations.js — the agent-facing half, which is the only part of
// ProxyPilot a machine that is not ours ever talks to. It carries no session
// and is authenticated purely by the single-use token in its path, so the
// tests here are about what that token can and cannot reach.
//
// The bootstrap script gets its own test because it is the one artefact an
// operator pipes into a root shell on a production server.

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { migrationAgentRouter, bootstrapScript } from '../routes/migrations.js';
import { setMigrationService } from '../lib/migration/index.js';
import { MANIFEST_SCHEMA } from '../lib/migration/manifest.js';

const SHA = 'a'.repeat(64);
const PIN = `sha256:${'b'.repeat(64)}`;

test('the bootstrap script verifies the binary before running it, and pins TLS', () => {
  const s = bootstrapScript({ base: 'https://edge.example.com', token: 'pmig_abc_xyz', migrationId: 7, pin: PIN, sums: { amd64: SHA, arm64: 'c'.repeat(64) } });

  assert.match(s, /^#!\/bin\/sh\n/);
  assert.match(s, /set -eu/);
  assert.match(s, /\[ "\$\(id -u\)" = "0" \]/, 'it must insist on root rather than half-run');
  // The hash check is the whole point of serving a script instead of a URL.
  assert.match(s, /GOT="\$\(sha256sum "\$BIN"/);
  assert.match(s, /\[ "\$GOT" = "\$SHA" \] \|\| \{ echo "proxypilot-migrate: REFUSED/);
  assert.ok(s.includes(SHA) && s.includes('c'.repeat(64)), 'both architectures carry their own hash');
  assert.match(s, /PIN="sha256:b{64}"/);
  // The agent runs DETACHED from the terminal: a transient systemd unit
  // where there is one, setsid+nohup elsewhere, and in the foreground only
  // when asked. The first real transfer died with the SSH session.
  assert.match(s, /systemd-run --quiet --collect --unit "\$NAME" .*"\$BIN" migrate --url "\$URL" --token "\$TOKEN" --pin "\$PIN"/);
  assert.match(s, /setsid nohup "\$BIN" migrate --url "\$URL" --token "\$TOKEN" --pin "\$PIN"/);
  assert.match(s, /PROXYPILOT_MIGRATE_FOREGROUND[^\n]*\n\s*exec "\$BIN" migrate --url "\$URL" --token "\$TOKEN" --pin "\$PIN"/);
  assert.match(s, /trap - EXIT INT TERM/, 'the cleanup trap is released once the agent is running detached');
  assert.match(s, /this session can be closed/);
  // An unsupported CPU stops, rather than downloading something that cannot run.
  assert.match(s, /unsupported CPU/);
  assert.match(s, /rm -f "\$BIN"/, 'the binary is cleaned up on the way out');
  assert.ok(!s.includes('--keep'), 'keep_agent off means the flag is simply absent');

  const keep = bootstrapScript({ base: 'https://e.example.com', token: 't', migrationId: 1, pin: null, sums: { amd64: SHA }, keepAgent: true });
  assert.equal((keep.match(/--pin "\$PIN" --keep/g) || []).length, 3, 'every launch form carries --keep');
  assert.match(keep, /PIN=""/, 'no certificate to pin is stated, not faked');

  // No build for an architecture → the script says so instead of downloading a 404.
  const none = bootstrapScript({ base: 'https://e.example.com', token: 't', migrationId: 1, pin: PIN, sums: {} });
  assert.match(none, /ProxyPilot has no \$ARCH agent build/);
});

/* ------------------------------ the routes ------------------------------- */

function appWith(svc) {
  setMigrationService(svc);
  const app = express();
  app.use(express.json());
  app.use('/api/migrations/agent', migrationAgentRouter);
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

function fakeService(over = {}) {
  const row = { id: 3, transport: 'rootfs-tar', tls_pin: PIN, spec_json: JSON.stringify({ keep_agent: false }) };
  const calls = [];
  return {
    calls, row,
    authenticate: (token, opts) => { calls.push(['authenticate', token, opts]); return token === 'good' ? { row } : { error: 'unknown migration token', code: 'bad_token' }; },
    agentBinaries: async () => ({ amd64: { path: '/tmp/x', size_bytes: 10, sha256: SHA }, arm64: null }),
    agentJob: async (r) => { calls.push(['job', r.id]); return { migration_id: r.id, approved: false }; },
    recordManifest: (r, body) => { calls.push(['manifest', body?.schema]); return body?.schema === MANIFEST_SCHEMA ? { summary: { hostname: 'h' }, concerns: [], auto_approved: false } : { error: 'manifest schema must be …' }; },
    recordEvent: (r, e) => { calls.push(['event', e]); return { recorded: true, phase: 'transfer' }; },
    receiveArtifact: async () => ({ bytes: 4, sha256: SHA }),
    agentFinish: async () => ({ imported: true, guest: 'pp-web' }),
    switchTransport: async (r, { transport, reason }) => { calls.push(['transport', { transport, reason }]); return transport === 'rootfs-tar' ? { switched: true, job: { transport } } : { error: 'the one fallback is incus-migrate → rootfs-tar' }; },
    rowById: () => row,
    view: () => ({ id: 3 }),
    listEvents: () => [],
    listMigrations: () => [],
    ...over,
  };
}

test('the agent router: a bad token reaches nothing, a good one reaches only its own migration', async () => {
  const svc = fakeService();
  const { base, close } = await listen(appWith(svc));
  try {
    for (const path of ['/install.sh', '/job', '/binary/amd64']) {
      const r = await fetch(`${base}/api/migrations/agent/nope${path}`);
      assert.equal(r.status, 401, `${path} must refuse an unknown token`);
      assert.match((await r.json()).error, /unknown migration token/);
    }

    const script = await fetch(`${base}/api/migrations/agent/good/install.sh`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') || '', /shellscript/);
    const body = await script.text();
    assert.ok(body.includes(SHA), 'the served script carries the hash of the binary it will download');
    assert.ok(body.includes(PIN));

    const job = await fetch(`${base}/api/migrations/agent/good/job`);
    assert.deepEqual(await job.json(), { migration_id: 3, approved: false });

    // An arch with no build is a clear 404, not a broken download.
    const missing = await fetch(`${base}/api/migrations/agent/good/binary/arm64`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /no arm64 agent build/);

    // The claimant travels in a header, not in the path.
    await fetch(`${base}/api/migrations/agent/good/job`, { headers: { 'X-Migration-Run': 'run-7' } });
    assert.equal(svc.calls.filter((c) => c[0] === 'authenticate').at(-1)[2].claimant, 'run-7');
  } finally { await close(); setMigrationService(null); }
});

test('the agent router: the inventory is validated by the service, events are shape-checked, an artifact needs the right transport', async () => {
  const svc = fakeService();
  const { base, close } = await listen(appWith(svc));
  const post = (path, body, headers = {}) => fetch(`${base}/api/migrations/agent/good${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const bad = await post('/inventory', { schema: 'wrong' });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error, /manifest schema/);

    const good = await post('/inventory', { schema: MANIFEST_SCHEMA });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).accepted, true);

    const badEvent = await post('/event', { kind: 'not-a-kind' });
    assert.equal(badEvent.status, 400);
    const ev = await post('/event', { kind: 'progress', bytes: 1024, phase: 'transfer' });
    assert.equal(ev.status, 200);
    assert.equal(svc.calls.filter((c) => c[0] === 'event').at(-1)[1].bytes, 1024);

    const fin = await post('/finish', { ok: true, bytes: 10 });
    assert.equal((await fin.json()).remove_self, true, 'the agent is told to delete itself');

    // The transport switch: shape-checked here, decided by the service, and
    // a refusal is a 409 that carries the service's reason.
    const badSwitch = await post('/transport', { transport: 'carrier-pigeon' });
    assert.equal(badSwitch.status, 400);
    const sw = await post('/transport', { transport: 'rootfs-tar', reason: 'no incus-migrate' });
    assert.equal(sw.status, 200);
    assert.equal((await sw.json()).job.transport, 'rootfs-tar');
    assert.deepEqual(svc.calls.filter((c) => c[0] === 'transport').at(-1)[1], { transport: 'rootfs-tar', reason: 'no incus-migrate' });
    const refused = await post('/transport', { transport: 'incus-migrate' });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /one fallback/);

    // A migration that does not transport by tarball refuses the upload.
    const rsyncSvc = fakeService({ authenticate: () => ({ row: { id: 4, transport: 'rsync', spec_json: '{}' } }) });
    const other = await listen(appWith(rsyncSvc));
    try {
      const r = await fetch(`${other.base}/api/migrations/agent/good/artifact`, { method: 'PUT', body: 'bytes' });
      assert.equal(r.status, 409);
      assert.match((await r.json()).error, /transports with rsync/);
    } finally { await other.close(); }
  } finally { await close(); setMigrationService(null); }
});

test('the agent path is CSRF-exempt by design, and nothing else under /api/migrations is', async () => {
  const { CSRF_EXEMPT_PREFIXES } = await import('../middleware/csrf.js').then(async (m) => {
    // The list is module-private; read the source instead of exporting it
    // just for a test, and assert on the one line that matters.
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../middleware/csrf.js', import.meta.url), 'utf8'));
    return { CSRF_EXEMPT_PREFIXES: src };
  });
  assert.match(CSRF_EXEMPT_PREFIXES, /'\/api\/migrations\/agent\/'/);
  assert.ok(!/'\/api\/migrations\/'/.test(CSRF_EXEMPT_PREFIXES), 'the operator half keeps its CSRF protection');
});
