// ProxyPilot remote MCP server (Streamable HTTP) + its token administration.
//
// Two routers:
//   createMcpRouter()      — mounted at /api/mcp, token-authenticated (Bearer
//                            header, or /t/<token> in the URL for claude.ai
//                            custom connectors, which cannot set headers).
//                            CSRF-exempt: the token never rides ambient
//                            cookies, so double-submit has nothing to protect
//                            (same rationale as the mock2 git endpoints).
//   createMcpAdminRouter() — mounted at /api/mcp-tokens behind the normal
//                            cookie session (admin only): mint / list /
//                            revoke access tokens.
//
// The tools deliberately mirror the UI's two-phase zip flow (inspect →
// confirm → apply with .old backups) so "asking first" happens in the AI
// conversation, and reuse the SAME lib helpers and staging store the UI
// routes use — an inspect over MCP and an apply over the UI interoperate.
//
// Zip transfer: tool arguments are JSON, so large zips ride a short-lived
// upload ticket (create_upload_ticket → PUT raw bytes → reference the
// ticket); small ones may come inline as base64. See lib/mcp-logic.js.

import express from 'express';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { getDb, logAudit } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  MCP_PROTOCOL_VERSION, MCP_KNOWN_VERSIONS, MCP_SERVER_INFO, MCP_TOOLS,
  rpcResult, rpcError, toolResult,
  RPC_PARSE_ERROR, RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND, RPC_INVALID_PARAMS, RPC_INTERNAL_ERROR,
  mintMcpToken, hashMcpToken, tokenFromRequest,
  mintUploadTicket, looksLikeUploadTicket, UPLOAD_TICKET_TTL_MS, INLINE_ZIP_MAX_BYTES,
  startupCandidates, validProjectFilePath,
  parseProjectCommand, projectCommandTimeoutMs, PROJECT_COMMAND_OUTPUT_CAP,
  applyStringEdit, normalizeReadRange,
  validSearchPattern, validPathspec, normalizeMaxResults, parseGitGrepOutput,
  validGitRef, normalizeGitLogLimit, GIT_LOG_FORMAT, parseGitLogOutput,
  parseGitStatusPorcelain, capPatch, normalizeBuildLogLimit, buildLogFromEvents,
} from '../lib/mcp-logic.js';
import {
  parseZip, detectWrapperDir, effectiveEntries, findConflicts, fsExistsKind,
  collectCandidatePaths, extractToStaging, applyStagingToTarget, ZIP_LIMITS, ZipError,
} from '../lib/zip-extract.js';
import { stageZipUpload, getZipUpload, discardZipUpload } from '../lib/zip-staging.js';
import {
  checkContainerConflicts, readContainerStartup, applyTarToContainer,
  setupStartupScript, writeTarFromZip, runHostCapture, runInContainer,
} from '../lib/lxc-zip.js';
import { resolveMock2Gate } from '../mock2/gating.js';

// The public base URL for links we hand to MCP clients (connector URL, upload
// URLs). The backend sits behind Caddy, and without app-level trust-proxy
// req.protocol reports the INTERNAL hop ("http") — which minted an http://
// connector URL that claude.ai refuses (operator report). Prefer the proxy's
// X-Forwarded-Proto; and since claude.ai requires https anyway, never emit
// http for a non-local host even if the header is missing.
function publicBaseUrl(req) {
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  let proto = fwd || req.protocol || 'https';
  const host = req.get('host') || '';
  const isLocal = /^(localhost|127\.|\[::1\])/i.test(host);
  if (proto === 'http' && !isLocal) proto = 'https';
  return `${proto}://${host}`;
}

const LXC_PREFIX = 'pp-';
const LXC_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const DEFAULT_LXC_TARGET = '/opt/app';
const MCP_TMP_DIR = process.env.ZIP_UPLOAD_TMP_DIR || join(os.tmpdir(), 'proxypilot-zip-uploads');

function validTargetDir(p) {
  const s = String(p || '').trim();
  if (!s.startsWith('/') || s.includes('..') || /[\u0000-\u001f\u007f]/.test(s)) return null;
  return s.replace(/\/+$/, '') || '/';
}

// ---- token auth ----

function findToken(rawToken) {
  if (!rawToken) return null;
  try {
    const row = getDb()
      .prepare(`SELECT * FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL`)
      .get(hashMcpToken(rawToken));
    if (!row) return null;
    getDb().prepare(`UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), row.id);
    return row;
  } catch { return null; }   // pre-migration
}

// ---- upload tickets (in-memory; single-use; TTL) ----

const uploadTickets = new Map(); // ticket -> { createdAt, filePath|null }

function sweepTickets() {
  const cutoff = Date.now() - UPLOAD_TICKET_TTL_MS;
  for (const [t, rec] of uploadTickets) {
    if (rec.createdAt < cutoff) {
      if (rec.filePath) rm(rec.filePath, { force: true }).catch(() => {});
      uploadTickets.delete(t);
    }
  }
}

// Resolve the zip bytes for an inspect tool: ticket (uploaded file) or inline
// base64. Returns { buf, cleanup } or throws a user-facing Error.
async function zipBytesFromArgs(args) {
  if (args.ticket) {
    if (!looksLikeUploadTicket(args.ticket)) throw new Error('Invalid upload ticket');
    const rec = uploadTickets.get(args.ticket);
    if (!rec || !rec.filePath) throw new Error('Upload ticket unknown, expired, or no bytes were uploaded to it yet');
    uploadTickets.delete(args.ticket);
    const buf = await readFile(rec.filePath);
    return { buf, tmpPath: rec.filePath };
  }
  if (args.zip_base64) {
    const buf = Buffer.from(String(args.zip_base64), 'base64');
    if (buf.length === 0) throw new Error('zip_base64 decoded to zero bytes');
    if (buf.length > INLINE_ZIP_MAX_BYTES) {
      throw new Error(`Inline zips are limited to ${Math.floor(INLINE_ZIP_MAX_BYTES / (1024 * 1024))} MB — use create_upload_ticket for this archive`);
    }
    const tmpPath = join(MCP_TMP_DIR, `mcp-${randomBytes(12).toString('hex')}.zip`);
    await mkdir(MCP_TMP_DIR, { recursive: true }).catch(() => {});
    await writeFile(tmpPath, buf);
    return { buf, tmpPath };
  }
  throw new Error('Provide either an upload ticket or zip_base64');
}

// ---- mock2 (projects) access — gated exactly like the UI router ----

function mock2Enabled() {
  return resolveMock2Gate({ env: process.env, existsSync }).enabled;
}

async function mock2Modules() {
  if (!mock2Enabled()) throw new Error('The Projects module is not enabled on this ProxyPilot install');
  const [projects, cycles, queue, chats, domains, provision, cloneLogic, assets, projectLogic, requests,
    cycleEvents, changeRecords, framework] = await Promise.all([
    import('../mock2/projects.js'), import('../mock2/cycles.js'), import('../mock2/build-queue.js'),
    import('../mock2/chats.js'), import('../mock2/domains.js'), import('../mock2/provision.js'),
    import('../mock2/clone-logic.js'), import('../mock2/project-assets.js'), import('../mock2/project-logic.js'),
    import('../mock2/requests.js'),
    import('../mock2/cycle-events.js'), import('../mock2/change-records.js'), import('../mock2/framework.js'),
  ]);
  return { projects, cycles, queue, chats, domains, provision, cloneLogic, assets, projectLogic, requests,
    cycleEvents, changeRecords, framework };
}

// Builds that SHIPPED but still await the operator's verification checks.
// Surfaced on get_project and echoed by send_project_build because re-sending
// an instruction that already shipped is paid for twice: the operator's export
// showed a $1.71 build re-queued in full because nothing at queue time said
// "that one is done — it's waiting for you to verify it".
function pendingVerification(m, projectId) {
  return m.cycles.listCyclesForProject(projectId, { limit: 50 })
    .filter((c) => c.verification_state === 'pending')
    .map((c) => {
      const req = c.request_id ? m.requests.getRequest(c.request_id) : null;
      return {
        cycle_id: c.id,
        instruction: req ? String(req.instruction || '').slice(0, 160) : null,
        finished_at: c.finished_at || c.updated_at || null,
      };
    });
}

function projectUrl(project, domains) {
  if (!project?.slug || !project?.parent_domain_id) return null;
  const parent = domains.getParentDomain(project.parent_domain_id);
  return parent ? `https://${project.slug}.${parent.domain}` : null;
}

function projectSummary(project, m) {
  const cycle = m.cycles.latestCycle(project.id);
  return {
    id: project.id,
    name: project.name,
    url: projectUrl(project, m.domains),
    lifecycle: project.lifecycle,
    latest_build: cycle ? { id: cycle.id, status: cycle.status, mode: cycle.build_mode || null, updated_at: cycle.updated_at || null } : null,
  };
}

/* ------------------------------- tools ---------------------------------- */

async function toolListStaticSites() {
  const rows = getDb().prepare(`SELECT id, name, domain, type, enabled FROM services WHERE type = 'static' ORDER BY name`).all();
  return toolResult({ sites: rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain, enabled: !!r.enabled })) });
}

