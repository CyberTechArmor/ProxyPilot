import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { operationsFixture } from './helpers/operations-fixture.js';
import { authorizePilotSelfReview } from '../lib/operational-pilot-review.js';

function world() {
  const f = operationsFixture(), owner = f.addUser(), other = f.addUser();
  const p = f.store.create(owner, { name: 'A8 demo pilot' });
  f.db.prepare('UPDATE ops_projects SET site_origin=? WHERE id=?').run('https://demo.fractionate.ai', p.id);
  f.store.saveDraft(owner, p.id, 1, { title: 'Demo guide', instructions: 'Open the demo sign-in dialog.' });
  const s = f.store.submit(owner, p.id, 2, {}).submission;
  const scope = { owner_id: owner.id, project_id: p.id, submission_id: s.id, content_hash: s.content_hash };
  const grant = () => authorizePilotSelfReview(f.db, scope, { now: () => s.submitted_at });
  const approve = () => f.store.review(owner, p.id, s.id, 1, { decision: 'approve' });
  return { f, owner, other, p, s, scope, approve, grant };
}

test('A8 pilot exception needs an operator grant and a separate manual owner decision; one immutable audited use', () => {
  const { f, owner, p, s, scope, approve, grant: authorize } = world();
  try {
    assert.throws(approve, e => e.status === 403);
    const grant = authorize();
    assert.equal(f.store.versions(owner, p.id).versions.length, 0);
    assert.equal(f.store.submission(owner, p.id, s.id).submission.pilot_self_review.owner_id, owner.id);
    assert.equal(approve().version.approved_by, owner.id);
    assert.equal(f.store.submission(owner, p.id, s.id).submission.pilot_self_review, null);
    const used = f.db.prepare("SELECT * FROM ops_project_events WHERE action='a8_pilot_self_review_used'").all();
    assert.equal(used.length, 1);
    assert.equal(JSON.parse(used[0].metadata_json).authorization_event_id, grant.authorization_event_id);
    assert.throws(approve, e => e.status === 412);
    assert.throws(() => authorizePilotSelfReview(f.db, scope));
    assert.throws(() => f.db.exec("DELETE FROM ops_project_events WHERE action='a8_pilot_self_review_used'"), /immutable/);
  } finally { f.close(); }
});

test('A8 pilot exception refuses mismatched hash, nonowner, other origin, expiry and future grants', () => {
  const { f, owner, other, p, s, scope, approve, grant } = world();
  try {
    for (const bad of [{ ...scope, owner_id: other.id }, { ...scope, content_hash: '0'.repeat(64) }])
      assert.throws(() => authorizePilotSelfReview(f.db, bad));
    f.db.prepare('UPDATE ops_projects SET site_origin=? WHERE id=?').run('https://example.com', p.id);
    assert.throws(() => authorizePilotSelfReview(f.db, scope));
    f.db.prepare('UPDATE ops_projects SET site_origin=? WHERE id=?').run('https://demo.fractionate.ai', p.id);
    const future = new Date(Date.now() + 60000).toISOString();
    authorizePilotSelfReview(f.db, scope, { now: () => future });
    assert.throws(approve, e => e.status === 403);
    grant();
    f.advance(60 * 60 * 1000 + 61000);
    assert.equal(f.store.submission(owner, p.id, s.id).submission.pilot_self_review, null);
    assert.throws(approve, e => e.status === 403);
  } finally { f.close(); }
});

test('A8 exception is tied to current owner and pending iteration; approval rollback restores unused grant', () => {
  const { f, owner, other, p, s, scope, approve, grant } = world();
  try {
    grant();
    f.db.prepare('UPDATE ops_projects SET owner_user_id=? WHERE id=?').run(other.id, p.id);
    assert.equal(f.store.submission(other, p.id, s.id).submission.pilot_self_review, null);
    f.db.prepare('UPDATE ops_projects SET owner_user_id=? WHERE id=?').run(owner.id, p.id);
    f.db.exec("CREATE TRIGGER fail_pilot_approval BEFORE INSERT ON ops_project_events WHEN NEW.action='guide_approved' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.throws(approve, /fixture/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM ops_project_events WHERE action='a8_pilot_self_review_used'").get().n, 0);
    assert.ok(f.store.submission(owner, p.id, s.id).submission.pilot_self_review);
    f.db.exec('DROP TRIGGER fail_pilot_approval');
    f.store.cancelSubmission(owner, p.id, s.id, 1, { reason: 'New draft' });
    f.store.saveDraft(owner, p.id, f.store.draft(owner, p.id).revision, { instructions: 'Changed guide' });
    const next = f.store.submit(owner, p.id, f.store.draft(owner, p.id).revision, {}).submission;
    assert.equal(next.pilot_self_review, null);
    assert.throws(() => f.store.review(owner, p.id, next.id, 1, { decision: 'approve' }), e => e.status === 403);
  } finally { f.close(); }
});

test('pilot operator writers have no HTTP/MCP import and the grant CLI remains root-only', () => {
  for (const path of ['../routes/operational-projects.js', '../routes/mcp-tools/index.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /authorizePilotSelfReview|importPilotBinding/);
  }
  const cli = readFileSync(new URL('../../../../scripts/a8-authorize-pilot-review.mjs', import.meta.url), 'utf8');
  assert.match(cli, /process\.getuid\(\) !== 0/);
  assert.match(cli, /info\.isSymbolicLink\(\)/);
});
