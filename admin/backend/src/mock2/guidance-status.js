// The live-guidance status, in memory: which guidance is active (seed or site),
// whether live guidance is on, and the last check's time, result and error.
// No imports on purpose — lib/self-update.js reads it for check_proxypilot_update
// and the dashboard's Update block without loading anything from the Projects
// module (on a host where that module is off, the status stays empty).

const status = {
  enabled: null,
  auto_rebuild: null,
  active_origin: null,
  active_version: null,
  active_site: null,
  active_release_sha256: null,
  active_fetched_at: null,
  source: null,
  last_check_at: null,
  last_result: null,
  last_error: null,
  last_site_version: null,
  // The newest site release whose selected files equal the active guidance
  // (a version-only release): current, nothing to publish.
  content_matches_version: null,
  last_published_framework_version: null,
};

const KEYS = Object.keys(status);

export function recordGuidanceCheck(patch = {}) {
  for (const k of KEYS) if (Object.prototype.hasOwnProperty.call(patch, k)) status[k] = patch[k] ?? null;
  return { ...status };
}

/** A copy of the status, or null when the Projects module never reported one. */
export function getGuidanceStatus() {
  return status.active_origin || status.enabled != null ? { ...status } : null;
}

export function _resetGuidanceStatusForTests() {
  for (const k of KEYS) status[k] = null;
}