function toolCreateUploadTicket(req) {
  sweepTickets();
  const ticket = mintUploadTicket();
  uploadTickets.set(ticket, { createdAt: Date.now(), filePath: null });
  const base = publicBaseUrl(req);
  return toolResult({
    ticket,
    upload_url: `${base}/api/mcp/upload/${ticket}`,
    method: 'PUT',
    content_type: 'application/zip',
    expires_in_seconds: Math.floor(UPLOAD_TICKET_TTL_MS / 1000),
  });
}

async function toolInspectStaticSiteZip(args, auth) {
  const service = getDb().prepare(`SELECT id, name, data_dir, type FROM services WHERE id = ? AND type = 'static'`).get(Number(args.service_id));
  if (!service || !service.data_dir) return toolResult('Static site not found — use list_static_sites for valid ids', { isError: true });
  const { buf, tmpPath } = await zipBytesFromArgs(args);
  let parsed;
  try {
    parsed = parseZip(buf);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    if (err instanceof ZipError) return toolResult(`Invalid zip: ${err.message}`, { isError: true });
    throw err;
  }
  const wrapperDir = detectWrapperDir(parsed.entries);
  const variant = (entries) => ({
    file_count: entries.filter((e) => !e.isDirectory).length,
    conflicts: existsSync(service.data_dir) ? findConflicts(entries, fsExistsKind(service.data_dir)) : [],
  });
  const rec = stageZipUpload({ kind: 'service', refId: String(service.id), zipPath: tmpPath, entries: parsed.entries, wrapperDir });
  logAudit(auth.created_by, 'ZIP_UPLOAD_INSPECTED', 'service', service.id, { via: 'mcp', bytes: buf.length, wrapperDir }, null);
  return toolResult({
    upload_id: rec.id,
    site: { id: service.id, name: service.name },
    zip_bytes: buf.length,
    wrapper_dir: wrapperDir,
    raw: variant(parsed.entries),
    stripped: wrapperDir ? variant(effectiveEntries(parsed.entries, true)) : null,
    next: 'Show the user any conflicts, then call apply_static_site_zip (confirm_overwrite: true only after they approve).',
  });
}

async function toolApplyStaticSiteZip(args, auth) {
  const service = getDb().prepare(`SELECT id, name, data_dir, type FROM services WHERE id = ? AND type = 'static'`).get(Number(args.service_id));
  if (!service || !service.data_dir) return toolResult('Static site not found', { isError: true });
  const rec = getZipUpload(String(args.upload_id), 'service', String(service.id));
  if (!rec) return toolResult('Upload not found or expired — inspect the zip again', { isError: true });

  const stripWrapper = args.strip_wrapper !== false;
  const entries = effectiveEntries(rec.entries, stripWrapper);
  const conflicts = existsSync(service.data_dir) ? findConflicts(entries, fsExistsKind(service.data_dir)) : [];
  if (conflicts.length > 0 && args.confirm_overwrite !== true) {
    return toolResult({
      applied: false,
      needs_confirmation: true,
      conflicts,
      message: `${conflicts.length} file(s) already exist and would be replaced (each kept as <name>.old). Ask the user, then re-call with confirm_overwrite: true.`,
    });
  }
  const stagingDir = join(service.data_dir, `.pp-zip-stage-${rec.id}`);
  try {
    const zipBuf = await readFile(rec.zipPath);
    await extractToStaging(zipBuf, entries, stagingDir);
    await applyStagingToTarget(stagingDir, service.data_dir, entries, conflicts);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (err instanceof ZipError) return toolResult(`Extraction failed: ${err.message}`, { isError: true });
    throw err;
  } finally {
    await discardZipUpload(rec.id);
  }
  logAudit(auth.created_by, 'ZIP_UPLOAD_APPLIED', 'service', service.id, { via: 'mcp', files: entries.filter((e) => !e.isDirectory).length, replaced: conflicts.length }, null);
  return toolResult({
    applied: true,
    files_written: entries.filter((e) => !e.isDirectory).length,
    replaced: conflicts,
    site: { id: service.id, name: service.name },
  });
}

// One batched in-container existence check answering for every variant —
// returns the findConflicts-compatible lookup (same shape as the UI route).
async function lxcExistsKind(incusName, targetDir, variantEntries) {
  const query = new Set();
  for (const entries of variantEntries) {
    for (const p of collectCandidatePaths(entries)) query.add(p);
  }
  const { files, dirs } = await checkContainerConflicts(incusName, targetDir, [...query]);
  const kind = new Map();
  for (const f of files) kind.set(f, 'file');
  for (const d of dirs) kind.set(d, 'dir');
  return (p) => kind.get(p) || null;
}

async function toolListLxcContainers() {
  const out = await runHostCapture('incus', ['list', '--format', 'json'], { timeoutMs: 30000 });
  let list = [];
  try { list = JSON.parse(out.stdout || '[]'); } catch { /* fall through */ }
  const containers = list
    .filter((c) => String(c.name || '').startsWith(LXC_PREFIX))
    .map((c) => ({
      name: String(c.name).slice(LXC_PREFIX.length),
      status: c.status || null,
      ip: c.state?.network?.eth0?.addresses?.find((a) => a.family === 'inet')?.address || null,
    }));
  return toolResult({ containers });
}

async function toolInspectLxcZip(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const targetDir = validTargetDir(args.target_dir || DEFAULT_LXC_TARGET);
  if (!targetDir) return toolResult('target_dir must be an absolute path inside the container (e.g. /opt/app)', { isError: true });
  const incusName = `${LXC_PREFIX}${name}`;

  const { buf, tmpPath } = await zipBytesFromArgs(args);
  let parsed;
  try {
    parsed = parseZip(buf);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    if (err instanceof ZipError) return toolResult(`Invalid zip: ${err.message}`, { isError: true });
    throw err;
  }
  const wrapperDir = detectWrapperDir(parsed.entries);
  const rawEntries = parsed.entries;
  const strippedEntries = wrapperDir ? effectiveEntries(parsed.entries, true) : null;
  let raw, stripped = null, existingStartup = null;
  try {
    const existsKind = await lxcExistsKind(
      incusName, targetDir,
      strippedEntries ? [rawEntries, strippedEntries] : [rawEntries],
    );
    const variant = (entries) => ({
      file_count: entries.filter((e) => !e.isDirectory).length,
      conflicts: findConflicts(entries, existsKind),
      ...startupCandidates(entries),
    });
    raw = variant(rawEntries);
    if (strippedEntries) stripped = variant(strippedEntries);
    existingStartup = await readContainerStartup(incusName).catch(() => null);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    return toolResult(`Cannot inspect container ${name} — is it running? (${err.message})`, { isError: true });
  }
  const rec = stageZipUpload({ kind: 'lxc', refId: name, zipPath: tmpPath, entries: parsed.entries, wrapperDir, targetDir });
  logAudit(auth.created_by, 'LXC_ZIP_UPLOAD_INSPECTED', 'lxc', name, { via: 'mcp', bytes: buf.length, targetDir, wrapperDir }, null);
  return toolResult({
    upload_id: rec.id,
    container: name,
    target_dir: targetDir,
    zip_bytes: buf.length,
    wrapper_dir: wrapperDir,
    raw,
    stripped,
    existing_startup: existingStartup,
    next: 'Show the user any conflicts (and the startup plan), then call apply_lxc_zip.',
  });
}

