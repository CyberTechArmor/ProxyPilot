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
import {
  publicGitConnectorShape,
  publicProjectRemoteShape,
  gitTestPlan,
  interpretGitTestResponse,
} from './git-logic.js';

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
  const conn = getGitConnector(remote.git_connector_id);
  if (!conn) return recordPush(project.id, { ok: false, error: 'git connector missing' });
  const repoPath = project.repo_path;
  if (!repoPath) return recordPush(project.id, { ok: false, error: 'project has no bare repo' });
  const cred = decryptGitCredential(conn);
  if (!cred) return recordPush(project.id, { ok: false, error: 'credential not decryptable' });

  const safeRepo = String(repoPath).replace(/'/g, `'\\''`);
  let result;
  if (conn.auth_kind === 'token') {
    // Token over HTTPS: build an authenticated URL for this one push (never
    // written to the repo config). Host derives from the connector base_url or
    // provider default; remote_repo is 'org/name' or a full URL.
    const url = buildTokenPushUrl(conn, remote.remote_repo, cred);
    if (!url) return recordPush(project.id, { ok: false, error: 'could not build push URL' });
    const safeUrl = url.replace(/'/g, `'\\''`);
    result = await sh(`git --git-dir='${safeRepo}' push '${safeUrl}' HEAD:refs/heads/main 2>&1`, { timeoutMs: 120000 });
  } else {
    // ssh_key: write the key to a 0600 temp file and point GIT_SSH_COMMAND at
    // it for this push only, then remove it. remote_repo must be an ssh URL.
    const b64key = Buffer.from(cred, 'utf8').toString('base64');
    const safeRemote = String(remote.remote_repo).replace(/'/g, `'\\''`);
    result = await sh(
      `KF="$(mktemp)"; printf '%s' '${b64key}' | base64 -d > "$KF"; chmod 600 "$KF"; ` +
      `GIT_SSH_COMMAND="ssh -i $KF -o StrictHostKeyChecking=accept-new" ` +
      `git --git-dir='${safeRepo}' push '${safeRemote}' HEAD:refs/heads/main 2>&1; rc=$?; rm -f "$KF"; exit $rc`,
      { timeoutMs: 120000 },
    );
  }
  const out = (result.stdout || result.stderr || '').trim().slice(-400);
  if (result.code !== 0) return recordPush(project.id, { ok: false, error: out || `git push exited ${result.code}` });
  return recordPush(project.id, { ok: true });
}

// Build an authenticated HTTPS push URL from a token connector. Never persisted.
function buildTokenPushUrl(conn, remoteRepo, token) {
  const repo = String(remoteRepo || '').trim();
  const m = /^(https?:\/\/)(.+)$/i.exec(repo);
  if (m) {
    // Full URL given — inject the token after the scheme, dropping any existing
    // userinfo so we don't double it.
    const rest = m[2].replace(/^[^@/]*@/, '');
    return `${m[1]}${encodeURIComponent(token)}@${rest}`;
  }
  // 'org/name' — resolve the host from base_url or the provider default.
  let host = null;
  if (conn.base_url) {
    const m = /^https?:\/\/([^/]+)/i.exec(conn.base_url);
    if (m) host = m[1];
  }
  if (!host) host = conn.provider === 'gitea' ? null : 'github.com';
  if (!host) return null;
  const path = repo.replace(/^\/+/, '').replace(/\.git$/, '');
  return `https://${encodeURIComponent(token)}@${host}/${path}.git`;
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
