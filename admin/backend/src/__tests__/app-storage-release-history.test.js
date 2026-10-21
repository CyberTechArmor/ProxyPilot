import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APPLICATION_RELEASE_SCHEMA } from '../mock2/application-profile.js';
import { previousLiveRelease, previousLiveFrom } from '../lib/app-storage/release-history.js';

const S = c => c.repeat(40);
const ROOT = '/opt/nodus-releases';
const rel = c => `${ROOT}/${S(c)}-p6-job${c}`;

function db({ live, rows = [] }) {
  const d = new DatabaseSync(':memory:');
  d.exec(APPLICATION_RELEASE_SCHEMA);
  d.prepare("INSERT INTO mock2_applications (id, target_id, name, repository_path, created_at, live_json) VALUES (1, 'nodus', 'Nodus', '/r', '2026-09-01T00:00:00Z', ?)").run(live ? JSON.stringify(live) : null);
  for (const r of rows) {
    d.prepare("INSERT INTO mock2_application_candidates (application_id, sha, profile_revision, profile_digest, tree_sha, checkpoint_at, hygiene_json, validation_json, live_json) VALUES (1, ?, ?, 'd', 't', '2026-09-01T00:00:00Z', '{}', ?, ?)")
      .run(r.sha, r.revision || 6, r.validation ? JSON.stringify(r.validation) : null, r.live ? JSON.stringify(r.live) : null);
  }
  return d;
}

test('the live record naming its previous release wins, with the folder it was deployed from', () => {
  const d = db({
    live: { sha: S('d'), releasePath: rel('d'), previousSha: S('b'), verifiedAt: '2026-10-20T12:00:00Z' },
    rows: [
      { sha: S('b'), validation: { passed: true, releasePath: rel('b'), validatedAt: '2026-10-10T00:00:00Z' }, live: { sha: S('b'), releasePath: rel('b'), verifiedAt: '2026-10-11T00:00:00Z' } },
      { sha: S('c'), validation: { passed: true, releasePath: rel('c'), validatedAt: '2026-10-19T00:00:00Z' } },
    ],
  });
  assert.deepEqual(previousLiveRelease(d, 1), { sha: S('b'), path: rel('b') });
});

test('previousSha null (application_verify dropped it): the release most recently live before the current one, never a newer validation', () => {
  const d = db({
    live: { sha: S('d'), releasePath: rel('d'), previousSha: null, verifiedAt: '2026-10-20T12:00:00Z' },
    rows: [
      { sha: S('a'), live: { sha: S('a'), releasePath: rel('a'), verifiedAt: '2026-10-01T00:00:00Z' } },
      { sha: S('b'), live: { sha: S('b'), releasePath: rel('b'), verifiedAt: '2026-10-11T00:00:00Z' } },
      // Validated after b, never deployed: newer, but never the previous live release.
      { sha: S('c'), validation: { passed: true, releasePath: rel('c'), validatedAt: '2026-10-19T00:00:00Z' } },
      // The current release's own record (an older profile revision too) is not "before".
      { sha: S('d'), live: { sha: S('d'), releasePath: rel('d'), verifiedAt: '2026-10-20T12:00:00Z' } },
      { sha: S('d'), revision: 5, live: { sha: S('d'), releasePath: `${ROOT}/${S('d')}-p5-old`, verifiedAt: '2026-10-15T00:00:00Z' } },
    ],
  });
  assert.deepEqual(previousLiveRelease(d, 1), { sha: S('b'), path: rel('b') });
});

test('no deploy history, no live record, an unreadable database: unknown (null)', () => {
  assert.equal(previousLiveRelease(db({ live: { sha: S('d'), releasePath: rel('d'), verifiedAt: '2026-10-20T12:00:00Z' }, rows: [{ sha: S('c'), validation: { passed: true, releasePath: rel('c') } }] }), 1), null);
  assert.equal(previousLiveRelease(db({ live: null }), 1), null);
  assert.equal(previousLiveRelease(db({ live: null }), 99), null);
  assert.equal(previousLiveRelease({ prepare() { throw new Error('locked'); } }, 1), null);
});

test('a restore record (previousSha equal to its own sha) falls back to the history; a folder-less history entry keeps its sha', () => {
  const live = { sha: S('b'), releasePath: rel('b'), previousSha: S('b'), verifiedAt: '2026-10-20T12:00:00Z', restored: true };
  assert.deepEqual(previousLiveFrom(live, [{ sha: S('a'), live: { releasePath: rel('a'), verifiedAt: '2026-10-01T00:00:00Z' } }]), { sha: S('a'), path: rel('a') });
  assert.deepEqual(previousLiveFrom({ ...live, previousSha: S('a') }, []), { sha: S('a'), path: null });
  assert.equal(previousLiveFrom({ sha: 'nope' }, []), null);
  assert.equal(previousLiveFrom(live, [{ sha: S('a'), live: { releasePath: '../x', verifiedAt: '2026-10-01T00:00:00Z' } }]), null, 'a relative folder is not history');
});
