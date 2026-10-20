import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { cleanupReleaseArtifacts, removeSelectedRelease, describeReleases, APPLICATION_RELEASE_RETENTION, staticReleaseRetention, normalizeReleaseRetention, resolveReleaseRetention, releaseContextFromApplication } from '../lib/setup-engine/application-release-cleanup.js';
import { applicationGuestScript, runApplicationReleaseOperation } from '../lib/setup-engine/application-deploy-op.js';

const job = '11111111-1111-4111-8111-111111111111';
const releaseName = number => `${String(number).repeat(40)}-p6-${job}`;
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'release-retention-'));
  t.after(() => { if (path.basename(parent).startsWith('release-retention-') && path.dirname(parent) === fs.realpathSync(os.tmpdir())) fs.rmSync(parent, { recursive: true, force: true }); });
  const root = path.join(parent, 'releases'); fs.mkdirSync(root);
  const create = number => { const dir = path.join(root, releaseName(number)); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, '.proxypilot-release.json'), JSON.stringify({ sha: String(number).repeat(40) })); return dir; };
  const live = create(1), candidate = create(2), obsolete = create(3);
  // Deterministic ages: the obsolete release is older than live, the candidate newest.
  const at = seconds => new Date(Date.UTC(2026, 9, 20, 12, 0, seconds));
  fs.utimesSync(obsolete, at(1), at(1)); fs.utimesSync(live, at(2), at(2)); fs.utimesSync(candidate, at(3), at(3));
  const source = path.join(parent, 'current');
  fs.symlinkSync(live, source, process.platform === 'win32' ? 'junction' : 'dir');
  const stageRoot = path.join(root, '.staging'); fs.mkdirSync(stageRoot);
  const stage = path.join(stageRoot, job + '-1'), bundle = stage + '.bundle';
  fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, 'test-output'), 'scratch'); fs.writeFileSync(bundle, 'source archive');
  const a = { profile: { releaseRoot: root, sourceDir: source, preservePaths: [], envFiles: [] }, stage, bundle, release: candidate, retention: { keepReleases: 2 } };
  return { parent, root, live, candidate, obsolete, source, stageRoot, stage, bundle, a, create, at };
}

test('only Nodus is opted into bounded release cleanup', () => {
  assert.deepEqual(APPLICATION_RELEASE_RETENTION, { nodus: { keepReleases: 2, trimBuildCache: true } });
});

// Changed by the counting fix (docs/features/application-release-retention.md):
// the release under validation is no longer counted, so the older release —
// the rollback target — survives instead of being deleted at validation time.
test('cleanup removes failed workspaces and bundles while preserving live, incoming and the rollback release', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const result = cleanupReleaseArtifacts(fs, path, f.a);
  assert.deepEqual(result, { stagesRemoved: 1, bundlesRemoved: 1, releasesRemoved: 0 });
  for (const target of [f.stage, f.bundle]) assert.equal(fs.existsSync(target), false);
  for (const target of [f.live, f.candidate, f.obsolete, f.source]) assert.equal(fs.existsSync(target), true);
});

test('counting keeps live + rollback (keepReleases 2); the incoming release is never counted and older releases go', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const older = f.create(4); fs.utimesSync(older, f.at(0), f.at(0));
  const result = cleanupReleaseArtifacts(fs, path, f.a);
  assert.equal(result.releasesRemoved, 1);
  assert.equal(fs.existsSync(older), false, 'the oldest release beyond live + rollback is removed');
  for (const target of [f.live, f.candidate, f.obsolete]) assert.equal(fs.existsSync(target), true);
  // The pre-build sweep (incoming path not built yet) keeps the same set.
  const g = fixture(t); const older2 = g.create(4); fs.utimesSync(older2, g.at(0), g.at(0));
  fs.rmSync(g.candidate, { recursive: true });
  cleanupReleaseArtifacts(fs, path, { ...g.a, sweepStages: true });
  assert.equal(fs.existsSync(g.obsolete), true, 'the rollback release survives the start of a validation');
  assert.equal(fs.existsSync(older2), false);
});

