// Live Mock2 guidance: read a newer release from the pinned standards site at
// runtime, verify it, cache it in the data dir, and publish it as a framework
// version — so a Mock2 release reaches ProxyPilot without a code change.
//
//   release.json  ← <site>/release.json        (the pinned source's sibling)
//   each file     ← <site>/<src>                (only the entries the seed carries)
//   limits        no redirects; 15 s per request and 2 min per run; each body
//                 streamed and cut off at 4 MB; an entry declaring more, or more
//                 than 200 selected entries, is refused before any download
//   verified      sha256 + byte count of every file against that release.json
//                 (guidance-release-logic.js, the same code the sync script runs)
//   unchanged     a newer version whose selected files all hash the same as the
//                 active guidance is recorded as current; nothing is published
//   cached        <dataDir>/<version>/{release.json,upstream-guidance.json}
//                 (temp dir + rename), and <dataDir>/current.json — written only
//                 once a framework version carries the release
//   published     through publish() — framework.js upgradeFrameworkFromSeed, the
//                 path a seed upgrade takes; on a throw the active guidance is put
//                 back, so the next check retries
//
// The vendored seed is the floor: a release is used only when its version is
// newer than the active guidance. "Off" freezes: nothing is fetched and the
// active guidance stays as it is. resetToSeed is the deliberate way back down.
// Any failure leaves the active guidance as it is and is reported in the status,
// never thrown. Dependencies are injected so the tests stub every boundary.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertFetchLimits, buildGuidanceBundle, compareGuidanceVersions, MAX_GUIDANCE_ENTRIES, MAX_GUIDANCE_FILE_BYTES,
  releaseLocations, sameGuidanceContent, selectGuidanceEntries, serializeBundle, sha256Hex,
  validateReleaseIdentity, verifyBundleAgainstRelease,
} from './guidance-release-logic.js';
import {
  clearLiveGuidance, getActiveGuidance, recordGuidanceCheck, restoreActiveGuidance, seedGuidance, setLiveGuidance,
} from './active-guidance.js';

export const LIVE_GUIDANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 120_000;
const CONCURRENCY = 4;
const KEEP_VERSIONS = 2;
const USER_AGENT = 'ProxyPilot-Mock2-Guidance';
const VERSION_DIR = /^\d+\.\d+\.\d+$/;
const PERSISTED = ['last_check_at', 'last_result', 'last_error', 'last_site_version', 'content_matches_version', 'last_published_framework_version'];

const timedOut = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

