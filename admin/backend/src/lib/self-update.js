// Self-update driver: the I/O half of ProxyPilot's "Update now".
//
//   checkForUpdates()  GitHub latest release + latest branch commit (10 s
//                      timeout, cached 10 min, ?force bypasses), the Mock2
//                      standards manifest (5 s, best-effort) and the host
//                      checkout facts. A network failure is a field in the
//                      answer, never a thrown error.
//   installedState()   agentCall('update.check') → shapeInstalled().
//   startUpdate()      agentCall('update.request') — drops the request file
//                      the root runner picks up. Nothing is executed here.
//   updateStatus()     agentCall('update.status') — the runner's state.json
//                      and a log tail. Falls back to reading the state file
//                      straight from /var/lib/proxypilot/update (bind-mounted
//                      into the container) when the agent is unreachable,
//                      which it briefly is while update.sh rebuilds it.
//   noteCompletedUpdateOnBoot()  audits a run that finished while the old
//                      backend was gone.
//
// No DB import: the routes hand in getSetting/setSetting/logAudit so this
// module (and lib/self-update-logic.js) test without better-sqlite3.

import { readFileSync } from 'node:fs';
import { readFile, stat, open as fsOpen } from 'node:fs/promises';
import { join } from 'node:path';
import { agentCall, AgentError } from './agent.js';
import {
  CHECK_CACHE_MS,
  STANDARDS_MANIFEST_URL,
  STANDARDS_SITE_URL,
  buildProgress,
  buildVersionCheck,
  flagsFromOptions,
  isUpdateId,
  normalizeVersion,
  sanitizeRequestedBy,
  shapeInstalled,
  shouldRecordCompletedUpdate,
  validateUpdateFlags,
} from './self-update-logic.js';

export const STATE_DIR = process.env.PROXYPILOT_UPDATE_STATE_DIR || '/var/lib/proxypilot/update';
const GITHUB_TIMEOUT_MS = 10_000;
const STANDARDS_TIMEOUT_MS = 5_000;
const AGENT_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LOG_TAIL = 16 * 1024;
const MAX_LOG_TAIL = 48 * 1024;
const USER_AGENT = 'ProxyPilot-Update-Checker';

let seedVersionCache = null;

// framework-seed/standards-version.json — the Mock2 standards version this
// build's seed renders (bumped with the seed; docs/mock2/standards-and-cpr.md §3).
export function readStandardsSeedVersion() {
  if (seedVersionCache) return seedVersionCache;
  try {
    const raw = readFileSync(new URL('../mock2/framework-seed/standards-version.json', import.meta.url), 'utf8');
    const j = JSON.parse(raw);
    seedVersionCache = {
      version: normalizeVersion(j.version) || null,
      source: typeof j.source === 'string' ? j.source : null,
      manifest: typeof j.manifest === 'string' ? j.manifest : STANDARDS_MANIFEST_URL,
      synced: typeof j.synced === 'string' ? j.synced : null,
    };
  } catch (err) {
    seedVersionCache = { version: null, source: null, manifest: STANDARDS_MANIFEST_URL, synced: null, error: err.message };
  }
  return seedVersionCache;
}

// A structured agent error keeps its code (update_in_progress, …); anything
// else — ECONNREFUSED, ENOENT on the socket, a timeout — is the agent being
// unreachable, whatever syscall said so.
function errorCode(err) {
  if (err instanceof AgentError) return err.code || 'agent_error';
  return 'agent_unreachable';
}

// Checkout facts are re-read at most once a minute unless forced: every
// dashboard shell mount asks, and each stale ask makes the agent wake the
// root runner for a `git status` on the host.
const INSTALLED_CACHE_MS = 60_000;
let installedCache = null;

export function clearInstalledCache() {
  installedCache = null;
}

/**
 * Host checkout facts via the agent. Never throws: an unreachable agent is
 * `{ reachable: false, error }`, which the UI renders as a disabled button.
 */
