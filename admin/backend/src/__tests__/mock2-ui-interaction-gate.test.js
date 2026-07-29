// UI-INTERACTION COVERAGE GATE — the glob trick is dead.
//
// Project 47 cycle 2, in the build's own words: "this cycle added public/sw.js
// + build-id to an existing ui-check's paths so the touched-file coverage gate
// passes — no product-code change was needed." The gate was satisfied with
// zero new assertions. These tests run the REAL gate script (from the pinned
// framework-seed/gates.json) under sh, against a real git repo, and pin:
// infra files exempt; glob-only coverage fails; a new/changed assertion
// passes; pre-existing coverage stands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const gates = JSON.parse(readFileSync(new URL('../mock2/framework-seed/gates.json', import.meta.url), 'utf8'));
const SCRIPT = gates.find((g) => g.name === 'ui-interaction').script;

const CHECK = (steps) => ({
  id: 'notes-list-loads',
  name: 'notes list',
  paths: ['public/app.html'],
  page: '/',
  steps,
});
const STEPS = [{ expect_visible: '#note-grid' }];

function repoWith({ committed, working }) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-uigate-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'gate@test.invalid');
  git('config', 'user.name', 'gate');
  for (const [rel, content] of Object.entries(committed)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  git('add', '-A');
  git('commit', '-qm', 'baseline');
  for (const [rel, content] of Object.entries(working)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function runGate(dir) {
  const f = join(dir, 'gate.sh');
  writeFileSync(f, SCRIPT);
  const r = spawnSync('sh', [f], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const BASE = {
  'state/ui-checks.json': JSON.stringify({ checks: [CHECK(STEPS)] }),
  'public/app.html': '<html><body>app</body></html>',
};

test('P47 shape: sw.js + build-id are infrastructure — exempt, no check demanded', () => {
  const dir = repoWith({
    committed: BASE,
    working: { 'public/sw.js': 'self.addEventListener("fetch", () => {})', 'public/build-id.js': 'window.BUILD="2"' },
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /infrastructure files.*exempt|no user-facing screen files/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('glob-only coverage of a newly touched screen FAILS', () => {
  // The general form of the trick: a new screen file, covered by extending an
  // existing check's paths, with not one assertion added or changed.
  const dir = repoWith({
    committed: BASE,
    working: {
      'public/notes.html': '<html><body>new screen</body></html>',
      'state/ui-checks.json': JSON.stringify({
        checks: [{ ...CHECK(STEPS), paths: ['public/app.html', 'public/notes.html'] }],
      }),
    },
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /conjured by extending an existing check's path globs/);
    assert.match(r.out, /public\/notes\.html/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the same change WITH a new assertion passes', () => {
  const dir = repoWith({
    committed: BASE,
    working: {
      'public/notes.html': '<html><body>new screen</body></html>',
      'state/ui-checks.json': JSON.stringify({
        checks: [{
          ...CHECK([...STEPS, { expect_visible: '#notes-screen' }]),
          paths: ['public/app.html', 'public/notes.html'],
        }],
      }),
    },
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /new coverage backed by new\/changed assertions/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a brand-new check covering the new screen passes', () => {
  const dir = repoWith({
    committed: BASE,
    working: {
      'public/notes.html': '<html><body>new screen</body></html>',
      'state/ui-checks.json': JSON.stringify({
        checks: [CHECK(STEPS), { id: 'notes-screen', name: 'n', paths: ['public/notes.html'], page: '/notes', steps: [{ expect_visible: '#notes-screen' }] }],
      }),
    },
  });
  try {
    assert.equal(runGate(dir).code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('editing an ALREADY-covered screen needs no spec ceremony', () => {
  const dir = repoWith({
    committed: BASE,
    working: { 'public/app.html': '<html><body>app v2</body></html>' },
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 0, r.out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a touched screen with NO matching check still fails outright', () => {
  const dir = repoWith({
    committed: BASE,
    working: { 'public/orphan.html': '<html><body>x</body></html>' },
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /NO matching interaction check/);
    assert.match(r.out, /public\/orphan\.html/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the gate still carries the whole-file example and the step validation', () => {
  assert.match(SCRIPT, /Write state\/ui-checks\.json\. It is one JSON file/);
  assert.match(SCRIPT, /expect_value\) must follow a fill of the same control/);
  assert.match(SCRIPT, /CHEAPEST-PASS NOTE/);
});