test('the recorded previous release is the rollback even when it is not the newest other one', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const previous = f.create(5); fs.utimesSync(previous, f.at(0), f.at(0));
  fs.writeFileSync(path.join(previous, '.proxypilot-release.json'), JSON.stringify({ sha: '5'.repeat(40) }));
  fs.utimesSync(previous, f.at(0), f.at(0));
  const result = cleanupReleaseArtifacts(fs, path, { ...f.a, previousSha: '5'.repeat(40) });
  assert.equal(result.releasesRemoved, 1);
  assert.equal(fs.existsSync(previous), true, 'the release whose marker names previousSha is the kept rollback');
  assert.equal(fs.existsSync(f.obsolete), false, 'a newer but unrecorded release is the one counted out');
});

test('a waiting validated candidate (protect) is kept and not counted', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const waiting = f.create(6); fs.utimesSync(waiting, f.at(4), f.at(4));
  const older = f.create(7); fs.utimesSync(older, f.at(0), f.at(0));
  const result = cleanupReleaseArtifacts(fs, path, { ...f.a, protect: [waiting] });
  assert.equal(result.releasesRemoved, 1);
  for (const target of [f.live, f.candidate, f.obsolete, waiting]) assert.equal(fs.existsSync(target), true);
  assert.equal(fs.existsSync(older), false);
  const d = describeReleases(fs, path, { ...f.a, protect: [waiting] });
  assert.equal(d.rollback, f.obsolete, 'the waiting candidate is never picked as the rollback release');
});

test('removeSelectedRelease shares the predicates: live, rollback, candidate and backing roots refuse; an old release goes', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const older = f.create(4); fs.utimesSync(older, f.at(0), f.at(0));
  const base = { profile: f.a.profile, protect: [f.candidate] };
  assert.throws(() => removeSelectedRelease(fs, path, { ...base, path: f.live }), /RELEASE_IS_LIVE/);
  assert.throws(() => removeSelectedRelease(fs, path, { ...base, path: f.obsolete }), /RELEASE_IS_ROLLBACK/);
  assert.throws(() => removeSelectedRelease(fs, path, { ...base, path: f.candidate }), /RELEASE_IS_CANDIDATE/);
  assert.throws(() => removeSelectedRelease(fs, path, { ...base, path: path.join(f.parent, 'elsewhere') }), /RELEASE_OUTSIDE_ROOT/);
  assert.throws(() => removeSelectedRelease(fs, path, { ...base, path: f.stageRoot }), /NOT_A_SEALED_RELEASE/);
  const models = path.join(older, 'models'); fs.mkdirSync(models); fs.utimesSync(older, f.at(0), f.at(0));
  fs.symlinkSync(models, path.join(f.live, 'models'), 'dir');
  assert.throws(() => removeSelectedRelease(fs, path, { ...base, profile: { ...f.a.profile, preservePaths: [path.join(f.source, 'models')] }, path: older }), /RELEASE_HOLDS_SHARED_DATA/);
  fs.unlinkSync(path.join(f.live, 'models'));
  const seen = [];
  const out = removeSelectedRelease(fs, path, { ...base, path: older }, target => { seen.push(target); fs.rmSync(target, { recursive: true }); return { bytes: 1 }; });
  assert.deepEqual(seen, [older]); assert.equal(out.removed, older); assert.equal(out.bytes, 1);
  for (const target of [f.live, f.obsolete, f.candidate]) assert.equal(fs.existsSync(target), true);
});

test('Nodus keeps its numbers: two releases and the .cache trim from the static policy; other targets unchanged', () => {
  assert.deepEqual(staticReleaseRetention('nodus'), { keepReleases: 2, trimBeforeSeal: ['.cache'], workspaces: true });
  assert.equal(staticReleaseRetention('other'), null);
  assert.deepEqual(normalizeReleaseRetention({ keepReleases: 3, trimBeforeSeal: ['test-results', '.cache', '../escape', '/abs', 'a/.git/x', 'coverage'] }), { keepReleases: 3, trimBeforeSeal: ['.cache', 'test-results', 'coverage'], workspaces: true });
});

