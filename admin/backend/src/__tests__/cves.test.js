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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// We bypass requireAdmin by stubbing req.user before the router runs.
// requireSudo isn't on GET / so the listing path is reachable.
async function callList(router) {
  const express = (await import('express')).default;
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1, role: 'admin', username: 'test' }; next(); });
  app.use('/', router);
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, async () => {
      const port = server.address().port;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`);
        const json = await r.json();
        resolve({ status: r.status, body: json });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

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
