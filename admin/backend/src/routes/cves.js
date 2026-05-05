// CVE inbox surface for the dashboard.
//
// The actual inbox lives at /var/lib/proxypilot/cve-inbox/<cve>.yaml.
// Claude writes entries; the Python engine executes them and reports
// back via state.history. This route is the read/operator-action
// surface: list, render YAML, mark seen, dismiss, and trigger a
// ONE_CLICK run-on-this-host.
//
// State writes (mark-seen / dismiss / run-one) shell out to the
// Python engine so the YAML round-trip and opaque-field preservation
// stay in one place. We don't reparse YAML in Node — for listings we
// extract just the badge-relevant fields with line-anchored regexes,
// which is robust enough for a UI listing because the spec values
// (status, action_class, operator_seen, tier) are flat scalars.
//
// Per-handler RBAC mirrors the security router: list/get is admin;
// state-changing actions are admin + sudo (the host-mutation actions
// are also rate-limited at the global /api limiter).

import { Router } from 'express';
import { readdir, readFile, stat, unlink, mkdir, rename, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { logAudit, getSetting, setSetting } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';

export const cvesRouter = Router();

const INBOX_DIR = process.env.PROXYPILOT_INBOX_DIR || '/var/lib/proxypilot/cve-inbox';
const ENGINE_BIN = process.env.PROXYPILOT_ENGINE_BIN || 'python3';
const ENGINE_MODULE = process.env.PROXYPILOT_ENGINE_MODULE || 'proxypilot.engine';
const HOSTNAME = process.env.PROXYPILOT_HOSTNAME || '';

// The dashboard runs in a Docker container; the engine + python3 +
// ruamel.yaml live on the host (Phase A architecture — the agent
// socket isn't wired for engine RPCs yet). Pivot through `nsenter
// -t 1` so the spawn lands in the host's mount + uts + net + ipc
// namespaces, where python3 -m proxypilot.engine resolves. Same
// pattern as caddy-driver.js / l4-diagnose.js / pty.js.
//
// Outside Docker (tests, dev), we run the engine directly.
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// CVE filenames are constrained to the canonical CVE-YYYY-NNNN[N..]
// shape so a malicious id can't traverse out of the inbox dir.
const CVE_ID_RE = /^CVE-\d{4}-\d{4,7}$/;

function safePath(cveId) {
  if (!CVE_ID_RE.test(cveId)) return null;
  return join(INBOX_DIR, `${cveId}.yaml`);
}

// ── tiny YAML-field extractor ───────────────────────────────────────────────
// Pulls a single top-level scalar (e.g. `cve:`, `name:`, `status:`)
// from a YAML body. Stops at the first match. Does not handle nested
// lookups — for `state.status` use extractNested.
function extractScalar(body, key) {
  const re = new RegExp(`(?:^|\\n)${key}:\\s*([^\\n]+)`);
  const m = body.match(re);
  if (!m) return null;
  // Strip surrounding quotes and trailing comments.
  return m[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
}

// extractNested("state", "status", body) finds the `status:` key
// inside the `state:` block. Indent-based: matches any line indented
// further than the block header. Also recognises flow-form blocks
// like `state: {status: NEW}` on a single line — common in compact
// hand-pasted YAML. Good enough for our flat schema.
function extractNested(parent, child, body) {
  // Flow form: `parent: { ..., child: VALUE, ... }` on one line.
  const flowMatch = body.match(
    new RegExp(`(?:^|\\n)${parent}:\\s*\\{([^}]*)\\}`));
  if (flowMatch) {
    const inner = flowMatch[1];
    const kv = inner.match(new RegExp(`(?:^|,)\\s*${child}:\\s*([^,}]+)`));
    if (kv) {
      return kv[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    }
  }
  const lines = body.split('\n');
  let inBlock = false;
  let baseIndent = -1;
  for (const line of lines) {
    if (!inBlock) {
      if (new RegExp(`^${parent}:\\s*$`).test(line)) {
        inBlock = true;
        baseIndent = -1;
      }
      continue;
    }
    if (/^\S/.test(line)) {
      // Top-level key — left the block.
      break;
    }
    const indentMatch = line.match(/^( +)(\S)/);
    if (!indentMatch) continue;
    const indent = indentMatch[1].length;
    if (baseIndent === -1) baseIndent = indent;
    if (indent !== baseIndent) continue;
    const m = line.match(new RegExp(`^ {${indent}}${child}:\\s*([^\\n]*)`));
    if (m) {
      return m[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    }
  }
  return null;
}

// Resolve action_class for the current host. The schema is either:
//   hosts:
//     <hostname>: { action_class: ..., tier: ... }
// or the legacy list form:
//   hosts:
//     - host: <hostname>
//       action_class: ...
// Heuristic: find the first `action_class:` after a `host: <name>` or
// `<name>:` line within the hosts block.
function extractHostAction(body, hostname) {
  if (!hostname) return null;
  const lines = body.split('\n');
  let inHosts = false;
  let inMatchingHost = false;
  for (const line of lines) {
    if (/^hosts:\s*$/.test(line)) { inHosts = true; continue; }
    if (!inHosts) continue;
    if (/^\S/.test(line)) break;            // left hosts block
    if (new RegExp(`^  ${hostname}:\\s*$`).test(line)) inMatchingHost = true;
    else if (new RegExp(`^  - host:\\s*${hostname}\\s*$`).test(line)) inMatchingHost = true;
    else if (/^  \S/.test(line) || /^  - /.test(line)) inMatchingHost = false;
    if (inMatchingHost) {
      const m = line.match(/action_class:\s*(\S+)/);
      if (m) return m[1].replace(/["']/g, '');
    }
  }
  return null;
}

// Spawn the Python engine and capture its single-line JSON result.
// All write actions go through here so the YAML mutation lives in
// the engine module, not duplicated in Node. Optionally feeds bytes
// on stdin (used for `validate`, which reads YAML from there).
function runEngine(args, { timeoutMs = 30 * 60 * 1000, stdinText = null } = {}) {
  // Build the argv. In Docker we wrap with nsenter so the spawn
  // pivots into the host namespace where the engine + python3 are
  // installed. Outside Docker we run the engine directly.
  //
  // The engine CLI's --inbox / --host flags come BEFORE the
  // subcommand, so prepend them here. Tests + alternate deployments
  // override INBOX_DIR / HOSTNAME via env, and we want those values
  // to actually reach the subprocess.
  const globalArgs = ['--inbox', INBOX_DIR];
  if (HOSTNAME) globalArgs.push('--host', HOSTNAME);
  let bin, fullArgs;
  if (isInDocker) {
    bin = 'nsenter';
    // -m mount, -u uts, -n net, -i ipc, -p pid (so signals reach
    // the right pid tree). We don't need -U because the host runs
    // as the same root.
    fullArgs = ['-t', '1', '-m', '-u', '-n', '-i', '-p', '--',
                ENGINE_BIN, '-m', ENGINE_MODULE, ...globalArgs, ...args];
  } else {
    bin = ENGINE_BIN;
    fullArgs = ['-m', ENGINE_MODULE, ...globalArgs, ...args];
  }
  // Set PYTHONPATH so `-m proxypilot.engine` resolves on the host.
  // install.sh copies the repo to /opt/proxypilot; operators with a
  // different layout override via PROXYPILOT_INSTALL_DIR.
  const installDir = process.env.PROXYPILOT_INSTALL_DIR || '/opt/proxypilot';
  const childEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    PYTHONPATH: installDir + (process.env.PYTHONPATH ? ':' + process.env.PYTHONPATH : ''),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(bin, fullArgs, { env: childEnv });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`engine timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => {
      clearTimeout(timer);
      // Surface a clearer error on the typical missing-binary cases
      // so the operator sees a remediation hint, not a raw ENOENT.
      if (err.code === 'ENOENT') {
        const what = isInDocker ? 'nsenter (util-linux not in container)' : 'python3';
        err = new Error(`engine spawn failed: ${what} not found. ` +
          (isInDocker
            ? 'Container needs util-linux installed and pid:host enabled.'
            : `Install python3 + ruamel.yaml on the host and ensure ${installDir} contains the proxypilot package.`));
      }
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      // The engine writes one JSON line per command. Even on non-zero
      // exit it's expected to emit a parseable {"ok":false,"error":...}.
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const parsed = JSON.parse(lastLine);
        if (code !== 0 && parsed.ok !== false) parsed.exit_code = code;
        resolve(parsed);
      } catch {
        // Common case: `No module named proxypilot` — the host has
        // python3 but the engine package isn't on PYTHONPATH. Surface
        // a remediation hint instead of a raw stderr dump.
        const errText = stderr.trim();
        if (/No module named ['\"]?proxypilot/.test(errText)) {
          reject(new Error(
            `engine package not found on host PYTHONPATH (${installDir}). ` +
            `Run install.sh / update.sh, or set PROXYPILOT_INSTALL_DIR to ` +
            `the directory containing the proxypilot/ package.`));
          return;
        }
        if (/No module named ['\"]?ruamel/.test(errText)) {
          reject(new Error(
            'ruamel.yaml not installed on the host. ' +
            'Install with: apt install python3-ruamel.yaml  (Debian/Ubuntu) ' +
            'or: pip3 install ruamel.yaml'));
          return;
        }
        reject(new Error(`engine exited ${code}; stderr: ${errText.slice(0, 500)}`));
      }
    });
    if (stdinText !== null) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}

// Atomic write: tmp-in-same-dir + rename so a crash mid-write can't
// leave half a YAML for the next poll to choke on. Mirrors the Python
// engine's writeFileAtomic.
async function writeYamlAtomic(targetPath, body) {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.cve-tmp-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o644 });
    await chmod(tmp, 0o644);
    await rename(tmp, targetPath);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

cvesRouter.get('/', requireAdmin, async (_req, res) => {
  let names;
  try {
    names = await readdir(INBOX_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ host: HOSTNAME, entries: [], unread: 0 });
    return res.status(500).json({ error: err.message });
  }

  const entries = [];
  let unread = 0;
  for (const name of names) {
    if (!name.endsWith('.yaml') || name.startsWith('_')) continue;
    const cve = basename(name, '.yaml');
    if (!CVE_ID_RE.test(cve)) continue;
    let body;
    try {
      body = await readFile(join(INBOX_DIR, name), 'utf8');
    } catch {
      continue;
    }
    const action = extractHostAction(body, HOSTNAME) || 'ALERT';
    const status = (extractNested('state', 'status', body) || 'NEW').toUpperCase().replace('_', '-');
    const seenStr = (extractNested('state', 'operator_seen', body) || 'false').toLowerCase();
    const seen = seenStr === 'true' || seenStr === 'yes';
    const lastUpdated = extractNested('state', 'last_updated', body);
    const opAction = extractNested('state', 'operator_action_required', body);
    const tier = extractScalar(body, 'tier');  // host-level; fallback to top-level
    let st;
    try { st = await stat(join(INBOX_DIR, name)); } catch { st = null; }
    if (!seen) unread += 1;
    entries.push({
      cve,
      name: extractScalar(body, 'name'),
      disclosed: extractScalar(body, 'disclosed'),
      cvss: extractScalar(body, 'cvss'),
      action_class: action,
      status,
      operator_seen: seen,
      operator_action_required: opAction,
      tier: tier ? parseInt(tier, 10) || tier : null,
      last_updated: lastUpdated,
      mtime: st ? st.mtime.toISOString() : null,
      // _proxypilot block is metadata: origin (paste|git), git_url,
      // git_commit, imported_at. Lives at top level alongside `cve:`,
      // so extractNested with parent="_proxypilot" works.
      origin: extractNested('_proxypilot', 'origin', body) || 'unknown',
      origin_git_url: extractNested('_proxypilot', 'git_url', body),
    });
  }
  res.json({ host: HOSTNAME, entries, unread });
});

cvesRouter.get('/:cveId', requireAdmin, async (req, res) => {
  const path = safePath(req.params.cveId);
  if (!path) return res.status(400).json({ error: 'invalid CVE id' });
  let body;
  try {
    body = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    return res.status(500).json({ error: err.message });
  }
  const action = extractHostAction(body, HOSTNAME) || 'ALERT';
  const status = (extractNested('state', 'status', body) || 'NEW').toUpperCase().replace('_', '-');
  res.json({
    cve: req.params.cveId,
    action_class: action,
    status,
    yaml: body,
  });
});

cvesRouter.post('/:cveId/seen', requireAdmin, async (req, res) => {
  const path = safePath(req.params.cveId);
  if (!path) return res.status(400).json({ error: 'invalid CVE id' });
  try {
    const out = await runEngine(['mark-seen', req.params.cveId]);
    if (!out.ok) return res.status(400).json(out);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const dismissBodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();

cvesRouter.post('/:cveId/dismiss', requireAdmin, requireSudo, async (req, res) => {
  const path = safePath(req.params.cveId);
  if (!path) return res.status(400).json({ error: 'invalid CVE id' });
  let body;
  try {
    body = dismissBodySchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    const out = await runEngine([
      'dismiss', req.params.cveId,
      '--reason', body.reason,
      '--actor', `operator:${req.user.username || req.user.id}`,
    ]);
    if (!out.ok) return res.status(400).json(out);
    logAudit(req.user.id, 'CVE_DISMISS', 'cve', req.params.cveId,
             { reason: body.reason }, req.ip);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const runBodySchema = z.object({
  // Force ONE_CLICK dispatch even if the spec says AUTO_PATCH —
  // matches the "Run on this host" button on a ONE_CLICK card. The
  // engine still runs the full snapshot/run/verify/rollback machine.
  force_action: z.enum(['AUTO_PATCH', 'ONE_CLICK']).optional(),
}).strict();

cvesRouter.post('/:cveId/run', requireAdmin, requireSudo, async (req, res) => {
  const path = safePath(req.params.cveId);
  if (!path) return res.status(400).json({ error: 'invalid CVE id' });
  let body;
  try {
    body = runBodySchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const args = ['run-one', req.params.cveId];
  if (body.force_action) {
    args.push('--force-action', body.force_action);
  }
  try {
    const out = await runEngine(args, { timeoutMs: 35 * 60 * 1000 });
    logAudit(req.user.id, 'CVE_RUN', 'cve', req.params.cveId, {
      force_action: body.force_action || null,
      final_status: out?.result?.final_status ?? null,
      operator_action_required: out?.result?.operator_action_required ?? null,
    }, req.ip);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── operator-managed inbox writes ──────────────────────────────────────────
//
// Paste / Save / Delete / Poll-now. These let the operator manage the
// inbox entirely from the dashboard without shelling onto the host.
//
// Paste + Save go through the engine's `validate` subcommand first
// so a malformed YAML (or one whose `cve:` field doesn't match the
// filename) is rejected before the file lands on disk. Delete and
// Poll-now are simple shell-outs.

// Cap upload size at something that fits even a chatty CVE spec but
// rules out a YAML bomb. Inbox entries on this branch top out at ~6KB.
const MAX_YAML_BYTES = 256 * 1024;

const writeBodySchema = z.object({
  // Raw YAML body. Filename is derived from the embedded `cve:` field
  // so the operator can't paste a body that disagrees with the URL.
  content: z.string().min(1).max(MAX_YAML_BYTES),
}).strict();

// POST /api/cves — paste a new entry (or overwrite an existing one).
// PUT /api/cves/:id — save an edit; the embedded cve must equal :id.
//
// Both call the engine's `paste` subcommand which validates the YAML,
// stamps `_proxypilot.origin: paste` on first import, and writes the
// file atomically. This keeps origin tracking in one place — the
// backend never serializes YAML itself.
async function handleWrite(req, res, { expectedCveId = null }) {
  let body;
  try {
    body = writeBodySchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // For PUT we still need to know the cve id so we can refuse
  // mismatched ids. Run validate first (cheap), then paste. validate
  // returns the parsed cve id without touching disk.
  let validation;
  try {
    validation = await runEngine(['validate'],
      { timeoutMs: 10_000, stdinText: body.content });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error || 'validation failed' });
  }
  const cveId = validation.cve;
  if (expectedCveId && cveId !== expectedCveId) {
    return res.status(400).json({
      error: `URL CVE id (${expectedCveId}) does not match embedded cve: ${cveId}`,
    });
  }

  let writeOut;
  try {
    writeOut = await runEngine(['paste'],
      { timeoutMs: 15_000, stdinText: body.content });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (!writeOut.ok) {
    return res.status(400).json({ error: writeOut.error || 'write failed' });
  }

  logAudit(req.user.id, expectedCveId ? 'CVE_EDIT' : 'CVE_PASTE', 'cve', cveId,
           { bytes: body.content.length }, req.ip);
  res.json({ ok: true, cve: cveId, path: writeOut.path });
}

cvesRouter.post('/', requireAdmin, requireSudo, (req, res) =>
  handleWrite(req, res, { expectedCveId: null }));

cvesRouter.put('/:cveId', requireAdmin, requireSudo, (req, res) => {
  if (!CVE_ID_RE.test(req.params.cveId)) {
    return res.status(400).json({ error: 'invalid CVE id' });
  }
  return handleWrite(req, res, { expectedCveId: req.params.cveId });
});

cvesRouter.delete('/:cveId', requireAdmin, requireSudo, async (req, res) => {
  const path = safePath(req.params.cveId);
  if (!path) return res.status(400).json({ error: 'invalid CVE id' });
  try {
    await unlink(path);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    return res.status(500).json({ error: err.message });
  }
  logAudit(req.user.id, 'CVE_DELETE', 'cve', req.params.cveId, {}, req.ip);
  res.json({ ok: true });
});

// POST /api/cves/poll — trigger an immediate engine poll. Useful right
// after pasting a new entry so the operator doesn't have to wait for
// the 5-minute timer. AUTO_PATCH entries that probe positive will run
// during this call; the response includes the per-entry summary.
cvesRouter.post('/poll', requireAdmin, requireSudo, async (req, res) => {
  try {
    const out = await runEngine(['poll'], { timeoutMs: 35 * 60 * 1000 });
    logAudit(req.user.id, 'CVE_POLL', 'cve', null,
             { entries: out?.entries?.length ?? null }, req.ip);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── read-only git source config + sync ────────────────────────────────────
//
// Operators point ProxyPilot at a git repo (typically a Claude-curated
// catalog of CVE specs) and the engine pulls new entries on demand.
// The sync is strictly additive: existing entries — including their
// origin (paste / a previous git URL) — never get overwritten or
// removed when the URL changes.
//
// State flow:
//   1. PUT /api/cves/git-config { url } — operator sets / changes URL.
//   2. POST /api/cves/git-sync — pulls + imports new specs.
//   3. Each import lands in the inbox with `_proxypilot.origin: git`,
//      `git_url`, `git_commit`. Engine + dashboard treat these as
//      opaque metadata.

const GIT_URL_KEY = 'cve_git_url';

// Permissive enough to allow https / git@ / file:// for tests, strict
// enough to block obvious shell-meta. The engine wraps the URL in argv
// for subprocess.run so injection isn't possible, but we still want a
// readable error in the dashboard rather than a cryptic git failure.
const gitUrlSchema = z.object({
  url: z.string().trim().min(0).max(1024)
    .refine(v => v === '' || /^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(v),
            { message: 'must be empty or start with https://, ssh://, git@, file://, or /' }),
}).strict();

cvesRouter.get('/git-config', requireAdmin, async (_req, res) => {
  res.json({ url: getSetting(GIT_URL_KEY) || '' });
});

cvesRouter.put('/git-config', requireAdmin, requireSudo, async (req, res) => {
  let body;
  try {
    body = gitUrlSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  setSetting(GIT_URL_KEY, body.url);
  logAudit(req.user.id, 'CVE_GIT_CONFIG', 'cve', null,
           { url_set: !!body.url }, req.ip);
  res.json({ ok: true, url: body.url });
});

cvesRouter.post('/git-sync', requireAdmin, requireSudo, async (req, res) => {
  const url = (getSetting(GIT_URL_KEY) || '').trim();
  if (!url) {
    return res.status(400).json({
      error: 'no git source configured; set one via PUT /api/cves/git-config',
    });
  }
  try {
    const out = await runEngine(['sync-git', '--git-url', url],
      { timeoutMs: 5 * 60 * 1000 });
    logAudit(req.user.id, 'CVE_GIT_SYNC', 'cve', null, {
      git_commit: out?.git_commit ?? null,
      imported: (out?.imported || []).length,
      errors: (out?.errors || []).length,
    }, req.ip);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
