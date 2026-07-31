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
  const [projects, cycles, queue, chats, domains, provision, cloneLogic, assets, projectLogic] = await Promise.all([
    import('../mock2/projects.js'), import('../mock2/cycles.js'), import('../mock2/build-queue.js'),
    import('../mock2/chats.js'), import('../mock2/domains.js'), import('../mock2/provision.js'),
    import('../mock2/clone-logic.js'), import('../mock2/project-assets.js'), import('../mock2/project-logic.js'),
  ]);
  return { projects, cycles, queue, chats, domains, provision, cloneLogic, assets, projectLogic };
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
  return toolResult({
    ...summary,
    description: project.description || null,
    provisioning: provisionStatus ? { phase: provisionStatus.phase, message: provisionStatus.message, error: provisionStatus.error || null } : null,
    queued_builds: queueRows.map((r) => ({ id: r.id, instruction: String(r.instruction || '').slice(0, 200) })),
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
  return toolResult({
    queued: true, queue_id: row.id,
    message: 'Build queued — it starts immediately if the project is idle. Poll get_project for status.',
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
  const r = await runHostCapture(
    'incus', ['exec', projectContainerName(m, project), '--', 'sh', '-c', 'p="$1"; test -f "$p" || { echo "PP_NOT_A_FILE" >&2; exit 66; }; wc -c < "$p"; head -c 524288 -- "$p"', 'sh', abs],
    { timeoutMs: 30000 },
  );
  if (r.status === 66) return toolResult(`Not a file: ${rel} (use list_project_files to see the tracked files)`, { isError: true });
  if (r.status !== 0) {
    return toolResult(`Could not read ${rel} — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const nl = r.stdout.indexOf('\n');
  const size = Number(String(r.stdout.slice(0, nl)).trim()) || 0;
  const body = Buffer.from(r.stdout.slice(nl + 1), 'utf8');
  if (body.includes(0)) return toolResult(`${rel} looks binary — this tool reads text files only`, { isError: true });
  return toolResult({
    path: rel, size_bytes: size,
    truncated: size > LXC_FILE_READ_CAP,
    content: body.toString('utf8'),
  });
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
  const message = String(args.commit_message || `chat edit: ${rel}`).slice(0, 200);
  const commitScript = 'set -e; cd /srv/app; git add -A -- "$1"; '
    + 'if git diff --cached --quiet -- "$1"; then echo PP_NOCHANGE; '
    + 'else git -c user.email=mcp@proxypilot -c user.name="ProxyPilot MCP" commit -q -m "$2" -- "$1"; fi; '
    + 'git push -q origin HEAD:main 2>/dev/null || echo PP_PUSH_FAILED >&2; git rev-parse HEAD';
  const c = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', commitScript, 'sh', rel, message],
    { timeoutMs: 60000 },
  );
  const unchanged = /PP_NOCHANGE/.test(c.stdout);
  const sha = (c.stdout.trim().split('\n').pop() || '').trim();
  logAudit(auth.created_by, 'MOCK2_FILE_WRITTEN', 'mock2_project', project.id, { via: 'mcp', path: rel, bytes: Buffer.byteLength(content), replaced: exists }, null);
  return toolResult({
    written: true, path: rel, bytes: Buffer.byteLength(content),
    committed: c.status === 0 && !unchanged,
    unchanged,
    commit: /^[0-9a-f]{40}$/.test(sha) ? sha : null,
    push_failed: /PP_PUSH_FAILED/.test(c.stderr || ''),
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
