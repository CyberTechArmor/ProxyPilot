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
import { join, basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { logAudit, getDb } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { getInboxDir, getHostname, CVE_ID_RE, safePath, runEngine } from '../lib/engine-cli.js';
import {
  getResearchSettings, saveResearchSettings, testConnectorConnectivity,
  listReusableMock2Connectors, resolveConnectorSource,
} from '../lib/cve-research.js';
import * as cveResearchScheduler from '../lib/cve-research-scheduler.js';

export const cvesRouter = Router();

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

// Walk state.history and return ALL items as structured objects.
// Each returned object includes ts/actor/change/host plus any extra
// engine-written fields (verdict, exit_code) — the schema is open.
//
// History grows append-only so items[items.length-1] is the most
// recent. We accept BOTH forms ruamel.yaml + hand-pasted YAMLs
// produce:
//
//   block:
//     history:
//       - ts: "2026-05-05T18:42:11Z"
//         actor: proxypilot-engine
//         change: "probe exit=1; host not affected"
//         verdict: not_affected
//         exit_code: 1
//
//   flow:
//     history:
//       - {ts: "...", actor: claude, change: created}
//
// Mixed within the same `history:` list is allowed and handled.
function extractHistoryItems(body) {
  if (!body) return [];
  const histStart = body.search(/\n\s+history:\s*\n/);
  if (histStart < 0) return [];
  const tail = body.slice(histStart);

  const lines = tail.split('\n');
  const items = [];
  let cur = null;
  let itemIndent = -1;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      if (cur) { items.push(cur); cur = null; }
      break;
    }
    const dash = line.match(/^(\s+)-\s+(.*)$/);
    if (dash) {
      if (cur) items.push(cur);
      itemIndent = dash[1].length;
      cur = { lines: [dash[2]], indent: itemIndent };
      continue;
    }
    const ind = line.match(/^(\s*)/)[1].length;
    if (cur && ind > itemIndent) {
      cur.lines.push(line.slice(itemIndent + 2));
    }
  }
  if (cur) items.push(cur);

  // Parse each item into a flat key→value object. Recognises both
  // flow form (`{k: v, ...}` on one line) and block form (one key
  // per line). Extra fields like `verdict`/`exit_code` round-trip
  // alongside the well-known ones.
  return items.map(item => parseHistoryItem(item));
}

