// Live Mock2 guidance (mock2/live-guidance.js + guidance-release-logic.js +
// active-guidance.js). Native-free: the network is a stubbed fetch, the data dir
// a temp directory, the setting and the publisher plain functions — nothing here
// opens mock2.db or reaches the standards site.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import vendored from '../mock2/framework-seed/upstream-guidance.json' with { type: 'json' };
import {
  buildGuidanceBundle, renderPinnedConstitution, releaseLocations, sha256Hex, serializeBundle, verifyBundleAgainstRelease,
  compareGuidanceVersions,
} from '../mock2/guidance-release-logic.js';
import { getActiveGuidance, effectiveConstitution, _resetActiveGuidanceForTests } from '../mock2/active-guidance.js';
import { getGuidanceStatus, _resetGuidanceStatusForTests } from '../mock2/guidance-status.js';
import { createLiveGuidance } from '../mock2/live-guidance.js';
import { mock2StandardsSeedFiles } from '../mock2/template.js';
import { buildVersionCheck } from '../lib/self-update-logic.js';
import { createSeedUpgrader, readSeedContent, readSeedFile } from '../mock2/framework-upgrade.js';
import { seedGuidance } from '../mock2/active-guidance.js';
import { pinnedGuidanceVersion, guidancePathFor, bundleConstitution } from '../mock2/guidance-release-logic.js';
import { shouldAutoAdopt } from '../mock2/auto-adopt-logic.js';
import { isLiveSourcedVersion } from '../mock2/framework-logic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = resolve(HERE, '../mock2/framework-seed');
const REPO = resolve(HERE, '../../../..');
const SITE = 'https://standards.test';
const MANIFEST = `${SITE}/manifest.json`;
const SEED_VERSION = vendored.version;
const bump = (v) => { const [a, b, c] = v.split('.').map(Number); return `${a}.${b}.${c + 1}`; };
const NEWER = bump(SEED_VERSION);

// A release built from the vendored bundle: same files, a given version, plus one
// entry ProxyPilot does not carry (proves the selection), optionally tampered.
function makeRelease(version = NEWER, { tamper = null, unchanged = false } = {}) {
  const files = new Map();
  const entries = vendored.files.map((f) => {
    let content = f.content;
    if (f.source === 'core/claude/CLAUDE.md' && version !== SEED_VERSION && !unchanged) content = content.replace(/\n$/, `\n<!-- release ${version} -->\n`);
    const bytes = Buffer.from(content, 'utf8');
    files.set(f.source, bytes);
    return { src: f.source, dest: `~/.mock2/${f.path}`, mode: 'replace', exec: false, sha256: sha256Hex(bytes), bytes: bytes.length };
  });
  const extra = Buffer.from('not guidance\n');
  files.set('core/installer/install.sh', extra);
  entries.push({ src: 'core/installer/install.sh', dest: '~/.mock2/install.sh', mode: 'replace', exec: true, sha256: sha256Hex(extra), bytes: extra.length });
  const release = { name: 'mock2-core', version, updated: '2026-10-18', files: entries };
  if (tamper === 'hash') files.set('core/cpr/Relay-Recording.md', Buffer.from('tampered\n'));
  if (tamper === 'bytes') { const e = entries.find((x) => x.src === 'core/claude/CLAUDE.md'); e.bytes += 1; }
  return { release, raw: Buffer.from(JSON.stringify(release, null, 2) + '\n'), files };
}

function stubFetch(rel, { missing = null, offline = false, hang = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    if (offline) throw new TypeError('fetch failed');
    if (hang) {
      // A real hung request holds a socket open; AbortSignal.timeout's timer is
      // unref'd, so keep the loop alive the same way until the abort fires.
      return new Promise((_, reject) => {
        const keep = setTimeout(() => reject(new Error('stub never aborted')), 10_000);
        opts.signal?.addEventListener('abort', () => { clearTimeout(keep); reject(opts.signal.reason); }, { once: true });
      });
    }
    if (url === `${SITE}/release.json`) return new Response(rel.raw, { status: 200 });
    const src = url.slice(SITE.length + 1);
    if (src === missing || !rel.files.has(src)) return new Response('nope', { status: 404 });
    return new Response(rel.files.get(src), { status: 200 });
  };
  return { fetchImpl, calls };
}

