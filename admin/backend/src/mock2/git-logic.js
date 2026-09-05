// Mock2 git-connector PURE decision layer (Phase M5, ADR-006). Native-free,
// unit-tested stub-first (risk R9). Git connectors are orchestrator-side push
// targets: credentials live encrypted in mock2.db and NEVER enter a container
// (ADR-006). This module holds the provider metadata, validation, the
// test-plan, and publicShape (never returns the decrypted credential).
//
// Terminology (risk R7): nothing here is named "agent".

export const GIT_PROVIDERS = Object.freeze(['github', 'gitea', 'generic_https', 'generic_ssh']);
export const GIT_AUTH_KINDS = Object.freeze(['token', 'ssh_key']);

export function validateGitConnectorInput({ provider, auth_kind, base_url }) {
  if (!GIT_PROVIDERS.includes(provider)) return `Unknown git provider "${provider}"`;
  if (!GIT_AUTH_KINDS.includes(auth_kind)) return `Unknown auth kind "${auth_kind}"`;
  if (provider === 'gitea' && !String(base_url || '').trim()) {
    return 'A base URL is required for a Gitea connector';
  }
  if ((provider === 'generic_https' || provider === 'generic_ssh') && !String(base_url || '').trim()) {
    return `A base URL is required for the ${provider} provider`;
  }
  if (provider === 'generic_ssh' && auth_kind !== 'ssh_key') {
    return 'generic_ssh requires ssh_key auth';
  }
  if (base_url && (provider === 'github' || provider === 'gitea' || provider === 'generic_https')) {
    if (!/^https?:\/\//i.test(String(base_url).trim())) return 'base_url must be an http(s) URL';
  }
  return null;
}

// The lightweight credential-validation plan (orchestrator-side, ADR-006): a
// "who am I" API call proving the token reaches the host. Returns null when the
// connector can't be tested without a concrete repo (generic/ssh) — the UI shows
// "verify by configuring a project remote". `token` is injected by the data
// layer and never stored on the connector shape.
export function gitTestPlan(connector) {
  const { provider, base_url } = connector;
  const token = connector.__token || null;
  if (connector.auth_kind !== 'token') return null; // ssh keys aren't API-testable here
  switch (provider) {
    case 'github':
      return {
        url: 'https://api.github.com/user',
        headers: { authorization: `Bearer ${token || ''}`, 'user-agent': 'proxypilot-mock2', accept: 'application/vnd.github+json' },
      };
    case 'gitea': {
      const b = String(base_url || '').replace(/\/+$/, '');
      return { url: `${b}/api/v1/user`, headers: { authorization: `token ${token || ''}` } };
    }
    default:
      return null; // generic_https: no standardized identity endpoint
  }
}

export function interpretGitTestResponse(status) {
  if (status >= 200 && status < 300) return { ok: true, detail: 'credentials accepted' };
  if (status === 401 || status === 403) return { ok: false, detail: `auth rejected (HTTP ${status})` };
  return { ok: false, detail: `HTTP ${status}` };
}

// Client-safe view. NEVER returns credential_enc or the decrypted credential;
// exposes secret_decryptable (a boolean the caller computes).
export function publicGitConnectorShape(row, { secretDecryptable = false } = {}) {
  if (!row) return null;
  let test = null;
  if (row.test_status) {
    try { test = JSON.parse(row.test_status); } catch { test = { ok: null, detail: String(row.test_status) }; }
  }
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    base_url: row.base_url || null,
    auth_kind: row.auth_kind,
    has_credential: !!row.credential_enc,
    secret_decryptable: !!secretDecryptable,
    test,
    test_at: row.test_at || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
  };
}

export function publicProjectRemoteShape(row) {
  if (!row) return null;
  return {
    project_id: row.project_id,
    git_connector_id: row.git_connector_id,
    remote_repo: row.remote_repo,
    push_on_checkpoint: !!row.push_on_checkpoint,
    last_push_at: row.last_push_at || null,
    last_push_error: row.last_push_error || null,
  };
}