test('effective release retention comes from a stored policy when one is supplied, else the static file', async () => {
  assert.deepEqual(await resolveReleaseRetention(null, 'nodus'), staticReleaseRetention('nodus'));
  assert.deepEqual(await resolveReleaseRetention(async id => (id === 'shop' ? { keepReleases: 4, trimBeforeSeal: ['.cache', 'coverage'], workspaces: false } : null), 'shop'), { keepReleases: 4, trimBeforeSeal: ['.cache', 'coverage'], workspaces: false });
  assert.equal(await resolveReleaseRetention(async () => null, 'nodus'), null, 'a disabled releases rule with no static entry means no retention');
  // The policy module reports the workspaces rule as an object.
  assert.equal((await resolveReleaseRetention(async () => ({ keepReleases: 2, trimBeforeSeal: ['.cache'], workspaces: { enabled: false, abandonedAfterHours: 1 }, source: 'policy' }), 'nodus')).workspaces, false);
  assert.equal((await resolveReleaseRetention(async () => ({ keepReleases: 2, trimBeforeSeal: ['.cache'], workspaces: { enabled: true, abandonedAfterHours: 1 }, source: 'static' }), 'nodus')).workspaces, true);
});

test('release context: the previous live release is the rollback and a newer validated candidate is protected', () => {
  const root = '/opt/app-releases';
  const app = {
    live: { sha: '1'.repeat(40), releasePath: `${root}/live`, previousSha: '2'.repeat(40), verifiedAt: '2026-10-20T10:00:00Z' },
    candidates: [
      { sha: '2'.repeat(40), checkpointAt: '2026-10-19T10:00:00Z', validation: { passed: true, releasePath: `${root}/prev` }, live: { releasePath: `${root}/prev` } },
      { sha: '3'.repeat(40), checkpointAt: '2026-10-20T11:00:00Z', validation: { passed: true, releasePath: `${root}/waiting` } },
      { sha: '4'.repeat(40), checkpointAt: '2026-10-20T12:00:00Z', validation: { passed: false, releasePath: `${root}/failed` } },
      { sha: '5'.repeat(40), checkpointAt: '2026-10-20T13:00:00Z', validation: { passed: true, releasePath: '/elsewhere/x' } },
    ],
  };
  assert.deepEqual(releaseContextFromApplication(app, { root }), { previousSha: '2'.repeat(40), rollback: `${root}/prev`, protect: [`${root}/prev`, `${root}/waiting`] });
  assert.deepEqual(releaseContextFromApplication({ live: null, candidates: [] }, { root }), { previousSha: null, rollback: null, protect: [] });
});

test('a release containing the live application model data is never pruned', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const models = path.join(f.obsolete, 'models'); fs.mkdirSync(models); fs.writeFileSync(path.join(models, 'weights'), 'required model');
  const link = path.join(f.live, 'models'); fs.symlinkSync(models, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.a.profile.preservePaths = [path.join(f.source, 'models')];
  cleanupReleaseArtifacts(fs, path, f.a);
  assert.equal(fs.readFileSync(path.join(f.source, 'models', 'weights'), 'utf8'), 'required model');
  assert.equal(fs.existsSync(f.obsolete), true);
});

test('the pre-build sweep removes only old generated attempts and leaves the owning attempt untouched', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const old = path.join(f.stageRoot, '22222222-2222-4222-8222-222222222222-1');
  fs.mkdirSync(old); fs.writeFileSync(old + '.bundle', 'old archive');
  fs.writeFileSync(path.join(f.stageRoot, 'operator-note'), 'keep');
  const result = cleanupReleaseArtifacts(fs, path, { ...f.a, sweepStages: true });
  assert.equal(result.stagesRemoved, 1); assert.equal(result.bundlesRemoved, 1);
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(old + '.bundle'), false);
  assert.equal(fs.existsSync(f.stage), true); assert.equal(fs.existsSync(f.bundle), true);
  assert.equal(fs.existsSync(path.join(f.stageRoot, 'operator-note')), true);
});

