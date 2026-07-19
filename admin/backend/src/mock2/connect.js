// Mock2 QUICK CONNECT host half — VS Code / git access to a project repo over
// smart HTTP (pure decisions in connect-logic.js).
//
// createMock2GitRouter() is mounted at /api/mock2/git OUTSIDE the dashboard's
// cookie-session middleware: git clients authenticate with a per-user connect
// token over HTTP Basic (no cookies → no CSRF surface; the path is exempted
// in middleware/csrf.js). The router speaks git's stateless smart-HTTP
// protocol by spawning `git upload-pack/receive-pack --stateless-rpc` against
// the project's bare repo (ADR-006 — the same repo the container's working
// tree pushes its checkpoints to).
//
// After a successful PUSH the bare repo is ahead of the container's working
// tree, which would make the next in-container checkpoint push non-fast-
// forward — so handleExternalPush() syncs the tree (ff-only, under the
// checkout lock), records a hash-chained change record + a chat message
// (the durable "what changed and who did it" trail), and redeploys so the
// pushed code goes live. If a build holds the lock, the commits are safe in
// the repo and the chat says how they land.
//
// Terminology (risk R7): nothing here is named "agent".

import { Router } from 'express';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { getMock2Db } from './db.js';
import { getProject, getMembership, isUserSuperadmin, lookupUser } from './projects.js';
import { resolveMock2Access } from './project-logic.js';
import { getOrCreateChat, insertMessage } from './chats.js';
import { insertChangeRecord } from './change-records.js';
import { getCurrentFrameworkVersion } from './framework.js';
import { acquireLock, releaseLock } from './locks.js';
import { deployProject } from './deploy.js';
import { sh } from './host.js';
import { containerSh } from './runner.js';
import { repoPathForProject } from './provision.js';
import { DEFAULT_WEB_PORT } from './template.js';
import {
  newConnectToken, sha256hex, parseBasicAuth, isTokenExpired, shapeConnectToken,
  gitServiceFor, pktLine, summarizePush, CONNECT_TOKEN_TTL_DAYS,
} from './connect-logic.js';

const nowIso = () => new Date().toISOString();
const APP_DIR = '/srv/app';

// ---- token store (mock2_connect_tokens, migration 535) ----

export function mintConnectToken({ projectId, userId, label = null, ttlDays = CONNECT_TOKEN_TTL_DAYS }) {
  const token = newConnectToken();
  const db = getMock2Db();
  const createdAt = nowIso();
  const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 86400000).toISOString() : null;
  const info = db.prepare(`
    INSERT INTO mock2_connect_tokens (project_id, user_id, token_hash, label, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(Number(projectId), String(userId), sha256hex(token), label, createdAt, expiresAt);
  const row = db.prepare(`SELECT * FROM mock2_connect_tokens WHERE id = ?`).get(info.lastInsertRowid);
  return { token, row };
}

export function listConnectTokens(projectId, { userId = null } = {}) {
  const db = getMock2Db();
  const rows = userId
    ? db.prepare(`SELECT * FROM mock2_connect_tokens WHERE project_id = ? AND user_id = ? ORDER BY id DESC`).all(Number(projectId), String(userId))
    : db.prepare(`SELECT * FROM mock2_connect_tokens WHERE project_id = ? ORDER BY id DESC`).all(Number(projectId));
  return rows;
}

export function getConnectToken(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_connect_tokens WHERE id = ?`).get(Number(id));
}

