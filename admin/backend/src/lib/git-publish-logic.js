// Pure planning logic for publishing a directory of files to an external git
// remote (Gitea, GitHub, or any HTTPS git host ProxyPilot has a connector for).
//
// The side-effecting half lives in lib/git-publish.js. Everything decidable
// without touching a disk, a container, or the network lives here so it can be
// unit-tested stub-first — the pattern the rest of the backend follows, and the
// only pattern that works in a sandbox where better-sqlite3 is absent.
//
// The important logic here is the exclude list. Publishing an application
// directory to a git host is a bulk egress of whatever happens to be on disk,
// and application directories routinely hold deployment secrets: a .env beside
// the compose file, a private key a build wrote, a database dropped in the
// working directory. Sending those to a remote — even a self-hosted one — is a
// credential disclosure that is very hard to walk back, because git keeps
// history and the push may be mirrored or cloned before anyone notices.
//
// So the exclusion is deny-by-pattern and ON by default, and every skipped
// path is reported back to the caller by name. A quiet exclusion would be its
// own hazard: an operator who believes a file shipped, and one who believes it
// did not, both need to be right.

// Patterns excluded from every publish unless the caller explicitly opts out.
// Ordered roughly by how badly you would want it back.
export const DEFAULT_EXCLUDES = Object.freeze([
  // Credentials and key material.
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.keystore',
  'id_rsa*',
  'id_ed25519*',
  '.ssh/**',
  '.aws/**',
  '.netrc',
  '.npmrc',
  '.pgpass',
  'credentials.json',
  'service-account*.json',
  // Local state that should never be a repo's contents.
  '.git/**',
  'node_modules/**',
  '__pycache__/**',
  '*.sqlite',
  '*.sqlite3',
  '*.db-wal',
  '*.db-shm',
  // Noise.
  '.DS_Store',
  'Thumbs.db',
]);

// Patterns that look like secrets but are conventionally safe to publish —
// they are templates, not the real thing. Checked before the deny list so a
// project's .env.example still ships.
export const EXCLUDE_ALLOWLIST = Object.freeze([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
]);

/**
 * Translate one glob-ish pattern into a RegExp.
 *
 * Supports the subset that matters here: `*` (no separator), `**` (any depth),
 * `?`, and a trailing `/**` meaning "this directory and everything under it".
 * Everything else is escaped literally — this is a safety filter, so an
 * unrecognised metacharacter must narrow the match, never widen it.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function patternToRegExp(pattern) {
  const p = String(pattern);
  let out = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**` spans separators. A following `/` is folded in so `.ssh/**`
        // matches `.ssh/known_hosts` and `dir/**` matches `dir/a/b`.
        i += 1;
        if (p[i + 1] === '/') i += 1;
        out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Should this path be excluded from the publish?
 *
 * Matching is applied to the full relative path AND to each path segment, so
 * `.env` catches `config/.env` and `node_modules/**` catches a nested one — a
 * pattern list that only matched at the root would miss the common cases.
 *
 * @param {string} relPath   path relative to the publish root, `/`-separated
 * @param {string[]} [patterns]
 * @returns {boolean}
 */
