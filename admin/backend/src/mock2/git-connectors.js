// Mock2 git connectors — data access + orchestrator-side git ops (Phase M5,
// ADR-006). Git connectors are OPTIONAL external push targets; the local bare
// repo is always primary (ADR-006 / ADR-011). Credentials are encrypted at rest
// (lib/secrets) and NEVER enter a container — push runs orchestrator-side
// through the host pivot (host.js, risk R3). Tables: mock2_git_connectors +
// mock2_project_remotes (migration 503).
//
// Also home to the `git archive` zip export ("Export as zip" = git archive of
// the bare repo — same state model, no second code path, ADR-006).
//
// PURE bits (validation, test plan, publicShape) live in git-logic.js
// (unit-tested stub-first, risk R9).
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';
import { sh } from './host.js';
import { MOCK2_DATA_DIR } from './provision.js';
import {
  publicGitConnectorShape,
  publicProjectRemoteShape,
  publicTargetRemoteShape,
  gitTestPlan,
  interpretGitTestResponse,
  gitEnsureRepoPlan,
  buildTokenPushUrl,
  validateTargetRef,
  normalizePushMode,
  hostPathForDocroot,
  mirrorSnapshotScript,
  docrootExportCmd,
  lxcExportCmd,
  parseMirrorSnapshotOutput,
  shq,
} from './git-logic.js';
import { getDb } from '../db.js';
import { readContainerStartup } from '../lib/lxc-zip.js';

const nowIso = () => new Date().toISOString();

// ---- connectors ----

export function listGitConnectors() {
  return getMock2Db().prepare(`SELECT * FROM mock2_git_connectors ORDER BY name`).all();
}

export function getGitConnector(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_git_connectors WHERE id = ?`).get(Number(id));
}

export function getGitConnectorByName(name) {
  return getMock2Db().prepare(`SELECT * FROM mock2_git_connectors WHERE name = ?`).get(name);
}

export function isGitSecretDecryptable(row) {
  if (!row?.credential_enc) return false;
  try { decryptSecret(row.credential_enc); return true; } catch { return false; }
}

export function shapeGitConnector(row) {
  return publicGitConnectorShape(row, { secretDecryptable: isGitSecretDecryptable(row) });
}

function decryptGitCredential(row) {
  if (!row?.credential_enc) return null;
  try { return decryptSecret(row.credential_enc); } catch { return null; }
}

export function insertGitConnector({ name, provider, baseUrl, authKind, credential, createdBy = null }) {
  const info = getMock2Db()
    .prepare(
      `INSERT INTO mock2_git_connectors
         (name, provider, base_url, auth_kind, credential_enc, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, provider, baseUrl || null, authKind, encryptSecret(credential), createdBy, nowIso());
  return getGitConnector(info.lastInsertRowid);
}

export function updateGitConnector(id, fields = {}) {
  const sets = [];
  const vals = [];
  const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
  if (fields.name !== undefined) set('name', fields.name);
  if (fields.base_url !== undefined) set('base_url', fields.base_url || null);
  if (fields.auth_kind !== undefined) set('auth_kind', fields.auth_kind);
  if (fields.credential !== undefined && fields.credential) set('credential_enc', encryptSecret(fields.credential));
  if (fields.base_url !== undefined || (fields.credential !== undefined && fields.credential) || fields.auth_kind !== undefined) {
    set('test_status', null);
    set('test_at', null);
  }
  if (sets.length === 0) return getGitConnector(id);
  vals.push(Number(id));
  getMock2Db().prepare(`UPDATE mock2_git_connectors SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getGitConnector(id);
}

export function deleteGitConnector(id) {
  const db = getMock2Db();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM mock2_project_remotes WHERE git_connector_id = ?`).run(Number(id));
    db.prepare(`DELETE FROM mock2_git_connectors WHERE id = ?`).run(Number(id));
  });
  tx();
}

function recordGitTestVerdict(id, verdict) {
  getMock2Db()
    .prepare(`UPDATE mock2_git_connectors SET test_status = ?, test_at = ? WHERE id = ?`)
    .run(JSON.stringify(verdict), nowIso(), Number(id));
}