export function createLiveGuidance({
  dataDir,
  fetchImpl = (...a) => fetch(...a),
  isEnabled = () => true,
  isAutoRebuild = () => null,
  sourceUrl,
  publish = () => null,
  currentPinnedVersion = () => null,
  freeze = () => {},
  now = () => new Date(),
  clock = () => Date.now(),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
  maxBytes = MAX_GUIDANCE_FILE_BYTES,
  maxEntries = MAX_GUIDANCE_ENTRIES,
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

  function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

  function record(patch) {
    const s = recordGuidanceCheck({ enabled: safe(() => !!isEnabled(), false), auto_rebuild: safe(isAutoRebuild, null), ...patch });
    try { writeAtomic(statusPath, JSON.stringify(Object.fromEntries(PERSISTED.map((k) => [k, s[k]])), null, 2) + '\n'); } catch { /* status persistence is best-effort */ }
    return s;
  }

  // One body, streamed with a byte counter: never more than `limit` bytes are
  // held, whatever Content-Length says; redirects are refused.
  async function getBytes(url, deadline, limit = maxBytes) {
    const left = deadline - clock();
    if (left <= 0) throw timedOut();
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'error', signal: AbortSignal.timeout(Math.min(requestTimeoutMs, left)) });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const tooBig = () => new Error(`${url} is larger than ${limit} bytes`);
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > limit) { try { await res.body?.cancel?.(); } catch { /* ignore */ } throw tooBig(); }
    const reader = res.body?.getReader?.();
    if (!reader) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > limit) throw tooBig();
      return bytes;
    }
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) throw tooBig();
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        if (clock() > deadline) throw timedOut();
      }
    } catch (e) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw e;
    }
    return Buffer.concat(chunks, total);
  }

  // Fetch every selected file (bounded concurrency); nothing is kept until all
  // of them arrived and buildGuidanceBundle has checked each one.
  async function fetchFiles(release, entries, loc, deadline) {
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

  function writeVersionDir(bundle, releaseRaw) {
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
  }

  function prune(keep) {
    try {
      const versions = readdirSync(dataDir).filter((n) => VERSION_DIR.test(n)).sort(compareGuidanceVersions).reverse();
      for (const v of versions.slice(KEEP_VERSIONS)) if (v !== keep) rmSync(join(dataDir, v), { recursive: true, force: true });
      for (const n of readdirSync(dataDir)) if (n.startsWith('.tmp-')) rmSync(join(dataDir, n), { recursive: true, force: true });
    } catch { /* pruning is best-effort */ }
  }

  function pinnedSite() {
    try { return releaseLocations(sourceUrl()).site; } catch { return null; }
  }

  /**
   * Boot: load the last published release from the data dir (synchronously,
   * before the framework seed upgrade runs). Loaded whatever the setting ("off"
   * freezes what is active, it does not roll it back); ignored when it is not
   * newer than the vendored seed, came from a different source than the one now
   * pinned, or fails re-verification against its own release.json. Never throws.
   * An ignored cache never downgrades the framework: the seed upgrade keeps the
   * newer published guidance (framework-upgrade.js) and the live check re-fetches.
   */
  function loadCache() {
    try {
      if (existsSync(statusPath)) recordGuidanceCheck(JSON.parse(readFileSync(statusPath, 'utf8')));
    } catch { /* a damaged status file only loses history */ }
    recordGuidanceCheck({ enabled: safe(() => !!isEnabled(), false), auto_rebuild: safe(isAutoRebuild, null), source: pinnedSite() });
    if (!existsSync(pointerPath)) return { loaded: false, reason: 'no cache' };
    try {
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
      if (!VERSION_DIR.test(String(pointer.version || ''))) throw new Error('bad cache pointer');
      if (compareGuidanceVersions(pointer.version, seedGuidance().version) <= 0) {
        return { loaded: false, reason: `cached ${pointer.version} is not newer than the seed ${seedGuidance().version}` };
      }
      const site = pinnedSite();
      if (pointer.site !== site) throw new Error(`it came from ${pointer.site}, not the pinned source ${site}`);
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

  async function run({ dryRun, reason }) {
    const at = now().toISOString();
    const active = getActiveGuidance();
    const base = { checked_at: at, reason, active: { origin: active.origin, version: active.version } };
    if (!safe(() => !!isEnabled(), false)) {
      record({ last_check_at: at, last_result: 'disabled', last_error: null });
      return { ...base, result: 'disabled', fetched: false, note: 'Live guidance is off (frozen): nothing is fetched and the active guidance stays as it is.' };
    }
    let site = null;
    try {
      const loc = releaseLocations(sourceUrl());
      site = loc.site;
      const deadline = clock() + totalTimeoutMs;
      const releaseRaw = await getBytes(loc.release, deadline);
      const releaseSha = sha256Hex(releaseRaw);
      const release = validateReleaseIdentity(JSON.parse(releaseRaw.toString('utf8')));
      if (compareGuidanceVersions(release.version, active.version) <= 0) {
        record({ last_check_at: at, last_result: 'current', last_error: null, last_site_version: release.version, source: site });
        return { ...base, result: 'current', site, site_version: release.version };
      }
      const entries = assertFetchLimits(selectGuidanceEntries(release), { maxEntries, maxBytes });
      if (sameGuidanceContent(entries, active.bundle)) {
        record({ last_check_at: at, last_result: 'current', last_error: null, last_site_version: release.version, content_matches_version: release.version, source: site });
        return { ...base, result: 'current', content_unchanged: true, site, site_version: release.version, note: `Mock2 ${release.version} changes no guidance file; nothing to publish.` };
      }
      const would = { from: { origin: active.origin, version: active.version }, to: { origin: 'site', version: release.version, site, release_sha256: releaseSha }, files: entries.map((e) => ({ src: e.src, bytes: e.bytes, sha256: e.sha256 })) };
      if (dryRun) return { ...base, result: 'update_available', dry_run: true, site, site_version: release.version, would };
      const bundle = await fetchFiles(release, entries, loc, deadline);
      writeVersionDir(bundle, releaseRaw);
      const before = getActiveGuidance();
      setLiveGuidance({ bundle, site, release_sha256: releaseSha, fetched_at: at });
      let row;
      try {
        row = publish(getActiveGuidance());
      } catch (e) {
        restoreActiveGuidance(before);
        const msg = `guidance ${bundle.version} verified, but publishing the framework version failed (active guidance put back; the next check retries): ${e?.message || e}`;
        record({ last_check_at: at, last_result: 'error', last_error: msg, last_site_version: release.version, source: site });
        return { ...base, result: 'error', published: false, error: msg, site, site_version: release.version };
      }
      // The guidance floor (framework-upgrade.js) keeps newer published guidance
      // (e.g. from a previously pinned source): this release is then not the one
      // the framework carries — say so and put the active guidance back.
      const carried = safe(currentPinnedVersion, null);
      if (carried && carried !== bundle.version) {
        restoreActiveGuidance(before);
        const msg = `the framework carries Mock2 ${carried}, newer than ${bundle.version} from ${site}; it was not replaced. refresh_standards_guidance with reset_to_seed goes back to the seed first.`;
        record({ last_check_at: at, last_result: 'blocked', last_error: msg, last_site_version: release.version, source: site });
        return { ...base, result: 'blocked', published: !!row, framework_version: row?.version ?? null, error: msg, site, site_version: release.version };
      }
      writeAtomic(pointerPath, JSON.stringify({ version: bundle.version, site, release_sha256: releaseSha, fetched_at: at }, null, 2) + '\n');
      prune(bundle.version);
      if (!row) {
        record({ last_check_at: at, last_result: 'already_published', last_error: null, last_site_version: release.version, content_matches_version: null, source: site });
        return { ...base, result: 'already_published', published: false, site, site_version: release.version, files: bundle.files.length, release_sha256: releaseSha, note: 'The current framework version already carries this guidance.' };
      }
      record({ last_check_at: at, last_result: 'updated', last_error: null, last_site_version: release.version, content_matches_version: null, last_published_framework_version: row.version ?? null, source: site });
      return { ...base, result: 'updated', published: true, site, site_version: release.version, files: bundle.files.length, framework_version: row.version ?? null, release_sha256: releaseSha };
    } catch (e) {
      const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : (e?.message || String(e));
      record({ last_check_at: at, last_result: 'error', last_error: msg, source: site });
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

  /**
   * Rollback: back to the vendored seed through the normal publish path (the
   * one deliberate guidance downgrade), the cache cleared, and live guidance
   * turned off so the next check does not adopt the same release again. Turn it
   * back on once the site is fixed. dryRun returns the plan only.
   */
  async function resetToSeed({ dryRun = false, by = null } = {}) {
    if (inflight) await inflight.catch(() => {});
    const at = now().toISOString();
    const before = getActiveGuidance();
    const seed = seedGuidance();
    const published = safe(currentPinnedVersion, null);
    const plan = {
      from: { origin: before.origin, version: before.version, framework_guidance: published },
      to: { origin: 'seed', version: seed.version },
      clears: pointerPath,
      then: 'live_guidance off (frozen at the seed) until it is turned back on',
    };
    if (dryRun) return { checked_at: at, result: 'reset_planned', dry_run: true, would: plan };
    clearLiveGuidance();
    let row;
    try {
      row = publish(seedGuidance(), { allowGuidanceDowngrade: true, resetFrom: published || before.version });
    } catch (e) {
      restoreActiveGuidance(before);
      const msg = `reset to the seed failed (nothing changed): ${e?.message || e}`;
      record({ last_check_at: at, last_result: 'error', last_error: msg });
      return { checked_at: at, result: 'error', published: false, error: msg };
    }
    try {
      rmSync(pointerPath, { force: true });
      for (const n of existsSync(dataDir) ? readdirSync(dataDir) : []) if (VERSION_DIR.test(n) || n.startsWith('.tmp-')) rmSync(join(dataDir, n), { recursive: true, force: true });
    } catch (e) { log.warn?.(`[mock2] live guidance reset: cache cleanup incomplete: ${e?.message || e}`); }
    try { freeze(by); } catch (e) { log.warn?.(`[mock2] live guidance reset: could not turn the setting off: ${e?.message || e}`); }
    record({ last_check_at: at, last_result: 'reset', last_error: null, content_matches_version: null, last_published_framework_version: row?.version ?? null });
    return { checked_at: at, result: 'reset', published: !!row, framework_version: row?.version ?? null, from: plan.from, to: plan.to, live_guidance: 'off' };
  }

  return { loadCache, refresh, resetToSeed };
}