async function toolApplyLxcZip(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const rec = getZipUpload(String(args.upload_id), 'lxc', name);
  if (!rec) return toolResult('Upload not found or expired — inspect the zip again', { isError: true });
  const incusName = `${LXC_PREFIX}${name}`;
  const { targetDir } = rec;
  const stripWrapper = args.strip_wrapper !== false;
  const runStartup = args.run_startup !== false;
  const startupScript = typeof args.startup_script === 'string' && args.startup_script ? args.startup_script : null;
  const entries = effectiveEntries(rec.entries, stripWrapper);

  if (startupScript && !entries.some((e) => !e.isDirectory && e.path === startupScript)) {
    return toolResult(`Startup script not found in the zip: ${startupScript}`, { isError: true });
  }
  let conflicts;
  try {
    conflicts = findConflicts(entries, await lxcExistsKind(incusName, targetDir, [entries]));
  } catch (err) {
    return toolResult(`Cannot inspect container ${name} — is it running? (${err.message})`, { isError: true });
  }
  if (conflicts.length > 0 && args.confirm_overwrite !== true) {
    return toolResult({
      applied: false, needs_confirmation: true, conflicts,
      message: `${conflicts.length} file(s) already exist in ${targetDir} and would be replaced (each kept as <name>.old). Ask the user, then re-call with confirm_overwrite: true.`,
    });
  }
  const existingStartup = startupScript ? await readContainerStartup(incusName).catch(() => null) : null;
  const scriptAbs = startupScript ? `${targetDir}/${startupScript}` : null;
  const startupReplaced = Boolean(existingStartup && scriptAbs && existingStartup.scriptPath !== scriptAbs);
  if (startupReplaced && args.confirm_replace_startup !== true) {
    return toolResult({
      applied: false, needs_confirmation: true, startup_conflict: existingStartup,
      message: 'A startup script is already registered for this container. Ask the user, then re-call with confirm_replace_startup: true.',
    });
  }

  const tarPath = `${rec.zipPath}.tar`;
  try {
    const zipBuf = await readFile(rec.zipPath);
    await writeTarFromZip(zipBuf, entries, tarPath);
    await applyTarToContainer(incusName, { targetDir, stageName: `.pp-zip-stage-${rec.id}`, conflicts, tarPath });
  } catch (err) {
    await rm(tarPath, { force: true }).catch(() => {});
    await discardZipUpload(rec.id);
    return toolResult(`Extraction failed: ${err.message}`, { isError: true });
  }
  let startup = null;
  if (startupScript) {
    startup = await setupStartupScript(incusName, {
      scriptPath: scriptAbs,
      workingDir: targetDir,
      previousScriptPath: startupReplaced ? existingStartup.scriptPath : null,
      runNow: runStartup,
    }, { runTimeoutMs: parseInt(process.env.PROXYPILOT_STARTUP_RUN_TIMEOUT_MS || '120000', 10) });
  }
  await rm(tarPath, { force: true }).catch(() => {});
  await discardZipUpload(rec.id);
  logAudit(auth.created_by, 'LXC_ZIP_UPLOAD_APPLIED', 'lxc', name, {
    via: 'mcp', files: entries.filter((e) => !e.isDirectory).length, replaced: conflicts.length, startupScript,
  }, null);
  return toolResult({
    applied: true,
    files_written: entries.filter((e) => !e.isDirectory).length,
    replaced: conflicts,
    target_dir: targetDir,
    startup,
  });
}

// ---- single-file LXC editing (the chat-only "update and redeploy" loop:
// read → propose → write with .old backup → rerun_startup) ----

const LXC_FILE_READ_CAP = 512 * 1024;
const LXC_FILE_WRITE_CAP = 2 * 1024 * 1024;