function setup({ rel = makeRelease(), enabled = true, fetchOpts = {}, opts = {} } = {}) {
  _resetActiveGuidanceForTests();
  _resetGuidanceStatusForTests();
  _resetActiveGuidanceForTests();
  const dataDir = join(mkdtempSync(join(tmpdir(), 'pp-guidance-')), 'guidance');
  const { fetchImpl, calls } = stubFetch(rel, fetchOpts);
  const published = [];
  const lg = createLiveGuidance({
    dataDir, fetchImpl, isEnabled: () => enabled, sourceUrl: () => MANIFEST,
    publish: (active) => { published.push(active); return { version: 40 + published.length }; },
    log: { warn() {} }, ...opts,
  });
  return { lg, dataDir, calls, published, rel };
}

const versionDirs = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => /^\d+\.\d+\.\d+$/.test(n)) : []);

/* ------------------------------ the live path ------------------------------ */

test('a newer release is verified, written atomically and published once; a second check is a no-op', async () => {
  const { lg, dataDir, calls, published, rel } = setup();
  const out = await lg.refresh();
  assert.equal(out.result, 'updated', out.error);
  assert.equal(out.site_version, NEWER);
  assert.equal(out.site, SITE);
  assert.equal(out.files, vendored.files.length);
  assert.equal(published.length, 1);
  assert.equal(published[0].origin, 'site');
  assert.equal(published[0].version, NEWER);
  assert.ok(!calls.includes(`${SITE}/core/installer/install.sh`), 'only the guidance entries are downloaded');

  // On disk: the release.json that was used, byte for byte, and the verified bundle.
  assert.deepEqual(readFileSync(join(dataDir, NEWER, 'release.json')), rel.raw);
  const bundle = JSON.parse(readFileSync(join(dataDir, NEWER, 'upstream-guidance.json'), 'utf8'));
  verifyBundleAgainstRelease(bundle, rel.release);
  const pointer = JSON.parse(readFileSync(join(dataDir, 'current.json'), 'utf8'));
  assert.deepEqual([pointer.version, pointer.site, pointer.release_sha256], [NEWER, SITE, sha256Hex(rel.raw)]);
  assert.ok(!readdirSync(dataDir).some((n) => n.startsWith('.tmp-')));

  const active = getActiveGuidance();
  assert.deepEqual([active.origin, active.version], ['site', NEWER]);
  const st = getGuidanceStatus();
  assert.deepEqual([st.active_origin, st.active_version, st.last_result, st.last_error, st.last_published_framework_version], ['site', NEWER, 'updated', null, 41]);
  assert.ok(st.last_check_at);

  const again = await lg.refresh();
  assert.equal(again.result, 'current');
  assert.equal(published.length, 1, 'the same release is never published twice');
});

test('the same version as the active guidance is a no-op: release.json only, nothing written or published', async () => {
  const { lg, dataDir, calls, published } = setup({ rel: makeRelease(SEED_VERSION) });
  const out = await lg.refresh();
  assert.equal(out.result, 'current');
  assert.deepEqual(calls, [`${SITE}/release.json`]);
  assert.equal(published.length, 0);
  assert.equal(existsSync(join(dataDir, 'current.json')), false);
  assert.deepEqual(versionDirs(dataDir), []);
  assert.equal(getActiveGuidance().origin, 'seed');
});

test('an older site release never replaces the seed', async () => {
  const { lg, published } = setup({ rel: makeRelease('1.0.0') });
  assert.equal((await lg.refresh()).result, 'current');
  assert.equal(published.length, 0);
  assert.equal(getActiveGuidance().version, SEED_VERSION);
});

for (const tamper of ['hash', 'bytes']) {
  test(`a ${tamper} mismatch writes nothing and leaves the active guidance unchanged`, async () => {
    const { lg, dataDir, published } = setup({ rel: makeRelease(NEWER, { tamper }) });
    const out = await lg.refresh();
    assert.equal(out.result, 'error');
    assert.match(out.error, /Release hash\/size mismatch/);
    assert.equal(published.length, 0);
    assert.equal(existsSync(join(dataDir, 'current.json')), false);
    assert.deepEqual(versionDirs(dataDir), []);
    assert.deepEqual([getActiveGuidance().origin, getActiveGuidance().version], ['seed', SEED_VERSION]);
    assert.match(getGuidanceStatus().last_error, /mismatch/);
  });
}

test('a partial download (one file missing) writes nothing', async () => {
  const { lg, dataDir, published } = setup({ fetchOpts: { missing: 'core/cpr/Universal-Integration.md' } });
  const out = await lg.refresh();
  assert.equal(out.result, 'error');
  assert.match(out.error, /HTTP 404/);
  assert.equal(published.length, 0);
  assert.deepEqual(versionDirs(dataDir), []);
  assert.equal(getActiveGuidance().origin, 'seed');
});