function parseHistoryItem(item) {
  const out = {};
  const head = item.lines[0] || '';
  const flowMatch = head.match(/^\s*\{(.+)\}\s*$/);
  if (flowMatch) {
    for (const part of flowMatch[1].split(/,(?![^{]*\})/)) {
      const kv = part.match(/^\s*(\w+):\s*(.*?)\s*$/);
      if (!kv) continue;
      out[kv[1]] = kv[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    }
    return out;
  }
  for (const ln of item.lines) {
    const m = ln.match(/^\s*(\w+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    if (!(key in out)) out[key] = val;
  }
  return out;
}

// Latest history item (the absolute newest, regardless of content).
// This is what the timeline shows; for the verdict signal use
// extractLatestVerdict instead.
function extractLatestHistory(body) {
  const items = extractHistoryItems(body);
  if (items.length === 0) return null;
  const last = items[items.length - 1];
  if (!last.ts && !last.actor && !last.change) return null;
  // Restrict the well-known fields the listing returns; the structured
  // verdict signal goes through extractLatestVerdict separately.
  return {
    ts: last.ts || null,
    actor: last.actor || null,
    change: last.change || null,
    host: last.host || null,
  };
}

// Latest verdict — walks history backwards looking for the first
// item that has a structured `verdict` field. This is what the
// engine's check_only writes; older AUTO_PATCH events also write
// verdicts (TODO once that path adopts extra_fields too). We do
// NOT text-match the change string — that was fragile in the old
// code and produced "verdict disappears on revisit" when a non-
// check history line was the absolute newest.
//
// Returns null when no item has a verdict field.
function extractLatestVerdict(body) {
  const items = extractHistoryItems(body);
  for (let i = items.length - 1; i >= 0; i--) {
    const v = items[i].verdict;
    if (v && /^[a-z_]+$/.test(v)) {
      return {
        verdict: v,
        exit_code: items[i].exit_code != null ? Number(items[i].exit_code) : null,
        ts: items[i].ts || null,
        actor: items[i].actor || null,
      };
    }
  }
  return null;
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

cvesRouter.get('/', requireAdmin, async (req, res) => {
  const inboxDir = getInboxDir();
  const hostname = getHostname();
  let names;
  try {
    names = await readdir(inboxDir);
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ host: hostname, entries: [], unread: 0 });
    return res.status(500).json({ error: err.message });
  }

  // Bulk-fetch the current operator's pin set so each row knows
  // its own pinned state without a per-row query.
  const pinRows = (() => {
    try {
      return getDb().prepare(
        `SELECT cve_id, note, pinned_at FROM cve_pins WHERE user_id = ?`
      ).all(req.user.id);
    } catch { return []; }
  })();
  const pinByCve = new Map(pinRows.map(r => [r.cve_id, r]));

  const entries = [];
  let unread = 0;
  for (const name of names) {
    if (!name.endsWith('.yaml') || name.startsWith('_')) continue;
    const cve = basename(name, '.yaml');
    if (!CVE_ID_RE.test(cve)) continue;
    let body;
    try {
      body = await readFile(join(inboxDir, name), 'utf8');
    } catch {
      continue;
    }
    const action = extractHostAction(body, hostname) || 'ALERT';
    const status = (extractNested('state', 'status', body) || 'NEW').toUpperCase().replace('_', '-');
    const seenStr = (extractNested('state', 'operator_seen', body) || 'false').toLowerCase();
    const seen = seenStr === 'true' || seenStr === 'yes';
    const lastUpdated = extractNested('state', 'last_updated', body);
    const opAction = extractNested('state', 'operator_action_required', body);
    const tier = extractScalar(body, 'tier');  // host-level; fallback to top-level
    let st;
    try { st = await stat(join(inboxDir, name)); } catch { st = null; }
    if (!seen) unread += 1;
    // "Added": when this entry first started being actionable on
    // THIS host. Prefer the engine's own _proxypilot.imported_at
    // stamp (set by the paste path), fall back to the file's ctime
    // (covers entries that landed before we added origin tracking).
    const importedAt = extractNested('_proxypilot', 'imported_at', body);
    const added = importedAt
      || (st ? st.ctime.toISOString() : null);
    const latestHistory = extractLatestHistory(body);
    const latestVerdict = extractLatestVerdict(body);
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
      added,
      mtime: st ? st.mtime.toISOString() : null,
      // _proxypilot block is metadata: origin (paste = manual,
      // ai = filed by the research routine) + imported_at. Lives at
      // top level alongside `cve:`, so extractNested with
      // parent="_proxypilot" works.
      origin: extractNested('_proxypilot', 'origin', body) || 'unknown',
      // Most recent timeline event so the list view can show
      // applicability ("probe exit=1; host not affected") without
      // an extra detail fetch.
      latest_note: latestHistory ? {
        ts: latestHistory.ts,
        actor: latestHistory.actor,
        change: latestHistory.change,
      } : null,
      // Authoritative verdict signal — pulled from the most recent
      // history entry that has a structured `verdict` field (engine
      // writes one on every check / AUTO_PATCH probe). Robust
      // against later non-verdict entries (Claude edits, dismissals)
      // burying the operator's last check.
      latest_verdict: latestVerdict,
      // Per-user pin state. `null` when the current user hasn't
      // pinned this entry; an object with note + pinned_at when they
      // have. The frontend renders the star + sorts pinned-first.
      pin: pinByCve.has(cve)
        ? { note: pinByCve.get(cve).note, pinned_at: pinByCve.get(cve).pinned_at }
        : null,
    });
  }
  res.json({ host: hostname, entries, unread });
});

