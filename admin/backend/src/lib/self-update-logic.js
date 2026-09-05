// Pure logic for ProxyPilot's self-update: version comparison, the
// "update available" decision, request/flag validation (mirrors the agent's
// and the runner's allowlists), state-file parsing and the public shapes the
// routes, the MCP tools and the dashboard share. No I/O, no DB — everything
// here is unit-tested without the native modules (self-update-logic.test.js).
//
// The flow it describes (docs/features/self-update.md): the dashboard asks
// the host agent (update.request) to drop a request file; a root-owned
// systemd oneshot (scripts/update-runner.sh) validates it and runs
// `update.sh --yes`; state.json + <id>.log on the host are what everyone
// polls, through the agent (update.status), before, during and after the
// container rebuild.

export const UPDATE_FLAGS = Object.freeze(['--rebuild', '--enable-mock2']);

// update.sh's "[n/7]" markers, in order. 3.5 is the host-agent rebuild step.
export const UPDATE_PHASES = Object.freeze([
  { index: 0, label: 'Backing up database' },
  { index: 1, label: 'Fetching latest changes' },
  { index: 2, label: 'Pulling latest code' },
  { index: 3, label: 'Checking Incus' },
  { index: 3.5, label: 'Building host agent' },
  { index: 4, label: 'Installing backend dependencies' },
  { index: 5, label: 'Installing frontend dependencies' },
  { index: 6, label: 'Building frontend' },
  { index: 7, label: 'Restarting ProxyPilot' },
]);

export const TERMINAL_STATUSES = Object.freeze(new Set(['success', 'failed', 'refused']));
export const LIVE_STATUSES = Object.freeze(new Set(['queued', 'running']));

export const CHECK_CACHE_MS = 10 * 60 * 1000;
export const RUNNING_STALE_MS = 60 * 60 * 1000;
export const STANDARDS_MANIFEST_URL = 'https://mock2.fractionate.ai/manifest.json';
export const STANDARDS_SITE_URL = 'https://mock2.fractionate.ai';

export const MCP_RUN_CONFIRM_MESSAGE =
  'Confirm with the user first: run_proxypilot_update runs update.sh on the ProxyPilot host — ' +
  'database backup, git pull, dependency install, frontend build and a docker compose rebuild — ' +
  'and the dashboard and this API are unreachable for about 1–2 minutes while the container restarts. ' +
  'Re-call with confirm: true to proceed (add rebuild: true to force a rebuild when the checkout is already up to date).';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUESTED_BY_RE = /^[A-Za-z0-9._@:+-]{1,80}$/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function isUpdateId(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_RE, '');
}

// "v1.4.0" / " 1.4.0 " → "1.4.0"; anything that is not a string → "".
export function normalizeVersion(v) {
  if (typeof v !== 'string') return '';
  return v.trim().replace(/^v/i, '');
}

// Numeric dotted compare: 1.4.10 > 1.4.9, missing parts are 0, a
// pre-release suffix on a part is ignored ("1.5.0-rc1" reads as 1.5.0).
// Returns -1 / 0 / 1; two unparseable inputs compare equal.
export function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map((p) => parseInt(p, 10) || 0);
  const pb = normalizeVersion(b).split('.').map((p) => parseInt(p, 10) || 0);
  const n = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// The same allowlist the agent (update.go) and the runner enforce. Never
// --discard-local: the dashboard and MCP must not be able to throw away an
// operator's local changes.
export function validateUpdateFlags(flags) {
  if (flags == null) return { ok: true, flags: [] };
  if (!Array.isArray(flags)) return { ok: false, error: 'flags must be an array of strings' };
  const out = [];
  for (const f of flags) {
    if (typeof f !== 'string' || !UPDATE_FLAGS.includes(f)) {
      return { ok: false, error: `flag ${JSON.stringify(f)} is not allowed (allowed: ${UPDATE_FLAGS.join(' ')})` };
    }
    if (!out.includes(f)) out.push(f);
  }
  return { ok: true, flags: out };
}