test('offline and timeout are reported, never thrown, and change nothing', async () => {
  const off = setup({ fetchOpts: { offline: true } });
  const a = await off.lg.refresh();
  assert.equal(a.result, 'error');
  assert.match(a.error, /fetch failed/);
  assert.equal(off.published.length, 0);
  assert.equal(getActiveGuidance().origin, 'seed');

  const slow = setup({ fetchOpts: { hang: true }, opts: { requestTimeoutMs: 30 } });
  const t0 = Date.now();
  const b = await slow.lg.refresh();
  assert.equal(b.result, 'error');
  assert.equal(b.error, 'timed out');
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(slow.published.length, 0);
  assert.equal(getGuidanceStatus().last_error, 'timed out');
  assert.equal(getActiveGuidance().origin, 'seed');
});

test('setting off: nothing is fetched, nothing published', async () => {
  const { lg, calls, published } = setup({ enabled: false });
  const out = await lg.refresh();
  assert.equal(out.result, 'disabled');
  assert.deepEqual(calls, []);
  assert.equal(published.length, 0);
  assert.equal(getGuidanceStatus().enabled, false);
});

test('dry run reads release.json only and reports exactly what would change', async () => {
  const { lg, dataDir, calls, published } = setup();
  const out = await lg.refresh({ dryRun: true });
  assert.equal(out.result, 'update_available');
  assert.deepEqual(calls, [`${SITE}/release.json`]);
  assert.deepEqual(out.would.from, { origin: 'seed', version: SEED_VERSION });
  assert.equal(out.would.to.version, NEWER);
  assert.equal(out.would.files.length, vendored.files.length);
  assert.equal(published.length, 0);
  assert.equal(existsSync(join(dataDir, 'current.json')), false);
});

test('a publish failure puts the active guidance back and the next check retries', async () => {
  let fail = true;
  const published = [];
  const { lg, dataDir } = setup({ opts: { publish: (a) => { if (fail) throw new Error('db locked'); published.push(a.version); return { version: 9 }; } } });
  const out = await lg.refresh();
  assert.equal(out.result, 'error');
  assert.equal(out.published, false);
  assert.match(out.error, /publishing the framework version failed .*: db locked/);
  assert.deepEqual([getActiveGuidance().origin, getActiveGuidance().version], ['seed', SEED_VERSION], 'active guidance put back');
  assert.equal(existsSync(join(dataDir, 'current.json')), false, 'no pointer to a release no framework version carries');
  fail = false;
  const again = await lg.refresh();
  assert.deepEqual([again.result, again.published, again.framework_version], ['updated', true, 9]);
  assert.deepEqual(published, [NEWER]);
  assert.ok(existsSync(join(dataDir, 'current.json')));
});

test('a publish that changes nothing reports published: false, not updated', async () => {
  const { lg, dataDir } = setup({ opts: { publish: () => null } });
  const out = await lg.refresh();
  assert.deepEqual([out.result, out.published], ['already_published', false]);
  assert.ok(existsSync(join(dataDir, 'current.json')));
  assert.equal(getGuidanceStatus().last_result, 'already_published');
});

test('concurrent refreshes share one run', async () => {
  const { lg, published } = setup();
  const [a, b] = await Promise.all([lg.refresh(), lg.refresh()]);
  assert.equal(a, b);
  assert.equal(published.length, 1);
});

/* ------------------------------ boot: the cache ----------------------------- */

test('boot: a verified newer cache is loaded without the network; a tampered or older cache is ignored (the seed wins)', async () => {
  const first = setup();
  assert.equal((await first.lg.refresh()).result, 'updated');

  // A fresh process: active guidance back to the seed, then the cache loads it.
  _resetActiveGuidanceForTests();
  const boot = createLiveGuidance({ dataDir: first.dataDir, fetchImpl: () => { throw new Error('no network at boot'); }, sourceUrl: () => MANIFEST, log: { warn() {} } });
  assert.deepEqual(boot.loadCache(), { loaded: true, version: NEWER });
  assert.equal(getActiveGuidance().origin, 'site');

  // Tampered bundle on disk → ignored.
  _resetActiveGuidanceForTests();
  const bundlePath = join(first.dataDir, NEWER, 'upstream-guidance.json');
  const b = JSON.parse(readFileSync(bundlePath, 'utf8'));
  b.files[0].content += 'x';
  writeFileSync(bundlePath, serializeBundle(b));
  assert.equal(boot.loadCache().loaded, false);
  assert.equal(getActiveGuidance().origin, 'seed');
  assert.match(getGuidanceStatus().last_error, /cached guidance ignored/);

  // A cache older than (or equal to) the vendored seed → the seed wins.
  _resetActiveGuidanceForTests();
  const dataDir = join(mkdtempSync(join(tmpdir(), 'pp-guidance-')), 'g');
  const old = makeRelease('1.0.0');
  const oldBundle = await buildGuidanceBundle(old.release, (src) => old.files.get(src));
  mkdirSync(join(dataDir, '1.0.0'), { recursive: true });
  writeFileSync(join(dataDir, '1.0.0', 'release.json'), old.raw);
  writeFileSync(join(dataDir, '1.0.0', 'upstream-guidance.json'), serializeBundle(oldBundle));
  writeFileSync(join(dataDir, 'current.json'), JSON.stringify({ version: '1.0.0', site: SITE, release_sha256: sha256Hex(old.raw) }));
  const r = createLiveGuidance({ dataDir, sourceUrl: () => MANIFEST, log: { warn() {} } }).loadCache();
  assert.equal(r.loaded, false);
  assert.match(r.reason, /not newer than the seed/);
  assert.deepEqual([getActiveGuidance().origin, getActiveGuidance().version], ['seed', SEED_VERSION]);
});

