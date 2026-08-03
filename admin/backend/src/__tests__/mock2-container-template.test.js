// Node 20 in the build container (run-taxonomy fix #2/A2) — pure logic tests
// plus source-level wiring checks.
//
// Native-free: node-runtime-logic.js imports nothing. template.js is native
// (imports scaffold.js etc. transitively) but buildContainerSetupScript itself
// is a pure string builder with no I/O, so it's exercised directly here — the
// existing convention (mock2-network.test.js, mock2-deploy.test.js already
// import buildContainerSetupScript / buildDevServiceUnit this way).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  NODE_RUNTIME_MIN_MAJOR, nodeRuntimeInstallScript, nodeRuntimeProbeScript,
  parseNodeRuntimeProbe, describeNodeRuntimeOutcome,
} from '../mock2/node-runtime-logic.js';
import { buildContainerSetupScript } from '../mock2/template.js';

// ---- node-runtime-logic (pure) ----

test('NODE_RUNTIME_MIN_MAJOR is 20', () => {
  assert.equal(NODE_RUNTIME_MIN_MAJOR, 20);
});

test('nodeRuntimeInstallScript: targets nodesource setup_20.x (or newer)', () => {
  const s = nodeRuntimeInstallScript();
  assert.match(s, /setup_(2[0-9])\.x/);
  const major = Number(s.match(/setup_(\d+)\.x/)[1]);
  assert.ok(major >= 20, `expected nodesource major >= 20, got ${major}`);
});

test('nodeRuntimeInstallScript: does not rely on the bare distro nodejs as its primary path', () => {
  const s = nodeRuntimeInstallScript();
  // The distro package appears only as a guarded fallback (after `command -v
  // node` fails), never as the first/unconditional install line.
  const firstInstallLine = s.split('\n').find((l) => /apt-get install/.test(l));
  assert.match(firstInstallLine, /nodesource|nodejs \\\s*$|nodejs$/); // nodesource's own apt-get install line
  assert.match(s, /command -v node >\/dev\/null 2>&1 \|\| apt-get install/, 'distro nodejs must be a fallback, guarded by a node-already-present check');
});

test('nodeRuntimeInstallScript: every install step is non-fatal', () => {
  const s = nodeRuntimeInstallScript();
  // No line can abort the script: curl/bash/apt-get calls are chained with &&
  // into a guarded if, or trailed with || echo / || true.
  for (const line of s.split('\n')) {
    if (!/apt-get install|curl -fsSL|bash \/tmp/.test(line)) continue;
    const guarded = /\|\|/.test(line) || /&&\s*$/.test(line.trimEnd()) || /\\\s*$/.test(line) || /^\s*if /.test(line);
    assert.ok(guarded, `install line is not guarded: "${line}"`);
  }
});

test('nodeRuntimeInstallScript: idempotent — guarded by a version-check condition', () => {
  const s = nodeRuntimeInstallScript();
  assert.match(s, /node -p 'process\.versions\.node\.split\("\."\)\[0\]'/);
  assert.match(s, /-ge 20/);
});

test('nodeRuntimeProbeScript: prints both markers unconditionally', () => {
  const s = nodeRuntimeProbeScript();
  assert.match(s, /__MOCK2_NODE_CHANGED__:\$NEEDS_INSTALL/);
  assert.match(s, /__MOCK2_NODE_VERSION__:/);
});

test('parseNodeRuntimeProbe: an install that ran and a resolved version', () => {
  const out = 'some apt noise\n__MOCK2_NODE_CHANGED__:1\n__MOCK2_NODE_VERSION__:v20.11.0\n';
  assert.deepEqual(parseNodeRuntimeProbe(out), { changed: true, version: 'v20.11.0' });
});

test('parseNodeRuntimeProbe: already satisfied, no install needed', () => {
  const out = '__MOCK2_NODE_CHANGED__:0\n__MOCK2_NODE_VERSION__:v20.11.0\n';
  assert.deepEqual(parseNodeRuntimeProbe(out), { changed: false, version: 'v20.11.0' });
});