export function flagsFromOptions({ rebuild = false, enableMock2 = false } = {}) {
  const flags = [];
  if (rebuild) flags.push('--rebuild');
  if (enableMock2) flags.push('--enable-mock2');
  return flags;
}

// requested_by lands in a file the root runner parses with sed, so it is
// squeezed into the same character class the agent and the runner enforce.
export function sanitizeRequestedBy(value, fallback = 'admin') {
  const s = String(value ?? '').replace(/[^A-Za-z0-9._@:+-]/g, '_').slice(0, 80);
  return REQUESTED_BY_RE.test(s) ? s : fallback;
}

// Agent error codes → HTTP status for the dashboard routes.
export function mapAgentErrorToHttp(code) {
  switch (code) {
    case 'update_in_progress':
    case 'update_pending':
      return 409;
    case 'invalid_params':
      return 400;
    default:
      return 502;
  }
}

// The host checkout facts as the dashboard sees them. `raw` is the agent's
// update.check result (installed.json merged with configured/fresh/pending);
// reachable=false shapes an empty object with the transport error.
export function shapeInstalled(raw, { reachable = true, error = null } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const sha = typeof r.head_sha === 'string' ? r.head_sha : null;
  const dirtyFiles = Array.isArray(r.dirty_files) ? r.dirty_files.map(String).slice(0, 20) : [];
  return {
    reachable: !!reachable,
    configured: reachable ? r.configured === true : false,
    fresh: reachable ? r.fresh === true : false,
    pending: reachable ? r.pending === true : false,
    source_dir: typeof r.source_dir === 'string' && r.source_dir ? r.source_dir : null,
    branch: typeof r.branch === 'string' && r.branch ? r.branch : null,
    sha,
    short_sha: typeof r.head_short === 'string' && r.head_short ? r.head_short : (sha ? sha.slice(0, 10) : null),
    head_date: typeof r.head_date === 'string' && r.head_date ? r.head_date : null,
    head_subject: typeof r.head_subject === 'string' ? r.head_subject : null,
    remote_url: typeof r.remote_url === 'string' && r.remote_url ? r.remote_url : null,
    dirty: r.dirty === true,
    dirty_count: Number.isFinite(r.dirty_count) ? r.dirty_count : dirtyFiles.length,
    dirty_files: dirtyFiles,
    checkout_version: typeof r.installed_version === 'string' && r.installed_version ? r.installed_version : null,
    checked_at: typeof r.checked_at === 'string' ? r.checked_at : null,
    agent_version: typeof r.agent_version === 'string' ? r.agent_version : null,
    error: error || (typeof r.error === 'string' ? r.error : null),
  };
}

// Is there something newer than what is installed?
//   installed: { version, sha }   latest: { version, sha }
//   standards: { seed_version, site_version }
export function decideUpdate({ installed = {}, latest = {}, standards = {} } = {}) {
  const iv = normalizeVersion(installed.version);
  const lv = normalizeVersion(latest.version);
  let reason = 'unknown';
  let available = false;
  if (lv && iv && compareVersions(lv, iv) > 0) {
    available = true;
    reason = 'newer_release';
  } else if (latest.sha && installed.sha) {
    if (latest.sha !== installed.sha) {
      available = true;
      reason = 'newer_commit';
    } else {
      reason = 'up_to_date';
    }
  } else if (lv && iv) {
    reason = 'up_to_date';
  }
  const seed = normalizeVersion(standards.seed_version);
  const site = normalizeVersion(standards.site_version);
  const standardsAvailable = !!(seed && site && compareVersions(site, seed) > 0);
  return {
    updateAvailable: available,
    code: { available, reason },
    standards: { available: standardsAvailable, seed_version: seed || null, site_version: site || null },
  };
}

