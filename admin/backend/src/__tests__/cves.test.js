// Smoke test for the CVE inbox route's regex-based YAML extractors.
//
// The route reads YAML files directly to render the listing — the
// engine owns mutation. The extractors are flat-scalar peeks
// (status, action_class for this host, operator_seen) that need to
// be robust against the existing inbox shapes (dict-keyed-by-hostname
// AND legacy list-of-objects). This test pins that behavior so a
// schema tweak doesn't silently break the badge count.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The DELETE / PUT / POST handlers call logAudit, which expects the
// audit_log table to exist. Point DATABASE_PATH at a fresh tmp dir
// BEFORE importing db.js so the schema is created against a throwaway
// SQLite file, not the operator's real one.
process.env.DATABASE_PATH = join(
  mkdtempSync(join(tmpdir(), 'pp-cve-test-')), 'test.db');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  || 'test-key-must-be-32-bytes-long-x';
// The route's runEngine() spawns `python -m proxypilot.engine` and
// inherits this process's cwd (admin/backend) which does NOT have
// the proxypilot package on sys.path. Point PYTHONPATH at the
// project root so the validate subprocess can find the module.
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
process.env.PYTHONPATH = REPO_ROOT
  + (process.env.PYTHONPATH ? ':' + process.env.PYTHONPATH : '');
const { initDatabase, getDb } = await import('../db.js');
initDatabase();

// Insert a test user so logAudit's FK on users(id) holds. The
// handlers don't read this row back; only the FK check needs it.
const TEST_USER_ID = 'test-user';
getDb().prepare(
  `INSERT OR IGNORE INTO users (id, username, password_hash, totp_secret, role, totp_enabled)
   VALUES (?, 'cve-test-user', 'unused', 'unused', 'admin', 0)`
).run(TEST_USER_ID);

// The extractors are not exported. We exercise them via the route's
// listing endpoint by spinning up a minimal Express app pointed at a
// throwaway inbox dir. PROXYPILOT_INBOX_DIR is read at import time,
// so we set it before we import the router.
async function loadRouter(inboxDir, hostname) {
  process.env.PROXYPILOT_INBOX_DIR = inboxDir;
  process.env.PROXYPILOT_HOSTNAME = hostname;
  // Bust the import cache: dynamic import each call so a fresh module
  // picks up the new env. node:test runs each test in the same
  // process, so without this the second test would see the first
  // test's env vars baked into module-scope constants.
  const url = `../routes/cves.js?_=${Date.now()}`;
  const mod = await import(url);
  return mod.cvesRouter;
}

// We bypass requireAdmin / requireSudo by stubbing req.user before
// the router runs. The auth middleware is exercised by other suites;
// here we focus on the route handlers themselves.
async function callRouter(router, path, { method = 'GET', body = null } = {}) {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.user = { id: TEST_USER_ID, role: 'admin', username: 'cve-test-user' };
    // requireSudo reads sudo_until off req.session; satisfy it for
    // the duration of the test without going through real auth. The
    // sliding-window DB write is wrapped in try/catch so an absent
    // sessions table is harmless.
    req.session = {
      id: 'test-session',
      sudo_until: new Date(Date.now() + 60_000).toISOString(),
    };
    next();
  });
  app.use('/', router);
  const { default: http } = await import('node:http');
  const server = http.createServer(app);
  // Wait for server to be ready, fire the request, await close so the
  // socket / keep-alive timer / express-rate-limit memory store don't
  // leave stray handles open between tests.
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  let result;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = r.headers.get('content-type')?.includes('json')
      ? await r.json() : await r.text();
    result = { status: r.status, body: json };
  } finally {
    await new Promise((resolve) => server.closeAllConnections?.() || resolve());
    await new Promise((resolve) => server.close(() => resolve()));
  }
  return result;
}

const callList = (router) => callRouter(router, '/');