export async function installedState({ call = agentCall, timeoutMs = AGENT_TIMEOUT_MS, force = false, now = Date.now } = {}) {
  if (!force && installedCache && installedCache.reachable && now() - installedCache.at < INSTALLED_CACHE_MS) {
    return installedCache.value;
  }
  let value;
  try {
    const raw = await call('update.check', {}, { timeoutMs });
    value = shapeInstalled(raw, { reachable: true });
  } catch (err) {
    value = shapeInstalled(null, { reachable: false, error: `${errorCode(err)}: ${err.message || 'agent unreachable'}` });
  }
  installedCache = { at: now(), reachable: value.reachable, value };
  return value;
}

async function readStateFromDisk({ id, logTailBytes }) {
  let path = join(STATE_DIR, 'state.json');
  if (isUpdateId(id)) {
    const per = join(STATE_DIR, `state.${id}.json`);
    try { await stat(per); path = per; } catch { /* fall back to latest */ }
  }
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const out = { ...raw };
  if (isUpdateId(id)) out.id_match = raw.id === id;
  try { await stat(join('/run/proxypilot-update', 'request.json')); out.pending = true; } catch { out.pending = false; }
  if (logTailBytes > 0 && typeof raw.log === 'string' && raw.log.startsWith(`${STATE_DIR}/`) && !raw.log.includes('..')) {
    try {
      const fh = await fsOpen(raw.log, 'r');
      try {
        const size = (await fh.stat()).size;
        const start = Math.max(0, size - logTailBytes);
        const buf = Buffer.alloc(size - start);
        await fh.read(buf, 0, buf.length, start);
        let text = buf.toString('utf8');
        if (start > 0) {
          const nl = text.indexOf('\n');
          if (nl >= 0) text = text.slice(nl + 1);
        }
        out.log_tail = text;
        out.log_total_bytes = size;
        out.log_truncated = start > 0;
      } finally {
        await fh.close();
      }
    } catch (err) {
      out.log_error = err.message;
    }
  }
  return out;
}

/**
 * Progress of the latest run (or of `id`). Agent first; host file second
 * (the agent is rebuilt and restarted by update.sh when its source changed,
 * and the state must stay readable through that); `idle` when nothing has
 * ever run and neither answers.
 */
export async function updateStatus({ id, logTailBytes = DEFAULT_LOG_TAIL, call = agentCall, timeoutMs = AGENT_TIMEOUT_MS, readState = readStateFromDisk } = {}) {
  const tail = Math.max(0, Math.min(Number(logTailBytes) || 0, MAX_LOG_TAIL));
  const params = {};
  if (isUpdateId(id)) params.id = id;
  if (tail > 0) params.log_tail_bytes = tail;
  let agentError = null;
  try {
    const raw = await call('update.status', params, { timeoutMs });
    return buildProgress({ agentStatus: raw, reachable: true, source: 'agent' });
  } catch (err) {
    agentError = `${errorCode(err)}: ${err.message || 'agent unreachable'}`;
  }
  try {
    const raw = await readState({ id, logTailBytes: tail });
    return buildProgress({ agentStatus: raw, reachable: false, source: 'file', error: agentError });
  } catch (err) {
    const missing = err && err.code === 'ENOENT';
    return buildProgress({ agentStatus: { status: 'idle' }, reachable: false, source: null, error: missing ? agentError : `${agentError}; state file: ${err.message}` });
  }
}

/**
 * Ask the runner to run update.sh. Resolves to the agent's update.request
 * result ({ id, requested_at, flags, state_path, log_path }); rejects with
 * an Error carrying .code (update_in_progress, update_pending,
 * invalid_params, agent_unreachable…) for the route to map to a status.
 */
