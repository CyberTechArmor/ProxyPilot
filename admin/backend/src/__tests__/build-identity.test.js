import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuildIdentity, readBuildIdentity } from '../lib/build-identity.js';
import { buildVersionCheck } from '../lib/self-update-logic.js';

const sha = 'a'.repeat(40);
test('missing, malformed and legacy image metadata never becomes checkout identity', () => {
  for (const value of [null, {}, { sha: 'unknown', built_at: 'bad' }]) {
    assert.equal(parseBuildIdentity(value).status, 'unknown');
  }
  assert.equal(readBuildIdentity(() => { throw Error('missing'); }).sha, null);
  assert.equal(readBuildIdentity(() => '{broken').status, 'unknown');
});

test('running image and mutable checkout are separate, even with the same package version', () => {
  const running = parseBuildIdentity({ sha, built_at: '2026-10-03T15:00:00Z', dirty: false });
  const args = { currentVersion: '1.4.0', runningBuild: running,
    installed: { sha: 'b'.repeat(40), reachable: true, configured: true, dirty: false } };
  const out = buildVersionCheck(args);
  assert.equal(out.running.sha, sha);
  assert.equal(out.installed.sha, 'b'.repeat(40));
  assert.equal(out.deployment.status, 'restart_or_rebuild_required');
  assert.equal(buildVersionCheck({ ...args, runningBuild: null }).deployment.status, 'unknown');
  assert.equal(buildVersionCheck({ ...args, installed: { ...args.installed, sha } }).deployment.status, 'matches_checkout');
  assert.equal(buildVersionCheck({ ...args, runningBuild: { ...running, dirty: true } }).deployment.status, 'unverified_source');
  assert.equal(buildVersionCheck({ ...args, installed: { ...args.installed, sha, dirty: true } }).deployment.status, 'unverified_source');
});

test('newer published standards do not promise an unchanged application update will adopt them', () => {
  const out = buildVersionCheck({ currentVersion: '1.4.0', standards: { seed_version: '0.3.0', site_version: '1.14.0' } });
  assert.equal(out.standards.status, 'adoption_required');
  assert.match(out.standards.next_action, /integrate/);
  assert.equal(buildVersionCheck({ standards: { site_version: '1.14.0' } }).standards.status, 'unknown');
});

test('standards compare source releases, never unrelated seed or package families', () => {
  const standards = { seed_version: '20.0.0', source_version: '1.14.0', site_version: '1.15.0', version_family: 'mock2-core' };
  const out = buildVersionCheck({ standards }).standards;
  assert.equal(out.seed_version, '20.0.0');
  assert.equal(out.source_version, '1.14.0');
  assert.equal(out.update_available, true);
  const other = buildVersionCheck({ standards: { ...standards, version_family: 'cpr-starter' } }).standards;
  assert.equal(other.update_available, false);
  assert.equal(other.status, 'unknown');
});