export function revokeConnectToken(id) {
  getMock2Db().prepare(`UPDATE mock2_connect_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(nowIso(), Number(id));
  return getConnectToken(id);
}

function findLiveToken(plaintext) {
  if (!plaintext) return null;
  const row = getMock2Db().prepare(`SELECT * FROM mock2_connect_tokens WHERE token_hash = ?`).get(sha256hex(plaintext));
  if (!row || isTokenExpired(row, Date.now())) return null;
  return row;
}

function touchToken(row) {
  try {
    getMock2Db().prepare(`UPDATE mock2_connect_tokens SET last_used_at = ? WHERE id = ?`).run(nowIso(), row.id);
  } catch { /* cosmetic */ }
}

// ---- git smart-HTTP auth ----

// Authenticate a git request: Basic password = connect token; the token pins
// BOTH the user and the project (a token for project A opens nothing on B).
// Role comes from the same ladder the dashboard uses (resolveMock2Access).
function authGitRequest(req, projectId, requiredRole) {
  const creds = parseBasicAuth(req.headers.authorization);
  if (!creds || !creds.password) return { ok: false, code: 401 };
  const tokenRow = findLiveToken(creds.password);
  if (!tokenRow || Number(tokenRow.project_id) !== Number(projectId)) return { ok: false, code: 401 };
  const user = lookupUser(tokenRow.user_id);
  if (!user) return { ok: false, code: 401 };
  const project = getProject(Number(projectId));
  if (!project) return { ok: false, code: 404 };
  const membership = getMembership(project.id, user.id) || null;
  const access = resolveMock2Access({
    user, membership, requiredRole,
    isSuperadmin: user.role === 'admin' ? true : isUserSuperadmin(user.id),
  });
  if (!access.allowed) return { ok: false, code: 403 };
  touchToken(tokenRow);
  return { ok: true, user, project, access };
}

function unauthorized(res, code) {
  if (code === 401) res.setHeader('WWW-Authenticate', 'Basic realm="ProxyPilot project git"');
  res.status(code).end();
}

function repoPathOf(project) {
  return project.repo_path || repoPathForProject(project.id);
}

// The request body stream, transparently gunzipped when the client compressed
// it (git does for large packs).
function bodyStream(req) {
  if (String(req.headers['content-encoding'] || '').includes('gzip')) {
    const gz = zlib.createGunzip();
    req.pipe(gz);
    return gz;
  }
  return req;
}

// ---- the router ----

export function createMock2GitRouter() {
  const router = Router();

  // GET /:id/info/refs?service=git-upload-pack|git-receive-pack — the smart
  // handshake: advertisement header + `--advertise-refs` output.
  router.get('/:id/info/refs', (req, res) => {
    const svc = gitServiceFor(String(req.query.service || ''));
    if (!svc) return res.status(400).send('smart HTTP only (dumb protocol is not served)');
    const auth = authGitRequest(req, req.params.id, svc.requiredRole);
    if (!auth.ok) return unauthorized(res, auth.code);
    res.setHeader('Content-Type', `application/x-${svc.service}-advertisement`);
    res.setHeader('Cache-Control', 'no-cache');
    res.write(pktLine(`# service=${svc.service}\n`));
    res.write('0000');
    const child = spawn('git', [svc.service.replace('git-', ''), '--stateless-rpc', '--advertise-refs', repoPathOf(auth.project)]);
    child.stdout.pipe(res);
    child.on('error', () => res.end());
    child.on('close', () => res.end());
  });

  // POST /:id/git-upload-pack — fetch/clone data transfer (viewer+).
  // POST /:id/git-receive-pack — push (editor+), with post-push handling.
  for (const svcName of ['git-upload-pack', 'git-receive-pack']) {
    router.post(`/:id/${svcName}`, async (req, res) => {
      const svc = gitServiceFor(svcName);
      const auth = authGitRequest(req, req.params.id, svc.requiredRole);
      if (!auth.ok) return unauthorized(res, auth.code);
      const repo = repoPathOf(auth.project);
      const isPush = svcName === 'git-receive-pack';

      // HEAD before the push so the recorded summary covers exactly this push.
      let oldHead = null;
      if (isPush) {
        const h = await sh(`git -C ${repo} rev-parse HEAD 2>/dev/null`).catch(() => null);
        oldHead = h && h.code === 0 ? (h.stdout || '').trim() : null;
      }

      res.setHeader('Content-Type', `application/x-${svcName}-result`);
      res.setHeader('Cache-Control', 'no-cache');
      const child = spawn('git', [svcName.replace('git-', ''), '--stateless-rpc', repo]);
      bodyStream(req).pipe(child.stdin);
      child.stdout.pipe(res);
      child.on('error', () => res.end());
      child.on('close', (code) => {
        res.end();
        if (isPush && code === 0) {
          handleExternalPush({ project: auth.project, user: auth.user, oldHead })
            .catch((e) => console.warn('[mock2] external push handling failed:', e?.message));
        }
      });
    });
  }

  return router;
}

