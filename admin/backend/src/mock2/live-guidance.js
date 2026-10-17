// Live Mock2 guidance: read a newer release from the pinned standards site at
// runtime, verify it, cache it in the data dir, and publish it as a framework
// version — so a Mock2 release reaches ProxyPilot without a code change.
//
//   release.json  ← <site>/release.json        (the pinned source's sibling)
//   each file     ← <site>/<src>                (only the entries the seed carries)
//   verified      sha256 + byte count of every file against that release.json
//                 (guidance-release-logic.js, the same code the sync script runs)
//   cached        <dataDir>/<version>/{release.json,upstream-guidance.json} +
//                 <dataDir>/current.json, written only after every file verified
//                 (temp dir + rename, so a crash leaves the previous cache intact)
//   published     through publish() — framework.js upgradeFrameworkFromSeed, the
//                 same path a seed upgrade takes, so projects adopt it the same way
//
// The vendored seed is the floor: a release is used only when its version is
// newer than the active guidance (and so newer than the seed). Any failure —
// setting off, offline, timeout, HTTP error, oversize, bad identity, hash or size
// mismatch — leaves the active guidance as it is and is reported in the status,
// never thrown. Dependencies are injected (fetch, the data dir, the setting, the
// source URL, publish) so the tests stub every boundary.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildGuidanceBundle, compareGuidanceVersions, releaseLocations, selectGuidanceEntries, serializeBundle, sha256Hex,
  validateReleaseIdentity, verifyBundleAgainstRelease,
} from './guidance-release-logic.js';
import { getActiveGuidance, recordGuidanceCheck, setLiveGuidance, seedGuidance } from './active-guidance.js';

export const LIVE_GUIDANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 120_000;
const MAX_BYTES = 4 * 1024 * 1024;
const CONCURRENCY = 4;
const KEEP_VERSIONS = 2;
const USER_AGENT = 'ProxyPilot-Mock2-Guidance';
const VERSION_DIR = /^\d+\.\d+\.\d+$/;