/* ---------------------- what the active guidance feeds ---------------------- */

test('the published constitution and new project seeds follow the active guidance', async () => {
  const seedConstitution = readFileSync(join(SEED_DIR, 'constitution.md'), 'utf8');
  _resetActiveGuidanceForTests();
  assert.equal(effectiveConstitution(seedConstitution), seedConstitution, 'seed active: the vendored constitution, unchanged');
  // The shared renderer reproduces the vendored constitution from the vendored bundle.
  assert.equal(renderPinnedConstitution(seedConstitution, vendored), seedConstitution);

  const { lg } = setup();
  await lg.refresh();
  const c = effectiveConstitution(seedConstitution);
  assert.match(c, new RegExp(`# Governing Mock2 guidance: ${NEWER.replace(/\./g, '\\.')}`));
  assert.ok(c.includes(`<!-- release ${NEWER} -->`));
  assert.ok(c.startsWith(seedConstitution.slice(0, seedConstitution.indexOf('<!-- BEGIN PINNED MOCK2 GUIDANCE -->'))));

  const emitted = mock2StandardsSeedFiles({ name: 'Example' });
  assert.equal(emitted.find((f) => f.path === '.mock2/standards/VERSION').content.trim(), NEWER);
  const prov = JSON.parse(emitted.find((f) => f.path.endsWith('/PROVENANCE.json')).content);
  assert.equal(prov.version, NEWER);
  assert.equal(prov.delivered_from, SITE);
  assert.ok(emitted.find((f) => f.path === '.mock2/standards/constitution.md').content.includes(`<!-- release ${NEWER} -->`));
  _resetActiveGuidanceForTests();
});

test('check_proxypilot_update compares the site with the active guidance and names it', () => {
  const guidance = { enabled: true, active_origin: 'site', active_version: NEWER, active_site: SITE, last_check_at: '2026-10-18T00:00:00Z', last_result: 'updated', last_error: null };
  const cur = buildVersionCheck({ standards: { seed_version: SEED_VERSION, source_version: SEED_VERSION, site_version: NEWER, guidance } }).standards;
  assert.equal(cur.status, 'current');
  assert.equal(cur.source_version, NEWER);
  assert.deepEqual([cur.guidance.active_origin, cur.guidance.active_version, cur.guidance.live_enabled, cur.guidance.last_result], ['site', NEWER, true, 'updated']);
  const ahead = buildVersionCheck({ standards: { seed_version: SEED_VERSION, source_version: SEED_VERSION, site_version: bump(NEWER), guidance: { ...guidance, active_origin: 'seed', active_version: SEED_VERSION } } }).standards;
  assert.equal(ahead.status, 'adoption_required');
  assert.match(ahead.next_action, /Live guidance is on/);
  const noLive = buildVersionCheck({ standards: { seed_version: SEED_VERSION, site_version: NEWER } }).standards;
  assert.equal(noLive.guidance, null);
  assert.match(noLive.next_action, /integrate/);
});

test('the source must be an https manifest URL; files resolve beside it', () => {
  const loc = releaseLocations('https://mock2.fractionate.ai/manifest.json');
  assert.equal(loc.release, 'https://mock2.fractionate.ai/release.json');
  assert.equal(loc.file('core/claude/CLAUDE.md'), 'https://mock2.fractionate.ai/core/claude/CLAUDE.md');
  assert.equal(releaseLocations('https://h.test/releases/1/manifest.json?x=1').release, 'https://h.test/releases/1/release.json');
  for (const bad of ['http://h.test/manifest.json', 'https://h.test/release.json', 'https://u:p@h.test/manifest.json', 'nope']) {
    assert.throws(() => releaseLocations(bad), /standards source/);
  }
  assert.throws(() => loc.file('core/../../etc/passwd'), /Invalid source path/);
  assert.equal(compareGuidanceVersions('1.23.10', '1.23.9'), 1);
});