// Why "Update now" is disabled right now, or null when it may run.
// progress is a buildProgress() result (or null when unknown).
export function updateStartRefusal({ installed, progress = null, policyEnabled = true } = {}) {
  if (policyEnabled === false) {
    return 'The MCP update trigger is disabled on this host (lib/mcp-policy/self-update-allowlist.json has enabled: false). Use the dashboard: Profile → Application Settings → Update now.';
  }
  if (!installed || !installed.reachable) {
    return 'The host agent (proxypilot-agent) is unreachable, so the update runner cannot be asked to run. Check `systemctl status proxypilot-agent` on the host.';
  }
  if (!installed.configured) {
    return installed.error
      || 'No ProxyPilot git checkout is recorded on the host. Run update.sh once by hand from the checkout; it records the path for the self-update runner.';
  }
  if (installed.dirty) {
    const n = installed.dirty_count || installed.dirty_files?.length || 0;
    const sample = (installed.dirty_files || []).slice(0, 5).map((f) => f.trim()).join(', ');
    return `The checkout on the host has ${n} uncommitted local change${n === 1 ? '' : 's'}${sample ? ` (${sample})` : ''}. ` +
      'update.sh refuses to run over local changes: commit, stash or discard them on the host first.';
  }
  if (progress && progress.pending) {
    return 'A request is already waiting for the update runner; try again in a moment.';
  }
  if (progress && LIVE_STATUSES.has(progress.status) && progress.live !== false) {
    return `An update is already running (${progress.phase || progress.status}); wait for it to finish.`;
  }
  return null;
}

// state.json (as the agent returns it) → the normalized run record.
export function parseState(raw, { nowMs = Date.now() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const status = typeof r.status === 'string' ? r.status : 'idle';
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v == null ? null : Number(v)));
  const startedUnix = num(r.started_at_unix);
  const ageMs = startedUnix ? nowMs - startedUnix * 1000 : null;
  const live = LIVE_STATUSES.has(status) && (ageMs == null || ageMs < RUNNING_STALE_MS);
  return {
    id: typeof r.id === 'string' ? r.id : null,
    action: typeof r.action === 'string' ? r.action : null,
    status,
    phase: typeof r.phase === 'string' ? r.phase : null,
    phase_index: num(r.phase_index) ?? 0,
    phase_total: num(r.phase_total) ?? 7,
    started_at: r.started_at || null,
    finished_at: r.finished_at || null,
    exit_code: r.exit_code == null ? null : num(r.exit_code),
    requested_by: typeof r.requested_by === 'string' ? r.requested_by : null,
    from_sha: r.from_sha || null,
    to_sha: r.to_sha || null,
    from_version: r.from_version || null,
    to_version: r.to_version || null,
    flags: typeof r.flags === 'string' ? r.flags : '',
    reason: typeof r.reason === 'string' ? r.reason : null,
    up_to_date: r.up_to_date === true,
    log_path: typeof r.log === 'string' ? r.log : null,
    updated_at: r.updated_at || null,
    terminal: TERMINAL_STATUSES.has(status),
    live,
    // A run marked running whose start is more than an hour old: the runner
    // has TimeoutStartSec=3600, so nothing legitimate lasts longer.
    stale: LIVE_STATUSES.has(status) && !live,
  };
}

// The phase checklist for the UI: done / active / pending per update.sh marker.
export function phaseList(state) {
  const idx = Number(state?.phase_index) || 0;
  const terminal = !!state?.terminal;
  const success = state?.status === 'success';
  return UPDATE_PHASES.map((p) => {
    let phaseState = 'pending';
    if (terminal) phaseState = success ? 'done' : (p.index <= idx ? 'done' : 'pending');
    else if (p.index < idx) phaseState = 'done';
    else if (p.index === idx) phaseState = 'active';
    if (terminal && !success && p.index === idx) phaseState = 'failed';
    return { ...p, state: phaseState };
  });
}