// Lightweight credential validation (orchestrator-side, ADR-006). Always
// resolves. ssh_key / generic_https connectors have no identity endpoint — the
// verdict says so rather than failing.
export async function testGitConnector(row) {
  const token = decryptGitCredential(row);
  const plan = gitTestPlan({ provider: row.provider, base_url: row.base_url, auth_kind: row.auth_kind, __token: token });
  if (!plan) {
    const verdict = { ok: null, detail: 'not API-testable — verify by pushing a project remote' };
    recordGitTestVerdict(row.id, verdict);
    return verdict;
  }
  const t0 = Date.now();
  let verdict;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(plan.url, { method: 'GET', headers: plan.headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    verdict = interpretGitTestResponse(res.status);
    verdict.latency_ms = Date.now() - t0;
  } catch (err) {
    verdict = { ok: false, detail: `unreachable: ${err?.message || String(err)}`, latency_ms: Date.now() - t0 };
  }
  recordGitTestVerdict(row.id, verdict);
  return verdict;
}

// ---- project remotes ----

export function getProjectRemote(projectId) {
  return getMock2Db().prepare(`SELECT * FROM mock2_project_remotes WHERE project_id = ?`).get(Number(projectId));
}

export function shapeProjectRemote(row) {
  return publicProjectRemoteShape(row);
}

export function setProjectRemote({ projectId, gitConnectorId, remoteRepo, pushOnCheckpoint = 0 }) {
  getMock2Db()
    .prepare(
      `INSERT INTO mock2_project_remotes (project_id, git_connector_id, remote_repo, push_on_checkpoint)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         git_connector_id = excluded.git_connector_id,
         remote_repo = excluded.remote_repo,
         push_on_checkpoint = excluded.push_on_checkpoint`,
    )
    .run(Number(projectId), Number(gitConnectorId), remoteRepo, pushOnCheckpoint ? 1 : 0);
  return getProjectRemote(projectId);
}

export function clearProjectRemote(projectId) {
  const r = getMock2Db().prepare(`DELETE FROM mock2_project_remotes WHERE project_id = ?`).run(Number(projectId));
  return { cleared: r.changes > 0 };
}

// ---- orchestrator-side push after checkpoint (ADR-006 / the M6 hook) ----
//
// If a project has a remote with push_on_checkpoint, the runner calls this after
// each checkpoint fetch to push the bare repo's main to the external remote.
// Credentials NEVER enter a container: the push runs host-side through the pivot
// (host.js), and the token/key is injected into the transport here. Records
// last_push_at / last_push_error on the mock2_project_remotes row. Always
// resolves — a push failure is a status column, never a cycle failure.
export async function pushProjectRemote(project) {
  const remote = getProjectRemote(project.id);
  if (!remote || !remote.push_on_checkpoint) return { ok: true, skipped: true };
  return pushProjectRemoteNow(project, remote);
}

// The manual "Push now" for a project: pushes whether or not push_on_checkpoint
// is set. Same transport, same status columns.
export async function pushProjectRemoteNow(project, remote = getProjectRemote(project.id)) {
  if (!remote) return { ok: false, error: 'no remote configured' };
  const conn = getGitConnector(remote.git_connector_id);
  if (!conn) return recordPush(project.id, { ok: false, error: 'git connector missing' });
  const repoPath = project.repo_path;
  if (!repoPath) return recordPush(project.id, { ok: false, error: 'project has no bare repo' });
  const r = await pushGitDir({ conn, gitDir: repoPath, remoteRepo: remote.remote_repo });
  return recordPush(project.id, r);
}

// Push a git-dir's HEAD to refs/heads/main on a connector's remote. Credentials
// NEVER enter a container: the push runs host-side through the pivot (host.js)
// and the token/key is injected into the transport for this one invocation.
// Shared by project remotes (the bare repo) and target remotes (the mirror).
export async function pushGitDir({ conn, gitDir, remoteRepo }) {
  const cred = decryptGitCredential(conn);
  if (!cred) return { ok: false, error: 'credential not decryptable' };
  const safeRepo = shq(gitDir);
  let result;
  if (conn.auth_kind === 'token') {
    const url = buildTokenPushUrl(conn, remoteRepo, cred);
    if (!url) return { ok: false, error: 'could not build push URL (a Gitea connector needs a base URL)' };
    result = await sh(`git --git-dir=${safeRepo} push ${shq(url)} HEAD:refs/heads/main 2>&1`, { timeoutMs: 120000 });
  } else {
    // ssh_key: write the key to a 0600 temp file and point GIT_SSH_COMMAND at
    // it for this push only, then remove it. remote_repo must be an ssh URL.
    const b64key = Buffer.from(cred, 'utf8').toString('base64');
    result = await sh(
      `KF="$(mktemp)"; printf '%s' '${b64key}' | base64 -d > "$KF"; chmod 600 "$KF"; ` +
      `GIT_SSH_COMMAND="ssh -i $KF -o StrictHostKeyChecking=accept-new" ` +
      `git --git-dir=${safeRepo} push ${shq(String(remoteRepo))} HEAD:refs/heads/main 2>&1; rc=$?; rm -f "$KF"; exit $rc`,
      { timeoutMs: 120000 },
    );
  }
  // Never let the token leak into a status column through git's own output.
  const scrub = (s) => String(s || '').replace(/https?:\/\/[^@\s/]+@/gi, 'https://***@');
  const out = scrub((result.stdout || result.stderr || '').trim()).slice(-400);
  if (result.code !== 0) return { ok: false, error: out || `git push exited ${result.code}` };
  return { ok: true };
}

// ---- make sure the remote repo exists (Gitea / GitHub, token connectors) ----
//
// "Submit to Gitea" should be one action: pick a connector, name the repo, push.
// This creates the repo when the lookup says it is not there — under the
// token's own user when the owner is that user, otherwise in the organisation.
// Returns { ok, created, url?, error? }. Providers without a standard API
// (generic_https, ssh) resolve { ok: true, skipped: true }: the push decides.
export async function ensureRemoteRepo(conn, remoteRepo, { isPrivate = true } = {}) {
  if (conn.auth_kind !== 'token') return { ok: true, skipped: true, reason: 'not a token connector' };
  const token = decryptGitCredential(conn);
  if (!token) return { ok: false, error: 'credential not decryptable' };
  const plan = gitEnsureRepoPlan(conn, remoteRepo, { token, isPrivate });
  if (!plan) {
    if (conn.provider === 'gitea' && !conn.base_url) return { ok: false, error: 'the Gitea connector has no base URL' };
    if (conn.provider === 'gitea' || conn.provider === 'github') return { ok: false, error: 'remote_repo must be owner/name (or a URL ending in owner/name)' };
    return { ok: true, skipped: true, reason: 'provider has no repo API' };
  }
  const call = async (req, method = 'GET') => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(req.url, { method, headers: req.headers, body: method === 'POST' ? req.body : undefined, signal: controller.signal });
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      return { status: res.status, json };
    } catch (err) {
      return { status: 0, json: null, error: err?.message || String(err) };
    } finally {
      clearTimeout(timer);
    }
  };
  const found = await call(plan.lookup);
  if (found.status === 200) return { ok: true, created: false, url: found.json?.html_url || null };
  if (found.status === 0) return { ok: false, error: `unreachable: ${found.error}` };
  if (found.status === 401 || found.status === 403) return { ok: false, error: `auth rejected (HTTP ${found.status})` };
  if (found.status !== 404) return { ok: false, error: `lookup failed (HTTP ${found.status})` };

  // Not there. Whose repo is it — the token user's or an organisation's?
  let ownerIsUser = plan.ownerIsUser;
  if (ownerIsUser == null) {
    const me = await call(plan.whoami);
    const login = me.json?.login || me.json?.username || null;
    ownerIsUser = login ? String(login).toLowerCase() === plan.ref.owner.toLowerCase() : null;
  }
  const attempts = ownerIsUser === false
    ? [plan.createInOrg]
    : ownerIsUser === true ? [plan.createAsUser] : [plan.createInOrg, plan.createAsUser];
  let last = null;
  for (const req of attempts) {
    const r = await call(req, 'POST');
    if (r.status === 201 || r.status === 200) return { ok: true, created: true, url: r.json?.html_url || null };
    last = r;
    if (r.status === 0) return { ok: false, error: `unreachable: ${r.error}` };
    if (r.status === 401) return { ok: false, error: 'auth rejected (HTTP 401)' };
  }
  const detail = last?.json?.message || last?.json?.error || (last ? `HTTP ${last.status}` : 'unknown');
  return { ok: false, error: `could not create ${plan.ref.owner}/${plan.ref.name}: ${detail}` };
}