/* --------------------- the sync script on the shared lib --------------------- */

test('scripts/sync-mock2-guidance.mjs still produces the vendored seed byte for byte', () => {
  const work = mkdtempSync(join(tmpdir(), 'pp-sync-'));
  const source = join(work, 'release');
  const seed = join(work, 'seed');
  // A local copy of the adopted release, rebuilt from the vendored bundle.
  const entries = vendored.files.map((f) => {
    const bytes = Buffer.from(f.content, 'utf8');
    mkdirSync(dirname(join(source, f.source)), { recursive: true });
    writeFileSync(join(source, f.source), bytes);
    return { src: f.source, sha256: sha256Hex(bytes), bytes: bytes.length };
  });
  writeFileSync(join(source, 'release.json'), JSON.stringify({ name: 'mock2-core', version: vendored.version, updated: vendored.updated, files: entries }));
  mkdirSync(seed);
  for (const name of ['upstream-guidance.json', 'constitution.md', 'standards-version.json']) cpSync(join(SEED_DIR, name), join(seed, name));
  writeFileSync(join(seed, 'upstream-guidance.json'), '{}\n'); // must be regenerated, not kept
  const run = spawnSync(process.execPath, [join(REPO, 'scripts/sync-mock2-guidance.mjs'), source, seed], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  for (const name of ['upstream-guidance.json', 'constitution.md', 'standards-version.json']) {
    assert.ok(readFileSync(join(seed, name)).equals(readFileSync(join(SEED_DIR, name))), `${name} differs from the vendored seed`);
  }
  // A tampered source file stops the script before anything is written.
  writeFileSync(join(source, 'core/cpr/Relay-Recording.md'), 'tampered\n');
  writeFileSync(join(seed, 'upstream-guidance.json'), 'untouched\n');
  const bad = spawnSync(process.execPath, [join(REPO, 'scripts/sync-mock2-guidance.mjs'), source, seed], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Release hash\/size mismatch/);
  assert.equal(readFileSync(join(seed, 'upstream-guidance.json'), 'utf8'), 'untouched\n');
  rmSync(work, { recursive: true, force: true });
});

test('a live-guidance publish records the site release as its provenance; a seed upgrade stays in_app', async () => {
  const { seedUpgradeProvenance } = await import('../mock2/framework-logic.js');
  const site = seedUpgradeProvenance({ origin: 'site', version: NEWER, site: SITE, release_sha256: 'ab'.repeat(32) }, 7);
  assert.equal(site.source, 'git_sync');
  assert.equal(site.sourceGitCommit, `mock2-core@${NEWER}`);
  assert.match(site.changelog, new RegExp(`Mock2 ${NEWER.replace(/\./g, '\\.')} from ${SITE}`));
  assert.match(site.changelog, /sha256 abab/);
  const seed = seedUpgradeProvenance({ origin: 'seed', version: SEED_VERSION }, 7);
  assert.deepEqual([seed.source, seed.sourceGitCommit], ['in_app', null]);
  assert.match(seed.changelog, /^Seed upgrade/);
});

/* ------------------------------ review fixes ------------------------------ */

// An in-memory mock2_framework_versions: the REAL upgradeFrameworkFromSeed
// (framework-upgrade.js, which framework.js binds to mock2.db) runs against it.
function memoryRegistry({ platformExtra = () => '' } = {}) {
  const rows = [];
  const readFile = (name) => {
    const text = readSeedFile(name);
    if (name !== 'constitution.md' || !platformExtra()) return text;
    const at = text.indexOf('<!-- BEGIN PINNED MOCK2 GUIDANCE -->');
    return `${text.slice(0, at).trimEnd()}\n\n${platformExtra()}\n\n${text.slice(at)}`;
  };
  const insert = ({ createdBy, sourceGitCommit, ...fields }) => {
    const row = { id: rows.length + 1, version: rows.length + 1, ...fields, source_git_commit: sourceGitCommit, created_by: createdBy };
    rows.push(row);
    return row;
  };
  const upgrade = createSeedUpgrader({ getCurrent: () => rows.at(-1), insert, readFile, log: { log() {}, error() {} } });
  // version 1: the vendored seed, as seedFrameworkV1 inserts it
  insert({ ...readSeedContent(seedGuidance(), { readFile }), changelog: 'Seed v1', source: 'in_app', sourceGitCommit: null, createdBy: 1 });
  return { rows, upgrade, pinned: () => pinnedGuidanceVersion(rows.at(-1).constitution_md) };
}

function liveWith(reg, { rel = makeRelease(), dataDir, sourceUrl = () => MANIFEST, enabled = () => true, freeze = () => {} } = {}) {
  const { fetchImpl, calls } = stubFetch(rel);
  const lg = createLiveGuidance({
    dataDir, fetchImpl, isEnabled: enabled, sourceUrl, freeze, log: { warn() {} },
    publish: (active, opts) => reg.upgrade(null, active, opts),
    currentPinnedVersion: reg.pinned,
  });
  return { lg, calls };
}

const freshDir = () => join(mkdtempSync(join(tmpdir(), 'pp-guidance-')), 'guidance');
const resetAll = () => { _resetActiveGuidanceForTests(); _resetGuidanceStatusForTests(); _resetActiveGuidanceForTests(); };

test('finding 1, end to end: a lost cache at boot never republishes older guidance; platform changes still land; the re-fetch publishes nothing new', async () => {
  resetAll();
  let extra = '';
  const reg = memoryRegistry({ platformExtra: () => extra });
  const dataDir = freshDir();
  const { lg } = liveWith(reg, { dataDir });
  assert.equal(reg.upgrade(null), null, 'boot on an unchanged seed publishes nothing');

  const first = await lg.refresh();
  assert.deepEqual([first.result, first.framework_version], ['updated', 2]);
  assert.deepEqual([reg.rows[1].source, reg.rows[1].source_git_commit, reg.pinned()], ['git_sync', `mock2-core@${NEWER}`, NEWER]);

  // Restart with the release directory gone (an interrupted write / a wiped disk):
  // the pointer names a directory that does not exist.
  rmSync(join(dataDir, NEWER), { recursive: true, force: true });
  _resetActiveGuidanceForTests();
  const boot = createLiveGuidance({ dataDir, sourceUrl: () => MANIFEST, log: { warn() {} } });
  const loaded = boot.loadCache();
  assert.equal(loaded.loaded, false);
  assert.match(loaded.reason, /cached guidance ignored: .*(ENOENT|no such file)/);
  assert.equal(getActiveGuidance().origin, 'seed');
  assert.equal(reg.upgrade(null), null, 'no downgrade: the seed guidance is not republished');
  assert.equal(reg.rows.length, 2);

  // A ProxyPilot update changes a platform section while the cache is still gone.
  extra = '## 99. A platform section added by a later ProxyPilot build';
  const v3 = reg.upgrade(null);
  assert.equal(v3.version, 3);
  assert.equal(v3.source, 'in_app');
  assert.ok(v3.constitution_md.includes(extra));
  assert.equal(pinnedGuidanceVersion(v3.constitution_md), NEWER, 'the published guidance is kept');
  assert.match(v3.changelog, new RegExp(`guidance ${NEWER.replace(/\./g, '\\.')} is kept`));

  // The live check re-fetches the same release: the framework already carries it.
  const refetch = await lg.refresh();
  assert.deepEqual([refetch.result, refetch.published], ['already_published', false]);
  assert.equal(reg.rows.length, 3, 'exactly two versions after v1, one adoption wave each');
  assert.equal(getActiveGuidance().version, NEWER);
  assert.equal(reg.upgrade(null), null, 'and the next boot publishes nothing');
});

test('reset_to_seed rolls a hostile 99.0.0 back through the normal publish path, clears the cache and freezes', async () => {
  resetAll();
  const reg = memoryRegistry();
  const dataDir = freshDir();
  const frozen = [];
  const { lg } = liveWith(reg, { dataDir, rel: makeRelease('99.0.0'), freeze: (by) => frozen.push(by) });
  assert.equal((await lg.refresh()).result, 'updated');
  assert.equal(reg.pinned(), '99.0.0');

  const plan = await lg.resetToSeed({ dryRun: true });
  assert.equal(plan.result, 'reset_planned');
  assert.deepEqual(plan.would.from, { origin: 'site', version: '99.0.0', framework_guidance: '99.0.0' });
  assert.equal(reg.rows.length, 2, 'dry run changes nothing');

  const out = await lg.resetToSeed({ by: 7 });
  assert.deepEqual([out.result, out.published, out.framework_version, out.live_guidance], ['reset', true, 3, 'off']);
  assert.deepEqual([reg.rows[2].source, reg.pinned()], ['in_app', SEED_VERSION]);
  assert.match(reg.rows[2].changelog, /^Reset to the vendored seed guidance .* from live guidance 99\.0\.0/);
  assert.deepEqual(frozen, [7]);
  assert.equal(existsSync(join(dataDir, 'current.json')), false);
  assert.deepEqual(versionDirs(dataDir), []);
  assert.equal(getActiveGuidance().origin, 'seed');
  _resetActiveGuidanceForTests();
  assert.equal(reg.upgrade(null), null, 'the next boot keeps the seed');
});

test('a lower release from a newly pinned source does not replace newer published guidance: blocked until reset_to_seed', async () => {
  resetAll();
  const reg = memoryRegistry();
  await liveWith(reg, { dataDir: freshDir(), rel: makeRelease('99.0.0') }).lg.refresh();
  _resetActiveGuidanceForTests(); // the cache from the old source is ignored at boot
  const out = await liveWith(reg, { dataDir: freshDir() }).lg.refresh();
  assert.equal(out.result, 'blocked');
  assert.equal(out.published, false);
  assert.match(out.error, /carries Mock2 99\.0\.0, newer than/);
  assert.equal(reg.rows.length, 2);
  assert.equal(getActiveGuidance().origin, 'seed');
});

test('a version-only release (no selected file changed) is recorded as current and nothing is published', async () => {
  const { lg, calls, published, dataDir } = setup({ rel: makeRelease(NEWER, { unchanged: true }) });
  const out = await lg.refresh();
  assert.deepEqual([out.result, out.content_unchanged, out.site_version], ['current', true, NEWER]);
  assert.deepEqual(calls, [`${SITE}/release.json`], 'nothing downloaded beyond release.json');
  assert.equal(published.length, 0);
  assert.equal(existsSync(join(dataDir, 'current.json')), false);
  const st = getGuidanceStatus();
  assert.deepEqual([st.content_matches_version, st.active_version], [NEWER, SEED_VERSION]);
  const check = buildVersionCheck({ standards: { seed_version: SEED_VERSION, source_version: SEED_VERSION, site_version: NEWER, guidance: st } }).standards;
  assert.equal(check.status, 'current');
});

test('a cache from a different source than the one now pinned is ignored at boot', async () => {
  const first = setup();
  assert.equal((await first.lg.refresh()).result, 'updated');
  _resetActiveGuidanceForTests();
  const other = createLiveGuidance({ dataDir: first.dataDir, sourceUrl: () => 'https://other.test/manifest.json', log: { warn() {} } });
  const r = other.loadCache();
  assert.equal(r.loaded, false);
  assert.match(r.reason, /came from https:\/\/standards\.test, not the pinned source https:\/\/other\.test/);
  assert.equal(getActiveGuidance().origin, 'seed');
});

test('streaming cap: an endless body is cut off at 4 MB without reading it all', async () => {
  resetAll();
  let pulls = 0;
  const endless = () => new ReadableStream({ pull(c) { pulls += 1; c.enqueue(new Uint8Array(64 * 1024)); } });
  const lg = createLiveGuidance({ dataDir: freshDir(), sourceUrl: () => MANIFEST, log: { warn() {} }, fetchImpl: async () => new Response(endless(), { status: 200 }) });
  const out = await lg.refresh();
  assert.equal(out.result, 'error');
  assert.match(out.error, /larger than 4194304 bytes/);
  assert.ok(pulls < 80, `stopped near the cap (${pulls} chunks of 64 KB)`);
});

test('an entry declaring more than the cap, or too many entries, is refused before any file is fetched', async () => {
  const big = makeRelease();
  big.release.files.find((e) => e.src === 'core/cpr/Relay-Recording.md').bytes = 5 * 1024 * 1024;
  big.raw = Buffer.from(JSON.stringify(big.release));
  const a = setup({ rel: big });
  const out = await a.lg.refresh();
  assert.match(out.error, /declares 5242880 bytes \(limit 4194304\)/);
  assert.deepEqual(a.calls, [`${SITE}/release.json`]);

  const many = makeRelease();
  for (let i = 0; i < 200; i++) many.release.files.push({ src: `core/claude/rules/extra-${i}.md`, sha256: 'a'.repeat(64), bytes: 1 });
  many.raw = Buffer.from(JSON.stringify(many.release));
  const b = setup({ rel: many });
  const out2 = await b.lg.refresh();
  assert.match(out2.error, /selects 230 guidance files \(limit 200\)/);
  assert.deepEqual(b.calls, [`${SITE}/release.json`]);
});

test('redirects are refused', async () => {
  resetAll();
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push(opts.redirect);
    if (opts.redirect === 'error') throw new TypeError('fetch failed: unexpected redirect');
    return new Response('{}', { status: 200 });
  };
  const out = await createLiveGuidance({ dataDir: freshDir(), sourceUrl: () => MANIFEST, fetchImpl, log: { warn() {} } }).refresh();
  assert.deepEqual(seen, ['error']);
  assert.equal(out.result, 'error');
  assert.match(out.error, /redirect/);
});

