import test from 'node:test';
import assert from 'node:assert/strict';
import { profileFromForm, profileToForm, releaseSummary, releaseBranchHead, jobPresentation } from '../../../frontend/src/components/mock2/application-release-model.mjs';

test('live, tested and remotely verified are independent evidence', () => {
  const app = { profile: { revision: 2, digest: 'p' }, candidates: [
    { sha: 'new', profileRevision: 2, profileDigest: 'p', publication: { pushAt: '2026-10-14', remoteSha: 'new' } },
    { sha: 'tested', validation: { passed: true, validatedAt: '2026-10-13' } },
    { sha: 'live', live: { verifiedAt: '2026-10-12' } },
    { sha: 'remote', publication: { verifiedAt: '2026-10-11', remoteSha: 'remote' } },
  ] };
  const r = releaseSummary(app, 'new');
  assert.equal(r.candidate.sha, 'new'); assert.equal(r.tested.sha, 'tested'); assert.equal(r.live.sha, 'live'); assert.equal(r.published.sha, 'remote'); assert.equal(r.validated, false);
});
test('old profile validation never enables deployment', () => {
  const app = { profile: { revision: 2, digest: 'new' }, candidates: [{ sha: 'old', profileRevision: 1, profileDigest: 'old', validation: { passed: true } }] };
  assert.equal(releaseSummary(app, 'old').validated, false);
});
test('profile serialization preserves path lists, uses existing connector and never installs', () => {
  const form = profileToForm({ name: 'Nodus', sourceDir: '/opt/nodus', connectorId: 1, validationScripts: ['test:integration'], preservePaths: ['/var/lib/nodus'], envFiles: ['/etc/nodus.env'] });
  const p = profileFromForm(form, 'nodus');
  assert.equal(p.installScript, null); assert.equal(p.connectorId, 1); assert.deepEqual(p.validationScripts, ['test:integration']); assert.deepEqual(p.envFiles, ['/etc/nodus.env']); assert.equal(p.targetId, 'nodus');
});

test('rollback observed live SHA takes precedence over historical candidate receipts', () => {
  const state = releaseSummary({ profile: {}, live: { sha: 'restored', verifiedAt: '2026-10-15' }, candidates: [{ sha: 'newer-code', live: { verifiedAt: '2026-10-14' } }] });
  assert.equal(state.live.sha, 'restored');
});

test('profile form round-trips the optional named preparation script', () => {
  const form = profileToForm({ installScript: 'dependencies:prepare' });
  assert.equal(profileFromForm(form, 'nodus').installScript, 'dependencies:prepare');
});

test('historical candidate live receipt cannot enable merge after observed live moved', () => {
  const candidate = { sha: 'candidate', profileRevision: 1, profileDigest: 'p', validation: { passed: true }, live: { verifiedAt: '2026-10-14' } };
  const app = { profile: { revision: 1, digest: 'p' }, candidates: [candidate], live: { sha: 'restored', verifiedAt: '2026-10-15' } };
  assert.equal(releaseSummary(app, 'candidate').mergeEligible, false);
  app.live.sha = 'candidate';
  assert.equal(releaseSummary(app, 'candidate').mergeEligible, true);
});
test('merge expected SHA refers to configured release branch, not an unrelated remote default', () => {
  assert.equal(releaseBranchHead(undefined, undefined), '');
  const app = { profile: { remoteBranch: 'release' } };
  assert.equal(releaseBranchHead(app, { branch: 'review/change', remoteSha: 'review', defaultBranch: 'main', defaultHeadSha: 'main-sha' }), '');
  assert.equal(releaseBranchHead(app, { branch: 'release', remoteSha: 'release-sha', defaultBranch: 'main', defaultHeadSha: 'main-sha' }), 'release-sha');
  assert.equal(releaseBranchHead(app, { branch: 'review/change', defaultBranch: 'release', defaultHeadSha: 'release-sha' }), 'release-sha');
});
test('real setup job reason and interrupted candidate drive recovery advice', () => {
  const job = { status: 'recovery_required', outcome: 'application_recovery_required', reason: 'Promotion was interrupted.', plan: { params: { sha: 'exact-interrupted-sha' } } };
  assert.deepEqual(jobPresentation(job), { reason: 'Promotion was interrupted.', outcome: 'application recovery required', recoveryRequired: true, interruptedSha: 'exact-interrupted-sha' });
  assert.equal(jobPresentation({ ...job, outcome: 'application_recovered' }).recoveryRequired, false);
});