// Absolute path inside the container. Executed via argv (no shell string for
// the path itself), so spaces are fine — only control chars and traversal
// dots are rejected as nonsense.
function validLxcFilePath(p) {
  const s = String(p || '').trim();
  if (!s.startsWith('/') || s.includes('..') || /[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

async function toolReadLxcFile(args) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const path = validLxcFilePath(args.path);
  if (!path) return toolResult('path must be an absolute file path inside the container', { isError: true });
  const r = await runHostCapture(
    'incus', ['exec', `${LXC_PREFIX}${name}`, '--', 'sh', '-c', 'p="$1"; test -f "$p" || { echo "PP_NOT_A_FILE" >&2; exit 66; }; wc -c < "$p"; head -c 524288 -- "$p"', 'sh', path],
    { timeoutMs: 30000 },
  );
  if (r.status === 66) return toolResult(`Not a file: ${path}`, { isError: true });
  if (r.status !== 0) {
    return toolResult(`Could not read ${path} — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const nl = r.stdout.indexOf('\n');
  const size = Number(String(r.stdout.slice(0, nl)).trim()) || 0;
  const body = Buffer.from(r.stdout.slice(nl + 1), 'utf8');
  if (body.includes(0)) return toolResult(`${path} looks binary — this tool reads text files only`, { isError: true });
  return toolResult({
    path, size_bytes: size,
    truncated: size > LXC_FILE_READ_CAP,
    content: body.toString('utf8'),
  });
}

async function toolWriteLxcFile(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const path = validLxcFilePath(args.path);
  if (!path) return toolResult('path must be an absolute file path inside the container', { isError: true });
  const content = String(args.content ?? '');
  if (Buffer.byteLength(content) > LXC_FILE_WRITE_CAP) {
    return toolResult(`Content exceeds the ${Math.floor(LXC_FILE_WRITE_CAP / (1024 * 1024))} MB single-file cap — use the zip flow for bigger payloads`, { isError: true });
  }
  const incusName = `${LXC_PREFIX}${name}`;

  // Ask-first when the file exists — same contract as every other overwrite.
  const probe = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', 'p="$1"; if [ -e "$p" ]; then echo EXISTS; wc -c < "$p"; else echo ABSENT; fi', 'sh', path],
    { timeoutMs: 30000 },
  );
  if (probe.status !== 0) {
    return toolResult(`Cannot inspect ${name} — is it running? ${(probe.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const exists = probe.stdout.startsWith('EXISTS');
  if (exists && args.confirm_overwrite !== true) {
    const size = Number(String(probe.stdout.split('\n')[1] || '').trim()) || 0;
    return toolResult({
      written: false,
      needs_confirmation: true,
      path,
      existing_size_bytes: size,
      message: `${path} already exists (${size} bytes; it will be kept as ${path}.old). Show the user your proposed change and re-call with confirm_overwrite: true after they approve.`,
    });
  }

  const w = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', 'set -e; p="$1"; if [ -e "$p" ]; then rm -rf -- "$p.old"; cp -a -- "$p" "$p.old"; fi; mkdir -p "$(dirname -- "$p")"; cat > "$p"', 'sh', path],
    { input: content, timeoutMs: 60000 },
  );
  if (w.status !== 0) {
    return toolResult(`Write failed: ${(w.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  logAudit(auth.created_by, 'LXC_FILE_WRITTEN', 'lxc', name, { via: 'mcp', path, bytes: Buffer.byteLength(content), replaced: exists }, null);
  return toolResult({
    written: true, path, bytes: Buffer.byteLength(content),
    backup: exists ? `${path}.old` : null,
    next: 'If this container has a registered startup script, redeploy with rerun_startup.',
  });
}

async function toolRerunStartup(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const incusName = `${LXC_PREFIX}${name}`;
  const startup = await readContainerStartup(incusName).catch(() => null);
  if (!startup?.scriptPath) {
    return toolResult('No startup script is registered for this container — deploy one via apply_lxc_zip (startup_script) first', { isError: true });
  }
  const wd = startup.workingDir || '/';
  const r = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', 'cd "$1" && exec "$2"', 'sh', wd, startup.scriptPath],
    { timeoutMs: parseInt(process.env.PROXYPILOT_STARTUP_RUN_TIMEOUT_MS || '120000', 10) },
  );
  logAudit(auth.created_by, 'LXC_STARTUP_RERUN', 'lxc', name, { via: 'mcp', script: startup.scriptPath, exit: r.status }, null);
  return toolResult({
    script: startup.scriptPath,
    working_dir: wd,
    exit_code: r.status,
    timed_out: !!r.timedOut,
    stdout: r.stdout.slice(-16 * 1024),
    stderr: r.stderr.slice(-16 * 1024),
  });
}

async function toolListProjects() {
  const m = await mock2Modules();
  const rows = m.projects.listProjects().filter((p) => p.lifecycle !== 'failed_provisioning');
  return toolResult({ projects: rows.map((p) => projectSummary(p, m)) });
}

async function toolGetProject(args) {
  const m = await mock2Modules();
  const project = m.projects.getProject(Number(args.project_id));
  if (!project) return toolResult('Project not found', { isError: true });
  const summary = projectSummary(project, m);
  const provisionStatus = m.provision.getProvisionStatus(project.id);
  const queueRows = m.queue.listBuildQueue(project.id).filter((r) => r.status === 'queued');
  const pending = pendingVerification(m, project.id);
  return toolResult({
    ...summary,
    description: project.description || null,
    provisioning: provisionStatus ? { phase: provisionStatus.phase, message: provisionStatus.message, error: provisionStatus.error || null } : null,
    queued_builds: queueRows.map((r) => ({ id: r.id, instruction: String(r.instruction || '').slice(0, 200) })),
    pending_verification: pending,
    ...(pending.length ? { note: `${pending.length} shipped build(s) await the operator's verification checks in the build chat — check them before queuing an instruction that may repeat one.` } : {}),
  });
}

async function toolSendProjectBuild(args, auth) {
  const m = await mock2Modules();
  const project = m.projects.getProject(Number(args.project_id));
  if (!project) return toolResult('Project not found', { isError: true });
  if (project.lifecycle !== 'active') {
    return toolResult(`Project is ${project.lifecycle} — it must be active (wake/rehydrate it from the UI first)`, { isError: true });
  }
  const instruction = String(args.instruction || '').trim();
  if (!instruction) return toolResult('An instruction is required', { isError: true });
  const row = m.queue.enqueueBuild({ projectId: project.id, instruction, buildMode: 'quick', initiatedBy: auth.created_by });
  try {
    m.chats.insertMessage({ projectId: project.id, authorUserId: auth.created_by, kind: 'user', body: instruction });
  } catch { /* chat echo is best-effort */ }
  // If the project is idle the drain starts it immediately; otherwise it runs
  // when the current build finishes.
  m.queue.drainBuildQueue(project.id).catch(() => {});
  logAudit(auth.created_by, 'MOCK2_BUILD_QUEUED', 'mock2_project', project.id, { via: 'mcp', queue_id: row.id }, null);
  const pending = pendingVerification(m, project.id);
  return toolResult({
    queued: true, queue_id: row.id,
    message: 'Build queued — it starts immediately if the project is idle. Poll get_project for status.',
    ...(pending.length ? {
      pending_verification: pending,
      warning: `${pending.length} earlier shipped build(s) still await operator verification — if this instruction repeats one of them, cancel it (cancel_queued_build) and verify instead of paying to rebuild.`,
    } : {}),
  });
}

async function toolUploadProjectReference(args, auth) {
  const m = await mock2Modules();
  const project = m.projects.getProject(Number(args.project_id));
  if (!project) return toolResult('Project not found', { isError: true });
  const content = String(args.content || '');
  if (!content.trim()) return toolResult('content is required', { isError: true });
  const asset = m.assets.addDocument({
    projectId: project.id,
    name: String(args.name || 'reference.txt'),
    buffer: Buffer.from(content, 'utf8'),
    createdBy: auth.created_by,
  });
  // Kick the async summary pass so builds see a brief, not a pending note.
  try {
    const { queueDocumentSummaries } = await import('../mock2/asset-summary.js');
    queueDocumentSummaries(project.id, [asset.id]);
  } catch { /* advisory */ }
  return toolResult({ added: true, asset_id: asset.id, name: asset.name });
}

async function toolCloneProject(args, auth) {
  const m = await mock2Modules();
  const source = m.projects.getProject(Number(args.project_id));
  const mode = m.cloneLogic.normalizeCloneMode(args.mode || 'fresh');
  if (!mode) return toolResult("mode must be 'fresh' or 'full'", { isError: true });
  const srcErr = m.cloneLogic.cloneSourceError(source, mode);
  if (srcErr) return toolResult(srcErr, { isError: true });
  const name = String(args.name || '').trim();
  if (!name) return toolResult('A name for the clone is required', { isError: true });
  const parentId = Number(source.parent_domain_id);
  let slug;
  try {
    slug = m.projects.deriveProjectSlug(parentId, name);
  } catch (err) {
    return toolResult(err.message, { isError: true });
  }
  let project = m.projects.createProject({
    name, description: source.description, parentDomainId: parentId, slug,
    repoPathFor: m.provision.repoPathForProject,
    containerNameFor: m.provision.containerNameForProject,
    createdBy: auth.created_by,
  });
  if (auth.created_by) {
    m.projects.upsertMember({ projectId: project.id, userId: auth.created_by, role: 'editor', invitedBy: auth.created_by });
  }
  project = m.projects.updateProject(project.id, m.cloneLogic.cloneCopyPatch(source));
  let assetsCopied = 0;
  try { assetsCopied = m.assets.copyProjectAssets(source.id, project.id); } catch { /* non-fatal */ }
  logAudit(auth.created_by, 'MOCK2_PROJECT_CLONE', 'mock2_project', project.id, { via: 'mcp', source_project_id: source.id, mode }, null);
  m.provision.startCloneProvision(project, {
    sourceRepoPath: source.repo_path || m.provision.repoPathForProject(source.id),
    sourceContainerName: source.container_name || m.provision.containerNameForProject(source.id),
    copyDatabase: mode === 'full',
  });
  return toolResult({
    cloned: true, mode, assets_copied: assetsCopied,
    project: { id: project.id, name: project.name, url: projectUrl(project, m.domains), lifecycle: project.lifecycle },
    message: 'Clone provisioning started — poll get_project on the new id until lifecycle is active.',
  });
}

// ---- project build control + chat-only project file editing ----
//
// The two AI lanes, made explicit: send_project_build spends the project's own
// configured API budget (harness, gates, change records); the tools below let
// the CHAT do the thinking on the operator's subscription while ProxyPilot
// only executes file ops — read → propose → write (git-committed) → redeploy.
// Writes and redeploys are refused while a build cycle is live, so the chat
// lane never fights the harness for the checkout (ADR-004 spirit).

const M2_APP_DIR = '/srv/app';
const LIVE_CYCLE_STATUSES = ['queued', 'estimating', 'running'];

function projectContainerName(m, project) {
  return project.container_name || m.provision.containerNameForProject(project.id);
}

function liveBuildGuard(m, project) {
  const cycle = m.cycles.latestCycle(project.id);
  if (cycle && LIVE_CYCLE_STATUSES.includes(cycle.status)) {
    return `A build is ${cycle.status} on this project — editing under it would collide with the build's own changes. Stop it first (interrupt_project_build) or send the change as a build instruction instead.`;
  }
  return null;
}

// Stage, commit and push one or more paths in a project's checkout.
//
// Extracted from toolWriteProjectFile so the edit/delete/move tools commit the
// SAME way — same identity, same push, same "nothing actually changed" answer.
// The message rides as $1 and the paths as "$@" after a shift, so neither is
// ever interpolated into the script text.
async function commitProjectPaths(incusName, paths, message) {
  const script = 'set -e; cd /srv/app; msg="$1"; shift; git add -A -- "$@"; '
    + 'if git diff --cached --quiet -- "$@"; then echo PP_NOCHANGE; '
    + 'else git -c user.email=mcp@proxypilot -c user.name="ProxyPilot MCP" commit -q -m "$msg" -- "$@"; fi; '
    + 'git push -q origin HEAD:main 2>/dev/null || echo PP_PUSH_FAILED >&2; git rev-parse HEAD';
  const c = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', script, 'sh', String(message).slice(0, 200), ...paths],
    { timeoutMs: 60000 },
  );
  const unchanged = /PP_NOCHANGE/.test(c.stdout);
  const sha = (c.stdout.trim().split('\n').pop() || '').trim();
  return {
    committed: c.status === 0 && !unchanged,
    unchanged,
    commit: /^[0-9a-f]{40}$/.test(sha) ? sha : null,
    push_failed: /PP_PUSH_FAILED/.test(c.stderr || ''),
  };
}

function requireActiveProject(m, args) {
  const project = m.projects.getProject(Number(args.project_id));
  if (!project) return { error: 'Project not found' };
  if (project.lifecycle !== 'active') {
    return { error: `Project is ${project.lifecycle} — its container must be online (wake/rehydrate it from the UI first)` };
  }
  return { project };
}

async function toolInterruptProjectBuild(args, auth) {
  const m = await mock2Modules();
  const project = m.projects.getProject(Number(args.project_id));
  if (!project) return toolResult('Project not found', { isError: true });
  const cycle = m.cycles.latestCycle(project.id);
  if (!cycle || !LIVE_CYCLE_STATUSES.includes(cycle.status)) {
    return toolResult(`No build is running on ${project.name}${cycle ? ` (latest cycle is ${cycle.status})` : ''}`, { isError: true });
  }
  const action = args.action === 'abandon' ? 'abandon' : 'stop_after_step';
  m.cycles.setInterrupt(cycle.id, action);
  logAudit(auth.created_by, 'MOCK2_CYCLE_INTERRUPT', 'mock2_cycle', cycle.id, { via: 'mcp', action }, null);
  return toolResult({
    interrupted: true, cycle_id: cycle.id, action,
    message: action === 'abandon'
      ? 'The build stops at its next step boundary and the cycle is discarded.'
      : 'The build checkpoints and stops at its next step boundary (resumable from the UI). Poll get_project to confirm.',
  });
}

async function toolCancelQueuedBuild(args, auth) {
  const m = await mock2Modules();
  const project = m.projects.getProject(Number(args.project_id));
  if (!project) return toolResult('Project not found', { isError: true });
  const r = m.queue.cancelQueuedBuild(project.id, Number(args.queue_id));
  if (!r.ok) return toolResult(r.error, { isError: true });
  logAudit(auth.created_by, 'MOCK2_BUILD_CANCELLED', 'mock2_project', project.id, { via: 'mcp', queue_id: Number(args.queue_id) }, null);
  return toolResult({ cancelled: true, queue_id: Number(args.queue_id) });
}

async function toolListProjectFiles(args) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  let sub = '';
  if (args.subdir != null && String(args.subdir).trim() !== '') {
    sub = validProjectFilePath(args.subdir);
    if (!sub) return toolResult('subdir must be a relative directory inside the app (no .., no leading /)', { isError: true });
  }
  const argv = ['exec', projectContainerName(m, project), '--', 'git', '-C', M2_APP_DIR, 'ls-files'];
  if (sub) argv.push('--', sub);
  const r = await runHostCapture('incus', argv, { timeoutMs: 30000 });
  if (r.status !== 0) {
    return toolResult(`Could not list files — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const files = r.stdout.split('\n').filter(Boolean);
  return toolResult({ file_count: files.length, files: files.slice(0, 2000), truncated: files.length > 2000 });
}

async function toolReadProjectFile(args) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const rel = validProjectFilePath(args.path);
  if (!rel) return toolResult('path must be a file path relative to the app root, e.g. src/server/routes.ts', { isError: true });
  const abs = `${M2_APP_DIR}/${rel}`;
  const range = normalizeReadRange(args.offset, args.limit);

  // Size and line count come back on their own two lines FIRST, so total_lines
  // reports the file's real length whether or not a window was asked for —
  // that is what lets a ranged read say how much it did not return. The window
  // is cut with sed INSIDE the container, so a 20-line read of a 2,000-line
  // file moves 20 lines over the wire, which is the whole point.
  const script = 'p="$1"; test -f "$p" || { echo "PP_NOT_A_FILE" >&2; exit 66; }; '
    + 'wc -c < "$p"; wc -l < "$p"; '
    + 'if [ "$2" = "all" ]; then head -c "$4" -- "$p"; else sed -n "$2,$3p" "$p" | head -c "$4"; fi';
  const startArg = range.ranged ? String(range.start) : 'all';
  const endArg = range.ranged ? (range.end === null ? '$' : String(range.end)) : '0';
  const r = await runHostCapture(
    'incus',
    ['exec', projectContainerName(m, project), '--', 'sh', '-c', script,
      'sh', abs, startArg, endArg, String(LXC_FILE_READ_CAP)],
    { timeoutMs: 30000 },
  );
  if (r.status === 66) return toolResult(`Not a file: ${rel} (use list_project_files to see the tracked files)`, { isError: true });
  if (r.status !== 0) {
    return toolResult(`Could not read ${rel} — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const nl1 = r.stdout.indexOf('\n');
  const nl2 = r.stdout.indexOf('\n', nl1 + 1);
  const size = Number(r.stdout.slice(0, nl1).trim()) || 0;
  // `wc -l` counts newlines, so a file with no trailing newline reads one
  // short — the max with 1 keeps a single unterminated line from being 0.
  const newlines = Number(r.stdout.slice(nl1 + 1, nl2).trim()) || 0;
  const totalLines = size === 0 ? 0 : Math.max(newlines, 1);
  const body = Buffer.from(r.stdout.slice(nl2 + 1), 'utf8');
  if (body.includes(0)) return toolResult(`${rel} looks binary — this tool reads text files only`, { isError: true });
  const content = body.toString('utf8');
  const returnedLines = content === '' ? 0 : content.replace(/\n$/, '').split('\n').length;

  const out = {
    path: rel,
    size_bytes: size,
    total_lines: totalLines,
    content,
  };
  if (range.ranged) {
    out.offset = range.start;
    out.limit = range.count;
    out.returned_lines = returnedLines;
    out.truncated = body.length >= LXC_FILE_READ_CAP;
    if (range.start > totalLines && totalLines > 0) {
      out.note = `offset ${range.start} is past the end of the file (${totalLines} lines).`;
    }
  } else {
    out.truncated = size > LXC_FILE_READ_CAP;
  }
  return toolResult(out);
}

async function toolWriteProjectFile(args, auth) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const guard = liveBuildGuard(m, project);
  if (guard) return toolResult(guard, { isError: true });
  const rel = validProjectFilePath(args.path);
  if (!rel) return toolResult('path must be a file path relative to the app root, e.g. src/server/routes.ts', { isError: true });
  const content = String(args.content ?? '');
  if (Buffer.byteLength(content) > LXC_FILE_WRITE_CAP) {
    return toolResult(`Content exceeds the ${Math.floor(LXC_FILE_WRITE_CAP / (1024 * 1024))} MB single-file cap`, { isError: true });
  }
  const incusName = projectContainerName(m, project);
  const abs = `${M2_APP_DIR}/${rel}`;

  // Ask-first when the file exists — same contract as every other overwrite.
  // git history (not a .old copy) is the backup here: a stray .old inside the
  // checkout would ride into the next build's diff.
  const probe = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', 'p="$1"; if [ -e "$p" ]; then echo EXISTS; wc -c < "$p"; else echo ABSENT; fi', 'sh', abs],
    { timeoutMs: 30000 },
  );
  if (probe.status !== 0) {
    return toolResult(`Cannot inspect the project container — is it running? ${(probe.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const exists = probe.stdout.startsWith('EXISTS');
  if (exists && args.confirm_overwrite !== true) {
    const size = Number(String(probe.stdout.split('\n')[1] || '').trim()) || 0;
    return toolResult({
      written: false,
      needs_confirmation: true,
      path: rel,
      existing_size_bytes: size,
      message: `${rel} already exists (${size} bytes; the previous version stays in git history). Show the user your proposed change and re-call with confirm_overwrite: true after they approve.`,
    });
  }

  const w = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', 'set -e; p="$1"; mkdir -p "$(dirname -- "$p")"; cat > "$p"', 'sh', abs],
    { input: content, timeoutMs: 60000 },
  );
  if (w.status !== 0) {
    return toolResult(`Write failed: ${(w.stderr || '').trim().slice(-300)}`, { isError: true });
  }

  // Commit the edit and push to the project's bare repo, so it survives
  // rehydrate and shows in the project's history like any other change.
  const git = await commitProjectPaths(incusName, [rel], args.commit_message || `chat edit: ${rel}`);
  logAudit(auth.created_by, 'MOCK2_FILE_WRITTEN', 'mock2_project', project.id, { via: 'mcp', path: rel, bytes: Buffer.byteLength(content), replaced: exists }, null);
  return toolResult({
    written: true, path: rel, bytes: Buffer.byteLength(content),
    ...git,
    next: 'When your edits are complete, apply them with redeploy_project.',
  });
}

// edit_project_file — the surgical write.
//
// Reads the file out, replaces in Node, writes it back. NOT sed/perl in the
// container: the caller's old_string is arbitrary text, and building a script
// around it is exactly the quoting hazard the positional-parameter convention
// everywhere else in this file exists to avoid. Doing it here also means the
// occurrence count is exact rather than whatever a regex engine thought.
//
// THE TRUNCATION TRAP: read_project_file caps at 512 KB. Replacing inside a
// truncated copy and writing it back would silently DELETE everything past the
// cap, so a file over the cap is refused outright rather than edited.
async function toolEditProjectFile(args, auth) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const guard = liveBuildGuard(m, project);
  if (guard) return toolResult(guard, { isError: true });
  const rel = validProjectFilePath(args.path);
  if (!rel) return toolResult('path must be a file path relative to the app root, e.g. src/server/routes.ts', { isError: true });

  const incusName = projectContainerName(m, project);
  const abs = `${M2_APP_DIR}/${rel}`;
  const r = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c',
      'p="$1"; test -f "$p" || { echo "PP_NOT_A_FILE" >&2; exit 66; }; wc -c < "$p"; cat -- "$p"', 'sh', abs],
    { timeoutMs: 30000 },
  );
  if (r.status === 66) return toolResult(`Not a file: ${rel} (use list_project_files to see the tracked files)`, { isError: true });
  if (r.status !== 0) {
    return toolResult(`Could not read ${rel} — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const nl = r.stdout.indexOf('\n');
  const size = Number(r.stdout.slice(0, nl).trim()) || 0;
  if (size > LXC_FILE_READ_CAP) {
    return toolResult(
      `${rel} is ${size} bytes, over the ${Math.floor(LXC_FILE_READ_CAP / 1024)} KB limit this tool can edit safely — editing it would risk truncating the part it cannot see. Use write_project_file with the complete new content instead.`,
      { isError: true },
    );
  }
  const before = r.stdout.slice(nl + 1);
  if (Buffer.from(before, 'utf8').includes(0)) {
    return toolResult(`${rel} looks binary — this tool edits text files only`, { isError: true });
  }

  const edited = applyStringEdit(before, args.old_string, args.new_string, args.expect_occurrences);
  if (edited.error) return toolResult(edited.error, { isError: true });

  const w = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', 'set -e; p="$1"; cat > "$p"', 'sh', abs],
    { input: edited.content, timeoutMs: 60000 },
  );
  if (w.status !== 0) {
    return toolResult(`Write failed: ${(w.stderr || '').trim().slice(-300)}`, { isError: true });
  }

  const git = await commitProjectPaths(incusName, [rel], args.commit_message || `chat edit: ${rel}`);
  logAudit(auth.created_by, 'MOCK2_FILE_EDITED', 'mock2_project', project.id, {
    via: 'mcp', path: rel, replaced: edited.replaced,
  }, null);
  return toolResult({
    edited: true,
    path: rel,
    replaced_count: edited.replaced,
    bytes: Buffer.byteLength(edited.content),
    ...git,
    next: 'When your edits are complete, apply them with redeploy_project.',
  });
}

// search_project_files — git grep over the tracked files.
//
// git grep rather than grep: it searches what is COMMITTED-and-tracked, skips
// .git and node_modules for free, and is fast on a big checkout. The pattern
// and pathspec are positional arguments to git — no shell — so regex
// punctuation needs no escaping and cannot become a command.
async function toolSearchProjectFiles(args) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const pattern = validSearchPattern(args.pattern);
  if (!pattern) return toolResult('pattern is required (an extended regular expression, up to 1000 characters, no control characters)', { isError: true });
  let glob = null;
  if (args.glob != null && String(args.glob).trim() !== '') {
    glob = validPathspec(args.glob);
    if (!glob) return toolResult('glob must be a relative git pathspec, e.g. "src/**/*.ts" (no leading / and no ..)', { isError: true });
  }
  const maxResults = normalizeMaxResults(args.max_results);

  const argv = ['exec', projectContainerName(m, project), '--',
    'git', '-C', M2_APP_DIR, 'grep', '-n', '-I', '-E'];
  if (args.ignore_case === true) argv.push('-i');
  argv.push('-e', pattern);
  if (glob) argv.push('--', glob);

  const r = await runHostCapture('incus', argv, { timeoutMs: 60000 });
  // git grep exits 1 for "no matches" — a result, not a failure.
  if (r.status !== 0 && r.status !== 1) {
    return toolResult(`Search failed: ${(r.stderr || '').trim().slice(-300) || 'is the container running?'}`, { isError: true });
  }
  const matches = parseGitGrepOutput(r.stdout, maxResults);
  const totalLines = r.stdout ? r.stdout.split('\n').filter(Boolean).length : 0;
  return toolResult({
    pattern, glob, match_count: matches.length,
    truncated: totalLines > matches.length,
    matches,
    next: matches.length
      ? 'Read the surrounding code with read_project_file using offset/limit around a line_number.'
      : 'No matches. Check the pattern (it is an extended regex, not a glob) or widen the pathspec.',
  });
}

async function toolDeleteProjectFile(args, auth) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const guard = liveBuildGuard(m, project);
  if (guard) return toolResult(guard, { isError: true });
  const rel = validProjectFilePath(args.path);
  if (!rel) return toolResult('path must be a file path relative to the app root', { isError: true });

  const incusName = projectContainerName(m, project);
  const r = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c',
      'p="$1"; test -e "$p" || { echo PP_ABSENT >&2; exit 66; }; rm -rf -- "$p"', 'sh', `${M2_APP_DIR}/${rel}`],
    { timeoutMs: 30000 },
  );
  if (r.status === 66) return toolResult(`${rel} does not exist in the checkout — nothing to delete.`, { isError: true });
  if (r.status !== 0) {
    return toolResult(`Delete failed: ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const git = await commitProjectPaths(incusName, [rel], args.commit_message || `chat delete: ${rel}`);
  logAudit(auth.created_by, 'MOCK2_FILE_DELETED', 'mock2_project', project.id, { via: 'mcp', path: rel }, null);
  return toolResult({
    deleted: true, path: rel, ...git,
    // `unchanged` here means the path was not tracked, so the removal is real
    // in the working tree but produced no commit — worth saying plainly.
    note: git.unchanged ? 'The file was not tracked by git, so there was nothing to commit — it is gone from the checkout but not recoverable from history.' : undefined,
    next: 'When your edits are complete, apply them with redeploy_project.',
  });
}

async function toolMoveProjectFile(args, auth) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const guard = liveBuildGuard(m, project);
  if (guard) return toolResult(guard, { isError: true });
  const from = validProjectFilePath(args.from);
  const to = validProjectFilePath(args.to);
  if (!from || !to) return toolResult('from and to must both be file paths relative to the app root', { isError: true });
  if (from === to) return toolResult('from and to are the same path — nothing to move.', { isError: true });

  const incusName = projectContainerName(m, project);
  const script = 'set -e; cd /srv/app; '
    + 'test -e "$1" || { echo PP_ABSENT >&2; exit 66; }; '
    + 'test -e "$2" && { echo PP_EXISTS >&2; exit 67; }; '
    + 'mkdir -p -- "$(dirname -- "$2")"; git mv -- "$1" "$2"';
  const r = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', script, 'sh', from, to],
    { timeoutMs: 30000 },
  );
  if (r.status === 66) return toolResult(`${from} does not exist in the checkout.`, { isError: true });
  if (r.status === 67) return toolResult(`${to} already exists — move refused rather than overwriting it.`, { isError: true });
  if (r.status !== 0) {
    return toolResult(`Move failed: ${(r.stderr || '').trim().slice(-300)}. git mv needs the source to be tracked; use read + write_project_file + delete_project_file for an untracked file.`, { isError: true });
  }
  const git = await commitProjectPaths(incusName, [from, to], args.commit_message || `chat move: ${from} → ${to}`);
  logAudit(auth.created_by, 'MOCK2_FILE_MOVED', 'mock2_project', project.id, { via: 'mcp', from, to }, null);
  return toolResult({
    moved: true, from, to, ...git,
    next: 'When your edits are complete, apply them with redeploy_project.',
  });
}

async function toolRedeployProject(args, auth) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const guard = liveBuildGuard(m, project);
  if (guard) return toolResult(guard, { isError: true });
  const [{ deployProject }, { DEFAULT_WEB_PORT }] = await Promise.all([
    import('../mock2/deploy.js'), import('../mock2/template.js'),
  ]);
  const steps = [];
  const res = await deployProject({
    containerName: projectContainerName(m, project),
    webPort: project.web_port || DEFAULT_WEB_PORT,
    onStep: (key, label) => steps.push(label || key),
  });
  logAudit(auth.created_by, 'MOCK2_PROJECT_REDEPLOY', 'mock2_project', project.id, { via: 'mcp', ok: !!res.ok, step: res.step || null }, null);
  if (!res.ok) {
    return toolResult(`Deploy failed at step "${res.step}": ${res.error}`, { isError: true });
  }
  return toolResult({
    deployed: true,
    skipped: !!res.skipped,
    steps,
    url: projectUrl(project, m.domains),
    message: res.skipped
      ? 'Nothing to deploy (no run contract — placeholder project).'
      : 'Deployed and health-checked — the live URL serves the current checkout.',
  });
}

// run_project_command — the verification lane the file tools could not reach.
//
// ENVIRONMENT PARITY IS THE POINT. This mirrors deploy.js's runInApp exactly
// (`set -a; . /etc/environment; cd <appDir>`), because a gates result produced
// in a different environment answers a different question than the one asked —
// and the reason to run it at all is to trust the answer.
//
// NO SHELL SEES THE CALLER'S INPUT. The argv arrives as POSITIONAL PARAMETERS
// (`sh -c '… "$@" …' sh npm run gates`) and is invoked as `"$@"`, so the tokens
// are passed to execve as-is and never re-parsed. Not `exec "$@"`, because the
// wrapper still has to read $? and tail the output afterwards.
// parseProjectCommand's charset check is a clarity guard, not the containment.
//
// OUTPUT IS THE TAIL, NOT THE HEAD. runHostCapture keeps the FIRST 256 KB it
// reads, which is the wrong end of a test run — the failure summary prints
// last. So each stream lands in a file inside the container and is tail'd
// there. Markers carry a per-call nonce so output that happens to contain the
// marker text cannot confuse the parse.
async function toolRunProjectCommand(args, auth) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const guard = liveBuildGuard(m, project);
  if (guard) return toolResult(guard, { isError: true });

  const parsed = parseProjectCommand(args.command);
  if (parsed.error) return toolResult(parsed.error, { isError: true });

  const incusName = projectContainerName(m, project);
  const timeoutMs = projectCommandTimeoutMs(args.timeout_seconds);
  const nonce = randomBytes(6).toString('hex');
  const mark = (k) => `PP_${nonce}_${k}`;
  const script = [
    'set -a', '. /etc/environment 2>/dev/null || true', 'set +a',
    `cd ${M2_APP_DIR} || exit 97`,
    'o=$(mktemp) || exit 98; e=$(mktemp) || exit 98',
    '"$@" >"$o" 2>"$e"; ec=$?',
    `echo "${mark('EXIT')}:$ec"`,
    `echo "${mark('OUT')}"`,
    `tail -c ${PROJECT_COMMAND_OUTPUT_CAP} "$o"`,
    // Guarantees the next marker starts its own line even when the tail does
    // not end in a newline; the stray blank line is trimmed on the way out.
    'echo ""',
    `echo "${mark('ERR')}"`,
    `tail -c ${PROJECT_COMMAND_OUTPUT_CAP} "$e"`,
    'rm -f "$o" "$e"',
  ].join('\n');

  const startedAt = Date.now();
  const r = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', script, 'sh', ...parsed.argv],
    { timeoutMs },
  );
  const durationMs = Date.now() - startedAt;

  if (r.status !== 0 && !r.stdout.includes(mark('EXIT'))) {
    // The wrapper itself never got to report — container down, incus refused,
    // or we killed it at the deadline.
    const why = r.timedOut
      ? `Timed out after ${Math.round(timeoutMs / 1000)}s. NOTE: the deadline kills the incus client, so the command may still be running inside the container — check with a short read-only call before retrying.`
      : r.status === 97
        ? `The app directory ${M2_APP_DIR} does not exist in this project's container.`
        : r.status === 98
          ? 'Could not create temporary files in the container (out of disk?).'
          : (r.stderr || '').trim().slice(-500) || 'no output from the container';
    return toolResult({
      ran: false, command: parsed.argv.join(' '), timed_out: !!r.timedOut,
      duration_ms: durationMs, error: why,
    }, { isError: true });
  }

  const out = r.stdout;
  const exitMatch = new RegExp(`${mark('EXIT')}:(-?\\d+)`).exec(out);
  const exitCode = exitMatch ? Number(exitMatch[1]) : null;
  const outAt = out.indexOf(`${mark('OUT')}\n`);
  const errAt = out.indexOf(mark('ERR'));
  const stdout = outAt >= 0 && errAt > outAt
    ? out.slice(outAt + mark('OUT').length + 1, errAt).replace(/\n$/, '')
    : '';
  const stderr = errAt >= 0 ? out.slice(errAt + mark('ERR').length).replace(/^\n/, '') : '';

  // The commit the result belongs to — so a green run can be tied to an exact
  // checkout rather than to "whatever was there at the time".
  const headR = await runHostCapture(
    'incus', ['exec', incusName, '--', 'git', '-C', M2_APP_DIR, 'rev-parse', 'HEAD'],
    { timeoutMs: 15000 },
  );
  const headSha = (headR.stdout || '').trim();

  logAudit(auth.created_by, 'MOCK2_PROJECT_COMMAND', 'mock2_project', project.id, {
    via: 'mcp', command: parsed.argv.join(' '), exit_code: exitCode, duration_ms: durationMs,
  }, null);

  return toolResult({
    ran: true,
    command: parsed.argv.join(' '),
    exit_code: exitCode,
    ok: exitCode === 0,
    duration_ms: durationMs,
    head_sha: /^[0-9a-f]{40}$/.test(headSha) ? headSha : null,
    stdout,
    stderr,
    output_truncated: stdout.length >= PROJECT_COMMAND_OUTPUT_CAP || stderr.length >= PROJECT_COMMAND_OUTPUT_CAP,
    // A non-zero exit is a real answer, not a broken tool — but it is marked
    // isError so a failing gate cannot be skimmed past as if it had passed.
  }, { isError: exitCode !== 0 });
}

// ---- read-only git history ----
//
// These overlap run_project_command, which already permits read-only git. They
// exist because STRUCTURE beats raw text for a caller that has to act on the
// answer: parsed commit rows, and a diff that also surfaces untracked files.

async function toolProjectGitLog(args) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const limit = normalizeGitLogLimit(args.limit);
  let rel = null;
  if (args.path != null && String(args.path).trim() !== '') {
    rel = validProjectFilePath(args.path);
    if (!rel) return toolResult('path must be relative to the app root', { isError: true });
  }
  const argv = ['exec', projectContainerName(m, project), '--',
    'git', '-C', M2_APP_DIR, 'log', `--max-count=${limit}`, `--format=${GIT_LOG_FORMAT}`];
  if (rel) argv.push('--', rel);
  const r = await runHostCapture('incus', argv, { timeoutMs: 30000 });
  if (r.status !== 0) {
    return toolResult(`Could not read history: ${(r.stderr || '').trim().slice(-300) || 'is the container running?'}`, { isError: true });
  }
  const commits = parseGitLogOutput(r.stdout);
  return toolResult({ path: rel, count: commits.length, commits });
}