test('parseNodeRuntimeProbe: node still unavailable after the repair attempt', () => {
  const out = '__MOCK2_NODE_CHANGED__:1\n__MOCK2_NODE_VERSION__:unavailable\n';
  assert.deepEqual(parseNodeRuntimeProbe(out), { changed: true, version: null });
});

test('parseNodeRuntimeProbe: garbage/empty output never throws', () => {
  assert.deepEqual(parseNodeRuntimeProbe(''), { changed: false, version: null });
  assert.deepEqual(parseNodeRuntimeProbe('a shell crashed halfway'), { changed: false, version: null });
});

test('describeNodeRuntimeOutcome: a resolved version is ok, whether or not it changed', () => {
  assert.deepEqual(
    describeNodeRuntimeOutcome({ changed: true, version: 'v20.11.0' }),
    { ok: true, changed: true, version: 'v20.11.0', detail: 'installed Node v20.11.0' },
  );
  assert.deepEqual(
    describeNodeRuntimeOutcome({ changed: false, version: 'v20.11.0' }),
    { ok: true, changed: false, version: 'v20.11.0', detail: 'already Node v20.11.0' },
  );
});

test('describeNodeRuntimeOutcome: no version resolved is NOT ok, and carries the stderr tail', () => {
  const out = describeNodeRuntimeOutcome({ changed: true, version: null }, { stderrTail: 'E: unable to locate package' });
  assert.equal(out.ok, false);
  assert.match(out.detail, /unable to locate package/);
});

// ---- buildContainerSetupScript (pure string builder) ----

test('buildContainerSetupScript embeds the shared Node runtime install block', () => {
  const s = buildContainerSetupScript({ appDir: '/srv/app', webPort: 3000 });
  assert.match(s, /setup_20\.x/);
  assert.doesNotMatch(
    s,
    /^apt-get install -y --no-install-recommends nodejs npm \|\| echo "\[mock2\] nodejs\/npm install skipped\/failed \(non-fatal; the app cannot deploy without it\)"$/m,
    'the OLD unconditional distro-only install line must be gone',
  );
});

test('buildContainerSetupScript: the Node block sits after python3/toolbox installs, before Postgres bring-up', () => {
  const s = buildContainerSetupScript({ appDir: '/srv/app', webPort: 3000 });
  const nodeIdx = s.indexOf('setup_20.x');
  const pgBringUpIdx = s.indexOf('pg_ctlcluster');
  assert.ok(nodeIdx !== -1 && pgBringUpIdx !== -1 && nodeIdx < pgBringUpIdx);
});

// ---- wiring: the repair pass reaches already-provisioned containers ----

test('ensureNodeRuntime is wired into the build-time repair pass (component-install.js)', async () => {
  const src = await readFile(new URL('../mock2/component-install.js', import.meta.url), 'utf8');
  assert.match(src, /export async function ensureNodeRuntime/);
  // Called from preinstallComponents (the "single choke point" every build
  // funnels through), alongside the existing scaffold-dep repair.
  const preinstallIdx = src.indexOf('export async function preinstallComponents');
  assert.ok(preinstallIdx !== -1);
  const afterPreinstall = src.slice(preinstallIdx);
  assert.match(afterPreinstall, /ensureScaffoldDeps\(/);
  assert.match(afterPreinstall, /ensureNodeRuntime\(/);
  const scaffoldAt = afterPreinstall.indexOf('ensureScaffoldDeps(');
  const nodeAt = afterPreinstall.indexOf('ensureNodeRuntime(');
  assert.ok(nodeAt > scaffoldAt, 'expected ensureNodeRuntime to run near/after the scaffold-dep repair');
});

test('ensureNodeRuntime is also wired into the manual retry-deploy repair pass (runner.js)', async () => {
  const src = await readFile(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  const retryDeployIdx = src.indexOf('export async function retryDeploy');
  assert.ok(retryDeployIdx !== -1);
  const nextFnIdx = src.indexOf('\nexport async function acceptPendingVerification');
  const body = src.slice(retryDeployIdx, nextFnIdx === -1 ? undefined : nextFnIdx);
  assert.match(body, /ensureNodeRuntime/);
});