test('the 120 s total deadline stops the run after release.json (injected clock)', async () => {
  resetAll();
  let t = 1_000_000;
  const rel = makeRelease();
  const { fetchImpl, calls } = stubFetch(rel);
  const lg = createLiveGuidance({
    dataDir: freshDir(), sourceUrl: () => MANIFEST, log: { warn() {} }, clock: () => t,
    fetchImpl: async (url, opts) => { const r = await fetchImpl(url, opts); if (url.endsWith('/release.json')) t += 120_001; return r; },
    publish: () => { throw new Error('must not publish'); },
  });
  const out = await lg.refresh();
  assert.equal(out.result, 'error');
  assert.equal(out.error, 'timed out');
  assert.deepEqual(calls, [`${SITE}/release.json`]);
  assert.equal(getActiveGuidance().origin, 'seed');
});

test('bundle rules: unique target paths; the constitution is selected by its source', async () => {
  const dup = makeRelease();
  const e = dup.release.files.find((x) => x.src === 'core/claude/rules/mock2-change-record.md');
  dup.release.files.push({ ...e, src: 'core/cpr/rules/mock2-change-record.md' }); // → .mock2/standards/rules/mock2-change-record.md
  dup.files.set('core/cpr/rules/mock2-change-record.md', dup.files.get(e.src));
  assert.equal(guidancePathFor('core/cpr/rules/mock2-change-record.md'), guidancePathFor(e.src));
  await assert.rejects(buildGuidanceBundle(dup.release, (src) => dup.files.get(src)), /Duplicate guidance target: \.mock2\/standards\/rules\/mock2-change-record\.md/);
  const ok = await buildGuidanceBundle(makeRelease().release, (src) => makeRelease().files.get(src));
  assert.equal(bundleConstitution(ok), ok.files.find((f) => f.source === 'core/claude/CLAUDE.md').content);
  assert.equal(bundleConstitution(vendored), vendored.files.find((f) => f.source === 'core/claude/CLAUDE.md').content);
});