export async function startUpdate({ requestedBy, flags = [], rebuild, call = agentCall, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const chosen = flags.length ? flags : flagsFromOptions({ rebuild: !!rebuild });
  const v = validateUpdateFlags(chosen);
  if (!v.ok) {
    const e = new Error(v.error);
    e.code = 'invalid_params';
    throw e;
  }
  try {
    const r = await call('update.request', { requested_by: sanitizeRequestedBy(requestedBy), flags: v.flags }, { timeoutMs });
    installedCache = null;
    return { id: r.id, requested_at: r.requested_at || null, flags: r.flags ?? v.flags.join(' '), state_path: r.state_path || null, log_path: r.log_path || null };
  } catch (err) {
    const e = new Error(err.message || 'agent unreachable');
    e.code = errorCode(err);
    throw e;
  }
}

async function fetchJson(fetchImpl, url, { timeoutMs, headers = {} } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const e = new Error(`${url} → HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/**
 * Latest release + latest commit on `branch` from GitHub, and how many
 * commits the installed sha is behind (when GitHub knows the sha). Every
 * failure is reported in `error`, never thrown.
 */
export async function fetchLatestFromGitHub({ repo, branch = 'main', installedSha = null, fetchImpl = fetch } = {}) {
  const out = { release: null, mainCommit: null, commitsBehind: null, fallbackVersion: null, error: null };
  if (!repo) {
    out.error = 'no GitHub repository configured';
    return out;
  }
  const api = `https://api.github.com/repos/${repo}`;
  const gh = { Accept: 'application/vnd.github+json' };
  const errors = [];
  try {
    const rel = await fetchJson(fetchImpl, `${api}/releases/latest`, { timeoutMs: GITHUB_TIMEOUT_MS, headers: gh });
    out.release = {
      version: normalizeVersion(rel.tag_name) || null,
      tag: rel.tag_name || null,
      url: rel.html_url || null,
      notes: typeof rel.body === 'string' ? rel.body : null,
      published_at: rel.published_at || null,
    };
  } catch (err) {
    if (err.status === 404) {
      // No releases on the repo: the package.json on the branch names the version.
      try {
        const pkg = await fetchJson(fetchImpl, `https://raw.githubusercontent.com/${repo}/${branch}/admin/backend/package.json`, { timeoutMs: GITHUB_TIMEOUT_MS });
        out.fallbackVersion = normalizeVersion(pkg.version) || null;
      } catch (err2) {
        errors.push(`package.json: ${err2.message}`);
      }
    } else {
      errors.push(`releases: ${err.message}`);
    }
  }
  try {
    const c = await fetchJson(fetchImpl, `${api}/commits/${encodeURIComponent(branch)}`, { timeoutMs: GITHUB_TIMEOUT_MS, headers: gh });
    out.mainCommit = { sha: c.sha || null, date: c.commit?.committer?.date || c.commit?.author?.date || null, branch, message: (c.commit?.message || '').split('\n')[0] || null };
  } catch (err) {
    errors.push(`commits/${branch}: ${err.message}`);
  }
  if (installedSha && out.mainCommit?.sha && out.mainCommit.sha !== installedSha) {
    try {
      const cmp = await fetchJson(fetchImpl, `${api}/compare/${installedSha}...${encodeURIComponent(branch)}`, { timeoutMs: GITHUB_TIMEOUT_MS, headers: gh });
      if (Number.isFinite(cmp.ahead_by)) out.commitsBehind = cmp.ahead_by;
    } catch {
      // A sha GitHub never saw (a local commit) is a null, not an error.
    }
  } else if (installedSha && out.mainCommit?.sha === installedSha) {
    out.commitsBehind = 0;
  }
  if (errors.length) out.error = errors.join('; ');
  return out;
}

/** The Mock2 standards site manifest ({ version, changelog }), best-effort. */
export async function fetchStandardsManifest({ url = STANDARDS_MANIFEST_URL, fetchImpl = fetch } = {}) {
  try {
    const m = await fetchJson(fetchImpl, url, { timeoutMs: STANDARDS_TIMEOUT_MS });
    return { site_version: normalizeVersion(m.version) || null, changelog: m.changelog ?? null, error: null };
  } catch (err) {
    return { site_version: null, changelog: null, error: err.message };
  }
}

let checkCache = null;

export function clearUpdateCheckCache() {
  checkCache = null;
  installedCache = null;
}

/**
 * The /version/check payload. Network results are cached for 10 minutes per
 * repo (force bypasses); the host checkout facts are read every time so a
 * just-finished update shows its new commit immediately.
 */
export async function checkForUpdates({ repo, currentVersion, force = false, fetchImpl = fetch, call = agentCall, now = Date.now } = {}) {
  const installed = await installedState({ call, force, now });
  const branch = installed.branch && installed.branch !== 'HEAD' ? installed.branch : 'main';
  const key = `${repo}@${branch}`;
  let net = checkCache && checkCache.key === key && now() - checkCache.at < CHECK_CACHE_MS && !force ? checkCache : null;
  let cached = !!net;
  if (!net) {
    const seed = readStandardsSeedVersion();
    const [github, manifest] = await Promise.all([
      fetchLatestFromGitHub({ repo, branch, installedSha: installed.sha, fetchImpl }),
      fetchStandardsManifest({ url: seed.manifest || STANDARDS_MANIFEST_URL, fetchImpl }),
    ]);
    net = { key, at: now(), github, manifest, seed, installedSha: installed.sha };
    checkCache = net;
    cached = false;
  } else if (installed.sha && net.installedSha !== installed.sha) {
    // The checkout moved since the cached compare — recount, keep the rest.
    const github = await fetchLatestFromGitHub({ repo, branch, installedSha: installed.sha, fetchImpl });
    net = { ...net, github, installedSha: installed.sha };
    checkCache = net;
  }
  return buildVersionCheck({
    currentVersion,
    repo,
    release: net.github.release,
    mainCommit: net.github.mainCommit,
    commitsBehind: net.github.commitsBehind,
    installed,
    standards: {
      seed_version: net.seed.version,
      site_version: net.manifest.site_version,
      changelog: net.manifest.changelog,
      site: STANDARDS_SITE_URL,
      source: net.seed.source,
      synced: net.seed.synced,
      error: net.manifest.error || net.seed.error || null,
    },
    github: { error: net.github.error, fallbackVersion: net.github.fallbackVersion },
    checkedAt: new Date(net.at).toISOString(),
    cached,
  });
}

/**
 * At boot: if the latest run succeeded within the last hour and was not
 * recorded yet, audit SELF_UPDATE_COMPLETED and remember its id so the UI
 * can say "updated to vX at T". The backend that requested the run died in
 * the rebuild, so this is the only place that can write that row.
 */
export async function noteCompletedUpdateOnBoot({ getSetting, setSetting, logAudit, call = agentCall, now = Date.now } = {}) {
  installedCache = null;
  const progress = await updateStatus({ logTailBytes: 0, call });
  const last = getSetting('last_update_id');
  if (!shouldRecordCompletedUpdate({ progress, lastRecordedId: last, nowMs: now() })) return null;
  const detail = {
    from_sha: progress.from_sha,
    to_sha: progress.to_sha,
    from_version: progress.from_version,
    to_version: progress.to_version,
    requested_by: progress.requested_by,
    flags: progress.flags,
    finished_at: progress.finished_at,
    up_to_date: progress.up_to_date,
  };
  logAudit(null, 'SELF_UPDATE_COMPLETED', 'system', progress.id, detail, null);
  setSetting('last_update_id', progress.id);
  setSetting('last_update_at', progress.finished_at || new Date(now()).toISOString());
  setSetting('last_update_version', progress.to_version || '');
  setSetting('update_dismissed', 'false');
  setSetting('dismissed_version', '');
  return { id: progress.id, ...detail };
}