test('unsafe roots, a moved live target and escaping cleanup paths refuse deletion', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  for (const extra of [{ release: f.parent }, { stage: f.live }, { bundle: path.join(f.parent, 'outside.bundle') }, { retention: { keepReleases: 0 } }]) {
    assert.throws(() => cleanupReleaseArtifacts(fs, path, { ...f.a, ...extra }));
    assert.equal(fs.existsSync(f.stage), true); assert.equal(fs.existsSync(f.obsolete), true);
  }
  const outside = path.join(f.parent, 'outside'); fs.mkdirSync(outside);
  fs.unlinkSync(f.source); fs.symlinkSync(outside, f.source, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => cleanupReleaseArtifacts(fs, path, f.a), /LIVE_RELEASE_OUTSIDE_ROOT/);
  assert.equal(fs.existsSync(f.stage), true);
});

test('symlink entries are never followed during staging cleanup', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.rmSync(f.stage, { recursive: true });
  const outside = path.join(f.parent, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'important'), 'keep');
  fs.symlinkSync(outside, f.stage, process.platform === 'win32' ? 'junction' : 'dir');
  cleanupReleaseArtifacts(fs, path, f.a);
  assert.equal(fs.readFileSync(path.join(outside, 'important'), 'utf8'), 'keep');
});