export function isExcluded(relPath, patterns = DEFAULT_EXCLUDES) {
  const rel = String(relPath || '').replace(/^\.?\//, '');
  if (!rel) return false;
  const segments = rel.split('/');
  const base = segments[segments.length - 1];

  // Templates win over the deny list.
  for (const ok of EXCLUDE_ALLOWLIST) {
    if (base === ok) return false;
  }

  for (const pattern of patterns) {
    const re = patternToRegExp(pattern);
    if (re.test(rel) || re.test(base)) return true;
    // A directory pattern (`x/**`) must also exclude everything beneath a
    // matching segment anywhere in the path.
    if (pattern.endsWith('/**')) {
      const dir = pattern.slice(0, -3);
      if (segments.slice(0, -1).some((s) => patternToRegExp(dir).test(s))) return true;
    }
  }
  return false;
}

/**
 * Split a file list into what will be published and what will be held back.
 *
 * @param {string[]} paths      relative paths
 * @param {object} [opts]
 * @param {string[]} [opts.extraExcludes]  caller-supplied patterns, added to the defaults
 * @param {boolean} [opts.includeSecrets]  bypass the deny list entirely (explicit opt-out)
 * @returns {{included: string[], excluded: Array<{path: string, reason: string}>}}
 */
export function planPublish(paths, { extraExcludes = [], includeSecrets = false } = {}) {
  const included = [];
  const excluded = [];
  const patterns = includeSecrets ? extraExcludes : [...DEFAULT_EXCLUDES, ...extraExcludes];
  for (const p of paths || []) {
    const rel = String(p || '').replace(/^\.?\//, '');
    if (!rel) continue;
    if (patterns.length && isExcluded(rel, patterns)) {
      excluded.push({ path: rel, reason: includeSecrets ? 'caller exclude' : 'excluded by default (possible secret or local state)' });
    } else {
      included.push(rel);
    }
  }
  return { included, excluded };
}

/**
 * Validate a `owner/name` repo reference or a full HTTPS URL.
 *
 * Returns null when valid, else a human-readable reason. Deliberately strict:
 * this string is interpolated into a git remote URL, so anything that could
 * change the host it resolves to has to be rejected here.
 *
 * @param {string} repo
 * @returns {string|null}
 */
export function validateRemoteRepo(repo) {
  const r = String(repo || '').trim();
  if (!r) return 'A remote repository is required (owner/name, or a full https:// URL)';
  if (/^https?:\/\//i.test(r)) {
    let u;
    try { u = new URL(r); } catch { return `"${repo}" is not a valid URL`; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Only http(s) remotes are supported here';
    if (!u.hostname) return 'The remote URL has no host';
    return null;
  }
  // owner/name — exactly two non-empty segments of safe characters.
  if (r.includes('..') || r.includes('//')) return `"${repo}" is not a valid owner/name reference`;
  const parts = r.replace(/\.git$/, '').split('/');
  if (parts.length !== 2) return `"${repo}" must be owner/name (or a full https:// URL)`;
  for (const part of parts) {
    if (!/^[A-Za-z0-9._-]+$/.test(part)) return `"${repo}" contains characters that are not valid in a repository path`;
    if (part.startsWith('.')) return `"${repo}" has a path segment starting with a dot`;
  }
  return null;
}

/**
 * Validate a git branch name for the subset we accept.
 *
 * @param {string} branch
 * @returns {string|null} null when valid, else a reason
 */
export function validateBranch(branch) {
  const b = String(branch || '').trim();
  if (!b) return 'A branch name is required';
  if (b.length > 200) return 'Branch name is too long';
  if (!/^[A-Za-z0-9._\/-]+$/.test(b)) return `"${branch}" contains characters that are not valid in a branch name`;
  if (b.startsWith('/') || b.endsWith('/') || b.includes('//')) return `"${branch}" is not a well-formed branch name`;
  if (b.includes('..') || b.startsWith('-') || b.endsWith('.lock')) return `"${branch}" is not a well-formed branch name`;
  return null;
}

/**
 * Build the Gitea API URL for "does this repo exist / create it".
 *
 * Only Gitea and GitHub expose a create-repo endpoint we use; anything else
 * returns null and the publish requires the repo to exist already.
 *
 * @param {{provider: string, base_url: string|null}} connector
 * @param {string} repo   owner/name
 * @returns {{getUrl: string, createUrl: string, createBody: object, ownerIsUser: boolean}|null}
 */
export function repoApiPlan(connector, repo) {
  const parts = String(repo || '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  let apiBase = null;
  if (connector.provider === 'gitea') {
    const b = String(connector.base_url || '').replace(/\/+$/, '');
    if (!b) return null;
    apiBase = `${b}/api/v1`;
  } else if (connector.provider === 'github') {
    apiBase = 'https://api.github.com';
  } else {
    return null;
  }
  return {
    getUrl: `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    // Creating under an org and under the authenticated user are different
    // endpoints; the caller tries the org form first and falls back, because
    // we cannot know which the owner is without another round trip.
    createUrl: `${apiBase}/orgs/${encodeURIComponent(owner)}/repos`,
    createUrlUser: `${apiBase}/user/repos`,
    createBody: { name, private: true, auto_init: false },
    ownerIsUser: false,
  };
}

/**
 * A one-line commit subject for a publish, capped and newline-free so it
 * cannot inject extra commit-message structure.
 *
 * @param {string} source   e.g. 'static site "docs"' or 'LXC mock2:/srv/app'
 * @param {string} [note]   operator-supplied note
 * @returns {string}
 */
export function commitSubject(source, note = '') {
  const clean = String(note || '').replace(/[\r\n]+/g, ' ').trim();
  const base = `Publish ${source} from ProxyPilot`;
  if (!clean) return base.slice(0, 200);
  return `${base}: ${clean}`.slice(0, 200);
}