async function toolProjectGitDiff(args) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  let ref = null;
  if (args.ref != null && String(args.ref).trim() !== '') {
    ref = validGitRef(args.ref);
    if (!ref) return toolResult('ref must be a revision or range, e.g. "HEAD~3" or "abc123..def456"', { isError: true });
  }
  let rel = null;
  if (args.path != null && String(args.path).trim() !== '') {
    rel = validProjectFilePath(args.path);
    if (!rel) return toolResult('path must be relative to the app root', { isError: true });
  }
  const incusName = projectContainerName(m, project);
  const argv = ['exec', incusName, '--', 'git', '-C', M2_APP_DIR, 'diff'];
  if (args.stat_only === true) argv.push('--stat');
  if (ref) argv.push(ref);
  if (rel) argv.push('--', rel);
  const r = await runHostCapture('incus', argv, { timeoutMs: 45000 });
  if (r.status !== 0) {
    return toolResult(`Diff failed: ${(r.stderr || '').trim().slice(-300) || 'is the container running?'}`, { isError: true });
  }
  const patch = capPatch(r.stdout);
  const out = { ref, path: rel, stat_only: args.stat_only === true, diff: patch.text, truncated: patch.truncated };

  // With no ref the question is "what is uncommitted", and a diff alone
  // answers it only for TRACKED files. An untracked file is invisible to both
  // git diff and git log while still sitting in the checkout — which is
  // exactly how a written-but-never-committed test file hides from review.
  if (!ref) {
    const s = await runHostCapture(
      'incus', ['exec', incusName, '--', 'git', '-C', M2_APP_DIR, 'status', '--porcelain'],
      { timeoutMs: 30000 },
    );
    if (s.status === 0) {
      const status = parseGitStatusPorcelain(s.stdout);
      out.untracked_files = status.untracked;
      out.changed_files = status.tracked;
      out.clean = status.untracked.length === 0 && status.tracked.length === 0;
      if (status.untracked.length) {
        out.note = `${status.untracked.length} untracked file(s) are in the checkout but not in git — they are invisible to project_git_log and to reviewers, and will not survive a rehydrate. Commit them with write_project_file or delete them.`;
      }
    }
  }
  return toolResult(out);
}

