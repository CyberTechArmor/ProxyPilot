// Which Mock2 guidance is active: the vendored seed (framework-seed/
// upstream-guidance.json, the floor) or a verified release fetched from the
// pinned standards site (mock2/live-guidance.js) when — and only when — that
// release is strictly newer than the seed. In memory, no I/O: live-guidance.js
// sets it after verifying its data-dir cache or a fresh download; template.js
// (new project seeds) and framework.js (the published constitution) read it.

import vendored from './framework-seed/upstream-guidance.json' with { type: 'json' };
import { compareGuidanceVersions, renderPinnedConstitution } from './guidance-release-logic.js';
import { recordGuidanceCheck } from './guidance-status.js';

export { recordGuidanceCheck, getGuidanceStatus } from './guidance-status.js';

const SEED = Object.freeze({ origin: 'seed', version: vendored.version, bundle: vendored, site: null, release_sha256: null, fetched_at: null });
let live = null;

function report() {
  const a = getActiveGuidance();
  recordGuidanceCheck({ active_origin: a.origin, active_version: a.version, active_site: a.site, active_release_sha256: a.release_sha256, active_fetched_at: a.fetched_at });
}

export function seedGuidance() { return SEED; }

/** { origin: 'seed'|'site', version, bundle, site, release_sha256, fetched_at } */
export function getActiveGuidance() {
  return live && compareGuidanceVersions(live.version, SEED.version) > 0 ? live : SEED;
}

/**
 * Make a verified site release the active guidance. Refused (returns false)
 * unless it is strictly newer than the active guidance (and so than the seed).
 */
export function setLiveGuidance({ bundle, site, release_sha256, fetched_at }) {
  if (!bundle || compareGuidanceVersions(bundle.version, getActiveGuidance().version) <= 0) { report(); return false; }
  live = Object.freeze({ origin: 'site', version: bundle.version, bundle, site: site || null, release_sha256: release_sha256 || null, fetched_at: fetched_at || null });
  report();
  return true;
}

/**
 * The constitution to publish: the vendored seed's own (it already carries the
 * seed's pinned block) unless a newer site release is active, in which case the
 * pinned block is re-rendered from that release exactly as the sync script does.
 */
export function effectiveConstitution(seedConstitution, active = getActiveGuidance()) {
  return active.origin === 'site' ? renderPinnedConstitution(seedConstitution, active.bundle) : seedConstitution;
}

report();

export function _resetActiveGuidanceForTests() { live = null; report(); }
