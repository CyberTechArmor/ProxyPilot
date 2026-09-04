// Publish a directory of files to an external git remote through a configured
// git connector.
//
// The connector half already existed for AI-dev projects: mock2/git-connectors.js
// stores a provider (gitea / github / generic HTTPS), a base URL and a token
// encrypted at rest, and pushes a project's bare repo host-side with the token
// injected per-push. What it could not do is publish anything that is NOT
// already a git repo — a static site's docroot, or an application directory
// inside an LXC guest. This module is that missing half.
//
// Shape of a publish
// ------------------
// Clone the remote (shallow, branch-scoped), replace its tracked content with
// the source directory, commit, push. NOT a force-push and NOT a fresh repo per
// publish: the remote keeps its history, so a publish is an ordinary commit an
// operator can read, diff and revert. An empty or not-yet-created remote falls
// back to `git init`, which is the only case that produces a root commit.
//
// Where the work happens
// ----------------------
// Everything runs host-side through the same pivot the rest of the platform
// uses (mock2/host.js → lib/host-exec.js, nsenter when the backend is in
// Docker). The token is injected into a one-shot remote URL and never written
// to a repo config, matching what pushProjectRemote already does. For an LXC
// source the files come OUT of the guest via `incus exec ... tar`; the
// credential never enters the container.
//
// Secret hygiene
// --------------
// Application directories hold deployment secrets. The exclude list in
// git-publish-logic.js is applied by default and every held-back path is
// reported by name — see that module's header for why this is deny-by-default.

import { sh, runHost } from '../mock2/host.js';
import {
  planPublish,
  validateRemoteRepo,
  validateBranch,
  repoApiPlan,
  commitSubject,
} from './git-publish-logic.js';

const GIT_IDENTITY =
  `-c user.name=ProxyPilot -c user.email=proxypilot@localhost ` +
  `-c commit.gpgsign=false -c core.hooksPath=/dev/null`;

// Single-quote a value for safe interpolation into an `sh -c` script.
const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/**
 * Build a one-shot authenticated HTTPS remote URL.
 *
 * Same contract as the project-push path: never persisted, never written to a
 * repo config, and the token is percent-encoded so a `/` or `@` in it cannot
 * restructure the URL.
 *
 * @param {{provider: string, base_url: string|null}} connector
 * @param {string} remoteRepo  owner/name or a full https URL
 * @param {string} token
 * @returns {string|null}
 */
export function buildAuthedRemoteUrl(connector, remoteRepo, token) {
  const repo = String(remoteRepo || '').trim();
  const m = /^(https?:\/\/)(.+)$/i.exec(repo);
  if (m) {
    const rest = m[2].replace(/^[^@/]*@/, '');
    return `${m[1]}${encodeURIComponent(token)}@${rest}`;
  }
  let host = null;
  let scheme = 'https://';
  if (connector.base_url) {
    const b = /^(https?:\/\/)([^/]+)/i.exec(connector.base_url);
    if (b) { scheme = b[1]; host = b[2]; }
  }
  if (!host && connector.provider === 'github') host = 'github.com';
  if (!host) return null;
  const path = repo.replace(/^\/+/, '').replace(/\.git$/, '');
  return `${scheme}${encodeURIComponent(token)}@${host}/${path}.git`;
}

/**
 * Ensure the remote repository exists, creating it private when it does not.
 *
 * Advisory: a provider with no create endpoint, or a failed create, returns a
 * reason rather than throwing — the push that follows will produce the real,
 * more useful error if the repo genuinely is not there.
 *
 * @param {object} connector
 * @param {string} remoteRepo
 * @param {string} token
 * @returns {Promise<{existed: boolean|null, created: boolean, detail: string|null}>}
 */