async function toolProjectGitShow(args) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const ref = validGitRef(args.ref);
  if (!ref) return toolResult('ref must be a commit sha or revision, e.g. "abc1234" or "HEAD~1"', { isError: true });
  let rel = null;
  if (args.path != null && String(args.path).trim() !== '') {
    rel = validProjectFilePath(args.path);
    if (!rel) return toolResult('path must be relative to the app root', { isError: true });
  }
  const argv = ['exec', projectContainerName(m, project), '--', 'git', '-C', M2_APP_DIR, 'show'];
  if (args.stat_only === true) argv.push('--stat');
  argv.push(ref);
  if (rel) argv.push('--', rel);
  const r = await runHostCapture('incus', argv, { timeoutMs: 45000 });
  if (r.status !== 0) {
    return toolResult(`Could not show ${ref}: ${(r.stderr || '').trim().slice(-300) || 'unknown revision?'}`, { isError: true });
  }
  const patch = capPatch(r.stdout);
  return toolResult({ ref, path: rel, stat_only: args.stat_only === true, content: patch.text, truncated: patch.truncated });
}

// get_build_log — what a failed cycle actually did.
//
// A failed build otherwise surfaces as a status with no output, which leaves
// nothing to diagnose from.
async function toolGetBuildLog(args) {
  const m = await mock2Modules();
  const project = m.projects.getProject(Number(args.project_id));
  if (!project) return toolResult('Project not found', { isError: true });
  const cycle = m.cycles.getCycle(Number(args.build_id));
  if (!cycle) return toolResult(`No build cycle ${args.build_id}`, { isError: true });
  // A cycle id from another project would otherwise leak that project's log.
  if (Number(cycle.project_id) !== Number(project.id)) {
    return toolResult(`Build ${args.build_id} does not belong to project ${project.id}`, { isError: true });
  }
  const limit = normalizeBuildLogLimit(args.limit);
  const events = m.cycleEvents.listCycleEvents(cycle.id);
  const flat = buildLogFromEvents(events, limit);
  return toolResult({
    build_id: cycle.id,
    project_id: project.id,
    status: cycle.status,
    error: cycle.error || null,
    verification_state: cycle.verification_state || null,
    started_at: cycle.started_at || cycle.created_at || null,
    finished_at: cycle.finished_at || null,
    total_events: flat.total_events,
    omitted_older_events: flat.omitted,
    steps: flat.steps,
    log: flat.log,
  });
}