test('list extracts dict-keyed hosts and counts unread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    await writeFile(join(dir, 'CVE-2026-0001.yaml'), [
      'cve: CVE-2026-0001',
      'name: "test entry"',
      'hosts:',
      '  vm:',
      '    action_class: AUTO_PATCH',
      '    tier: 1',
      'state:',
      '  status: NEW',
      '  operator_seen: false',
      '',
    ].join('\n'));
    const router = await loadRouter(dir, 'vm');
    const { status, body } = await callList(router);
    assert.equal(status, 200);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].action_class, 'AUTO_PATCH');
    assert.equal(body.entries[0].status, 'NEW');
    assert.equal(body.entries[0].operator_seen, false);
    // `added` falls back to file ctime when there's no _proxypilot
    // block. Just check it's an ISO timestamp string.
    assert.match(body.entries[0].added, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.entries[0].latest_note, null);
    assert.equal(body.unread, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list handles legacy list-of-objects hosts form', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    await writeFile(join(dir, 'CVE-2025-9999.yaml'), [
      'cve: CVE-2025-9999',
      'name: legacy',
      'hosts:',
      '  - host: vm',
      '    action_class: ONE_CLICK',
      '    tier: 2',
      'state:',
      '  status: QUEUED',
      '  operator_seen: true',
      '',
    ].join('\n'));
    const router = await loadRouter(dir, 'vm');
    const { body } = await callList(router);
    assert.equal(body.entries[0].action_class, 'ONE_CLICK');
    assert.equal(body.entries[0].status, 'QUEUED');
    assert.equal(body.entries[0].operator_seen, true);
    assert.equal(body.unread, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list ignores _last_run.yaml and non-CVE files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    await writeFile(join(dir, '_last_run.yaml'), 'timestamp: 0\n');
    await writeFile(join(dir, 'README.md'), '# nope\n');
    await writeFile(join(dir, 'not-a-cve.yaml'), 'cve: foo\n');
    await writeFile(join(dir, 'CVE-2026-0042.yaml'),
      'cve: CVE-2026-0042\nstate: {status: NEW, operator_seen: false}\n');
    const router = await loadRouter(dir, 'vm');
    const { body } = await callList(router);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].cve, 'CVE-2026-0042');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing host in spec defaults action_class to ALERT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    await writeFile(join(dir, 'CVE-2026-0050.yaml'), [
      'cve: CVE-2026-0050',
      'hosts:',
      '  other:',
      '    action_class: AUTO_PATCH',
      '    tier: 1',
      'state: {status: NEW, operator_seen: true}',
      '',
    ].join('\n'));
    const router = await loadRouter(dir, 'vm');
    const { body } = await callList(router);
    assert.equal(body.entries[0].action_class, 'ALERT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── paste / save / delete ─────────────────────────────────────────────────
//
// These routes shell out to the Python engine for `validate`. Skip when
// the engine isn't on PYTHONPATH (CI without the repo root mounted).

import { spawnSync } from 'node:child_process';

function engineAvailable() {
  // PYTHONPATH was set above; just check that the entrypoint resolves.
  const r = spawnSync('python3', ['-m', 'proxypilot.engine', '--help'],
    { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0;
}

test('paste creates a new entry, validate rejects bad cve id', { skip: !engineAvailable() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    process.env.PROXYPILOT_ENGINE_BIN = 'python3';
    process.env.PROXYPILOT_ENGINE_MODULE = 'proxypilot.engine';
    const router = await loadRouter(dir, 'vm');

    // Bad: missing cve field.
    const bad = await callRouter(router, '/', {
      method: 'POST',
      body: { content: 'name: just a thing\n' },
    });
    assert.equal(bad.status, 400);

    // Good: minimal valid spec gets written.
    const ok = await callRouter(router, '/', {
      method: 'POST',
      body: {
        content: [
          'cve: CVE-2026-7777',
          'name: paste test',
          'hosts:',
          '  vm: {action_class: ALERT, tier: 4}',
          'state: {status: NEW, operator_seen: false}',
          '',
        ].join('\n'),
      },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.cve, 'CVE-2026-7777');

    // List now sees the new entry.
    const { body: list } = await callList(router);
    const hit = list.entries.find(e => e.cve === 'CVE-2026-7777');
    assert.ok(hit, 'pasted entry appears in list');
    assert.equal(hit.action_class, 'ALERT');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PUT rejects when embedded cve disagrees with URL', { skip: !engineAvailable() }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    const router = await loadRouter(dir, 'vm');
    const r = await callRouter(router, '/CVE-2026-1111', {
      method: 'PUT',
      body: {
        content: 'cve: CVE-2026-2222\nstate: {status: NEW}\n',
      },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /does not match/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DELETE removes the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    await writeFile(join(dir, 'CVE-2026-3333.yaml'),
      'cve: CVE-2026-3333\nstate: {status: NEW}\n');
    const router = await loadRouter(dir, 'vm');
    const r = await callRouter(router, '/CVE-2026-3333', { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    const { body: list } = await callList(router);
    assert.equal(list.entries.find(e => e.cve === 'CVE-2026-3333'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DELETE 404s on missing entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    const router = await loadRouter(dir, 'vm');
    const r = await callRouter(router, '/CVE-2026-4444', { method: 'DELETE' });
    assert.equal(r.status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DELETE rejects path traversal in id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    const router = await loadRouter(dir, 'vm');
    const r = await callRouter(router, '/..%2F..%2Fetc%2Fshadow', { method: 'DELETE' });
    assert.equal(r.status, 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression: literal-path routes (/git-config, /git-sync, /poll)
// must register before the `:cveId` wildcard, or Express matches the
// wildcard first and the handler 400s the request as "invalid CVE id".
// The user hit this when clicking Save URL on the git source dialog —
// the PUT was being matched as PUT /:cveId with cveId='git-config'.

test('GET /git-config does not collide with /:cveId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    const router = await loadRouter(dir, 'vm');
    const r = await callRouter(router, '/git-config');
    assert.equal(r.status, 200);
    assert.ok('url' in r.body, 'returns the git-config shape, not a CVE detail');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PUT /git-config does not collide with /:cveId', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    const router = await loadRouter(dir, 'vm');
    const r = await callRouter(router, '/git-config', {
      method: 'PUT',
      body: { url: 'https://example.com/x.git#main' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.url, 'https://example.com/x.git#main');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PUT /git-config with empty URL clears the setting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    const router = await loadRouter(dir, 'vm');
    const r = await callRouter(router, '/git-config', {
      method: 'PUT',
      body: { url: '' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.url, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PUT /git-config rejects bare strings (no scheme)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    const router = await loadRouter(dir, 'vm');
    const r = await callRouter(router, '/git-config', {
      method: 'PUT',
      body: { url: 'just a string' },
    });
    assert.equal(r.status, 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// New "Added" + "latest_note" listing fields. These let the table
// render Date Added / Date Updated columns and inline applicability
// hints without an extra detail fetch.

test('list surfaces _proxypilot.imported_at as `added`', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    await writeFile(join(dir, 'CVE-2026-0010.yaml'), [
      'cve: CVE-2026-0010',
      'name: imported',
      '_proxypilot:',
      '  origin: git',
      '  git_url: https://example.com/x.git',
      '  imported_at: "2026-04-15T10:00:00Z"',
      'hosts: {vm: {action_class: ALERT, tier: 4}}',
      'state: {status: NEW, operator_seen: false}',
      '',
    ].join('\n'));
    const router = await loadRouter(dir, 'vm');
    const { body } = await callList(router);
    assert.equal(body.entries[0].added, '2026-04-15T10:00:00Z');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('list surfaces latest history entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    await writeFile(join(dir, 'CVE-2026-0011.yaml'), [
      'cve: CVE-2026-0011',
      'name: with-history',
      'hosts: {vm: {action_class: AUTO_PATCH, tier: 1}}',
      'state:',
      '  status: RESOLVED',
      '  operator_seen: true',
      '  history:',
      '    - ts: "2026-05-01T12:00:00Z"',
      '      actor: claude-routine',
      '      change: "initial entry"',
      '    - ts: "2026-05-05T18:42:11Z"',
      '      actor: proxypilot-engine',
      '      change: "probe exit=1; host not affected"',
      '      host: vm',
      '',
    ].join('\n'));
    const router = await loadRouter(dir, 'vm');
    const { body } = await callList(router);
    const note = body.entries[0].latest_note;
    assert.ok(note, 'latest_note should be present');
    assert.equal(note.ts, '2026-05-05T18:42:11Z');
    assert.equal(note.actor, 'proxypilot-engine');
    assert.match(note.change, /probe exit=1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detail returns added + latest_note + last_updated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cve-test-'));
  try {
    await writeFile(join(dir, 'CVE-2026-0012.yaml'), [
      'cve: CVE-2026-0012',
      'name: detail-fields',
      '_proxypilot: {origin: paste, imported_at: "2026-04-20T00:00:00Z"}',
      'hosts: {vm: {action_class: ALERT, tier: 4}}',
      'state:',
      '  status: NEW',
      '  last_updated: "2026-05-06T09:00:00Z"',
      '  history:',
      '    - {ts: "2026-04-20T00:00:00Z", actor: claude, change: created}',
      '',
    ].join('\n'));
    const router = await loadRouter(dir, 'vm');
    const { status, body } = await callRouter(router, '/CVE-2026-0012');
    assert.equal(status, 200);
    assert.equal(body.added, '2026-04-20T00:00:00Z');
    assert.equal(body.last_updated, '2026-05-06T09:00:00Z');
    assert.ok(body.latest_note);
    assert.equal(body.latest_note.actor, 'claude');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