export async function ensureRemoteRepo(connector, remoteRepo, token) {
  if (/^https?:\/\//i.test(String(remoteRepo || ''))) {
    return { existed: null, created: false, detail: 'full URL given — not checked' };
  }
  const plan = repoApiPlan(connector, remoteRepo);
  if (!plan) return { existed: null, created: false, detail: 'provider has no repo API' };

  const headers = {
    authorization: `token ${token}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'proxypilot',
  };
  const fetchJson = async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      return await fetch(url, { ...init, headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const head = await fetchJson(plan.getUrl, { method: 'GET' });
    if (head.ok) return { existed: true, created: false, detail: null };
    if (head.status !== 404) {
      return { existed: null, created: false, detail: `repo lookup returned ${head.status}` };
    }
  } catch (e) {
    return { existed: null, created: false, detail: `repo lookup failed: ${e?.message || e}` };
  }

  // 404 → create. Try the org endpoint first, then the authenticated user's;
  // we cannot tell which the owner is without another round trip, and guessing
  // wrong is a 404/403 rather than anything destructive.
  for (const url of [plan.createUrl, plan.createUrlUser]) {
    try {
      const res = await fetchJson(url, { method: 'POST', body: JSON.stringify(plan.createBody) });
      if (res.ok) return { existed: false, created: true, detail: `created ${remoteRepo} (private)` };
    } catch { /* try the next form */ }
  }
  return { existed: false, created: false, detail: 'repository does not exist and could not be created' };
}

/**
 * Build the host script that performs one publish.
 *
 * Exported and pure so its shell can be syntax-checked and its shape asserted
 * in tests — a quoting mistake in here would be a command-injection surface,
 * and it is not the kind of thing to find out about on a production host.
 *
 * The manifest is read from stdin, never interpolated, so no filename can
 * break out of the script. Every interpolated value goes through q().
 *
 * @param {object} opts
 * @param {string} opts.url          authenticated remote URL
 * @param {string} opts.branch       validated branch name
 * @param {string} opts.sourceDir    absolute host path to publish
 * @param {string} opts.subdir       validated repo-relative subdirectory ('' for root)
 * @param {string} opts.subject      commit subject
 * @param {string} opts.gitIdentity  `-c` flags pinning committer identity
 * @returns {string}
 */
export function buildPublishScript({ url, branch, sourceDir, subdir = '', subject, gitIdentity = GIT_IDENTITY }) {
  const targetExpr = subdir ? `"$W"/${subdir}` : '"$W"';
  const wipeExpr = subdir
    ? `find ${q(subdir)} -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} + 2>/dev/null || true`
    : `find . -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} + 2>/dev/null || true`;
  return [
    `set -e`,
    `M="$(mktemp -d)"`,
    `trap 'rm -rf "$M"' EXIT INT TERM`,
    `cat > "$M/manifest"`,
    `W="$M/work"`,
    `mkdir -p "$W"`,
    // Shallow, branch-scoped clone. A repo with no such branch (new or empty)
    // falls through to init — the only path that creates a root commit.
    `if git clone --depth 1 --branch ${q(branch)} ${q(url)} "$W" >/dev/null 2>&1; then`,
    `  MODE=clone`,
    `elif git clone --depth 1 ${q(url)} "$W" >/dev/null 2>&1; then`,
    `  (cd "$W" && git checkout -q -b ${q(branch)} 2>/dev/null) || true`,
    `  MODE=clone-newbranch`,
    `else`,
    `  rm -rf "$W"; mkdir -p "$W"`,
    `  (cd "$W" && git init -q -b ${q(branch)} .)`,
    `  MODE=init`,
    `fi`,
    // Pack exactly the planned files, so the exclude decision lives in one
    // place (the planner) rather than being re-derived here by shell globs
    // that could disagree with what was reported to the operator.
    `(cd ${q(sourceDir)} && tar --null -T "$M/manifest" -cf "$M/payload.tar")`,
    // Replace the published subtree wholesale so a delete in the source shows
    // up as a delete in the commit.
    `cd "$W"`,
    wipeExpr,
    `mkdir -p ${targetExpr}`,
    `tar -xf "$M/payload.tar" -C ${targetExpr}`,
    `cd "$W"`,
    `git ${gitIdentity} add -A`,
    `if git diff --cached --quiet; then echo "PROXYPILOT_NOCHANGE"; exit 0; fi`,
    `git ${gitIdentity} commit -q -m ${q(subject)}`,
    `git ${gitIdentity} push -q ${q(url)} HEAD:refs/heads/${branch} 2>&1`,
    `echo "PROXYPILOT_PUSHED $MODE $(git rev-parse --short HEAD)"`,
  ].join('\n');
}

/**
 * Publish a host directory to a git remote.
 *
 * @param {object} opts
 * @param {string} opts.sourceDir     absolute host path whose CONTENTS become the repo root
 * @param {object} opts.connector     row from mock2_git_connectors (provider, base_url)
 * @param {string} opts.token         decrypted credential
 * @param {string} opts.remoteRepo    owner/name or full https URL
 * @param {string} [opts.branch]      default 'main'
 * @param {string} [opts.subdir]      publish into this path inside the repo instead of its root
 * @param {string} [opts.message]     operator note, folded into the commit subject
 * @param {string} [opts.sourceLabel] human label for the commit subject
 * @param {string[]} [opts.extraExcludes]
 * @param {boolean} [opts.includeSecrets]
 * @param {boolean} [opts.dryRun]     plan and report, push nothing
 * @returns {Promise<object>} result with included/excluded file lists and the push outcome
 */
export async function publishDirToGit({
  sourceDir,
  connector,
  token,
  remoteRepo,
  branch = 'main',
  subdir = '',
  message = '',
  sourceLabel = 'files',
  extraExcludes = [],
  includeSecrets = false,
  dryRun = false,
}) {
  const repoErr = validateRemoteRepo(remoteRepo);
  if (repoErr) return { ok: false, error: repoErr };
  const branchErr = validateBranch(branch);
  if (branchErr) return { ok: false, error: branchErr };
  if (!sourceDir || !String(sourceDir).startsWith('/')) {
    return { ok: false, error: 'sourceDir must be an absolute path' };
  }
  const cleanSubdir = String(subdir || '').replace(/^\/+|\/+$/g, '');
  if (cleanSubdir && !/^[A-Za-z0-9._\/-]+$/.test(cleanSubdir)) {
    return { ok: false, error: `"${subdir}" is not a valid path inside the repository` };
  }
  if (cleanSubdir.includes('..')) {
    return { ok: false, error: 'The repository subdirectory may not contain ".."' };
  }

  // 1. Enumerate the source. NUL-delimited end to end: a filename containing a
  //    newline must not be able to split into two entries and smuggle an extra
  //    path into the manifest.
  const listed = await sh(
    `cd ${q(sourceDir)} 2>/dev/null && find . -type f -print0`,
    { timeoutMs: 60000 },
  );
  if (listed.code !== 0) {
    return { ok: false, error: `Could not read ${sourceDir}: ${(listed.stderr || '').trim() || `exit ${listed.code}`}` };
  }
  const allPaths = (listed.stdout || '')
    .split('\0')
    .map((p) => p.replace(/^\.\//, ''))
    .filter(Boolean);
  if (allPaths.length === 0) {
    return { ok: false, error: `${sourceDir} contains no files` };
  }

  const { included, excluded } = planPublish(allPaths, { extraExcludes, includeSecrets });
  if (included.length === 0) {
    return {
      ok: false,
      error: 'Every file in the source was held back by the exclude list — nothing to publish',
      excluded,
    };
  }

  const plan = {
    source: sourceDir,
    remote_repo: remoteRepo,
    branch,
    ...(cleanSubdir ? { subdirectory: cleanSubdir } : {}),
    file_count: included.length,
    files: included.slice(0, 200),
    ...(included.length > 200 ? { files_truncated: true } : {}),
    excluded,
    secrets_filter: includeSecrets ? 'DISABLED by caller' : 'default deny-list applied',
  };
  if (dryRun) return { ok: true, dry_run: true, ...plan };

  const url = buildAuthedRemoteUrl(connector, remoteRepo, token);
  if (!url) {
    return { ok: false, error: 'Could not build a push URL — the connector has no base URL and the repo is not a full URL' };
  }

  const repoState = await ensureRemoteRepo(connector, remoteRepo, token);

  // 2. Clone → replace → commit → push as ONE host script, so a failure can
  //    never leave a half-populated temp tree (or an authenticated remote in a
  //    clone's .git/config) behind: the trap removes everything on any exit.
  //
  //    The manifest arrives on stdin rather than being interpolated, so neither
  //    its size nor any character in a filename can break the script.
  const subject = commitSubject(sourceLabel, message);
  const script = buildPublishScript({
    url, branch, sourceDir, subdir: cleanSubdir, subject, gitIdentity: GIT_IDENTITY,
  });

  const run = await sh(script, { input: included.join('\0'), timeoutMs: 300000 });

  // The token appears in the remote URL, so anything git echoes back could
  // carry it. Redact before the output reaches a log, an API response, or an
  // agent's context.
  const out = `${run.stdout || ''}${run.stderr || ''}`.trim();
  const encoded = encodeURIComponent(token);
  const redacted = out
    .split(encoded).join('***')
    .split(token).join('***');

  if (run.code !== 0) {
    return { ok: false, error: `git publish failed: ${redacted.slice(-600) || `exit ${run.code}`}`, ...plan, repo: repoState };
  }
  if (redacted.includes('PROXYPILOT_NOCHANGE')) {
    return { ok: true, changed: false, message: 'Remote already matches the source — nothing to commit', ...plan, repo: repoState };
  }
  const m = /PROXYPILOT_PUSHED\s+(\S+)\s+(\S+)/.exec(redacted);
  return {
    ok: true,
    changed: true,
    mode: m ? m[1] : 'unknown',
    commit: m ? m[2] : null,
    ...plan,
    repo: repoState,
  };
}

/**
 * Copy a directory out of an LXC guest to a temporary host directory.
 *
 * The credential never enters the container: the guest only ever produces a
 * tar on stdout, and the git work happens host-side afterwards.
 *
 * Caller owns the returned path and must remove it — `publishLxcDir` in
 * routes does this in a finally.
 *
 * @param {string} incusName  full instance name (with the pp- prefix)
 * @param {string} guestPath  absolute path inside the guest
 * @returns {Promise<{ok: boolean, dir?: string, error?: string}>}
 */
export async function stageLxcDir(incusName, guestPath) {
  if (!guestPath || !String(guestPath).startsWith('/')) {
    return { ok: false, error: 'The container path must be absolute' };
  }
  if (String(guestPath).includes('..')) {
    return { ok: false, error: 'The container path may not contain ".."' };
  }
  const mk = await sh(`mktemp -d`, { timeoutMs: 15000 });
  if (mk.code !== 0) return { ok: false, error: 'Could not create a staging directory on the host' };
  const dir = (mk.stdout || '').trim();
  if (!dir.startsWith('/')) return { ok: false, error: 'Could not create a staging directory on the host' };

  // `incus exec` streams the tar; the pipe stays host-side.
  const r = await runHost(
    'sh',
    ['-c',
      `incus exec ${q(incusName)} -- tar -cf - -C ${q(guestPath)} . 2>/dev/null | tar -xf - -C ${q(dir)}`],
    { timeoutMs: 300000 },
  );
  if (r.code !== 0) {
    await sh(`rm -rf ${q(dir)}`, { timeoutMs: 15000 }).catch(() => {});
    return { ok: false, error: `Could not read ${guestPath} from the container: ${(r.stderr || '').trim() || `exit ${r.code}`}` };
  }
  return { ok: true, dir };
}

/** Remove a staging directory created by stageLxcDir. Best effort. */
export async function cleanupStagedDir(dir) {
  if (!dir || !dir.startsWith('/tmp')) return;
  await sh(`rm -rf ${q(dir)}`, { timeoutMs: 30000 }).catch(() => {});
}