export function createLiveGuidance({
  dataDir,
  fetchImpl = (...a) => fetch(...a),
  isEnabled = () => true,
  sourceUrl,
  publish = () => null,
  now = () => new Date(),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
  log = console,
} = {}) {
  if (!dataDir) throw new Error('createLiveGuidance: dataDir is required');
  let inflight = null;

  const statusPath = join(dataDir, 'status.json');
  const pointerPath = join(dataDir, 'current.json');

  function writeAtomic(path, text) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  }

  function record(patch) {
    const s = recordGuidanceCheck(patch);
    try { writeAtomic(statusPath, JSON.stringify({ last_check_at: s.last_check_at, last_result: s.last_result, last_error: s.last_error, last_site_version: s.last_site_version, last_published_framework_version: s.last_published_framework_version }, null, 2) + '\n'); } catch { /* status persistence is best-effort */ }
    return s;
  }

  async function getBytes(url, deadline) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('timed out');
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'error', signal: AbortSignal.timeout(Math.min(requestTimeoutMs, left)) });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`${url} is larger than ${MAX_BYTES} bytes`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new Error(`${url} is larger than ${MAX_BYTES} bytes`);
    return bytes;
  }

  // Fetch every selected file (bounded concurrency) — nothing is verified-and-kept
  // until all of them have arrived and buildGuidanceBundle has checked each one.
  async function fetchFiles(release, loc, deadline) {
    const entries = selectGuidanceEntries(release);
    const got = new Map();
    let next = 0;
    async function worker() {
      while (next < entries.length) {
        const e = entries[next++];
        got.set(e.src, await getBytes(loc.file(e.src), deadline));
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
    return buildGuidanceBundle(release, (src) => {
      const b = got.get(src);
      if (!b) throw new Error(`Missing download: ${src}`);
      return b;
    });
  }

  function writeCache({ bundle, releaseRaw, releaseSha, site, fetchedAt }) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = join(dataDir, `.tmp-${bundle.version}-${process.pid}-${Date.now()}`);
    const final = join(dataDir, bundle.version);
    try {
      mkdirSync(tmp, { mode: 0o700 });
      writeFileSync(join(tmp, 'release.json'), releaseRaw, { mode: 0o600 });
      writeFileSync(join(tmp, 'upstream-guidance.json'), serializeBundle(bundle), { mode: 0o600 });
      rmSync(final, { recursive: true, force: true });
      renameSync(tmp, final);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
    writeAtomic(pointerPath, JSON.stringify({ version: bundle.version, site, release_sha256: releaseSha, fetched_at: fetchedAt }, null, 2) + '\n');
    prune(bundle.version);
  }

  function prune(keep) {
    try {
      const versions = readdirSync(dataDir).filter((n) => VERSION_DIR.test(n)).sort(compareGuidanceVersions).reverse();
      for (const v of versions.slice(KEEP_VERSIONS)) if (v !== keep) rmSync(join(dataDir, v), { recursive: true, force: true });
      for (const n of readdirSync(dataDir)) if (n.startsWith('.tmp-')) rmSync(join(dataDir, n), { recursive: true, force: true });
    } catch { /* pruning is best-effort */ }
  }

  /**
   * Boot: load the last verified release from the data dir (synchronously, before
   * the framework seed upgrade runs, so a restart republishes nothing). The cache
   * is re-verified against its own release.json; a cache that is not newer than
   * the vendored seed is ignored (the seed wins). Never throws.
   */
  function loadCache() {
    try {
      if (existsSync(statusPath)) recordGuidanceCheck(JSON.parse(readFileSync(statusPath, 'utf8')));
    } catch { /* a damaged status file only loses history */ }
    recordGuidanceCheck({ enabled: safeEnabled() });
    if (!existsSync(pointerPath)) return { loaded: false, reason: 'no cache' };
    try {
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
      if (!VERSION_DIR.test(String(pointer.version || ''))) throw new Error('bad cache pointer');
      if (compareGuidanceVersions(pointer.version, seedGuidance().version) <= 0) {
        return { loaded: false, reason: `cached ${pointer.version} is not newer than the seed ${seedGuidance().version}` };
      }
      const releaseRaw = readFileSync(join(dataDir, pointer.version, 'release.json'));
      if (sha256Hex(releaseRaw) !== pointer.release_sha256) throw new Error('cached release.json does not match its recorded sha256');
      const release = validateReleaseIdentity(JSON.parse(releaseRaw.toString('utf8')));
      const bundle = verifyBundleAgainstRelease(JSON.parse(readFileSync(join(dataDir, pointer.version, 'upstream-guidance.json'), 'utf8')), release);
      setLiveGuidance({ bundle, site: pointer.site, release_sha256: pointer.release_sha256, fetched_at: pointer.fetched_at });
      return { loaded: true, version: bundle.version };
    } catch (e) {
      const msg = `cached guidance ignored: ${e?.message || e}`;
      record({ last_error: msg });
      log.warn?.(`[mock2] ${msg}`);
      return { loaded: false, reason: msg };
    }
  }

  function safeEnabled() {
    try { return !!isEnabled(); } catch { return false; }
  }

  async function run({ dryRun, reason }) {
    const at = now().toISOString();
    const enabled = safeEnabled();
    const active = getActiveGuidance();
    const base = { checked_at: at, reason, active: { origin: active.origin, version: active.version } };
    if (!enabled) {
      record({ enabled: false, last_check_at: at, last_result: 'disabled', last_error: null });
      return { ...base, result: 'disabled', fetched: false, note: 'Live guidance is off; nothing was fetched.' };
    }
    let site = null;
    try {
      const loc = releaseLocations(sourceUrl());
      site = loc.site;
      const deadline = Date.now() + totalTimeoutMs;
      const releaseRaw = await getBytes(loc.release, deadline);
      const releaseSha = sha256Hex(releaseRaw);
      const release = validateReleaseIdentity(JSON.parse(releaseRaw.toString('utf8')));
      if (compareGuidanceVersions(release.version, active.version) <= 0) {
        record({ enabled, last_check_at: at, last_result: 'current', last_error: null, last_site_version: release.version, source: site });
        return { ...base, result: 'current', site, site_version: release.version };
      }
      const entries = selectGuidanceEntries(release);
      const would = { from: { origin: active.origin, version: active.version }, to: { origin: 'site', version: release.version, site, release_sha256: releaseSha }, files: entries.map((e) => ({ src: e.src, bytes: e.bytes, sha256: e.sha256 })) };
      if (dryRun) return { ...base, result: 'update_available', dry_run: true, site, site_version: release.version, would };
      const bundle = await fetchFiles(release, loc, deadline);
      writeCache({ bundle, releaseRaw, releaseSha, site, fetchedAt: at });
      setLiveGuidance({ bundle, site, release_sha256: releaseSha, fetched_at: at });
      let row = null;
      try { row = publish(getActiveGuidance()); } catch (e) {
        const msg = `guidance ${bundle.version} verified and cached, but publishing the framework version failed: ${e?.message || e}`;
        record({ enabled, last_check_at: at, last_result: 'error', last_error: msg, last_site_version: release.version, source: site });
        return { ...base, result: 'error', error: msg, site, site_version: release.version };
      }
      record({ enabled, last_check_at: at, last_result: 'updated', last_error: null, last_site_version: release.version, last_published_framework_version: row?.version ?? null, source: site });
      return { ...base, result: 'updated', site, site_version: release.version, files: bundle.files.length, framework_version: row?.version ?? null, release_sha256: releaseSha };
    } catch (e) {
      const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : (e?.message || String(e));
      record({ enabled, last_check_at: at, last_result: 'error', last_error: msg, source: site });
      return { ...base, result: 'error', error: msg, site };
    }
  }

  /**
   * Check the pinned site and adopt a newer release. dryRun: report what would
   * change without downloading the files or writing anything. Single-flight: a
   * call while another runs (not dry) waits for and returns that run.
   */
  async function refresh({ dryRun = false, reason = 'manual' } = {}) {
    if (dryRun) return run({ dryRun: true, reason });
    if (inflight) return inflight;
    inflight = run({ dryRun: false, reason }).finally(() => { inflight = null; });
    return inflight;
  }

  return { loadCache, refresh };
}