test('auto-adopt skips live-sourced versions only when live_guidance_auto_rebuild is off', () => {
  const facts = { enabled: true, currentFrameworkId: 5, project: { lifecycle: 'active', design_approved_at: 'x', last_built_framework_version_id: 4 } };
  const live = { source: 'git_sync', source_git_commit: `mock2-core@${NEWER}` };
  assert.equal(isLiveSourcedVersion(live), true);
  assert.equal(isLiveSourcedVersion({ source: 'in_app', source_git_commit: null }), false);
  assert.deepEqual(shouldAutoAdopt({ ...facts, liveSourced: true, liveAutoRebuild: false }), { adopt: false, reason: 'live guidance version; automatic rebuild off' });
  assert.equal(shouldAutoAdopt({ ...facts, liveSourced: true, liveAutoRebuild: true }).adopt, true);
  assert.equal(shouldAutoAdopt({ ...facts, liveSourced: false, liveAutoRebuild: false }).adopt, true, 'seed versions still adopt');
  // The default lives in one constant (flip it there).
  const src = readFileSync(resolve(HERE, '../mock2/settings.js'), 'utf8');
  assert.equal((src.match(/LIVE_GUIDANCE_AUTO_REBUILD_DEFAULT = '(on|off)';/g) || []).length, 1);
  assert.match(src, /getMock2Setting\(LIVE_GUIDANCE_AUTO_REBUILD_KEY, LIVE_GUIDANCE_AUTO_REBUILD_DEFAULT\)/);
  const sweep = readFileSync(resolve(HERE, '../mock2/auto-adopt.js'), 'utf8');
  assert.match(sweep, /isLiveSourcedVersion\(framework\) && !getLiveGuidanceAutoRebuild\(\)/);
});

test('off is a freeze: the boot cache still loads, nothing is fetched', async () => {
  const first = setup();
  await first.lg.refresh();
  _resetActiveGuidanceForTests();
  const calls = [];
  const off = createLiveGuidance({ dataDir: first.dataDir, sourceUrl: () => MANIFEST, isEnabled: () => false, fetchImpl: async (u) => { calls.push(u); throw new Error('no'); }, log: { warn() {} } });
  assert.equal(off.loadCache().loaded, true);
  assert.deepEqual([getActiveGuidance().origin, getActiveGuidance().version], ['site', NEWER]);
  assert.equal((await off.refresh()).result, 'disabled');
  assert.deepEqual(calls, []);
  assert.equal(getActiveGuidance().version, NEWER, 'frozen, not rolled back');
});
