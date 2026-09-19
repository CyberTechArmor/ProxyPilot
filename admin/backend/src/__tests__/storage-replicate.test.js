// scripts/storage-replicate.sh — the syncoid wrapper's status file, which is
// the ONLY thing replication_status and the freshness monitor read. Driven
// with a stub syncoid, so it runs anywhere (no ZFS, no network).
//
// Regression: every successful run used to write
//   "finished_at":"2026-…""2026-…"
// because `${v:+"\"$v\""}${v:-null}` yields the value twice when v is set.
// The file did not parse, so a job that had just succeeded was reported as
// never having succeeded — caught by the loop-device job in CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WRAPPER = new URL('../../../../scripts/storage-replicate.sh', import.meta.url).pathname;
const JOB = 'unittest';

function harness({ syncoid }) {
  const root = mkdtempSync(join(tmpdir(), 'pp-repl-'));
  const conf = join(root, 'conf'); const state = join(root, 'state');
  mkdirSync(conf, { recursive: true }); mkdirSync(state, { recursive: true });
  writeFileSync(join(conf, `replication-${JOB}.conf`), [
    `PP_REPL_NAME='${JOB}'`, "PP_REPL_SOURCES='tank/incus'", "PP_REPL_TARGET='tank2/pp'",
    "PP_REPL_KIND='local'", "PP_REPL_SSH_KEY=''", "PP_REPL_SSH_PORT=''", "PP_REPL_RECURSIVE='1'", "PP_REPL_EXTRA_ARGS=''", '',
  ].join('\n'));
  const bin = join(root, 'syncoid');
  writeFileSync(bin, `#!/bin/sh\n${syncoid}\n`); chmodSync(bin, 0o755);
  const run = () => spawnSync('bash', [WRAPPER, JOB], {
    encoding: 'utf8',
    env: { ...process.env, PROXYPILOT_STORAGE_CONF_DIR: conf, PROXYPILOT_STORAGE_STATE_DIR: state, SYNCOID_BIN: bin },
  });
  /** Re-point the stub at a new body and run again, same state dir. */
  const runWith = (body) => { writeFileSync(bin, `#!/bin/sh\n${body}\n`); chmodSync(bin, 0o755); return run(); };
  const statusFile = join(state, 'replication', `${JOB}.json`);
  const status = () => JSON.parse(readFileSync(statusFile, 'utf8'));
  return { run, runWith, status, statusFile, state, conf };
}

test('a successful run writes VALID json recording the success', () => {
  const h = harness({ syncoid: 'echo "INFO: sending incremental"; exit 0' });
  const r = h.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(h.statusFile), 'status file written');
  const s = h.status();                       // throws if the JSON is malformed
  assert.equal(s.name, JOB);
  assert.equal(s.ok, true);
  assert.equal(s.running, false);
  assert.equal(s.exit_code, 0);
  assert.equal(s.error, '');
  assert.match(s.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(s.finished_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(s.last_success_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(s.last_success_at, s.finished_at);
  assert.equal(s.target, 'tank2/pp');
  assert.match(s.log_tail, /sending incremental/);
});

test('a failing run records the failure, with syncoid\'s own message, and keeps a previous success', () => {
  // one harness, two runs against the same state dir: succeed, then fail.
  const h = harness({ syncoid: 'exit 0' });
  assert.equal(h.run().status, 0);
  const firstSuccess = h.status().last_success_at;
  assert.ok(firstSuccess);

  const r = h.runWith('echo "CRITICAL ERROR: cannot receive: destination has snapshots" >&2; exit 3');
  assert.equal(r.status, 3, 'the wrapper exits with syncoid\'s status');
  const s = h.status();
  assert.equal(s.ok, false);
  assert.equal(s.exit_code, 3);
  assert.match(s.error, /cannot receive: destination has snapshots/);
  assert.ok(!s.error.startsWith('=='), 'the reason is syncoid\'s line, not the wrapper\'s marker');
  assert.equal(s.last_success_at, firstSuccess, 'the earlier success survives a later failure');
  assert.equal(s.running, false);
});

test('the wrapper refuses a config it did not write, and an unknown job', () => {
  const h = harness({ syncoid: 'exit 0' });
  const unknown = spawnSync('bash', [WRAPPER, 'nope'], { encoding: 'utf8', env: { ...process.env, PROXYPILOT_STORAGE_CONF_DIR: h.conf, PROXYPILOT_STORAGE_STATE_DIR: h.state } });
  assert.equal(unknown.status, 66);
  const bad = spawnSync('bash', [WRAPPER, 'BadName'], { encoding: 'utf8' });
  assert.equal(bad.status, 64);
  // a conf carrying anything but the generated KEY='value' lines is refused
  const conf = h.conf;
  writeFileSync(join(conf, 'replication-evil.conf'), "PP_REPL_NAME='evil'\nrm -rf /tmp/pwned\n");
  const evil = spawnSync('bash', [WRAPPER, 'evil'], { encoding: 'utf8', env: { ...process.env, PROXYPILOT_STORAGE_CONF_DIR: conf, PROXYPILOT_STORAGE_STATE_DIR: h.state } });
  assert.equal(evil.status, 65);
  assert.match(evil.stderr, /refusing to source/);
});