// append_change_record — a correctly chained record for chat-lane work.
//
// The chain is computed SERVER-SIDE by the same insertChangeRecord the build
// runner uses, inside its transaction. That is the whole point of the tool:
// the canonical payload is an explicit field allowlist with its own defaults
// (change-logic.js's changePayload), NOT "the record minus its hashes", so a
// hand-computed hash agrees only by coincidence and stops agreeing the moment
// a field is added. Hand-appending is how an audit trail comes to look
// verified when nothing verified it.
async function toolAppendChangeRecord(args, auth) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const guard = liveBuildGuard(m, project);
  if (guard) return toolResult(guard, { isError: true });
  const summary = String(args.summary || '').trim();
  if (!summary) return toolResult('summary is required — say what this checkpoint recorded.', { isError: true });

  const framework = m.framework.getCurrentFrameworkVersion();
  if (!framework) {
    return toolResult('This install has no framework version recorded, so a change record cannot be chained to one.', { isError: true });
  }

  let record;
  try {
    record = m.changeRecords.insertChangeRecord({
      projectId: project.id,
      cycleId: args.cycle_id == null ? null : Number(args.cycle_id),
      initiatedBy: auth.created_by,
      // MCP tokens are admin-minted and admin-scoped, so a record appended
      // through one is an admin acting directly rather than the harness.
      actingAsAdmin: 1,
      frameworkVersion: framework.version,
      frameworkVersionId: framework.id,
      rulesTouched: args.rules_touched ?? null,
      gatesRun: args.gates_run ?? null,
      commitSha: args.commit_sha ?? null,
      summary,
    });
  } catch (e) {
    return toolResult(`Could not append the change record: ${e?.message || e}`, { isError: true });
  }

  // Mirror it into the checkout as state/changes/<seq>.json, the same file a
  // build cycle writes, so the readable history survives losing mock2.db.
  const incusName = projectContainerName(m, project);
  const rel = `state/changes/${record.seq}.json`;
  const mirror = JSON.stringify(m.changeRecords.changeRecordMirror(record), null, 2);
  const w = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', 'set -e; p="$1"; mkdir -p "$(dirname -- "$p")"; cat > "$p"', 'sh', `${M2_APP_DIR}/${rel}`],
    { input: mirror, timeoutMs: 30000 },
  );
  let git = { committed: false, unchanged: false, commit: null, push_failed: false };
  if (w.status === 0) {
    git = await commitProjectPaths(incusName, [rel], `mock2: change record ${record.seq}`);
  }

  logAudit(auth.created_by, 'MOCK2_CHANGE_RECORD_APPENDED', 'mock2_project', project.id, {
    via: 'mcp', seq: record.seq, commit_sha: record.commit_sha || null,
  }, null);

  const chain = m.changeRecords.verifyProjectChain(project.id);
  return toolResult({
    appended: true,
    seq: record.seq,
    hash: record.hash,
    prev_hash: record.prev_hash,
    created_at: record.created_at,
    mirror_path: rel,
    mirror_written: w.status === 0,
    ...git,
    // Verified right after appending, because a record that broke the chain is
    // worth hearing about now rather than at the next audit.
    chain_ok: chain.ok,
    chain_broken_at: chain.brokenAt,
  }, { isError: !chain.ok });
}

