// Build identity / PWA cache correctness.
//
// Origin (measured, project 34): a hardcoded service-worker cache name meant the
// worker's bytes never changed across deploys, so the browser never installed a
// new worker and never purged old assets. A client could keep executing
// pre-deploy JS while the server served the new build — three builds ($5.81,
// ~43 min) were spent chasing that ghost before the real cause was found. These
// tests pin the mechanism that makes a deploy actually reach a browser.
//
// Native-free: pure deploy-logic + the pure scaffold file contents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newBuildId, sanitizeBuildId, buildIdStampScript, buildStampReportScript,
  interpretBuildStamp, BUILD_ID_PLACEHOLDER, BUILD_ID_RE, LEGACY_SW_JS,
} from '../mock2/deploy-logic.js';
import { buildScaffoldFiles, scaffoldPwaFiles } from '../mock2/scaffold.js';

test('newBuildId: sortable, unique-ish, and safe in a JS literal / cache name', () => {
  const id = newBuildId(new Date('2026-07-25T12:34:56Z'), 0.5);
  assert.match(id, BUILD_ID_RE);
  assert.ok(id.startsWith('20260725123456'), `expected a UTC timestamp prefix, got ${id}`);
  // No quote/slash/space can reach a sed expression or a CacheStorage key.
  assert.match(id, /^[0-9a-z-]+$/);
  // Sortable: a later deploy always compares greater.
  assert.ok(newBuildId(new Date('2026-07-25T12:34:57Z'), 0.5) > id);
});

test('sanitizeBuildId: strips anything that could escape a shell/sed context', () => {
  assert.equal(sanitizeBuildId("a'b;rm -rf /"), 'abrm-rf');
  assert.equal(sanitizeBuildId(''), 'unknown');
  assert.equal(sanitizeBuildId(null), 'unknown');
  assert.equal(sanitizeBuildId('20260725123456-abcd'), '20260725123456-abcd');
});

test('stamp script re-stamps: matches the placeholder AND a previous build id', () => {
  const script = buildIdStampScript('/srv/app', '20260725123456-zzzz');
  // The sed alternation is what makes a SECOND deploy work — without the
  // already-stamped branch, stamping would silently no-op after the first one.
  const sedLine = script.split('\n').find((l) => l.includes('sw.js'));
  assert.ok(sedLine.includes(BUILD_ID_PLACEHOLDER), 'must still match a never-stamped file');
  assert.ok(/\[0-9\]\\\{14\\\}-\[a-z0-9\]\\\{1,4\\\}/.test(sedLine), 'must also match an already-stamped id');
  // Touches all three surfaces: the worker, the client copy, the server copy.
  assert.ok(script.includes('public/sw.js'));
  assert.ok(script.includes('public/build-id.js'));
  assert.ok(script.includes('public/build-id.txt'));
  // Every file is optional — an older project must not fail the deploy.
  assert.ok(script.includes('|| true'));
});

test('interpretBuildStamp: consistent stamp is healthy', () => {
  const v = interpretBuildStamp('TXT=20260725123456-abcd\nJS=20260725123456-abcd\nSW=20260725123456-abcd');
  assert.equal(v.ok, true);
  assert.equal(v.instrumented, true);
  assert.equal(v.stale_risk, false);
});

test('interpretBuildStamp: the exact failure modes are flagged as stale risk', () => {
  // Never stamped — the worker can never update (the original defect).
  const never = interpretBuildStamp(`TXT=${BUILD_ID_PLACEHOLDER}\nJS=${BUILD_ID_PLACEHOLDER}\nSW=${BUILD_ID_PLACEHOLDER}`);
  assert.equal(never.stale_risk, true);
  assert.match(never.detail, /never stamped/);

  // The worker lagged behind the server — clients run a different build.
  const drift = interpretBuildStamp('TXT=20260725123456-abcd\nJS=20260725123456-abcd\nSW=20260101000000-0000');
  assert.equal(drift.stale_risk, true);
  assert.match(drift.detail, /disagree/);

  // Partially instrumented.
  const partial = interpretBuildStamp('TXT=20260725123456-abcd\nJS=-\nSW=-');
  assert.equal(partial.stale_risk, true);
});

test('interpretBuildStamp: a pre-instrumentation project is reported, not failed', () => {
  const v = interpretBuildStamp('TXT=-\nJS=-\nSW=-');
  assert.equal(v.instrumented, false);
  assert.equal(v.stale_risk, false);
  assert.equal(v.ok, true); // never turns a working deploy into a failure
  assert.match(v.detail, /pre-instrumentation/);
});

test('buildStampReportScript reads all three surfaces', () => {
  const s = buildStampReportScript('/srv/app');
  for (const k of ['TXT=', 'JS=', 'SW=']) assert.ok(s.includes(k), `missing ${k}`);
});

test('scaffold ships a per-deploy-versioned worker that purges old caches', () => {
  const files = buildScaffoldFiles({ name: 'Notes' });
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
  const sw = byPath['public/sw.js'];
  assert.ok(sw, 'public/sw.js present');

  // The whole fix in one assertion: the cache name is derived from a per-deploy
  // build id, NOT hardcoded. The legacy worker is what this replaces.
  assert.ok(sw.includes(BUILD_ID_PLACEHOLDER), 'sw.js must carry the stampable build id');
  assert.match(sw, /const CACHE = 'app-shell-' \+ BUILD_ID/);
  assert.ok(!sw.includes("'app-shell-v1'"), 'the hardcoded cache name must be gone');
  // activate purges every cache that is not this build's.
  assert.match(sw, /caches\.delete/);
  // The waiting worker can be told to take over (drives the update prompt).
  assert.match(sw, /SKIP_WAITING/);
  // The staleness probe must never be served from cache.
  assert.match(sw, /'\/__build'/);

  // Client + server copies of the id, and the update/self-heal bootstrap.
  assert.ok(byPath['public/build-id.js'].includes(BUILD_ID_PLACEHOLDER));
  assert.ok(byPath['public/build-id.txt'].includes(BUILD_ID_PLACEHOLDER));
  const install = byPath['public/install.js'];
  assert.match(install, /controllerchange/);
  assert.match(install, /__build/);          // self-heal probe
  assert.match(install, /sessionStorage/);   // reload-loop guard
  // The shell serves the client id and the app exposes the live one.
  assert.match(byPath['public/app-shell.html'], /build-id\.js/);
});

test('the legacy worker constant matches what the retrofit is allowed to replace', () => {
  // The retrofit replaces public/sw.js ONLY when it hashes to this exact string.
  // If the constant drifted from the real legacy content the retrofit would
  // silently stop firing, so pin its defining properties.
  assert.ok(LEGACY_SW_JS.includes("const CACHE = 'app-shell-v1';"));
  assert.ok(!LEGACY_SW_JS.includes('BUILD_ID'), 'legacy worker has no build id — that is the bug');
  // And it must NOT equal the current worker (otherwise nothing to retrofit).
  assert.notEqual(LEGACY_SW_JS, scaffoldPwaFiles().swJs);
});