// ---- remotes for static sites and LXC containers (migration 558) ----
//
// Everything ProxyPilot hosts can be pushed to a git remote: AI-dev projects
// (mock2_project_remotes — the bare repo IS the source), static sites and LXC
// containers (mock2_target_remotes — a host-side MIRROR repo snapshots the
// docroot / the guest's app directory on each push). These are the pure rules.

export const REMOTE_TARGET_KINDS = Object.freeze(['project', 'static_site', 'lxc']);
export const MIRROR_TARGET_KINDS = Object.freeze(['static_site', 'lxc']);
export const PUSH_MODES = Object.freeze(['manual', 'auto']);

const LXC_TARGET_RE = /^[a-zA-Z][a-zA-Z0-9-]{0,62}$/;
const STATIC_TARGET_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;

export function normalizePushMode(raw, fallback = 'manual') {
  const v = String(raw || '').trim().toLowerCase();
  return PUSH_MODES.includes(v) ? v : fallback;
}

// Validate a (kind, target_id) pair for the mirror table. Returns null when
// valid, else the reason. The project kind is handled by its own table.
export function validateTargetRef(kind, targetId) {
  if (!MIRROR_TARGET_KINDS.includes(kind)) return `kind must be one of ${MIRROR_TARGET_KINDS.join(', ')}`;
  const id = String(targetId || '').trim();
  if (!id) return 'target_id is required';
  if (kind === 'lxc' && !LXC_TARGET_RE.test(id)) return 'target_id must be a container name (letters, digits, hyphens)';
  if (kind === 'static_site' && !STATIC_TARGET_RE.test(id)) return 'target_id must be a static site id';
  return null;
}