test('new artifact sealing strips generated caches before computing the verified digest', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const cache = path.join(f.stage, '.cache');
  fs.writeFileSync(path.join(f.stage, '.gitignore'), '.cache/\n');
  fs.writeFileSync(path.join(f.stage, 'app.js'), 'export const value = 1;\n');
  execFileSync('git', ['init', '-q', f.stage]); execFileSync('git', ['-C', f.stage, 'add', '.']);
  execFileSync('git', ['-C', f.stage, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  fs.mkdirSync(cache); fs.writeFileSync(path.join(cache, 'browser-binary'), 'build-only cache');
  const sha = execFileSync('git', ['-C', f.stage, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const treeSha = execFileSync('git', ['-C', f.stage, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const release = path.join(f.root, 'sealed'), marker = { sha, treeSha, profileDigest: 'c'.repeat(64), evidenceDigest: 'd'.repeat(64) };
  const run = data => spawnSync('sh', ['-c', applicationGuestScript(data)], { encoding: 'utf8' });
  const sealed = run({ action: 'seal', profile: f.a.profile, retention: { trimBuildCache: true }, stage: f.stage, release, sha, treeSha, marker });
  assert.equal(sealed.status, 0, sealed.stdout);
  assert.equal(fs.existsSync(path.join(release, '.cache')), false);
  const verified = run({ action: 'artifact', profile: f.a.profile, release, ...marker, artifactDigest: JSON.parse(sealed.stdout).artifactDigest });
  assert.equal(verified.status, 0, verified.stdout);
});

test('tracked cache content is never silently stripped from an artifact', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), cache = path.join(f.stage, '.cache'); fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'tracked-data'), 'source data');
  execFileSync('git', ['init', '-q', f.stage]); execFileSync('git', ['-C', f.stage, 'add', '.']);
  execFileSync('git', ['-C', f.stage, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const result = spawnSync('sh', ['-c', applicationGuestScript({ action: 'seal', profile: f.a.profile, retention: { trimBuildCache: true }, stage: f.stage, release: path.join(f.root, 'sealed') })], { encoding: 'utf8' });
  assert.equal(JSON.parse(result.stdout).code, 'TRACKED_BUILD_CACHE');
  assert.equal(fs.readFileSync(path.join(cache, 'tracked-data'), 'utf8'), 'source data');
});

test('trimBeforeSeal removes untracked generated output, keeps and reports tracked or linked entries', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.stage, '.gitignore'), '.cache/\ntest-results/\n');
  fs.writeFileSync(path.join(f.stage, 'app.js'), 'export const value = 1;\n');
  fs.mkdirSync(path.join(f.stage, 'coverage')); fs.writeFileSync(path.join(f.stage, 'coverage', 'kept.json'), '{}');
  execFileSync('git', ['init', '-q', f.stage]); execFileSync('git', ['-C', f.stage, 'add', '.']);
  execFileSync('git', ['-C', f.stage, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  fs.mkdirSync(path.join(f.stage, '.cache')); fs.writeFileSync(path.join(f.stage, '.cache', 'blob'), 'x');
  fs.mkdirSync(path.join(f.stage, 'test-results')); fs.writeFileSync(path.join(f.stage, 'test-results', 'shot.png'), 'x');
  const outside = path.join(f.parent, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  fs.symlinkSync(outside, path.join(f.stage, 'playwright-report'), 'dir');
  const sha = execFileSync('git', ['-C', f.stage, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const treeSha = execFileSync('git', ['-C', f.stage, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  const release = path.join(f.root, 'sealed'), marker = { sha, treeSha, profileDigest: 'c'.repeat(64), evidenceDigest: 'd'.repeat(64) };
  // The link would escape the artifact, so it is removed by hand after being reported.
  const run = data => spawnSync('sh', ['-c', applicationGuestScript(data)], { encoding: 'utf8' });
  const sealed = run({ action: 'seal', profile: f.a.profile, retention: { trimBeforeSeal: ['.cache', 'test-results', 'coverage', 'playwright-report', 'node_modules/.cache', '../x'] }, stage: f.stage, release, sha, treeSha, marker });
  const answer = JSON.parse(sealed.stdout);
  assert.equal(answer.ok, false, 'an escaping link that trim refused to touch still fails the artifact digest');
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep', 'the link target is never followed');
  fs.unlinkSync(path.join(f.stage, 'playwright-report'));
  fs.rmSync(path.join(f.stage, '.proxypilot-release.json'), { force: true });
  fs.mkdirSync(path.join(f.stage, '.cache'), { recursive: true }); fs.mkdirSync(path.join(f.stage, 'test-results'), { recursive: true });
  const again = JSON.parse(run({ action: 'seal', profile: f.a.profile, retention: { trimBeforeSeal: ['.cache', 'test-results', 'coverage', 'node_modules/.cache', '../x'] }, stage: f.stage, release, sha, treeSha, marker }).stdout);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual(again.trim.removed, ['.cache', 'test-results']);
  assert.deepEqual(again.trim.kept, [{ path: 'coverage', reason: 'tracked' }, { path: '../x', reason: 'invalid' }]);
  assert.equal(fs.readFileSync(path.join(release, 'coverage', 'kept.json'), 'utf8'), '{}', 'tracked output is part of the source and stays');
  assert.equal(fs.existsSync(path.join(release, 'test-results')), false);
});

test('an already sealed tree is never trimmed', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.stage, '.proxypilot-release.json'), '{}');
  fs.mkdirSync(path.join(f.stage, 'test-results')); fs.writeFileSync(path.join(f.stage, 'test-results', 'a'), 'x');
  const result = spawnSync('sh', ['-c', applicationGuestScript({ action: 'seal', profile: f.a.profile, retention: { trimBeforeSeal: ['test-results'] }, stage: f.stage, release: path.join(f.root, 'sealed') })], { encoding: 'utf8' });
  assert.equal(JSON.parse(result.stdout).code, 'ALREADY_SEALED');
  assert.equal(fs.existsSync(path.join(f.stage, 'test-results', 'a')), true);
});

function opFixture({ targetId = 'nodus' } = {}) {
  const calls = [];
  const profile = { targetId, sourceDir: '/opt/app', releaseRoot: '/opt/app-releases', serviceName: 'app.service', healthUrl: 'http://127.0.0.1:3000/ready', installScript: 'deps', buildScript: 'build', validationScripts: ['test'], preservePaths: [], envFiles: [], revision: 1, digest: 'c'.repeat(64) };
  const candidate = { sha: 'a'.repeat(40), treeSha: 'b'.repeat(40) };
  const service = {
    prepareCandidate: async () => ({ profile, candidate, gitDir: '/trusted/repo.git' }),
    recordValidation: async () => {},
    getApplication: async () => ({ live: { sha: '1'.repeat(40), releasePath: '/opt/app-releases/live', previousSha: '2'.repeat(40), verifiedAt: '2026-10-20T10:00:00Z' }, candidates: [{ sha: '2'.repeat(40), live: { releasePath: '/opt/app-releases/prev' } }] }),
  };
  const exec = {
    host: async argv => { if (argv.includes('bundle') && argv.includes('create')) fs.writeFileSync(argv[argv.indexOf('create') + 1], 'fixture'); return { code: 0, stdout: '' }; },
    guest: async (container, script) => {
      if (script.includes('STALE_WRITERS:')) return { code: 0, stdout: 'STALE_WRITERS:0\n' };
      const body = Buffer.from(script.match(/printf '%s' '([^']+)' \| base64/)[1], 'base64').toString();
      const data = JSON.parse(Buffer.from(body.match(/ '([A-Za-z0-9+/=]+)'\n$/)[1], 'base64').toString());
      calls.push(data);
      const response = { ok: true };
      if (data.action === 'seal') response.artifactDigest = 'f'.repeat(64);
      if (data.action === 'inspect') Object.assign(response, { user: 'root', group: '' });
      return { code: 0, stdout: JSON.stringify(response), stderr: 'CONTAINMENT:systemd fixture' };
    },
  };
  const job = { id: '11111111-1111-4111-8111-111111111111', app: `pp-${targetId}`, epoch: 1, fence() {}, checkpoint() {}, event() {} };
  const params = { applicationId: 1, profileRevision: 1, profileDigest: profile.digest, sha: candidate.sha, treeSha: candidate.treeSha };
  return { calls, service, exec, job, params };
}

test('validation applies the stored policy, passes rollback/candidate protection, and keeps Nodus on the static file', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-op-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const f = opFixture({ targetId: 'shop' });
  await runApplicationReleaseOperation({ kind: 'application_validate', params: f.params, exec: f.exec, job: f.job, service: f.service, hostRoot: temp, releaseRetention: async id => (id === 'shop' ? { keepReleases: 3, trimBeforeSeal: ['.cache', 'coverage'], workspaces: false } : null) });
  const cleanups = f.calls.filter(c => c.action === 'release_cleanup');
  assert.equal(cleanups.length, 2);
  assert.deepEqual(cleanups[0].retention, { keepReleases: 3, trimBeforeSeal: ['.cache', 'coverage'], workspaces: false });
  assert.equal(cleanups[0].sweepStages, false, 'a disabled workspaces rule skips the sweep of other attempts');
  assert.equal(cleanups[0].previousSha, '2'.repeat(40));
  assert.equal(cleanups[0].rollback, '/opt/app-releases/prev');
  assert.deepEqual(cleanups[0].protect, ['/opt/app-releases/prev']);
  assert.deepEqual(f.calls.find(c => c.action === 'seal').retention.trimBeforeSeal, ['.cache', 'coverage']);

  const nodus = opFixture({ targetId: 'nodus' });
  await runApplicationReleaseOperation({ kind: 'application_validate', params: nodus.params, exec: nodus.exec, job: nodus.job, service: nodus.service, hostRoot: temp });
  const first = nodus.calls.find(c => c.action === 'release_cleanup');
  assert.deepEqual(first.retention, { keepReleases: 2, trimBeforeSeal: ['.cache'], workspaces: true });
  assert.equal(first.sweepStages, true);

  const other = opFixture({ targetId: 'other' });
  await runApplicationReleaseOperation({ kind: 'application_validate', params: other.params, exec: other.exec, job: other.job, service: other.service, hostRoot: temp });
  assert.equal(other.calls.some(c => c.action === 'release_cleanup'), false, 'an unlisted target with no policy is unchanged');

  const broken = opFixture({ targetId: 'nodus' }); const events = [];
  broken.job.event = (kind) => events.push(kind);
  await runApplicationReleaseOperation({ kind: 'application_validate', params: broken.params, exec: broken.exec, job: broken.job, service: broken.service, hostRoot: temp, releaseRetention: async () => { throw new Error('db locked'); } });
  assert.equal(broken.calls.some(c => c.action === 'release_cleanup'), false, 'an unreadable policy applies no retention rather than a guess');
  assert.ok(events.includes('retention_unavailable'));
});