const TOOL_HANDLERS = {
  list_static_sites: (args, auth, req) => toolListStaticSites(args, auth, req),
  create_upload_ticket: (_args, _auth, req) => toolCreateUploadTicket(req),
  inspect_static_site_zip: toolInspectStaticSiteZip,
  apply_static_site_zip: toolApplyStaticSiteZip,
  list_lxc_containers: toolListLxcContainers,
  inspect_lxc_zip: toolInspectLxcZip,
  apply_lxc_zip: toolApplyLxcZip,
  read_lxc_file: toolReadLxcFile,
  write_lxc_file: toolWriteLxcFile,
  rerun_startup: toolRerunStartup,
  list_projects: toolListProjects,
  get_project: toolGetProject,
  send_project_build: toolSendProjectBuild,
  upload_project_reference: toolUploadProjectReference,
  clone_project: toolCloneProject,
  interrupt_project_build: toolInterruptProjectBuild,
  cancel_queued_build: toolCancelQueuedBuild,
  list_project_files: toolListProjectFiles,
  read_project_file: toolReadProjectFile,
  write_project_file: toolWriteProjectFile,
  edit_project_file: toolEditProjectFile,
  search_project_files: toolSearchProjectFiles,
  delete_project_file: toolDeleteProjectFile,
  move_project_file: toolMoveProjectFile,
  run_project_command: toolRunProjectCommand,
  project_git_log: toolProjectGitLog,
  project_git_diff: toolProjectGitDiff,
  project_git_show: toolProjectGitShow,
  get_build_log: toolGetBuildLog,
  append_change_record: toolAppendChangeRecord,
  redeploy_project: toolRedeployProject,
};

/* ---------------------------- JSON-RPC core ------------------------------ */

async function handleRpc(message, auth, req) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id, RPC_INVALID_REQUEST, 'Invalid JSON-RPC request');
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const version = MCP_KNOWN_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        instructions: [
          'ProxyPilot infrastructure control. Zip deploys are two-phase: inspect first, show the user',
          'any files that would be replaced, and only pass confirm_overwrite after they approve —',
          'replaced files are kept as <name>.old. For zips over ~2 MB use create_upload_ticket and PUT',
          'the bytes to its upload_url instead of inlining base64.',
        ].join(' '),
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;   // notifications: acknowledged with 202, no body
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const handler = TOOL_HANDLERS[name];
      if (!handler) return rpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      try {
        const result = await handler(params?.arguments || {}, auth, req);
        return rpcResult(id, result);
      } catch (err) {
        console.error(`[mcp] tool ${name} failed:`, err?.message || err);
        // Tool-level failure — surfaced as tool output so the model can react.
        return rpcResult(id, toolResult(`Tool failed: ${err?.message || 'unknown error'}`, { isError: true }));
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/* ------------------------------- routers -------------------------------- */

export function createMcpRouter() {
  const router = express.Router();

  // Raw zip upload for a ticket. The ticket in the URL is the secret (minted
  // over the authenticated tools channel), so no separate auth here — this is
  // what lets a shell `curl -T site.zip <url>` push the bytes.
  router.put('/upload/:ticket', express.raw({ type: () => true, limit: ZIP_LIMITS.maxZipBytes }), async (req, res) => {
    sweepTickets();
    const rec = uploadTickets.get(req.params.ticket);
    if (!rec) return res.status(404).json({ error: 'Unknown or expired upload ticket' });
    if (rec.filePath) return res.status(409).json({ error: 'This ticket already received an upload' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Send the raw zip bytes as the request body' });
    }
    await mkdir(MCP_TMP_DIR, { recursive: true }).catch(() => {});
    const filePath = join(MCP_TMP_DIR, `mcp-${randomBytes(12).toString('hex')}.zip`);
    await writeFile(filePath, req.body);
    rec.filePath = filePath;
    res.json({ ok: true, bytes: req.body.length });
  });

  // The MCP endpoint proper — at '/' (Bearer auth) and '/t/:token' (tokenized
  // URL for clients that cannot set headers).
  const endpoint = (pathTokenParam) => async (req, res) => {
    const token = tokenFromRequest({
      authorization: req.headers.authorization,
      pathToken: pathTokenParam ? req.params.token : '',
    });
    const auth = findToken(token);
    if (!auth) {
      return res.status(401).json({ error: 'Unauthorized: supply a valid ProxyPilot MCP token (Authorization: Bearer …, or the tokenized connector URL)' });
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      // No server-initiated stream / session teardown — allowed by the spec.
      return res.status(405).json({ error: 'Method not allowed — POST JSON-RPC messages to this endpoint' });
    }
    const body = req.body;
    if (body == null || typeof body !== 'object') {
      return res.status(400).json(rpcError(null, RPC_PARSE_ERROR, 'Body must be a JSON-RPC message'));
    }
    try {
      if (Array.isArray(body)) {
        const responses = (await Promise.all(body.map((m) => handleRpc(m, auth, req)))).filter(Boolean);
        if (responses.length === 0) return res.status(202).end();
        return res.json(responses);
      }
      const response = await handleRpc(body, auth, req);
      if (response == null) return res.status(202).end();
      return res.json(response);
    } catch (err) {
      console.error('[mcp] request failed:', err?.message || err);
      return res.status(500).json(rpcError(body?.id ?? null, RPC_INTERNAL_ERROR, 'Internal error'));
    }
  };

  router.all('/t/:token', express.json({ limit: '8mb' }), endpoint(true));
  router.all('/', express.json({ limit: '8mb' }), endpoint(false));
  return router;
}

// Token administration — behind the normal cookie session, admin only.
export function createMcpAdminRouter() {
  const router = express.Router();

  router.get('/', requireAdmin, (req, res) => {
    let rows = [];
    try {
      rows = getDb().prepare(`SELECT id, name, created_by, created_at, last_used_at, revoked_at FROM mcp_tokens ORDER BY id DESC`).all();
    } catch { /* pre-migration */ }
    res.json({ tokens: rows });
  });

  // Mint: the raw token (and the ready-to-paste connector URL) is returned
  // ONCE; only its hash is stored.
  router.post('/', requireAdmin, (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 100) || 'MCP client';
    const token = mintMcpToken();
    getDb().prepare(`
      INSERT INTO mcp_tokens (name, token_hash, created_by, created_at)
      VALUES (?, ?, ?, ?)
    `).run(name, hashMcpToken(token), String(req.user.id), new Date().toISOString());
    logAudit(req.user.id, 'MCP_TOKEN_CREATED', 'mcp_token', name, {}, req.ip);
    const base = publicBaseUrl(req);
    res.status(201).json({
      token,
      name,
      endpoint: `${base}/api/mcp`,
      connector_url: `${base}/api/mcp/t/${token}`,
      note: 'Store this token now — it is shown only once.',
    });
  });

  router.delete('/:id', requireAdmin, (req, res) => {
    const r = getDb().prepare(`UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
      .run(new Date().toISOString(), Number(req.params.id));
    if (r.changes === 0) return res.status(404).json({ error: 'Token not found or already revoked' });
    logAudit(req.user.id, 'MCP_TOKEN_REVOKED', 'mcp_token', req.params.id, {}, req.ip);
    res.json({ revoked: true });
  });

  return router;
}
