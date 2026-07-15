// Mock2 checkpoint-restore tests — the point-in-time restore decision layer.
//
// Stub-first (risk R9): imports ONLY restore-logic.js (pure, native-free). The
// restore path mutates a project's working tree AND its database, so the rules
// that gate it (valid target, no running build, latest-is-current) and the
// script invariants (append-only, history mirrors preserved, DB replay guarded)
// are unit-tested here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DB_SNAPSHOT_PATH, RESTORE_PRESERVED_PATHS,
  isValidCommitSha, validateRestoreRequest,
  buildDbSnapshotScript, buildRestoreScript,
  parseRestoreOutput, restoreSummary,
} from '../mock2/restore-logic.js';

const SHA = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4';

test('isValidCommitSha: hex 7–40 only', () => {
  assert.equal(isValidCommitSha(SHA), true);
  assert.equal(isValidCommitSha('abc1234'), true);
  assert.equal(isValidCommitSha('ABC1234'), true); // case-insensitive hex
  assert.equal(isValidCommitSha('abc123'), false); // too short
  assert.equal(isValidCommitSha(`${SHA}0`), false); // too long
  assert.equal(isValidCommitSha('main'), false);
  assert.equal(isValidCommitSha('HEAD; rm -rf /'), false);
  assert.equal(isValidCommitSha(''), false);
  assert.equal(isValidCommitSha(null), false);
});

test('validateRestoreRequest: happy path', () => {
  const r = validateRestoreRequest({
    record: { seq: 3, commit_sha: SHA }, latestSeq: 7, runningCycles: 0, lifecycle: 'active',
  });
  assert.equal(r.ok, true);
});

test('validateRestoreRequest: refusals name the specific problem', () => {
  const record = { seq: 3, commit_sha: SHA };
  // project offline
  let r = validateRestoreRequest({ record, latestSeq: 7, runningCycles: 0, lifecycle: 'stopped' });
  assert.equal(r.ok, false);
  assert.match(r.error, /online/);
  // a build is running
  r = validateRestoreRequest({ record, latestSeq: 7, runningCycles: 1, lifecycle: 'active' });
  assert.equal(r.ok, false);
  assert.match(r.error, /build is running/i);
  // unknown checkpoint
  r = validateRestoreRequest({ record: null, latestSeq: 7, runningCycles: 0, lifecycle: 'active' });
  assert.equal(r.ok, false);
  assert.match(r.error, /No such checkpoint/);
  // checkpoint without a commit (pre-checkpointing history)
  r = validateRestoreRequest({ record: { seq: 3, commit_sha: null }, latestSeq: 7, runningCycles: 0, lifecycle: 'active' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no commit/);
  // the latest checkpoint IS the current state — the default, nothing to restore
  r = validateRestoreRequest({ record: { seq: 7, commit_sha: SHA }, latestSeq: 7, runningCycles: 0, lifecycle: 'active' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already the current state/);
});

test('buildDbSnapshotScript: guarded pg_dump into the snapshot path, never fails the checkpoint', () => {
  const s = buildDbSnapshotScript({ appDir: '/srv/app' });
  assert.match(s, /pg_dump --clean --if-exists app/); // replaying resets schema AND data
  assert.ok(s.includes(DB_SNAPSHOT_PATH));
  assert.match(s, /command -v pg_dump/); // no Postgres → skip, not fail
  assert.match(s, /exit 0\s*$/); // best-effort by contract
  // dump goes through a tmp file so a failed dump never truncates a good snapshot
  assert.ok(s.includes(`${DB_SNAPSHOT_PATH}.tmp`));
});

test('buildRestoreScript: append-only restore with history mirrors preserved', () => {
  const s = buildRestoreScript({ appDir: '/srv/app', commitSha: SHA, message: 'restore to checkpoint #3' });
  // target must exist in the repo before anything moves
  assert.match(s, /git cat-file -e "\$TARGET\^\{commit\}"/);
  // uncommitted work is checkpointed FIRST — restore never destroys state
  assert.match(s, /checkpoint: pre-restore \(auto\)/);
  // tree reset to the target…
  assert.match(s, /git read-tree -u --reset "\$TARGET"/);
  // …with the append-only change-record mirrors carried across
  for (const p of RESTORE_PRESERVED_PATHS) assert.ok(s.includes(p));
  // DB replay only when the restored tree carries a snapshot AND Postgres is up
  assert.ok(s.includes(`[ -f "${DB_SNAPSHOT_PATH}" ]`));
  assert.match(s, /MOCK2_DB_RESTORE=restored/);
  assert.match(s, /MOCK2_DB_RESTORE=no_snapshot/);
  assert.match(s, /MOCK2_DB_RESTORE=no_postgres/);
  // the restore lands as a NEW commit (its record needs its own sha) and pushes
  assert.match(s, /commit -q --allow-empty/);
  assert.match(s, /git push -q origin HEAD:main/);
  assert.match(s, /MOCK2_RESTORED_SHA=\$\(git rev-parse HEAD\)/);
});

test('buildRestoreScript: refuses a non-sha target (injection guard)', () => {
  assert.throws(() => buildRestoreScript({ commitSha: 'main' }), /invalid commit sha/);
  assert.throws(() => buildRestoreScript({ commitSha: `${SHA}; rm -rf /` }), /invalid commit sha/);
  assert.throws(() => buildRestoreScript({}), /invalid commit sha/);
});

test('buildRestoreScript: message is sanitized like the checkpoint script', () => {
  const s = buildRestoreScript({ commitSha: SHA, message: 'evil "$(touch /pwned)" `x` \\' });
  // the dangerous characters ("'`$\) are stripped from the message before it
  // lands inside the double-quoted -m argument
  assert.ok(!s.includes('$(touch'));
  assert.ok(!s.includes('`x`'));
  assert.ok(s.includes('evil (touch /pwned) x'));
});

test('parseRestoreOutput: extracts the markers, tolerates noise', () => {
  const out = `[mock2] some noise\nMOCK2_DB_RESTORE=restored\nmore noise\nMOCK2_RESTORED_SHA=${SHA}\n`;
  assert.deepEqual(parseRestoreOutput(out), { sha: SHA, db: 'restored' });
  assert.deepEqual(parseRestoreOutput('no markers at all'), { sha: null, db: null });
  assert.deepEqual(parseRestoreOutput(null), { sha: null, db: null });
  // an unknown db token is not matched (the route treats it as unknown, not trusted)
  assert.equal(parseRestoreOutput('MOCK2_DB_RESTORE=maybe').db, null);
});

test('restoreSummary: says where the project went and whether the database rode along', () => {
  const base = { seq: 3, commitSha: SHA };
  assert.match(restoreSummary({ ...base, db: 'restored' }), /checkpoint #3/);
  assert.match(restoreSummary({ ...base, db: 'restored' }), /code and database/);
  assert.match(restoreSummary({ ...base, db: 'no_snapshot' }), /no database snapshot existed/);
  assert.match(restoreSummary({ ...base, db: 'failed' }), /replay failed/);
  assert.match(restoreSummary({ ...base, db: null }), /code/);
  // history stays append-only and the reader is told so
  assert.match(restoreSummary({ ...base, db: 'restored' }), /History above is preserved/);
});