// A guest directory a container remote mirrors. Absolute, no traversal, and
// never the guest root (mirroring / would ship the OS).
export function validateSourceDir(dir) {
  const d = String(dir || '').trim();
  if (!d) return null; // optional — falls back to the registered startup dir
  if (!d.startsWith('/')) return 'source_dir must be an absolute path inside the container';
  if (d === '/' || /(^|\/)\.\.(\/|$)/.test(d)) return 'source_dir cannot be / or contain ..';
  if (/[\s'"`$\\]/.test(d)) return 'source_dir contains characters that are not allowed';
  return null;
}

// Client-safe view of a mock2_target_remotes row.
export function publicTargetRemoteShape(row) {
  if (!row) return null;
  return {
    kind: row.kind,
    target_id: row.target_id,
    git_connector_id: row.git_connector_id,
    remote_repo: row.remote_repo,
    push_mode: normalizePushMode(row.push_mode),
    source_dir: row.source_dir || null,
    last_push_at: row.last_push_at || null,
    last_push_error: row.last_push_error || null,
    last_pushed_commit: row.last_pushed_commit || null,
  };
}

// Split "org/name", "org/name.git" or a full URL into { owner, name }. Null when
// it cannot be read that way (e.g. an ssh URL with an unusual shape).
export function parseRemoteRepoRef(remoteRepo) {
  const raw = String(remoteRepo || '').trim();
  if (!raw) return null;
  let path = raw;
  const url = /^https?:\/\/[^/]+\/(.+)$/i.exec(raw);
  if (url) path = url[1];
  const ssh = /^[^@\s]+@[^:\s]+:(.+)$/.exec(raw);
  if (ssh) path = ssh[1];
  const parts = path.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  return { owner, name };
}

// Build an authenticated HTTPS push URL from a token connector. Never persisted;
// the caller uses it for one push and drops it. Returns null when the host
// cannot be determined (a gitea connector without base_url).
export function buildTokenPushUrl(conn, remoteRepo, token) {
  const repo = String(remoteRepo || '').trim();
  const m = /^(https?:\/\/)(.+)$/i.exec(repo);
  if (m) {
    const rest = m[2].replace(/^[^@/]*@/, '');
    return `${m[1]}${encodeURIComponent(token)}@${rest}`;
  }
  let host = null;
  if (conn.base_url) {
    const h = /^https?:\/\/([^/]+)/i.exec(conn.base_url);
    if (h) host = h[1];
  }
  if (!host) host = conn.provider === 'gitea' ? null : 'github.com';
  if (!host) return null;
  const path = repo.replace(/^\/+/, '').replace(/\.git$/, '');
  return `https://${encodeURIComponent(token)}@${host}/${path}.git`;
}

// The browse URL of a remote repo (what the UI links to). Null when unknown.
export function remoteRepoWebUrl(conn, remoteRepo) {
  const raw = String(remoteRepo || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\.git$/i, '');
  const ref = parseRemoteRepoRef(raw);
  if (!ref) return null;
  let base = null;
  if (conn?.base_url) base = String(conn.base_url).replace(/\/+$/, '');
  else if (conn?.provider === 'github') base = 'https://github.com';
  if (!base) return null;
  return `${base}/${ref.owner}/${ref.name}`;
}

// The API plan to make sure a remote repo EXISTS on a token connector (Gitea or
// GitHub): a lookup request, and — when the lookup says 404 — the create
// request, which differs by whether the owner is the token's own user or an
// organisation. `tokenLogin` is the login the connector test discovered
// (`/api/v1/user` on Gitea, `/user` on GitHub); when unknown, the caller tries
// the org form first and falls back to the user form on 404/403/422.
// Returns null for providers without a standard repo API (generic/ssh).
export function gitEnsureRepoPlan(conn, remoteRepo, { token = '', tokenLogin = null, isPrivate = true } = {}) {
  const ref = parseRemoteRepoRef(remoteRepo);
  if (!ref) return null;
  if (conn.auth_kind !== 'token') return null;
  const provider = conn.provider;
  if (provider === 'gitea') {
    const b = String(conn.base_url || '').replace(/\/+$/, '');
    if (!b) return null;
    const headers = { authorization: `token ${token}`, 'content-type': 'application/json', accept: 'application/json' };
    const body = JSON.stringify({ name: ref.name, private: !!isPrivate, default_branch: 'main', auto_init: false });
    return {
      provider, ref,
      lookup: { url: `${b}/api/v1/repos/${ref.owner}/${ref.name}`, headers },
      whoami: { url: `${b}/api/v1/user`, headers },
      createAsUser: { url: `${b}/api/v1/user/repos`, headers, body },
      createInOrg: { url: `${b}/api/v1/orgs/${ref.owner}/repos`, headers, body },
      ownerIsUser: tokenLogin ? tokenLogin.toLowerCase() === ref.owner.toLowerCase() : null,
    };
  }
  if (provider === 'github') {
    const b = String(conn.base_url || 'https://api.github.com').replace(/\/+$/, '');
    const headers = { authorization: `Bearer ${token}`, 'user-agent': 'proxypilot-mock2', accept: 'application/vnd.github+json', 'content-type': 'application/json' };
    const body = JSON.stringify({ name: ref.name, private: !!isPrivate, auto_init: false });
    return {
      provider, ref,
      lookup: { url: `${b}/repos/${ref.owner}/${ref.name}`, headers },
      whoami: { url: `${b}/user`, headers },
      createAsUser: { url: `${b}/user/repos`, headers, body },
      createInOrg: { url: `${b}/orgs/${ref.owner}/repos`, headers, body },
      ownerIsUser: tokenLogin ? tokenLogin.toLowerCase() === ref.owner.toLowerCase() : null,
    };
  }
  return null;
}

// Map a static site's docroot as the BACKEND sees it (SERVICES_DATA_DIR, e.g.
// /data/services inside Docker) to the path the HOST sees (CADDY_STATIC_ROOT) —
// the mirror's git commands run host-side through the pivot. Same translation
// the Caddy renderer applies to root_dir.
export function hostPathForDocroot(dataDir, { servicesDataDir = '/data/services', caddyStaticRoot = null } = {}) {
  const d = String(dataDir || '');
  if (!d) return null;
  const root = caddyStaticRoot || servicesDataDir;
  if (root === servicesDataDir) return d;
  if (d === servicesDataDir) return root;
  if (d.startsWith(`${servicesDataDir}/`)) return `${root}${d.slice(servicesDataDir.length)}`;
  return d;
}

// Shell-quote for the host `sh -c` scripts below.
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Directories never worth mirroring: dependency trees, build output, the
// platform's own staging dirs, secrets. Applied to both kinds.
export const MIRROR_EXCLUDES = Object.freeze([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.cache', '.npm', '__pycache__',
  '.venv', 'venv', '.pp-zip-stage-*', '*.old', '.env', '.env.*', '*.pem', '*.key', 'id_rsa*',
]);

// The tar flags that carry MIRROR_EXCLUDES.
export function mirrorExcludeArgs(excludes = MIRROR_EXCLUDES) {
  return excludes.map((e) => `--exclude=${shq(e)}`).join(' ');
}

// Host-side script: snapshot a content directory into a mirror repo and report
// the resulting commit. `exportCmd` writes a tar stream of the content to
// stdout (a plain `tar -C dir -cf - .` for a docroot, `incus exec … tar …` for a
// guest); the script extracts it into a fresh work tree, commits with the
// mirror's own git-dir, and prints `PP_COMMIT:<sha>` (or `PP_NOCHANGE:<sha>`
// when the tree is identical to HEAD). No credential is involved here; the
// push is a separate step so a failed export never touches the remote.
export function mirrorSnapshotScript({ gitDir, exportCmd, message, authorName = 'ProxyPilot', authorEmail = 'proxypilot@localhost' }) {
  const g = shq(gitDir);
  const msg = shq(message);
  return [
    'set -e',
    `mkdir -p ${g}`,
    `[ -d ${g}/objects ] || git init -q --bare -b main ${g}`,
    'WT="$(mktemp -d)"; trap \'rm -rf "$WT"\' EXIT',
    `${exportCmd} | tar -xf - -C "$WT"`,
    `export GIT_DIR=${g} GIT_WORK_TREE="$WT"`,
    `export GIT_AUTHOR_NAME=${shq(authorName)} GIT_AUTHOR_EMAIL=${shq(authorEmail)} GIT_COMMITTER_NAME=${shq(authorName)} GIT_COMMITTER_EMAIL=${shq(authorEmail)}`,
    'git symbolic-ref HEAD refs/heads/main',
    // A fresh index every time: the work tree is a new snapshot, so the index
    // must describe exactly it (deletions included).
    'rm -f "$GIT_DIR/index"',
    'git add -A .',
    'if git rev-parse -q --verify HEAD >/dev/null 2>&1 && git diff --cached --quiet; then echo "PP_NOCHANGE:$(git rev-parse HEAD)"; exit 0; fi',
    `git commit -q -m ${msg}`,
    'echo "PP_COMMIT:$(git rev-parse HEAD)"',
  ].join('\n');
}

// The export commands the snapshot script consumes.
export function docrootExportCmd(hostDocroot) {
  return `tar -C ${shq(hostDocroot)} ${mirrorExcludeArgs()} -cf - .`;
}
export function lxcExportCmd(incusName, sourceDir) {
  // tar inside the guest, streamed out through incus exec. --warning=no-file-changed
  // keeps a live app dir from failing the snapshot on a log file that grew.
  return `incus exec ${shq(incusName)} -- tar -C ${shq(sourceDir)} ${mirrorExcludeArgs()} --warning=no-file-changed -cf - .`;
}

// Parse the snapshot script's last line.
export function parseMirrorSnapshotOutput(stdout) {
  const lines = String(stdout || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^PP_(COMMIT|NOCHANGE):([0-9a-f]{7,40})$/.exec(lines[i].trim());
    if (m) return { commit: m[2], changed: m[1] === 'COMMIT' };
  }
  return null;
}
