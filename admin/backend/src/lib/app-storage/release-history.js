// Application storage — which release ran BEFORE the current live one, from
// the deploy history in mock2.db. Never guessed from folder times.
//
// The release roles themselves (live, rollback, waiting candidate, backing
// roots) are decided in one place, describeReleases in
// lib/setup-engine/application-release-cleanup.js. That function runs inside
// the container and cannot read the database, so the callers (the release
// job, the storage cleanup job and the storage check) look the previous
// release up here and pass it in as `previousLive`.
//
//   previousLiveRelease(mock2Db, applicationId) → { sha, path } | null
//
// 1. The live record names its previous release (`previousSha`, written by a
//    deployment): that release, with the folder it was deployed from.
// 2. Otherwise (an older `application_verify` dropped previousSha, or the
//    live release was restored): the other release most recently recorded
//    live, before the current live record — each candidate row keeps the live
//    record of its last time live.
// 3. Neither → null: the previous release is unknown. describeReleases then
//    reports `rollbackUnknown` and protects every sealed release.
// `path` is null when the history names the release but not its folder.

const SHA_RE = /^[a-f0-9]{40}$/;
const parse = (text) => { if (typeof text !== 'string' || !text) return null; try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const absolute = (x) => typeof x === 'string' && x.startsWith('/') && !x.includes('\0') && !x.split('/').includes('..');

/**
 * The pure rule over the live record and the candidate rows (any profile
 * revision): `rows` are { sha, live, validation } with `live`/`validation`
 * parsed objects or null.
 */
export function previousLiveFrom(live, rows = []) {
  if (!live || !SHA_RE.test(live.sha || '')) return null;
  const list = Array.isArray(rows) ? rows.filter((r) => r && SHA_RE.test(r.sha || '')) : [];
  const pathFor = (sha) => {
    // The folder it was deployed from, else the one its passed validation sealed.
    const lived = list.filter((r) => r.sha === sha && absolute(r.live?.releasePath)).sort((a, b) => (Date.parse(b.live.verifiedAt || '') || 0) - (Date.parse(a.live.verifiedAt || '') || 0))[0];
    if (lived) return lived.live.releasePath;
    const validated = list.filter((r) => r.sha === sha && r.validation?.passed === true && absolute(r.validation.releasePath)).sort((a, b) => (Date.parse(b.validation.validatedAt || '') || 0) - (Date.parse(a.validation.validatedAt || '') || 0))[0];
    return validated ? validated.validation.releasePath : null;
  };
  if (SHA_RE.test(live.previousSha || '') && live.previousSha !== live.sha) return { sha: live.previousSha, path: pathFor(live.previousSha) };
  const liveAt = Date.parse(live.verifiedAt || '');
  const before = list
    .filter((r) => r.sha !== live.sha && r.live && absolute(r.live.releasePath) && r.live.releasePath !== live.releasePath)
    .map((r) => ({ sha: r.sha, path: r.live.releasePath, at: Date.parse(r.live.verifiedAt || '') }))
    .filter((r) => Number.isFinite(r.at) && (!Number.isFinite(liveAt) || r.at <= liveAt))
    .sort((a, b) => b.at - a.at);
  return before.length ? { sha: before[0].sha, path: before[0].path } : null;
}

/** The previous live release of one application, from mock2.db; null when unknown or unreadable. */
export function previousLiveRelease(mock2Db, applicationId) {
  try {
    const app = mock2Db.prepare('SELECT live_json FROM mock2_applications WHERE id = ?').get(Number(applicationId));
    if (!app) return null;
    const rows = mock2Db.prepare('SELECT sha, live_json, validation_json FROM mock2_application_candidates WHERE application_id = ?').all(Number(applicationId))
      .map((r) => ({ sha: r.sha, live: parse(r.live_json), validation: parse(r.validation_json) }));
    return previousLiveFrom(parse(app.live_json), rows);
  } catch {
    return null;
  }
}