// ── literal-path routes ───────────────────────────────────────────────────
//
// Express routes match in registration order. The `:cveId` wildcard
// below would otherwise swallow `/poll` and `/research/*` (they're
// valid `:cveId` values from the wildcard's POV) — so the specific
// paths MUST register first. Reordering this file is the test: every
// `/<literal>` route should sit above any `/<wildcard>` route on the
// same HTTP verb.

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

// ── AI research routine (toggleable, native replacement for a manual ──────
// external research session) — connector config, connectivity test, and
// on-demand / scheduled runs. The scheduler (lib/cve-research-scheduler.js)
// calls the same runResearchPass() this route's run-now hits.

const researchConfigSchema = z.object({
  // provider/api_key are required for a standalone connector; omit both
  // and set import_connector_id instead to reuse a connector already
  // configured under Projects (mock2) — the route resolves the actual
  // provider/base_url/key server-side from that connector's stored key.
  provider: z.enum(['anthropic', 'openai', 'gemini', 'ollama', 'openai_compatible']).optional(),
  base_url: z.string().trim().max(500).optional(),
  model: z.string().trim().min(1).max(200),
  // Optional on a standalone update — omit/empty to keep the previously stored key.
  api_key: z.string().trim().max(2000).optional(),
  import_connector_id: z.number().int().positive().optional(),
  enabled: z.boolean(),
  interval_hours: z.number().int().min(1).max(168),
}).strict().refine(
  (v) => v.import_connector_id != null || v.provider,
  { message: 'provider is required unless import_connector_id is set' },
);

cvesRouter.get('/research/config', requireAdmin, async (_req, res) => {
  res.json(getResearchSettings());
});

