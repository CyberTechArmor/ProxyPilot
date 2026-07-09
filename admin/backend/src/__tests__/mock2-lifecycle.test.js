// Mock2 Phase M3 tests — archived read-only predicate, idle-stop staleness,
// the archive checkpoint script, and the archived-project routing invariant.
//
// Stub-first (risk R9 / docs/known-issues.md): imports ONLY the pure decision
// modules (project-logic.js, template.js). None pulls in better-sqlite3,
// Express, Incus, or git, so the suite never worsens the fresh-checkout
// native-module gap. The real archive/rehydrate host round-trip is exercised by
// scripts/mock2-m3-verify.sh on an enabled host (see docs/mock2/README.md).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isProjectReadOnly,
  isIdleStale,
  projectActiveFqdns,
  deriveProjectStatus,
} from '../mock2/project-logic.js';
import { buildCheckpointScript } from '../mock2/template.js';

// ---- archived read-only guard predicate (Q4 / §M3) ----

test('isProjectReadOnly: only an archived project is read-only', () => {
  assert.equal(isProjectReadOnly({ lifecycle: 'archived' }), true);
  assert.equal(isProjectReadOnly({ lifecycle: 'active' }), false);
  assert.equal(isProjectReadOnly({ lifecycle: 'stopped' }), false);
  assert.equal(isProjectReadOnly({ lifecycle: 'provisioning' }), false);
  assert.equal(isProjectReadOnly({ lifecycle: 'failed_provisioning' }), false);
  assert.equal(isProjectReadOnly(null), false);
});

// ---- archived project publishes no route (rehydrate restores the same slug) ----

test('projectActiveFqdns: an archived project contributes nothing to Caddy', () => {
  const archived = {
    id: 3, lifecycle: 'archived', slug: 'p-12345678', parent_domain: 'dev.example.com',
    container_ip: '10.0.3.4', web_port: 3000, // stale cache — must still publish nothing
  };
  assert.deepEqual(projectActiveFqdns(archived, [], '2026-07-09T12:00:00.000Z'), []);
});

test('deriveProjectStatus: archived wins over everything', () => {
  assert.equal(deriveProjectStatus({ lifecycle: 'archived' }, { editorCount: 0, containerState: 'running' }), 'archived');
});

// ---- idle-stop staleness (M3 groundwork) ----

const NOW = '2026-07-20T12:00:00.000Z';

test('isIdleStale: an active project past the window is stale', () => {
  const eightDaysAgo = '2026-07-12T11:00:00.000Z';
  assert.equal(isIdleStale({ lifecycle: 'active', last_activity_at: eightDaysAgo }, NOW, 7), true);
});

test('isIdleStale: within the window is not stale', () => {
  const threeDaysAgo = '2026-07-17T12:00:00.000Z';
  assert.equal(isIdleStale({ lifecycle: 'active', last_activity_at: threeDaysAgo }, NOW, 7), false);
});

test('isIdleStale: only active projects are ever stale', () => {
  const old = '2026-06-01T00:00:00.000Z';
  for (const lc of ['archived', 'stopped', 'provisioning', 'failed_provisioning']) {
    assert.equal(isIdleStale({ lifecycle: lc, last_activity_at: old }, NOW, 7), false);
  }
});

test('isIdleStale: a window of 0 disables idle-stop', () => {
  const old = '2026-06-01T00:00:00.000Z';
  assert.equal(isIdleStale({ lifecycle: 'active', last_activity_at: old }, NOW, 0), false);
});

test('isIdleStale: falls back to created_at, and never crashes on a bad date', () => {
  const old = '2026-06-01T00:00:00.000Z';
  assert.equal(isIdleStale({ lifecycle: 'active', created_at: old }, NOW, 7), true);
  assert.equal(isIdleStale({ lifecycle: 'active', last_activity_at: 'not-a-date' }, NOW, 7), false);
  assert.equal(isIdleStale({ lifecycle: 'active' }, NOW, 7), false);
});

// ---- archive checkpoint script (ADR-006/011) ----

test('buildCheckpointScript: commits dirty state and pushes to the bare repo over the mount', () => {
  const s = buildCheckpointScript({ appDir: '/srv/app' });
  assert.match(s, /APP_DIR="\/srv\/app"/);
  assert.match(s, /git add -A/);
  assert.match(s, /git diff --cached --quiet/);      // only commit when there is something
  assert.match(s, /commit -q -m "checkpoint: pre-archive"/);
  assert.match(s, /git push -q origin HEAD:main/);   // push to the bare repo (origin = /srv/repo.git)
});

test('buildCheckpointScript: is a no-op with exit 0 when there is no working clone', () => {
  const s = buildCheckpointScript({ appDir: '/srv/app' });
  assert.match(s, /if \[ ! -d "\$APP_DIR\/\.git" \]; then/);
  assert.match(s, /exit 0/);
});

test('buildCheckpointScript: sanitizes the commit message (no shell breakout)', () => {
  const s = buildCheckpointScript({ appDir: '/srv/app', message: 'evil"; rm -rf /; echo "' });
  // Quotes/backticks/$/backslash are stripped, so the payload cannot close the
  // -m "..." string and inject a command.
  assert.ok(!s.includes('"; rm'), 'commit message must not break out of its quotes');
  assert.match(s, /commit -q -m "evil; rm -rf \/; echo "/);
});