// ---- post-push: record + sync + redeploy ----

async function handleExternalPush({ project, user, oldHead }) {
  const projectId = Number(project.id);
  const repo = repoPathOf(project);
  const h = await sh(`git -C ${repo} rev-parse HEAD 2>/dev/null`).catch(() => null);
  const newHead = h && h.code === 0 ? (h.stdout || '').trim() : null;
  if (!newHead || newHead === oldHead) return; // nothing landed (e.g. up-to-date push)

  const range = oldHead ? `${oldHead}..${newHead}` : newHead;
  const log = await sh(`git -C ${repo} log --oneline --no-decorate ${range} 2>/dev/null | head -20`).catch(() => null);
  const summary = summarizePush(log?.stdout);
  const who = user.username || user.email || user.id;

  getOrCreateChat(projectId);
  const say = (body) => {
    try { insertMessage({ projectId, kind: 'system', body }); } catch { /* best effort */ }
  };
  say(`External push (VS Code / git) by ${who}: ${summary}`);

  // The durable, hash-chained record — same trail the builds write, so the
  // change history shows human pushes right between build checkpoints.
  try {
    const framework = getCurrentFrameworkVersion();
    insertChangeRecord({
      projectId, cycleId: null, initiatedBy: user.id,
      frameworkVersion: framework?.version ?? 0, frameworkVersionId: framework?.id ?? null,
      commitSha: newHead, summary: `External push (VS Code / git) by ${who}: ${summary}`,
    });
  } catch (e) { console.warn('[mock2] external push change record failed:', e?.message); }

  if (project.lifecycle !== 'active' || !project.container_name) {
    say('The project container is not running — the pushed commits are safe in the repository and the working tree syncs when the project comes back online (wake it, then Redeploy app).');
    return;
  }

  // Sync the container working tree (it must not fall behind the bare repo, or
  // the next build's checkpoint push is rejected). Serialized with builds/asks
  // via the checkout lock — if one is running, the sync waits for a later trigger.
  const lock = acquireLock({ projectId, requester: { type: 'user', id: user.id }, role: 'editor' });
  if (!lock.ok) {
    say('A build or ask is running — the pushed commits are recorded in the repository and will be synced into the working tree afterwards (press "Redeploy app" in the Build panel, or run any Quick update).');
    return;
  }
  try {
    const sync = await containerSh(
      project.container_name,
      `git -C ${APP_DIR} fetch origin >/dev/null 2>&1 && git -C ${APP_DIR} merge --ff-only FETCH_HEAD 2>&1`,
      { timeoutMs: 120000 },
    );
    if (sync.code !== 0) {
      say(`Pushed commits could not be fast-forwarded into the working tree (it has diverged): ${(sync.stdout || sync.stderr || '').trim().slice(-300)}. Run a build to reconcile, or resolve in VS Code and push again.`);
      return;
    }
  } finally {
    try { releaseLock(projectId, { type: 'user', id: user.id }); } catch { /* sweep reclaims */ }
  }

  // Deploy so the pushed code actually serves (queued per container, same
  // pipeline as builds: install → migrate → build → start → health).
  say('Working tree synced — deploying the pushed changes…');
  try {
    const result = await deployProject({
      containerName: project.container_name, appDir: APP_DIR,
      webPort: project.web_port || DEFAULT_WEB_PORT,
    });
    if (result.ok) say('Deployed — the pushed changes are live on the project URL.');
    else say(`Deploy of the pushed changes failed at "${result.step}": ${String(result.error || '').slice(0, 400)} — fix and push again, or press "Redeploy app" in the Build panel.`);
  } catch (e) {
    say(`Deploy of the pushed changes errored: ${String(e?.message || e).slice(0, 300)}`);
  }
}
