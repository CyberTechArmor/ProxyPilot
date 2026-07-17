// The component-reuse gate (framework-seed/gates.json, battery order 8): the
// deterministic detector for the request-36 failure — a build re-implementing
// capability an installed component already ships instead of wiring it. These
// tests execute the gate's REAL embedded node script (extracted from the seed,
// so the tested logic is the shipped logic) against on-disk fixtures. The sh
// wrapper half (git diff collection, skip-when-absent) is conventional and
// covered by the ui-interaction gate's identical pattern.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(__dirname, '..', 'mock2', 'framework-seed', 'gates.json');

function gateNodeScript() {
  const gates = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const gate = gates.find((g) => g.name === 'component-reuse');
  assert.ok(gate, 'component-reuse gate present in the seed');
  assert.equal(gate.order, 8);
  const m = gate.script.match(/node <<'CRGATE'\n([\s\S]*?)\nCRGATE\n/);
  assert.ok(m, 'gate embeds a CRGATE node heredoc');
  return m[1];
}

// A scratch project tree: state/components.json + files on disk + the changed
// list the sh wrapper would have produced. Returns { dir, run }.
function fixture({ entries, files = {}, changed = [], allowlist = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-gate-'));
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state/components.json'), JSON.stringify({ schema_version: 1, entries }));
  if (allowlist != null) fs.writeFileSync(path.join(dir, 'state/component-reuse-allowlist.txt'), allowlist);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  const listFile = path.join(dir, 'changed.txt');
  fs.writeFileSync(listFile, changed.join('\n') + '\n');
  const script = path.join(dir, 'gate.cjs');
  fs.writeFileSync(script, gateNodeScript());
  const run = () => spawnSync(process.execPath, [script], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, CR_CHANGED: listFile },
  });
  return { dir, run };
}

const AUTH = {
  key: 'proxypilot-auth', status: 'installed', installed_at: 't',
  api: [
    { method: 'POST', path: '/api/auth/bootstrap/superadmin' },
    { method: 'GET', path: '/api/auth/bootstrap/status' },
    { method: 'POST', path: '/api/auth/login' },
  ],
  files: ['src/auth/routes.ts', 'scripts/bootstrap-superadmin.mjs', 'public/login.js'],
};

test('exact re-registration of a component endpoint outside its files FAILS', () => {
  const { run } = fixture({
    entries: [AUTH],
    files: { 'src/newauth/bootstrap.ts': `router.post('/api/auth/bootstrap/superadmin', handler);` },
    changed: ['src/newauth/bootstrap.ts'],
  });
  const r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /proxypilot-auth/);
  assert.match(r.stdout, /bootstrap\/superadmin/);
  assert.match(r.stdout, /Wire the component/);
});

test('mounted-router suffix (>=2 segments) FAILS; method must match', () => {
  const { run } = fixture({
    entries: [AUTH],
    files: {
      // POST /bootstrap/superadmin under a mount → duplication of the contract path.
      // GET on the same path is a different method → not the contract endpoint.
      'src/newauth/routes.ts': `r.post('/bootstrap/superadmin', h);\nr.get('/bootstrap/superadmin', h2);`,
    },
    changed: ['src/newauth/routes.ts'],
  });
  const r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /POST \/bootstrap\/superadmin/);
  assert.ok(!/GET \/bootstrap\/superadmin - already/.test(r.stdout), 'GET (method mismatch) not flagged');
});

test('client code CALLING a component endpoint is wiring, never flagged', () => {
  const { run } = fixture({
    entries: [AUTH],
    files: {
      // The app's own client helper + axios both CALL the component's endpoint —
      // that is exactly the wiring the harness wants; only an express-looking
      // receiver (app/router/xRouter/r) counts as a re-REGISTRATION.
      'src/lib/api-client.ts': `api.post('/api/auth/login', body);\naxios.post('/api/auth/bootstrap/superadmin', data);\nfetch('/api/auth/bootstrap/status');`,
    },
    changed: ['src/lib/api-client.ts'],
  });
  const r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /component-reuse: OK/);
});

test('a generic one-segment suffix never false-positives', () => {
  const { run } = fixture({
    entries: [AUTH],
    files: { 'src/health/routes.ts': `router.get('/status', health);` },
    changed: ['src/health/routes.ts'],
  });
  const r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /component-reuse: OK/);
});

test('editing the component\'s OWN file is adaptation, not duplication', () => {
  const { run } = fixture({
    entries: [AUTH],
    files: { 'src/auth/routes.ts': `router.post('/api/auth/bootstrap/superadmin', patched);` },
    changed: ['src/auth/routes.ts'],
  });
  assert.equal(run().status, 0);
});

test('a parallel copy of a component file (same basename, both on disk) FAILS', () => {
  const { run } = fixture({
    entries: [AUTH],
    files: {
      'scripts/bootstrap-superadmin.mjs': '// component original',
      'tools/bootstrap-superadmin.mjs': '// rebuilt copy',
    },
    changed: ['tools/bootstrap-superadmin.mjs'],
  });
  const r = run();
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /duplicates installed component file scripts\/bootstrap-superadmin\.mjs/);
});

test('a MOVE does not flag (component original gone) and generic basenames are exempt', () => {
  const moved = fixture({
    entries: [AUTH],
    files: { 'tools/bootstrap-superadmin.mjs': '// moved here; original gone' },
    changed: ['tools/bootstrap-superadmin.mjs'],
  });
  assert.equal(moved.run().status, 0);
  const generic = fixture({
    entries: [{ ...AUTH, files: ['src/auth/index.ts'] }],
    files: { 'src/other/index.ts': 'export {};' },
    changed: ['src/other/index.ts'],
  });
  assert.equal(generic.run().status, 0);
});

test('an allowlisted path is a reviewed waiver — the gate passes', () => {
  const { run } = fixture({
    entries: [AUTH],
    files: {
      'scripts/bootstrap-superadmin.mjs': '// original',
      'tools/bootstrap-superadmin.mjs': '// admin-approved duplicate',
    },
    changed: ['tools/bootstrap-superadmin.mjs'],
    allowlist: '# approved via deviation 12\ntools/bootstrap-superadmin.mjs\n',
  });
  assert.equal(run().status, 0);
});

test('no installed components → visible skip, exit 0', () => {
  const { run } = fixture({ entries: [], changed: ['src/x.ts'], files: { 'src/x.ts': '' } });
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skipped/);
});