// The /version/update/progress payload. `agentStatus` is the agent's
// update.status result (or a state.json read straight from the host file
// when the agent is restarting — `source` says which).
export function buildProgress({ agentStatus, reachable = true, source = 'agent', error = null, nowMs = Date.now() } = {}) {
  const raw = agentStatus && typeof agentStatus === 'object' ? agentStatus : {};
  const state = parseState(raw, { nowMs });
  const tail = typeof raw.log_tail === 'string' ? stripAnsi(raw.log_tail) : '';
  return {
    agent: { reachable: !!reachable, source: source || null, version: typeof raw.agent_version === 'string' ? raw.agent_version : null, error },
    ...state,
    pending: raw.pending === true,
    id_match: raw.id_match === undefined ? null : raw.id_match === true,
    log_tail: tail,
    log_truncated: raw.log_truncated === true,
    log_total_bytes: Number.isFinite(raw.log_total_bytes) ? raw.log_total_bytes : null,
    log_error: typeof raw.log_error === 'string' ? raw.log_error : null,
    phases: phaseList(state),
  };
}

// The /version/check payload.
export function buildVersionCheck({
  currentVersion,
  repo,
  release = null,
  mainCommit = null,
  commitsBehind = null,
  installed,
  standards = {},
  github = {},
  checkedAt = new Date().toISOString(),
  cached = false,
} = {}) {
  const inst = installed || shapeInstalled(null, { reachable: false });
  const latestVersion = normalizeVersion(release?.version) || normalizeVersion(github.fallbackVersion) || normalizeVersion(currentVersion);
  const decision = decideUpdate({
    installed: { version: currentVersion, sha: inst.sha },
    latest: { version: latestVersion, sha: mainCommit?.sha || null },
    standards: { seed_version: standards.seed_version, site_version: standards.site_version },
  });
  const refusal = updateStartRefusal({ installed: inst });
  return {
    currentVersion: normalizeVersion(currentVersion) || null,
    latestVersion: latestVersion || null,
    updateAvailable: decision.updateAvailable,
    updateReason: decision.code.reason,
    releaseUrl: release?.url || (repo ? `https://github.com/${repo}` : null),
    releaseNotes: release?.notes ?? null,
    releaseTag: release?.tag || null,
    releasePublishedAt: release?.published_at || null,
    latest_sha: mainCommit?.sha || null,
    latest_sha_short: mainCommit?.sha ? String(mainCommit.sha).slice(0, 10) : null,
    latest_commit_date: mainCommit?.date || null,
    latest_branch: mainCommit?.branch || null,
    commits_behind: Number.isFinite(commitsBehind) ? commitsBehind : null,
    installed: inst,
    standards: {
      seed_version: decision.standards.seed_version,
      site_version: decision.standards.site_version,
      update_available: decision.standards.available,
      site: standards.site || STANDARDS_SITE_URL,
      source: standards.source || null,
      synced: standards.synced || null,
      changelog: standards.changelog ?? null,
      error: standards.error || null,
    },
    agent: { reachable: inst.reachable, version: inst.agent_version },
    canUpdate: refusal === null,
    cannotUpdateReason: refusal,
    github: { repo: repo || null, error: github.error || null },
    checkedAt,
    cached,
  };
}

// Boot-time bookkeeping: record a run that finished successfully and was
// not recorded yet (the backend that started it died in the rebuild).
export function shouldRecordCompletedUpdate({ progress, lastRecordedId = null, nowMs = Date.now(), windowMs = RUNNING_STALE_MS } = {}) {
  if (!progress || progress.status !== 'success' || !isUpdateId(progress.id)) return false;
  if (progress.id === lastRecordedId) return false;
  const finished = progress.finished_at ? Date.parse(progress.finished_at) : NaN;
  if (!Number.isFinite(finished)) return false;
  return nowMs - finished >= 0 && nowMs - finished <= windowMs;
}