// Connectors already configured under Projects (mock2) that could be
// reused here, so the operator isn't forced to paste a key twice. Empty
// list (not an error) when Projects is disabled or has nothing usable.
cvesRouter.get('/research/connectors', requireAdmin, async (_req, res) => {
  try {
    res.json(await listReusableMock2Connectors());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

cvesRouter.put('/research/config', requireAdmin, requireSudo, async (req, res) => {
  let body;
  try {
    body = researchConfigSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  let source;
  try {
    source = await resolveConnectorSource(body);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  let saved;
  try {
    saved = saveResearchSettings({
      ...source,
      model: body.model,
      enabled: body.enabled,
      interval_hours: body.interval_hours,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (body.enabled) cveResearchScheduler.register({ interval_hours: body.interval_hours });
  else cveResearchScheduler.unregister();
  logAudit(req.user.id, 'CVE_RESEARCH_CONFIG', 'cve', null, {
    provider: source.provider, model: body.model,
    enabled: body.enabled, interval_hours: body.interval_hours,
    imported_from: source.sourceConnectorName,
    api_key_changed: !!source.api_key,
  }, req.ip);
  res.json(saved);
});

// Cheap live connectivity check — a single no-tools model turn asking for
// a fixed reply. Mirrors mock2's connector test pattern (connectors.js
// testConnector) without pulling in the mock2 module.
cvesRouter.post('/research/test', requireAdmin, requireSudo, async (_req, res) => {
  try {
    const out = await testConnectorConnectivity();
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

cvesRouter.post('/research/run-now', requireAdmin, requireSudo, async (req, res) => {
  if (cveResearchScheduler.isBusy()) {
    return res.status(409).json({ error: 'a research run is already in progress' });
  }
  try {
    // runResearchPass() itself writes the CVE_RESEARCH_RUN audit row
    // (actorUserId flows through so manual runs still attribute to the
    // operator) — no second logAudit call needed here.
    const out = await cveResearchScheduler.runNow('manual', { actorUserId: req.user.id });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── wildcard `:cveId` routes (must register AFTER literal paths above) ────

cvesRouter.get('/:cveId', requireAdmin, async (req, res) => {
  const path = safePath(req.params.cveId);
  if (!path) return res.status(400).json({ error: 'invalid CVE id' });
  let body;
  let st;
  try {
    body = await readFile(path, 'utf8');
    st = await stat(path);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    return res.status(500).json({ error: err.message });
  }
  const action = extractHostAction(body, getHostname()) || 'ALERT';
  const status = (extractNested('state', 'status', body) || 'NEW').toUpperCase().replace('_', '-');
  const importedAt = extractNested('_proxypilot', 'imported_at', body);
  let pin = null;
  try {
    const row = getDb().prepare(
      `SELECT note, pinned_at FROM cve_pins WHERE user_id = ? AND cve_id = ?`
    ).get(req.user.id, req.params.cveId);
    if (row) pin = row;
  } catch { /* table missing or DB error → no pin info */ }
  res.json({
    cve: req.params.cveId,
    action_class: action,
    status,
    yaml: body,
    // Convenience fields the About tab uses without re-parsing the
    // YAML on the client. The yaml itself stays in the response so
    // the Spec tab keeps working unchanged.
    last_updated: extractNested('state', 'last_updated', body),
    added: importedAt || (st ? st.ctime.toISOString() : null),
    operator_action_required: extractNested('state', 'operator_action_required', body),
    latest_note: extractLatestHistory(body),
    latest_verdict: extractLatestVerdict(body),
    pin,
  });
});

// PUT /api/cves/:id/pin — pin (or update note on) an entry for the
// current operator. DELETE removes the pin. Admin-only — pins are
// per-user UI state, not destructive against host or DB beyond the
// pinning user's own row.
const pinBodySchema = z.object({
  note: z.string().trim().max(280).optional(),
}).strict();

cvesRouter.put('/:cveId/pin', requireAdmin, async (req, res) => {
  if (!CVE_ID_RE.test(req.params.cveId)) {
    return res.status(400).json({ error: 'invalid CVE id' });
  }
  let body;
  try { body = pinBodySchema.parse(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    getDb().prepare(
      `INSERT INTO cve_pins (user_id, cve_id, pinned_at, note)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT (user_id, cve_id)
       DO UPDATE SET note = excluded.note`
    ).run(req.user.id, req.params.cveId, body.note || null);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  // No audit log — pins are noisy and per-user; the activity is
  // already implicit in subsequent CVE_RUN / CVE_DISMISS events.
  res.json({ ok: true, pinned: true, note: body.note || null });
});

cvesRouter.delete('/:cveId/pin', requireAdmin, async (req, res) => {
  if (!CVE_ID_RE.test(req.params.cveId)) {
    return res.status(400).json({ error: 'invalid CVE id' });
  }
  try {
    getDb().prepare(
      `DELETE FROM cve_pins WHERE user_id = ? AND cve_id = ?`
    ).run(req.user.id, req.params.cveId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true, pinned: false });
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

// POST /api/cves/:id/check — run probe only. Read-only against the
// host (no patch, no snapshot, no state.status mutation), so it's
// admin-only — NOT sudo-gated. The friction-free reflex action is
// the whole point: operators check applicability without re-auth.
cvesRouter.post('/:cveId/check', requireAdmin, async (req, res) => {
  const path = safePath(req.params.cveId);
  if (!path) return res.status(400).json({ error: 'invalid CVE id' });
  const args = ['check', req.params.cveId,
    '--actor', `operator:${req.user.username || req.user.id}`];
  try {
    const out = await runEngine(args, { timeoutMs: 5 * 60 * 1000 });
    logAudit(req.user.id, 'CVE_CHECK', 'cve', req.params.cveId, {
      verdict: out?.verdict ?? null,
      exit_code: out?.exit_code ?? null,
    }, req.ip);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