function recordPush(projectId, { ok, error = null }) {
  try {
    getMock2Db()
      .prepare(`UPDATE mock2_project_remotes SET last_push_at = ?, last_push_error = ? WHERE project_id = ?`)
      .run(ok ? nowIso() : null, ok ? null : error, Number(projectId));
  } catch { /* best effort */ }
  return { ok, error };
}

// ---- zip export (git archive of the bare repo, ADR-006) ----
//
// "Export as zip" is `git archive` of the project's bare repo — same state model
// as everything else, no second code path. Runs on the host through the pivot
// (risk R3). base64-wrapped so the binary zip survives the string-capturing
// runner; the route decodes to a Buffer. Returns { ok, buffer, error }.
export async function exportProjectZip(repoPath, ref = 'HEAD') {
  if (!repoPath) return { ok: false, error: 'project has no repo path' };
  // --git-dir points at the bare repo; single-quote-escape the path.
  const safeRepo = String(repoPath).replace(/'/g, `'\\''`);
  const safeRef = /^[\w./-]+$/.test(ref) ? ref : 'HEAD';
  const r = await sh(
    `git --git-dir='${safeRepo}' archive --format=zip ${safeRef} 2>/dev/null | base64 -w0`,
    { timeoutMs: 60000 },
  );
  const b64 = (r.stdout || '').trim();
  if (r.code !== 0 || !b64) {
    return { ok: false, error: (r.stderr || 'git archive produced no output — is the bare repo seeded?').trim().slice(-300) };
  }
  try {
    return { ok: true, buffer: Buffer.from(b64, 'base64') };
  } catch (err) {
    return { ok: false, error: `decode failed: ${err?.message}` };
  }
}

// ---- git repository export (git bundle of the bare repo — FULL history) ----
//
// Unlike the zip (a `git archive` of the working tree at HEAD, which drops all
// history), this exports the whole repository as a single-file `git bundle` with
// every ref and every commit — the checkpoints, the mirrored change records, the
// hash-chained history. `git clone <file>.bundle` reconstructs a working repo, so
// it is the portable, verifiable "download the git" artifact. Same host pivot +
// base64 wrapping as the zip export (risk R3). Returns { ok, buffer, error }.
export async function exportProjectRepoBundle(repoPath) {
  if (!repoPath) return { ok: false, error: 'project has no repo path' };
  const safeRepo = String(repoPath).replace(/'/g, `'\\''`);
  // `bundle create -` streams the bundle to stdout; --all bundles every ref.
  const r = await sh(
    `git --git-dir='${safeRepo}' bundle create - --all 2>/dev/null | base64 -w0`,
    { timeoutMs: 120000 },
  );
  const b64 = (r.stdout || '').trim();
  if (r.code !== 0 || !b64) {
    return { ok: false, error: (r.stderr || 'git bundle produced no output — is the bare repo seeded with at least one commit?').trim().slice(-300) };
  }
  try {
    return { ok: true, buffer: Buffer.from(b64, 'base64') };
  } catch (err) {
    return { ok: false, error: `decode failed: ${err?.message}` };
  }
}

// ---- target remotes: static sites + LXC containers (migration 558) ----
//
// The content itself is not a git repo (a served docroot, a guest's app dir),
// so a host-side MIRROR repo under MOCK2_DATA_DIR/git-mirrors snapshots it on
// each push: export → commit into the mirror → push the mirror. Nothing
// git-related is written into the docroot or the guest, and the credential
// stays host-side exactly as for project remotes.

export const GIT_MIRRORS_DIR = `${MOCK2_DATA_DIR}/git-mirrors`;

export function mirrorGitDirFor(kind, targetId) {
  return `${GIT_MIRRORS_DIR}/${kind}/${String(targetId).replace(/[^A-Za-z0-9_.-]/g, '_')}.git`;
}

export function getTargetRemote(kind, targetId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_target_remotes WHERE kind = ? AND target_id = ?`)
    .get(String(kind), String(targetId));
}

export function listTargetRemotes(kind = null) {
  const db = getMock2Db();
  return kind
    ? db.prepare(`SELECT * FROM mock2_target_remotes WHERE kind = ? ORDER BY target_id`).all(String(kind))
    : db.prepare(`SELECT * FROM mock2_target_remotes ORDER BY kind, target_id`).all();
}

export function shapeTargetRemote(row) {
  return publicTargetRemoteShape(row);
}

export function setTargetRemote({ kind, targetId, gitConnectorId, remoteRepo, pushMode = 'manual', sourceDir = null, createdBy = null }) {
  const bad = validateTargetRef(kind, targetId);
  if (bad) throw new Error(bad);
  getMock2Db()
    .prepare(
      `INSERT INTO mock2_target_remotes (kind, target_id, git_connector_id, remote_repo, push_mode, source_dir, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, target_id) DO UPDATE SET
         git_connector_id = excluded.git_connector_id,
         remote_repo = excluded.remote_repo,
         push_mode = excluded.push_mode,
         source_dir = excluded.source_dir`,
    )
    .run(String(kind), String(targetId), Number(gitConnectorId), String(remoteRepo), normalizePushMode(pushMode), sourceDir || null, createdBy, nowIso());
  return getTargetRemote(kind, targetId);
}

export function clearTargetRemote(kind, targetId) {
  const r = getMock2Db().prepare(`DELETE FROM mock2_target_remotes WHERE kind = ? AND target_id = ?`).run(String(kind), String(targetId));
  return { cleared: r.changes > 0 };
}

function recordTargetPush(kind, targetId, { ok, error = null, commit = null, unchanged = false }) {
  try {
    getMock2Db()
      .prepare(`UPDATE mock2_target_remotes SET last_push_at = ?, last_push_error = ?, last_pushed_commit = COALESCE(?, last_pushed_commit) WHERE kind = ? AND target_id = ?`)
      .run(ok ? nowIso() : null, ok ? null : error, ok ? commit : null, String(kind), String(targetId));
  } catch { /* best effort */ }
  return { ok, error, commit, unchanged };
}

// Resolve what a target remote exports: the host path of a docroot, or the
// incus name + directory inside a guest. { error } when the target is gone or
// has nothing to mirror yet.
export async function resolveTargetSource(remote, { env = process.env } = {}) {
  if (remote.kind === 'static_site') {
    const site = getDb().prepare(`SELECT id, name, data_dir, root_dir FROM services WHERE id = ? AND type = 'static'`).get(String(remote.target_id));
    if (!site) return { error: 'static site not found' };
    const dataDir = site.data_dir || site.root_dir;
    if (!dataDir) return { error: 'static site has no docroot' };
    const hostDir = hostPathForDocroot(dataDir, {
      servicesDataDir: env.SERVICES_DATA_DIR || '/data/services',
      caddyStaticRoot: env.CADDY_STATIC_ROOT || null,
    });
    return { label: site.name, exportCmd: docrootExportCmd(hostDir), describe: hostDir };
  }
  if (remote.kind === 'lxc') {
    const incusName = `${env.LXC_PREFIX ?? 'pp-'}${remote.target_id}`;
    let dir = remote.source_dir || null;
    if (!dir) {
      const startup = await readContainerStartup(incusName).catch(() => null);
      dir = startup?.workingDir || null;
    }
    if (!dir) return { error: 'no source directory: set source_dir on the remote or register a startup script' };
    return { label: remote.target_id, exportCmd: lxcExportCmd(incusName, dir), describe: `${incusName}:${dir}` };
  }
  return { error: `unknown kind ${remote.kind}` };
}

// Snapshot + push one target remote. Always resolves; the outcome lands in the
// row's last_push_* columns. `reason` becomes part of the commit message so the
// remote's history says what ProxyPilot did ("zip applied", "file saved", …).
export async function pushTargetRemote(kind, targetId, { reason = 'manual push', actor = null } = {}) {
  const remote = getTargetRemote(kind, targetId);
  if (!remote) return { ok: false, error: 'no remote configured' };
  const conn = getGitConnector(remote.git_connector_id);
  if (!conn) return recordTargetPush(kind, targetId, { ok: false, error: 'git connector missing' });
  const src = await resolveTargetSource(remote);
  if (src.error) return recordTargetPush(kind, targetId, { ok: false, error: src.error });

  const gitDir = mirrorGitDirFor(kind, targetId);
  const who = actor ? ` by ${String(actor).slice(0, 60)}` : '';
  const message = `ProxyPilot: ${reason}${who} (${kind} ${remote.target_id}, ${new Date().toISOString()})`;
  const snap = await sh(mirrorSnapshotScript({ gitDir, exportCmd: src.exportCmd, message }), { timeoutMs: 10 * 60 * 1000 });
  const parsed = parseMirrorSnapshotOutput(snap.stdout);
  if (snap.code !== 0 || !parsed) {
    const out = ((snap.stderr || '') + '\n' + (snap.stdout || '')).trim().slice(-400);
    return recordTargetPush(kind, targetId, { ok: false, error: `snapshot failed: ${out || `exit ${snap.code}`}` });
  }
  if (!parsed.changed && remote.last_pushed_commit === parsed.commit && !remote.last_push_error) {
    // Nothing new since the last successful push — say so, do not spam the remote.
    return recordTargetPush(kind, targetId, { ok: true, commit: parsed.commit, unchanged: true });
  }
  const pushed = await pushGitDir({ conn, gitDir, remoteRepo: remote.remote_repo });
  if (!pushed.ok) return recordTargetPush(kind, targetId, { ok: false, error: pushed.error });
  return recordTargetPush(kind, targetId, { ok: true, commit: parsed.commit });
}

