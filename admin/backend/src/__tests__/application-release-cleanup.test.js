import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { cleanupReleaseArtifacts, APPLICATION_RELEASE_RETENTION } from '../lib/setup-engine/application-release-cleanup.js';
import { applicationGuestScript } from '../lib/setup-engine/application-deploy-op.js';

const job = '11111111-1111-4111-8111-111111111111';
const releaseName = number => `${String(number).repeat(40)}-p6-${job}`;
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'release-retention-'));
  t.after(() => { if (path.basename(parent).startsWith('release-retention-') && path.dirname(parent) === fs.realpathSync(os.tmpdir())) fs.rmSync(parent, { recursive: true, force: true }); });
  const root = path.join(parent, 'releases'); fs.mkdirSync(root);
  const create = number => { const dir = path.join(root, releaseName(number)); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, '.proxypilot-release.json'), JSON.stringify({ sha: String(number).repeat(40) })); return dir; };
  const live = create(1), candidate = create(2), obsolete = create(3);
  const source = path.join(parent, 'current');
  fs.symlinkSync(live, source, process.platform === 'win32' ? 'junction' : 'dir');
  const stageRoot = path.join(root, '.staging'); fs.mkdirSync(stageRoot);
  const stage = path.join(stageRoot, job + '-1'), bundle = stage + '.bundle';
  fs.mkdirSync(stage); fs.writeFileSync(path.join(stage, 'test-output'), 'scratch'); fs.writeFileSync(bundle, 'source archive');
  const a = { profile: { releaseRoot: root, sourceDir: source, preservePaths: [], envFiles: [] }, stage, bundle, release: candidate, retention: { keepReleases: 2 } };
  return { parent, root, live, candidate, obsolete, source, stageRoot, stage, bundle, a };
}

test('only Nodus is opted into bounded release cleanup', () => {
  assert.deepEqual(APPLICATION_RELEASE_RETENTION, { nodus: { keepReleases: 2, trimBuildCache: true } });
});

test('cleanup removes failed workspaces, bundles and excess releases while preserving live and incoming artifacts', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const result = cleanupReleaseArtifacts(fs, path, f.a);
  assert.deepEqual(result, { stagesRemoved: 1, bundlesRemoved: 1, releasesRemoved: 1 });
  for (const target of [f.stage, f.bundle, f.obsolete]) assert.equal(fs.existsSync(target), false);
  for (const target of [f.live, f.candidate, f.source]) assert.equal(fs.existsSync(target), true);
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
