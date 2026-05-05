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
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';

export const cvesRouter = Router();

const INBOX_DIR = process.env.PROXYPILOT_INBOX_DIR || '/var/lib/proxypilot/cve-inbox';
const ENGINE_BIN = process.env.PROXYPILOT_ENGINE_BIN || 'python3';
const ENGINE_MODULE = process.env.PROXYPILOT_ENGINE_MODULE || 'proxypilot.engine';
const HOSTNAME = process.env.PROXYPILOT_HOSTNAME || '';

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
// further than the block header. Good enough for our flat schema.
function extractNested(parent, child, body) {
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
// the engine module, not duplicated in Node.
function runEngine(args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ENGINE_BIN, ['-m', ENGINE_MODULE, ...args], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`engine timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
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
        reject(new Error(`engine exited ${code}; stderr: ${stderr.trim().slice(0, 500)}`));
      }
    });
  });
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
