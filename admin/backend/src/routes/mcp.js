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
import { appendFile, readFile, writeFile, rename, rm, mkdir, stat as fsStat, readdir, copyFile, open as fsOpen } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { getDb, logAudit } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  MCP_PROTOCOL_VERSION, MCP_KNOWN_VERSIONS, MCP_SERVER_INFO, MCP_SERVER_INSTRUCTIONS, MCP_TOOLS,
  rpcResult, rpcError, toolResult,
  RPC_PARSE_ERROR, RPC_INVALID_REQUEST, RPC_METHOD_NOT_FOUND, RPC_INVALID_PARAMS, RPC_INTERNAL_ERROR,
  mintMcpToken, hashMcpToken, tokenFromRequest,
  mintUploadTicket, looksLikeUploadTicket, UPLOAD_TICKET_TTL_MS, INLINE_ZIP_MAX_BYTES,
  validSha256, sha256Hex, zipChecksumError,
  normalizeChunkSeq, decodeChunkBase64,
  parseLxcListJson, lxcContainerSummaries, validFileMode,
  LXC_LIST_CAPTURE_CAP, captureEvidence,
  pickUpstreamAddress, instanceNicParent, validRoutePathPrefix, validRouteHealthPath,
  startupRunTimeoutMs, parseMarkedStreams,
  parseLxcCommand, lxcCommandTimeoutMs, lxcContainerDetail,
  validSnapshotName, defaultSnapshotName, validateLxcConfigChange,
  validIpv4, validImageAlias,
  validDomainName, normalizePort, parseCurlProbeOutput, classifyCurlExit,
  summarizeAccessLog, caddyAccessLogPath,
  parseStatFileList, parseSystemctlShow, validUnitName, validProbeHost, validFileGlob, normalizeServiceId,
  startupCandidates, validProjectFilePath,
  parseProjectCommand, projectCommandTimeoutMs, PROJECT_COMMAND_OUTPUT_CAP,
  applyStringEdit, normalizeReadRange,
  editByteInvariantError, expectedSha256Error, readIntegrityError, normalizeInsertLine,
  verifiedWriteScript, appendScript, insertAtLineScript, parseWriteOk, PP_SHA_FN, NO_SHA,
  validSearchPattern, validPathspec, normalizeMaxResults, parseGitGrepOutput,
  validGitRef, normalizeGitLogLimit, GIT_LOG_FORMAT, parseGitLogOutput,
  parseGitStatusPorcelain, capPatch, normalizeBuildLogLimit, buildLogFromEvents,
  PATCH_INLINE_MAX_BYTES, PATCH_MAX_BYTES, parseUnifiedDiffPaths, parseApplyNumstat,
  parseGitApplyFailure, stripApplyNoise, normalizeExpectedShaMap, patchPreconditionError,
  applyPatchScript, patchScriptBlock, parseBeforeBlock, parseAfterBlock, buildPatchFileReport,
  BATCH_READ_MAX_FILES, normalizeBatchReadBudget, normalizeBatchReadRequest,
  batchReadScript, parseBatchReadOutput,
  normalizeContextLines, normalizeSearchByteBudget, parseGitGrepContext, parseGitGrepFileList,
  PROJECT_MAP_MAX_FILES_DEFAULT, PROJECT_MAP_MAX_FILES_CAP, PROJECT_MAP_SYMBOLS_PER_FILE,
  PROJECT_MAP_SYMBOL_PATTERN, buildProjectMap, parseLineCounts,
} from '../lib/mcp-logic.js';
import {
  parseZip, detectWrapperDir, effectiveEntries, findConflicts, fsExistsKind,
  collectCandidatePaths, extractToStaging, applyStagingToTarget, ZIP_LIMITS, ZipError,
} from '../lib/zip-extract.js';
import { stageZipUpload, getZipUpload, discardZipUpload } from '../lib/zip-staging.js';
import {
  parseNetworkIpv4Cidr, collectHostDiagnostics, hostKeyringFacts,
} from '../lib/host-facts.js';
import {
  checkContainerConflicts, readContainerStartup, applyTarToContainer,
  setupStartupScript, writeTarFromZip, runHostCapture, runInContainer, CAPTURE_CAP,
  STARTUP_UNIT_NAME,
} from '../lib/lxc-zip.js';
import { resolveMock2Gate } from '../mock2/gating.js';
import { ensureNetworkNat, findOrCreateLxcService } from './lxc.js';
import { regenerateDomainCaddyConfig, ensureCaddyStructure, assertRoutesShareSslStance, syncPrimaryRouteFromLegacy } from './services.js';
import { caddyAdapt, caddyReload } from '../lib/caddy-driver.js';
import { resolveTlsForHost } from '../lib/tls-cert-store.js';
import { resolveCertDir } from '../lib/caddy-cert.js';
import { parseCertificate, daysUntil, expiryStatus } from '../lib/tls-certs.js';
import { v4 as uuidv4 } from 'uuid';

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

// The exec allowlist — loaded once at module init. This JSON is the
// enforcement source of truth (the run_lxc_command description only
// summarizes it); it is also packaged verbatim in the mcp-lxc-sites-upgrades
// component spec, and the two must be kept in sync.
const LXC_CMD_POLICY = JSON.parse(
  readFileSync(new URL('../lib/mcp-policy/lxc-command-allowlist.json', import.meta.url), 'utf8'),
);
const LXC_CFG_POLICY = JSON.parse(
  readFileSync(new URL('../lib/mcp-policy/lxc-config-allowlist.json', import.meta.url), 'utf8'),
);
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
//
// rec: { createdAt, filePath|null, chunkPath|null, nextSeq, chunkBytes }.
// filePath is set when the ticket holds a COMPLETE archive (PUT, or a
// finished chunked upload); chunkPath is the in-progress chunk assembly.

const uploadTickets = new Map();

function sweepTickets() {
  const cutoff = Date.now() - UPLOAD_TICKET_TTL_MS;
  for (const [t, rec] of uploadTickets) {
    if (rec.createdAt < cutoff) {
      if (rec.filePath) rm(rec.filePath, { force: true }).catch(() => {});
      if (rec.chunkPath) rm(rec.chunkPath, { force: true }).catch(() => {});
      uploadTickets.delete(t);
    }
  }
}

// Resolve the zip bytes for an inspect tool: ticket (uploaded file) or inline
// base64. Returns { buf, tmpPath } or throws a user-facing Error. When the
// caller declared a sha256, the bytes are verified HERE — before any parsing
// or staging — so transport corruption reads as exactly that instead of as a
// downstream extraction error (bugfix: inline base64 was observed corrupting
// silently in the field).
async function zipBytesFromArgs(args) {
  let buf, tmpPath;
  if (args.ticket) {
    if (!looksLikeUploadTicket(args.ticket)) throw new Error('Invalid upload ticket');
    const rec = uploadTickets.get(args.ticket);
    if (!rec || !rec.filePath) throw new Error('Upload ticket unknown, expired, or no bytes were uploaded to it yet');
    uploadTickets.delete(args.ticket);
    buf = await readFile(rec.filePath);
    tmpPath = rec.filePath;
  } else if (args.zip_base64) {
    buf = Buffer.from(String(args.zip_base64), 'base64');
    if (buf.length === 0) throw new Error('zip_base64 decoded to zero bytes');
    if (buf.length > INLINE_ZIP_MAX_BYTES) {
      throw new Error(`Inline zips are limited to ${Math.floor(INLINE_ZIP_MAX_BYTES / (1024 * 1024))} MB — use create_upload_ticket for this archive`);
    }
    tmpPath = join(MCP_TMP_DIR, `mcp-${randomBytes(12).toString('hex')}.zip`);
    await mkdir(MCP_TMP_DIR, { recursive: true }).catch(() => {});
    await writeFile(tmpPath, buf);
  } else {
    throw new Error('Provide either an upload ticket or zip_base64');
  }
  if (args.sha256 != null && String(args.sha256).trim() !== '') {
    const mismatch = zipChecksumError(buf, args.sha256);
    if (mismatch) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw new Error(mismatch);
    }
  }
  return { buf, tmpPath };
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
  // `domain` moved off `services` and into `service_http_routes` (D.14 drops
  // the legacy route-owned columns) — selecting it from services was throwing
  // "no such column: domain" on every call, which made the whole static-site
  // surface unreachable over MCP (the deploy tools need an id only this list
  // can provide). `enabled` never existed on services at all (that column
  // belongs to service_l4_forwards); the row state lives in `status`. The
  // primary domain is the root-path route, oldest first.
  let rows;
  try {
    rows = getDb().prepare(`
      SELECT s.id, s.name, s.status,
             (SELECT r.domain FROM service_http_routes r
                WHERE r.service_id = s.id
                ORDER BY (r.path_prefix = '/') DESC, r.created_at ASC, r.id ASC
                LIMIT 1) AS domain
      FROM services s
      WHERE s.type = 'static'
      ORDER BY s.name
    `).all();
  } catch (err) {
    // Schema drift bit this tool once already — if it happens again, say so
    // loudly instead of answering with an error the caller cannot act on.
    return toolResult(`Could not list static sites (schema mismatch?): ${err?.message || err}`, { isError: true });
  }
  return toolResult({
    sites: rows.map((r) => ({
      id: r.id, name: r.name, domain: r.domain || null,
      status: r.status || null, enabled: r.status === 'active',
    })),
  });
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

// ---- chunked upload (the ticket path for clients that cannot PUT) ----
//
// The documented big-zip flow returns a PUT URL on the public edge host —
// which egress-restricted agent sandboxes cannot reach (observed in the
// field: CONNECT 403), closing the large-archive path to exactly the clients
// most likely to drive these tools. These two tools deliver the same bytes
// through the already-working MCP channel: ordered base64 chunks appended to
// the ticket, sealed by a mandatory whole-file checksum.

async function toolAppendUploadChunk(args) {
  sweepTickets();
  const ticket = String(args.ticket || '');
  if (!looksLikeUploadTicket(ticket)) return toolResult('Invalid upload ticket', { isError: true });
  const rec = uploadTickets.get(ticket);
  if (!rec) return toolResult('Upload ticket unknown or expired — create a new one with create_upload_ticket', { isError: true });
  if (rec.filePath) return toolResult('This ticket already holds a complete upload', { isError: true });
  const seq = normalizeChunkSeq(args.seq);
  if (seq === null) return toolResult('seq must be a whole number starting at 0', { isError: true });
  const expected = rec.nextSeq || 0;
  if (seq !== expected) {
    return toolResult(`Out-of-order chunk: expected seq ${expected}, got ${seq}. Chunks must arrive in order, each exactly once — if a call failed mid-flight, re-send the expected seq.`, { isError: true });
  }
  const dec = decodeChunkBase64(args.chunk_base64);
  if (dec.error) return toolResult(dec.error, { isError: true });
  const total = (rec.chunkBytes || 0) + dec.buf.length;
  if (total > ZIP_LIMITS.maxZipBytes) {
    if (rec.chunkPath) await rm(rec.chunkPath, { force: true }).catch(() => {});
    uploadTickets.delete(ticket);
    return toolResult(`Upload exceeds the ${Math.floor(ZIP_LIMITS.maxZipBytes / (1024 * 1024))} MB zip limit — the ticket has been discarded`, { isError: true });
  }
  if (!rec.chunkPath) {
    await mkdir(MCP_TMP_DIR, { recursive: true }).catch(() => {});
    rec.chunkPath = join(MCP_TMP_DIR, `mcp-${randomBytes(12).toString('hex')}.zip.part`);
  }
  await appendFile(rec.chunkPath, dec.buf);
  rec.nextSeq = expected + 1;
  rec.chunkBytes = total;
  return toolResult({
    appended: true, seq, next_seq: rec.nextSeq, received_bytes: total,
    next: 'Append the next chunk, or seal the upload with finish_upload (pass the sha256 of the complete zip).',
  });
}

async function toolFinishUpload(args) {
  sweepTickets();
  const ticket = String(args.ticket || '');
  if (!looksLikeUploadTicket(ticket)) return toolResult('Invalid upload ticket', { isError: true });
  const rec = uploadTickets.get(ticket);
  if (!rec) return toolResult('Upload ticket unknown or expired', { isError: true });
  if (rec.filePath) return toolResult('This ticket already holds a complete upload', { isError: true });
  if (!rec.chunkPath || !(rec.chunkBytes > 0)) {
    return toolResult('No chunks have been appended to this ticket yet — send them with append_upload_chunk first', { isError: true });
  }
  const want = validSha256(args.sha256);
  if (!want) return toolResult('sha256 is required: the 64-character hex SHA-256 of the complete zip file', { isError: true });
  const buf = await readFile(rec.chunkPath);
  const got = sha256Hex(buf);
  if (got !== want) {
    // Corrupted in transport — refuse to hand corrupted bytes to an inspect
    // tool. The ticket dies with the bad bytes so a retry starts clean.
    await rm(rec.chunkPath, { force: true }).catch(() => {});
    uploadTickets.delete(ticket);
    return toolResult(`Assembled upload does not match sha256 (declared ${want}, got ${got} over ${buf.length} bytes) — a chunk was corrupted in transport. Create a new ticket and re-send.`, { isError: true });
  }
  rec.filePath = rec.chunkPath;
  rec.chunkPath = null;
  return toolResult({
    finished: true, bytes: buf.length, sha256: got,
    next: 'Pass the ticket to inspect_static_site_zip or inspect_lxc_zip (the ticket stays single-use and expires on its original 30-minute clock).',
  });
}

async function toolInspectStaticSiteZip(args, auth) {
  // Ids are TEXT (uuid for UI-created sites, legacy integers as text) — the
  // old Number() coercion NaN'd every uuid and reported "not found".
  const siteId = normalizeServiceId(args.service_id);
  const service = siteId ? getDb().prepare(`SELECT id, name, data_dir, type FROM services WHERE id = ? AND type = 'static'`).get(siteId) : null;
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
  const siteId = normalizeServiceId(args.service_id);
  const service = siteId ? getDb().prepare(`SELECT id, name, data_dir, type FROM services WHERE id = ? AND type = 'static'`).get(siteId) : null;
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
  // This tool used to swallow every failure mode — non-zero exit, and JSON
  // made unparseable by the host-capture cap — and answer `{"containers":[]}`,
  // which reads as "the host is empty" while name-addressed tools were happily
  // operating on live guests. An agent then plans to CREATE a duplicate. A
  // failed list must therefore be an error, never an empty success.
  //
  // --all-projects first, so a guest living outside the default Incus project
  // still appears; older incus clients without the flag fall back cleanly.
  let out = await runHostCapture('incus', ['list', '--all-projects', '--format', 'json'],
    { timeoutMs: 30000, maxCapture: LXC_LIST_CAPTURE_CAP });
  if (out.status !== 0) {
    out = await runHostCapture('incus', ['list', '--format', 'json'],
      { timeoutMs: 30000, maxCapture: LXC_LIST_CAPTURE_CAP });
  }
  if (out.status !== 0) {
    const why = out.timedOut ? 'timed out' : (out.stderr || '').trim().slice(-300) || out.error || 'unknown error';
    return toolResult(`Could not list containers — incus list failed (${why}). This is a listing failure, not proof the host is empty; name-addressed tools (read_lxc_file, …) may still reach containers directly.`, { isError: true });
  }
  const parsed = parseLxcListJson(out.stdout);
  if (parsed.error) {
    return toolResult(`Could not list containers — incus list returned ${parsed.error} (${captureEvidence(out)}). This is a listing failure, not proof the host is empty.`, { isError: true });
  }
  return toolResult({ containers: lxcContainerSummaries(parsed.list, LXC_PREFIX) });
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

// How much stdout a file read is allowed to bring back. This MUST exceed
// LXC_FILE_READ_CAP plus the header lines, or the transport silently returns
// less than the tool promises — which is exactly the bug that corrupted five
// files: runHostCapture defaulted to 256 KB while these tools advertised
// 512 KB, so any file in between came back cut at a chunk boundary (~267 KB,
// ~299 KB, ~327 KB — the variance was the chunk, not a limit) and the edit
// wrote the stump back over the original.
const FILE_READ_CAPTURE = LXC_FILE_READ_CAP + 64 * 1024;

// The header every file read prints before the content: byte count, line
// count, and the file's SHA-256 as computed INSIDE the container. The hash is
// what makes the read checkable — it is a statement about the file, not about
// the bytes that happened to arrive.
//
// The script using this must set `p` (the path) and `cap` (the read cap in
// bytes) first. Files over the cap are not hashed: the read cannot return
// them whole, so the hash would be neither a precondition token nor a check
// on the transfer — just a full pass over a file nobody asked to read.
const FILE_READ_HEADER = `${PP_SHA_FN}sz=$(wc -c < "$p"); echo "$sz"; wc -l < "$p"; `
  + `if [ "$sz" -le "$cap" ]; then pp_sha "$p"; else echo ${NO_SHA}; fi; `;

/** Split the three header lines off a file read. Returns null if the header
 *  is not intact — a read that lost its own header lost content too. */
function parseReadHeader(stdout) {
  const nl1 = stdout.indexOf('\n');
  const nl2 = stdout.indexOf('\n', nl1 + 1);
  const nl3 = stdout.indexOf('\n', nl2 + 1);
  if (nl1 < 0 || nl2 < 0 || nl3 < 0) return null;
  const size = Number(stdout.slice(0, nl1).trim());
  if (!Number.isInteger(size)) return null;
  const sha = stdout.slice(nl2 + 1, nl3).trim();
  return {
    size,
    // `wc -l` counts newlines, so a file with no trailing newline reads one
    // short — the max with 1 keeps a single unterminated line from being 0.
    totalLines: size === 0 ? 0 : Math.max(Number(stdout.slice(nl1 + 1, nl2).trim()) || 0, 1),
    sha256: sha === NO_SHA ? null : sha,
    body: stdout.slice(nl3 + 1),
  };
}

/** A capture that hit its cap, or was still open when the child exited, is a
 *  short read. Never treat it as the file. */
function captureTruncationError(rel, r) {
  if (r.stdoutTruncated) {
    return `Read of ${rel} exceeded the ${Math.floor(FILE_READ_CAPTURE / 1024)} KB transport budget and came back `
      + 'incomplete. Nothing was written. Read a line range with offset/limit instead.';
  }
  if (r.stdoutComplete === false) {
    return `Read of ${rel} ended before the container closed its output, so the tail may be missing. `
      + 'Nothing was written. Retry the call.';
  }
  return null;
}

/**
 * Run a verified write inside a container: content is staged next to the
 * target, checked for byte count and SHA-256, and only then moved into place,
 * after which the file at the path is re-read and re-hashed. Returns either
 * `{ error }` (nothing was written — the original is untouched) or the
 * `{ bytes, sha256, total_lines }` the far side confirmed.
 */
async function verifiedContainerWrite(incusName, absPath, content, {
  mode = null, keepOld = false, expectedSha = null, label = absPath,
} = {}) {
  const bytes = Buffer.byteLength(content, 'utf8');
  const wantSha = sha256Hex(Buffer.from(content, 'utf8'));
  const w = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', verifiedWriteScript(),
      'sh', absPath, String(bytes), wantSha, mode || '', keepOld ? '1' : '0', expectedSha || ''],
    { input: content, timeoutMs: 60000 },
  );
  const detail = (w.stderr || '').trim().slice(-300);
  if (w.status === 64) {
    const found = detail.split(' ')[1] || 'unknown';
    return {
      error: found === 'ABSENT'
        ? `${label} no longer exists, so expected_sha256 could not match. Nothing was written.`
        : `${label} has changed since you read it (expected ${expectedSha}, found ${found}). `
          + 'Nothing was written — re-read the file and rebuild your change on its current content.',
    };
  }
  if (w.status === 65) {
    return {
      error: `The content that reached the container did not match what was sent (${detail}). `
        + `${label} is untouched — nothing was written. Retry the call.`,
    };
  }
  if (w.status === 66) {
    return {
      error: `Write of ${label} did not verify on read-back (${detail}). The file may be in an unexpected `
        + 'state — read it before writing again.',
    };
  }
  if (w.status !== 0) return { error: `Write failed: ${detail || 'is the container running?'}` };
  const ok = parseWriteOk(w.stdout);
  if (!ok) return { error: `Write of ${label} did not report a verified result — treat it as unconfirmed and read the file back.` };
  if (ok.bytes !== bytes) {
    return { error: `Write of ${label} landed ${ok.bytes} bytes, not the ${bytes} sent. Read the file back before doing anything else.` };
  }
  return ok;
}

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
    'incus', ['exec', `${LXC_PREFIX}${name}`, '--', 'sh', '-c',
      `p="$1"; cap="$2"; test -f "$p" || { echo "PP_NOT_A_FILE" >&2; exit 66; }; ${FILE_READ_HEADER}head -c "$cap" -- "$p"`,
      'sh', path, String(LXC_FILE_READ_CAP)],
    { timeoutMs: 30000, maxCapture: FILE_READ_CAPTURE },
  );
  if (r.status === 66) return toolResult(`Not a file: ${path}`, { isError: true });
  if (r.status !== 0) {
    return toolResult(`Could not read ${path} — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const capped = captureTruncationError(path, r);
  if (capped) return toolResult(capped, { isError: true });
  const head = parseReadHeader(r.stdout);
  if (!head) return toolResult(`Read of ${path} came back malformed — retry the call.`, { isError: true });
  const body = Buffer.from(head.body, 'utf8');
  if (body.includes(0)) return toolResult(`${path} looks binary — this tool reads text files only`, { isError: true });
  const overCap = head.size > LXC_FILE_READ_CAP;
  // Below the cap the read is provably whole or it is an error — never a
  // silently short copy that a later write_lxc_file would make permanent.
  if (!overCap) {
    const short = readIntegrityError(path, head.size, head.sha256, body);
    if (short) return toolResult(short, { isError: true });
  }
  return toolResult({
    path, size_bytes: head.size, total_lines: head.totalLines, sha256: head.sha256,
    truncated: overCap,
    ...(overCap ? { note: `Only the first ${Math.floor(LXC_FILE_READ_CAP / 1024)} KB of ${head.size} bytes is here — do NOT write this back as the whole file.` } : {}),
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
  // Optional mode, so a script written here is actually runnable — without it
  // the only way to deliver an executable file was a full zip apply.
  let mode = null;
  if (args.mode != null && String(args.mode).trim() !== '') {
    mode = validFileMode(args.mode);
    if (!mode) return toolResult('mode must be three octal permission digits, e.g. "0755" or "644"', { isError: true });
  }
  const incusName = `${LXC_PREFIX}${name}`;
  const expectedSha = validSha256(args.expected_sha256);
  if (args.expected_sha256 != null && String(args.expected_sha256).trim() !== '' && !expectedSha) {
    return toolResult('expected_sha256 must be the 64-character hex SHA-256 of the file you read (read_lxc_file returns it).', { isError: true });
  }

  // Ask-first when the file exists — same contract as every other overwrite.
  const probe = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c',
      `${PP_SHA_FN}p="$1"; if [ -e "$p" ]; then echo EXISTS; wc -c < "$p"; pp_sha "$p"; else echo ABSENT; fi`, 'sh', path],
    { timeoutMs: 30000 },
  );
  if (probe.status !== 0) {
    return toolResult(`Cannot inspect ${name} — is it running? ${(probe.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const probeLines = probe.stdout.split('\n');
  const exists = probe.stdout.startsWith('EXISTS');
  if (exists && args.confirm_overwrite !== true) {
    const size = Number(String(probeLines[1] || '').trim()) || 0;
    const cur = String(probeLines[2] || '').trim();
    return toolResult({
      written: false,
      needs_confirmation: true,
      path,
      existing_size_bytes: size,
      sha256: cur === NO_SHA ? null : cur,
      message: `${path} already exists (${size} bytes; it will be kept as ${path}.old). Show the user your proposed change and re-call with confirm_overwrite: true after they approve.`,
    });
  }

  // Staged, hashed, moved into place, then read back — a write that does not
  // verify leaves the previous file exactly where it was.
  const written = await verifiedContainerWrite(incusName, path, content, {
    mode, keepOld: true, expectedSha: expectedSha || null, label: path,
  });
  if (written.error) return toolResult(written.error, { isError: true });
  logAudit(auth.created_by, 'LXC_FILE_WRITTEN', 'lxc', name, { via: 'mcp', path, bytes: written.bytes, replaced: exists, ...(mode ? { mode } : {}) }, null);
  return toolResult({
    written: true, path,
    bytes: written.bytes, total_lines: written.total_lines, sha256: written.sha256,
    verified: true,
    backup: exists ? `${path}.old` : null,
    ...(mode ? { mode } : {}),
    next: 'If this container has a registered startup script, redeploy with rerun_startup.',
  });
}

// rerun_startup — now with a caller timeout and REAL output tails.
//
// A first-boot script was observed doing a full Docker engine install plus a
// 910 MB image pull inside one blocking call: no timeout parameter, and the
// old `.slice(-16 KB)` was the tail of the FIRST 256 KB the host capture
// kept — the head of the run, not its end. Same recipe as
// toolRunProjectCommand: each stream lands in a file inside the container and
// is tail'd there, framed by nonce markers so output containing the marker
// text cannot confuse the parse.
async function toolRerunStartup(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const incusName = `${LXC_PREFIX}${name}`;
  const startup = await readContainerStartup(incusName).catch(() => null);
  if (!startup?.scriptPath) {
    return toolResult('No startup script is registered for this container — deploy one via apply_lxc_zip (startup_script) first', { isError: true });
  }
  const wd = startup.workingDir || '/';
  const timeoutMs = startupRunTimeoutMs(
    args.timeout_seconds,
    parseInt(process.env.PROXYPILOT_STARTUP_RUN_TIMEOUT_MS || '120000', 10),
  );
  const nonce = randomBytes(6).toString('hex');
  const mark = (k) => `PP_${nonce}_${k}`;
  const script = [
    'cd "$1" || exit 97',
    'o=$(mktemp) || exit 98; e=$(mktemp) || exit 98',
    '"$2" >"$o" 2>"$e"; ec=$?',
    `echo "${mark('EXIT')}:$ec"`,
    `echo "${mark('OUT')}"`,
    `tail -c ${PROJECT_COMMAND_OUTPUT_CAP} "$o"`,
    'echo ""',
    `echo "${mark('ERR')}"`,
    `tail -c ${PROJECT_COMMAND_OUTPUT_CAP} "$e"`,
    'rm -f "$o" "$e"',
  ].join('\n');

  const startedAt = Date.now();
  const r = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', script, 'sh', wd, startup.scriptPath],
    { timeoutMs },
  );
  const durationMs = Date.now() - startedAt;
  const streams = parseMarkedStreams(r.stdout, nonce);
  logAudit(auth.created_by, 'LXC_STARTUP_RERUN', 'lxc', name, {
    via: 'mcp', script: startup.scriptPath, exit: streams.found ? streams.exit_code : r.status, timed_out: !!r.timedOut,
  }, null);

  if (!streams.found) {
    // The wrapper never reported — container down, incus refused, or we
    // killed it at the deadline.
    const why = r.timedOut
      ? `Timed out after ${Math.round(timeoutMs / 1000)}s. NOTE: the deadline kills the incus client, so the script may still be running inside the container — check its effects (or the app's port) before re-running. Pass timeout_seconds (max 1800) for long first-boot installs.`
      : r.status === 97
        ? `The working directory ${wd} does not exist in the container.`
        : r.status === 98
          ? 'Could not create temporary files in the container (out of disk?).'
          : (r.stderr || '').trim().slice(-500) || 'no output from the container';
    return toolResult({
      ran: false,
      script: startup.scriptPath,
      working_dir: wd,
      timed_out: !!r.timedOut,
      duration_ms: durationMs,
      error: why,
    }, { isError: true });
  }
  return toolResult({
    script: startup.scriptPath,
    working_dir: wd,
    exit_code: streams.exit_code,
    timed_out: !!r.timedOut,
    duration_ms: durationMs,
    stdout: streams.stdout,
    stderr: streams.stderr,
    output_truncated: streams.stdout.length >= PROJECT_COMMAND_OUTPUT_CAP || streams.stderr.length >= PROJECT_COMMAND_OUTPUT_CAP,
  });
}

// ---- LXC observe + exec (spec cycle 2: the pair that would have collapsed
// the field session from five redeploys to two calls) ----

// Fetch one instance's full JSON (state + config + snapshots), across all
// Incus projects when the client supports it. Exact-name match — incus treats
// the CLI filter as a pattern, so pp-Web must not accidentally resolve pp-Web2.
async function fetchLxcInstance(incusName) {
  let out = await runHostCapture('incus', ['list', incusName, '--all-projects', '--format', 'json'],
    { timeoutMs: 30000, maxCapture: LXC_LIST_CAPTURE_CAP });
  if (out.status !== 0) {
    out = await runHostCapture('incus', ['list', incusName, '--format', 'json'],
      { timeoutMs: 30000, maxCapture: LXC_LIST_CAPTURE_CAP });
  }
  if (out.status !== 0) {
    const why = out.timedOut ? 'timed out' : (out.stderr || '').trim().slice(-300) || out.error || 'unknown error';
    return { error: `incus list failed (${why})` };
  }
  const parsed = parseLxcListJson(out.stdout);
  if (parsed.error) return { error: `incus list returned ${parsed.error} (${captureEvidence(out)})` };
  const instance = parsed.list.find((c) => c?.name === incusName);
  if (!instance) return { notFound: true };
  return { instance };
}

async function toolGetLxcContainer(args) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const incusName = `${LXC_PREFIX}${name}`;
  const r = await fetchLxcInstance(incusName);
  if (r.error) return toolResult(`Could not inspect ${name}: ${r.error}`, { isError: true });
  if (r.notFound) return toolResult(`Container ${name} not found — use list_lxc_containers for valid names`, { isError: true });
  const startup = await readContainerStartup(incusName).catch(() => null);
  return toolResult({
    name,
    ...lxcContainerDetail(r.instance),
    registered_startup: startup?.scriptPath
      ? { script_path: startup.scriptPath, working_dir: startup.workingDir || null }
      : null,
  });
}

// run_lxc_command — one allowlisted command inside a guest, with the same
// containment as run_project_command: whitespace-split argv handed to sh as
// POSITIONAL PARAMETERS and invoked as "$@" (never re-parsed), output tails
// captured inside the guest, policy loaded from lib/mcp-policy/. This single
// tool eliminates the edit-boot-script-and-redeploy debugging loop the field
// session was forced into.
async function toolRunLxcCommand(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const incusName = `${LXC_PREFIX}${name}`;

  let requestedWd = null;
  if (args.working_dir != null && String(args.working_dir).trim() !== '') {
    requestedWd = validTargetDir(args.working_dir);
    if (!requestedWd) return toolResult('working_dir must be an absolute path inside the guest', { isError: true });
  }
  const startup = await readContainerStartup(incusName).catch(() => null);
  const registeredWd = startup?.workingDir || null;
  const workingDir = requestedWd || registeredWd || '/';

  const parsed = parseLxcCommand(args.command, LXC_CMD_POLICY, {
    workingDir,
    registeredWorkingDir: registeredWd,
    // argv verbatim — the only way to express an argument containing a space
    // (`-H`, `Connection: Upgrade`), which `command` cannot survive.
    args: Array.isArray(args.args) ? args.args : null,
  });
  if (parsed.error) return toolResult(parsed.error, { isError: true });

  const timeoutMs = lxcCommandTimeoutMs(args.timeout_seconds, LXC_CMD_POLICY);
  const cap = Number(LXC_CMD_POLICY.output_cap_bytes) > 0 ? Number(LXC_CMD_POLICY.output_cap_bytes) : PROJECT_COMMAND_OUTPUT_CAP;
  const nonce = randomBytes(6).toString('hex');
  const mark = (k) => `PP_${nonce}_${k}`;
  const script = [
    'wd="$1"; shift',
    'cd "$wd" || exit 97',
    'o=$(mktemp) || exit 98; e=$(mktemp) || exit 98',
    '"$@" >"$o" 2>"$e"; ec=$?',
    `echo "${mark('EXIT')}:$ec"`,
    `echo "${mark('OUT')}"`,
    `tail -c ${cap} "$o"`,
    'echo ""',
    `echo "${mark('ERR')}"`,
    `tail -c ${cap} "$e"`,
    'rm -f "$o" "$e"',
  ].join('\n');

  const startedAt = Date.now();
  const r = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', script, 'sh', workingDir, ...parsed.argv],
    { timeoutMs },
  );
  const durationMs = Date.now() - startedAt;
  const streams = parseMarkedStreams(r.stdout, nonce);

  logAudit(auth.created_by, 'LXC_COMMAND_RUN', 'lxc', name, {
    via: 'mcp', command: parsed.argv.join(' '), scope: parsed.scope,
    working_dir: workingDir, exit_code: streams.found ? streams.exit_code : null,
    timed_out: !!r.timedOut, duration_ms: durationMs,
  }, null);

  if (!streams.found) {
    const why = r.timedOut
      ? `Timed out after ${Math.round(timeoutMs / 1000)}s. NOTE: the deadline kills the incus client, so the command may still be running inside the guest — check with a short read-only call before retrying. Pass timeout_seconds (max ${LXC_CMD_POLICY.max_timeout_seconds}) for long operations.`
      : r.status === 97
        ? `The working directory ${workingDir} does not exist in the guest.`
        : r.status === 98
          ? 'Could not create temporary files in the guest (out of disk?).'
          : (r.stderr || '').trim().slice(-500) || 'no output from the guest — is the container running?';
    return toolResult({
      ran: false, command: parsed.argv.join(' '), working_dir: workingDir,
      timed_out: !!r.timedOut, duration_ms: durationMs, error: why,
    }, { isError: true });
  }
  return toolResult({
    ran: true,
    command: parsed.argv.join(' '),
    argv: parsed.argv,
    scope: parsed.scope,
    working_dir: workingDir,
    exit_code: streams.exit_code,
    ok: streams.exit_code === 0,
    timed_out: !!r.timedOut,
    duration_ms: durationMs,
    stdout: streams.stdout,
    stderr: streams.stderr,
    output_truncated: streams.stdout.length >= cap || streams.stderr.length >= cap,
  }, { isError: streams.exit_code !== 0 });
}

// ---- LXC observe, continued (spec cycle 5): file listing/search, logs,
// port probes, startup detail — all read-only ----

async function toolListLxcFiles(args) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const path = validTargetDir(args.path);
  if (!path) return toolResult('path must be an absolute directory inside the guest, e.g. /opt/app', { isError: true });
  const depth = args.recursive === true ? '' : '-maxdepth 1 ';
  const script = `p="$1"; test -d "$p" || { echo PP_NOT_A_DIR >&2; exit 66; }; `
    + `find "$p" -mindepth 1 ${depth}-exec stat -c '%A|%s|%Y|%N' {} + 2>/dev/null | head -n 2001`;
  const r = await runHostCapture('incus', ['exec', `${LXC_PREFIX}${name}`, '--', 'sh', '-c', script, 'sh', path], { timeoutMs: 60000 });
  if (r.status === 66) return toolResult(`Not a directory: ${path}`, { isError: true });
  if (r.status !== 0) return toolResult(`Could not list ${path} — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  const entries = parseStatFileList(r.stdout);
  return toolResult({
    path,
    recursive: args.recursive === true,
    entry_count: Math.min(entries.length, 2000),
    truncated: entries.length > 2000,
    entries: entries.slice(0, 2000),
  });
}

async function toolSearchLxcFiles(args) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const path = validTargetDir(args.path);
  if (!path) return toolResult('path must be an absolute directory inside the guest', { isError: true });
  const pattern = validSearchPattern(args.pattern);
  if (!pattern) return toolResult('pattern is required (an extended regular expression, up to 1000 characters)', { isError: true });
  let glob = null;
  if (args.glob != null && String(args.glob).trim() !== '') {
    glob = validFileGlob(args.glob);
    if (!glob) return toolResult('glob must be a simple filename glob, e.g. *.yml', { isError: true });
  }
  // Our own script text, so the pipe to head is fine — the caller's pattern
  // and glob ride as positional parameters and never reach a parser.
  const script = glob
    ? 'grep -rnIE --include="$3" -e "$2" -- "$1" 2>/dev/null | head -n 201'
    : 'grep -rnIE -e "$2" -- "$1" 2>/dev/null | head -n 201';
  const r = await runHostCapture(
    'incus', ['exec', `${LXC_PREFIX}${name}`, '--', 'sh', '-c', script, 'sh', path, pattern, ...(glob ? [glob] : [])],
    { timeoutMs: 60000 },
  );
  // grep exit 1 = no matches (head may also mask it) — a result, not a failure.
  if (r.status !== 0 && r.status !== 1 && r.stdout.trim() === '') {
    return toolResult(`Search failed: ${(r.stderr || '').trim().slice(-300) || 'is the container running?'}`, { isError: true });
  }
  const matches = parseGitGrepOutput(r.stdout, 200);
  return toolResult({
    path, pattern, glob,
    match_count: matches.length,
    truncated: r.stdout.split('\n').filter(Boolean).length > matches.length,
    matches,
  });
}

async function toolGetLxcLogs(args) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const source = String(args.source || '');
  let lines = Number(args.lines);
  lines = Number.isInteger(lines) && lines >= 1 ? Math.min(lines, 1000) : 100;
  const incusName = `${LXC_PREFIX}${name}`;

  let argv;
  if (source === 'startup') {
    argv = ['exec', incusName, '--', 'journalctl', '-u', STARTUP_UNIT_NAME, '--no-pager', '-n', String(lines)];
  } else if (source === 'journal') {
    const unit = validUnitName(args.unit);
    if (!unit) return toolResult('unit is required for source=journal, e.g. docker.service', { isError: true });
    argv = ['exec', incusName, '--', 'journalctl', '-u', unit, '--no-pager', '-n', String(lines)];
  } else if (source === 'docker-compose') {
    const dir = validTargetDir(args.compose_dir);
    if (!dir) return toolResult('compose_dir is required for source=docker-compose (absolute path containing docker-compose.yml)', { isError: true });
    argv = ['exec', incusName, '--', 'sh', '-c', 'cd "$1" && docker compose logs --no-color --tail "$2"', 'sh', dir, String(lines)];
  } else {
    return toolResult("source must be 'startup' (the registered ProxyPilot startup service), 'journal' (a systemd unit — pass unit), or 'docker-compose' (pass compose_dir)", { isError: true });
  }
  const r = await runHostCapture('incus', argv, { timeoutMs: 60000 });
  if (r.status !== 0) {
    return toolResult(`Could not fetch logs: ${(r.stderr || '').trim().slice(-300) || 'is the container running?'}`, { isError: true });
  }
  return toolResult({
    source, lines,
    log: r.stdout.slice(-PROJECT_COMMAND_OUTPUT_CAP),
    truncated: r.stdout.length > PROJECT_COMMAND_OUTPUT_CAP,
  });
}

// probe_lxc_port — the one-call answer to "is the app up behind the proxy",
// from INSIDE the guest. In the field, telling an edge 502 apart from an
// in-guest 401 required rewriting the boot script to smuggle curl output
// through startup stdout. Never returns response bodies.
async function toolProbeLxcPort(args) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const port = normalizePort(args.port);
  if (!port) return toolResult('port must be a port number (1–65535)', { isError: true });
  const host = validProbeHost(args.host || '127.0.0.1');
  if (!host) return toolResult('host must be an IP or hostname', { isError: true });
  const scheme = String(args.scheme || 'http');
  if (!['tcp', 'http', 'https'].includes(scheme)) return toolResult("scheme must be 'tcp', 'http', or 'https'", { isError: true });
  let path = '/';
  if (args.path != null && String(args.path).trim() !== '') {
    path = String(args.path).trim();
    if (!path.startsWith('/') || /[\u0000-\u001f\u007f\s]/.test(path)) return toolResult('path must be a URL path starting with /', { isError: true });
  }
  let timeout = Number(args.timeout_seconds);
  timeout = Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.round(timeout), 60) : 10;
  const incusName = `${LXC_PREFIX}${name}`;

  const guestCurl = async (url, extraArgs = []) => {
    const argv = ['exec', incusName, '--', 'curl', '-sS', '-o', '/dev/null', '-D', '-', '-k',
      '--max-time', String(timeout), '-w', '\\nPP_TIME:%{time_total}\\nPP_CODE:%{http_code}', ...extraArgs, url];
    const r = await runHostCapture('incus', argv, { timeoutMs: (timeout + 10) * 1000 });
    return { r, parsed: parseCurlProbeOutput(r.stdout) };
  };

  if (scheme === 'tcp') {
    // telnet:// makes curl connect and then wait for data — so a short
    // timeout AFTER a successful connect (exit 28) means the port is OPEN,
    // while refused/unreachable fail immediately.
    const { r } = await guestCurl(`telnet://${host}:${port}`);
    if (r.status === 127) return toolResult('curl is not installed in this guest — apt install curl (via the startup script) first', { isError: true });
    const openish = r.status === 0 || r.status === 28 || r.status === 56;
    return toolResult({
      host, port, scheme: 'tcp',
      tcp_connect: openish,
      ...(openish ? {} : { failure: classifyCurlExit(r.status) }),
    });
  }

  const url = `${scheme}://${host}:${port}${path}`;
  const { r, parsed } = await guestCurl(url);
  if (r.status === 127) return toolResult('curl is not installed in this guest — apt install curl (via the startup script) first', { isError: true });
  const failed = r.status !== 0 && !parsed.status_code;

  // The handshake runs whatever the plain HTTP probe did. A server that
  // speaks ONLY WebSocket (RustDesk hbbs, plenty of RPC and game backends)
  // closes any non-handshake connection, so `empty_reply` here is the
  // EXPECTED signature of a healthy WS-only listener — precisely the case
  // where skipping the upgrade test hid the answer.
  let websocket = null;
  if (args.test_websocket === true) {
    const key = randomBytes(16).toString('base64');
    const w = await guestCurl(url, ['-H', 'Connection: Upgrade', '-H', 'Upgrade: websocket', '-H', `Sec-WebSocket-Key: ${key}`, '-H', 'Sec-WebSocket-Version: 13']);
    const wsFailed = w.r.status !== 0 && !w.parsed.status_code;
    websocket = {
      upgraded: w.parsed.status_code === 101,
      status_code: w.parsed.status_code ?? null,
      ...(wsFailed ? { failure: classifyCurlExit(w.r.timedOut ? 28 : w.r.status) } : {}),
    };
  }
  const wsOnly = failed && websocket?.upgraded === true;

  return toolResult({
    host, port, scheme, path,
    ...(wsOnly
      ? {
        reachable: true,
        ws_only: true,
        http_probe: { reachable: false, failure: classifyCurlExit(r.timedOut ? 28 : r.status) },
        note: 'WS-only listener: the plain HTTP probe was closed without a response and the WebSocket upgrade succeeded. That is a healthy server, not an outage.',
      }
      : failed
        ? { reachable: false, failure: classifyCurlExit(r.timedOut ? 28 : r.status) }
        : {
          reachable: true,
          status_code: parsed.status_code,
          server: parsed.server,
          content_type: parsed.content_type,
          time_seconds: parsed.time_seconds,
          note: parsed.status_code === 401 || parsed.status_code === 403
            ? 'An auth status means the app IS answering — if the public route fails, the problem is at the edge (see test_route).'
            : undefined,
        }),
    websocket,
  });
}

async function toolGetLxcStartup(args) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const incusName = `${LXC_PREFIX}${name}`;
  const startup = await readContainerStartup(incusName).catch(() => null);
  if (!startup?.scriptPath) {
    return toolResult('No startup script is registered for this container — apply_lxc_zip with startup_script registers one', { isError: true });
  }
  const read = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', 'p="$1"; wc -c < "$p" 2>/dev/null || echo -1; head -c $2 -- "$p" 2>/dev/null',
      'sh', startup.scriptPath, String(LXC_FILE_READ_CAP)],
    { timeoutMs: 30000, maxCapture: FILE_READ_CAPTURE },
  );
  let content = null; let size = null;
  if (read.status === 0) {
    const nl = read.stdout.indexOf('\n');
    size = Number(read.stdout.slice(0, nl).trim());
    content = size >= 0 ? read.stdout.slice(nl + 1) : null;
  }
  const unitR = await runHostCapture(
    'incus', ['exec', incusName, '--', 'systemctl', 'show', STARTUP_UNIT_NAME,
      '-p', 'ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp'],
    { timeoutMs: 30000 },
  );
  const unit = unitR.status === 0 ? parseSystemctlShow(unitR.stdout) : {};
  return toolResult({
    script_path: startup.scriptPath,
    working_dir: startup.workingDir || null,
    size_bytes: size != null && size >= 0 ? size : null,
    // Either cap can cut this: the file cap in the container, or the transport
    // budget on the way back. Both are the same fact to a caller.
    truncated: (size != null && size > LXC_FILE_READ_CAP) || read.stdoutTruncated === true,
    content,
    unit: {
      name: STARTUP_UNIT_NAME,
      state: unit.ActiveState || null,
      result: unit.Result || null,
      last_exit_code: unit.ExecMainStatus != null && unit.ExecMainStatus !== '' ? Number(unit.ExecMainStatus) : null,
      last_started_at: unit.ExecMainStartTimestamp || null,
      last_exited_at: unit.ExecMainExitTimestamp || null,
    },
  });
}

// ---- LXC lifecycle/config (spec cycle 4: every mutation confirms and
// snapshots first; deliberately NO delete verb — removal stays host-side) ----

// The snapshot primitive every other mutating tool leans on. Returns
// { name } or { error }.
async function takeLxcSnapshot(incusName, snapName) {
  // `incus snapshot <instance> <name>` is LXD-era syntax. Incus moved snapshots
  // into a subcommand group, so the bare form now resolves the instance name as
  // a subcommand: `unknown command "pp-Foo" for "incus snapshot"`. Every
  // mutating LXC tool snapshots first, so this one word took out
  // snapshot_lxc_container, set_lxc_config AND set_lxc_network at once.
  const r = await runHostCapture('incus', ['snapshot', 'create', incusName, snapName], { timeoutMs: 120000 });
  if (r.status !== 0) {
    const why = r.timedOut ? 'timed out' : (r.stderr || '').trim().slice(-300) || 'unknown error';
    return { error: `snapshot failed (${why})` };
  }
  return { name: snapName };
}

async function toolSnapshotLxcContainer(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const incusName = `${LXC_PREFIX}${name}`;

  if (args.list === true) {
    const r = await fetchLxcInstance(incusName);
    if (r.error) return toolResult(`Could not list snapshots: ${r.error}`, { isError: true });
    if (r.notFound) return toolResult(`Container ${name} not found`, { isError: true });
    return toolResult({ container: name, snapshots: lxcContainerDetail(r.instance).snapshots });
  }

  let snapName = defaultSnapshotName(new Date());
  if (args.name != null && String(args.name).trim() !== '') {
    snapName = validSnapshotName(args.name);
    if (!snapName) return toolResult('Snapshot name must be alphanumeric plus ._- (max 63 chars)', { isError: true });
  }
  const snap = await takeLxcSnapshot(incusName, snapName);
  if (snap.error) return toolResult(`Could not snapshot ${name}: ${snap.error}`, { isError: true });
  logAudit(auth.created_by, 'LXC_SNAPSHOT_TAKEN', 'lxc', name, { via: 'mcp', snapshot: snapName }, null);
  return toolResult({
    snapshotted: true, container: name, snapshot: snapName,
    note: 'Restoring or deleting snapshots is a deliberate host-side act (incus snapshot restore / incus snapshot delete) — no MCP verb exists for either, by design.',
  });
}

async function toolControlLxcContainer(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const action = String(args.action || '');
  if (!['start', 'stop', 'restart'].includes(action)) {
    return toolResult("action must be 'start', 'stop', or 'restart'", { isError: true });
  }
  if (args.confirm !== true) {
    return toolResult(`Confirm with the user, then re-call with confirm: true to ${action} ${name}.`, { isError: true });
  }
  const incusName = `${LXC_PREFIX}${name}`;
  // Clean shutdown only — no --force. A guest that will not stop cleanly is
  // exactly the case a human should look at.
  const r = await runHostCapture('incus', [action, incusName], { timeoutMs: 180000 });
  logAudit(auth.created_by, 'LXC_CONTROL', 'lxc', name, { via: 'mcp', action, exit: r.status, timed_out: !!r.timedOut }, null);
  if (r.status !== 0) {
    const why = r.timedOut
      ? `timed out — the guest did not ${action} cleanly within 180s (no force-kill is issued over MCP; check it with get_lxc_container)`
      : (r.stderr || '').trim().slice(-300) || 'unknown error';
    return toolResult(`Could not ${action} ${name}: ${why}`, { isError: true });
  }
  const detail = await fetchLxcInstance(incusName);
  return toolResult({
    done: true, action, container: name,
    status: detail.instance?.status || null,
  });
}

async function toolSetLxcConfig(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const change = validateLxcConfigChange(args.key, args.value, { acknowledgeRisk: args.acknowledge_risk === true }, LXC_CFG_POLICY);
  if (change.error) return toolResult(change.error, { isError: true });
  if (args.confirm !== true) {
    return toolResult({
      applied: false, needs_confirmation: true,
      message: `Setting ${change.key}=${change.value} on ${name}${change.restartRequired ? ' (takes effect after a restart)' : ''}. Confirm with the user, then re-call with confirm: true.`,
      ...(change.warning ? { warning: change.warning } : {}),
    });
  }
  const incusName = `${LXC_PREFIX}${name}`;

  // Snapshot BEFORE the write — the undo path must exist before the change.
  const snap = await takeLxcSnapshot(incusName, defaultSnapshotName(new Date(), `pp-mcp-pre-${change.key.replace(/[^A-Za-z0-9]/g, '_')}`));
  if (snap.error) {
    return toolResult(`Refusing to change config without a snapshot: ${snap.error}`, { isError: true });
  }
  const r = await runHostCapture('incus', ['config', 'set', incusName, change.key, change.value], { timeoutMs: 60000 });
  if (r.status !== 0) {
    return toolResult(`incus config set failed: ${(r.stderr || '').trim().slice(-300) || 'unknown error'} (pre-change snapshot ${snap.name} was taken)`, { isError: true });
  }
  logAudit(auth.created_by, 'LXC_CONFIG_SET', 'lxc', name, {
    via: 'mcp', key: change.key, value: change.value, snapshot: snap.name,
    ...(change.warning ? { acknowledged_risk: true } : {}),
  }, null);
  return toolResult({
    applied: true, container: name, key: change.key, value: change.value,
    snapshot: snap.name,
    restart_required: change.restartRequired,
    ...(change.restartRequired ? { next: `Apply it with control_lxc_container action=restart (confirm: true).` } : {}),
    ...(change.warning ? { warning: change.warning } : {}),
  });
}

// create_lxc_container — creation-only, so inherently non-destructive: it
// fails if the name is taken, never replaces. Mirrors the UI route's launch
// flags (routes/lxc.js POST /containers) so nesting and the syscall intercepts
// are set at birth. Deliberately does NOT accept security.privileged — that
// flip stays behind set_lxc_config's acknowledge_risk gate.
//
// What docker_ready does NOT do — and used to claim it did — is prevent
// keyring failures. Those are a HOST condition: unprivileged guests map
// container-root to a non-root host uid, so they get kernel.keys.maxkeys (200
// by default) instead of root's million, and every ProxyPilot guest shares one
// idmap and therefore one budget. A brand-new guest can fail its very first
// `docker compose up` with "unable to join session keyring: disk quota
// exceeded" because OTHER guests spent the keys. So a docker_ready create
// checks the host's headroom and says so up front, rather than letting an
// agent meet it as an opaque EDQUOT twenty minutes into a deploy.
async function toolCreateLxcContainer(args, auth) {
  const name = String(args.name || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name (letters, digits, hyphens; must start alphanumeric)', { isError: true });
  if (args.confirm !== true) {
    return toolResult(`Confirm with the user, then re-call with confirm: true to create container ${name}.`, { isError: true });
  }
  const image = validImageAlias(args.image || 'images:debian/12');
  if (!image) return toolResult('image must be an Incus image alias, e.g. "images:debian/12"', { isError: true });
  const cpu = args.cpu == null ? 2 : Number(args.cpu);
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 64) return toolResult('cpu must be a whole number of vCPUs (1–64)', { isError: true });
  const memoryGb = args.memory_gb == null ? 4 : Number(args.memory_gb);
  if (!Number.isFinite(memoryGb) || memoryGb < 0.5 || memoryGb > 512) return toolResult('memory_gb must be between 0.5 and 512', { isError: true });
  const diskGb = args.disk_gb == null ? null : Number(args.disk_gb);
  if (diskGb !== null && (!Number.isInteger(diskGb) || diskGb < 1 || diskGb > 2048)) return toolResult('disk_gb must be a whole number of GB (1–2048)', { isError: true });
  const dockerReady = args.docker_ready !== false;
  const autostart = args.autostart !== false;
  const incusName = `${LXC_PREFIX}${name}`;

  const existing = await fetchLxcInstance(incusName);
  if (existing.error) return toolResult(`Could not check for an existing container: ${existing.error}`, { isError: true });
  if (existing.instance) {
    return toolResult(`Container ${name} already exists (status ${existing.instance.status}) — creation never replaces. Use get_lxc_container to inspect it.`, { isError: true });
  }

  const argv = ['launch', image, incusName, '--profile', 'default',
    '--config', `limits.cpu=${cpu}`,
    '--config', `limits.memory=${memoryGb}GB`,
    '--config', `boot.autostart=${autostart}`];
  if (dockerReady) {
    // Same flag set the UI creation route uses for Docker-in-LXC guests:
    // nesting plus the syscall intercepts BuildKit and sysctl-touching
    // images need. Privileged mode is NOT part of docker-ready.
    argv.push(
      '--config', 'security.nesting=true',
      '--config', 'security.syscalls.intercept.mknod=true',
      '--config', 'security.syscalls.intercept.setxattr=true',
      '--config', 'security.syscalls.intercept.bpf=true',
      '--config', 'security.syscalls.intercept.bpf.devices=true',
    );
  }
  // Image download can dominate first-launch time.
  const r = await runHostCapture('incus', argv, { timeoutMs: 300000 });
  if (r.status !== 0) {
    // Best-effort cleanup of a half-created instance, same as the UI route —
    // but NEVER when the launch failed because the name is in use: that
    // instance belongs to someone else (a create that raced this one), and
    // "cleaning it up" would force-delete a live container we did not make.
    const stderrTail = (r.stderr || '').trim();
    if (!/already exists|already in use/i.test(stderrTail)) {
      await runHostCapture('incus', ['delete', incusName, '--force'], { timeoutMs: 60000 }).catch(() => {});
    }
    const why = r.timedOut ? 'timed out after 300s (slow image download?)' : stderrTail.slice(-400) || 'unknown error';
    return toolResult(`Launch failed: ${why}`, { isError: true });
  }

  const warnings = [];
  if (dockerReady) {
    try {
      const keyring = await hostKeyringFacts();
      if (keyring.assessment?.warning) warnings.push(keyring.assessment.warning);
    } catch { /* a diagnostic must never fail a create */ }
  }
  await ensureNetworkNat().catch(() => {});
  if (diskGb !== null) {
    const d = await runHostCapture('incus', ['config', 'device', 'override', incusName, 'root', `size=${diskGb}GiB`], { timeoutMs: 30000 });
    if (d.status !== 0) warnings.push(`root disk size could not be set (${(d.stderr || '').trim().slice(-200)}) — the profile default applies`);
  }

  // Give the guest a moment to pick up a DHCP lease so the result is usable.
  let detail = null;
  for (let i = 0; i < 15; i += 1) {
    const probe = await fetchLxcInstance(incusName);
    detail = probe.instance ? lxcContainerDetail(probe.instance) : null;
    if (detail?.addresses?.some((a) => a.family === 'inet')) break;
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
  }
  logAudit(auth.created_by, 'LXC_CREATED', 'lxc', name, {
    via: 'mcp', image, cpu, memory_gb: memoryGb, disk_gb: diskGb, docker_ready: dockerReady, autostart,
  }, null);
  return toolResult({
    created: true,
    container: name,
    image,
    ...(detail || {}),
    ...(warnings.length ? { warnings } : {}),
    next: 'Deploy content with inspect_lxc_zip/apply_lxc_zip (register a startup.sh), or write files directly with write_lxc_file.',
  });
}

// set_lxc_network — pin a guest's addressing so the working deployment does
// not sit on a dynamic lease whose next renewal silently reproduces the edge
// 502 that was just debugged (the exact field scenario). The pin is an
// instance-level eth0 ipv4.address, which Incus turns into a static DHCP
// reservation on its managed bridge.
async function toolSetLxcNetwork(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const mode = String(args.mode || '');
  if (!['reserve-current', 'static'].includes(mode)) {
    return toolResult("mode must be 'reserve-current' (recommended: pin the address the guest holds now) or 'static' (assign the ip given)", { isError: true });
  }
  const incusName = `${LXC_PREFIX}${name}`;
  const probe = await fetchLxcInstance(incusName);
  if (probe.error) return toolResult(`Could not inspect ${name}: ${probe.error}`, { isError: true });
  if (probe.notFound) return toolResult(`Container ${name} not found`, { isError: true });
  const detail = lxcContainerDetail(probe.instance);
  const current = detail.addresses.find((a) => a.family === 'inet')?.address || null;

  let ip;
  if (mode === 'reserve-current') {
    if (!current) return toolResult(`${name} holds no IPv4 address right now — is it running?`, { isError: true });
    ip = current;
  } else {
    ip = validIpv4(args.ip);
    if (!ip) return toolResult('ip is required for mode=static and must be a plain IPv4 address', { isError: true });
  }

  // Routes that point at an address this change would abandon keep "working"
  // until the lease turns over, then 502 — say so before it happens.
  let abandoned = [];
  if (current && ip !== current) {
    try {
      abandoned = getDb().prepare(`
        SELECT DISTINCT r.domain FROM service_http_routes r
        INNER JOIN services s ON s.id = r.service_id
        WHERE s.target_ip = ? OR s.lxc_container_name = ?
      `).all(current, name).map((row) => row.domain);
    } catch { /* advisory only */ }
  }
  if (args.confirm !== true) {
    return toolResult({
      applied: false, needs_confirmation: true,
      message: `Pin ${name} to ${ip}${current ? ` (currently ${current})` : ''}. Confirm with the user, then re-call with confirm: true.`,
      ...(abandoned.length ? { warning: `These routed domains currently target ${current}, which this change abandons: ${abandoned.join(', ')}. Update them with set_route after pinning.` } : {}),
    });
  }

  const snap = await takeLxcSnapshot(incusName, defaultSnapshotName(new Date(), 'pp-mcp-pre-network'));
  if (snap.error) return toolResult(`Refusing to change addressing without a snapshot: ${snap.error}`, { isError: true });

  // Instance-level eth0 usually comes from the profile → override creates it;
  // if a previous pin already made it instance-level, set updates it.
  let w = await runHostCapture('incus', ['config', 'device', 'override', incusName, 'eth0', `ipv4.address=${ip}`], { timeoutMs: 30000 });
  if (w.status !== 0 && /already exists/i.test(w.stderr || '')) {
    w = await runHostCapture('incus', ['config', 'device', 'set', incusName, 'eth0', 'ipv4.address', ip], { timeoutMs: 30000 });
  }
  if (w.status !== 0) {
    return toolResult(`Could not pin the address: ${(w.stderr || '').trim().slice(-300)} (pre-change snapshot ${snap.name} was taken). Note: pinning requires the guest's NIC to come from a managed Incus bridge.`, { isError: true });
  }
  logAudit(auth.created_by, 'LXC_NETWORK_PINNED', 'lxc', name, { via: 'mcp', mode, ip, previous: current, snapshot: snap.name }, null);
  return toolResult({
    applied: true, container: name, ip, mode,
    previous_address: current,
    snapshot: snap.name,
    restart_recommended: ip !== current,
    ...(abandoned.length ? { warning: `Routed domains still targeting ${current}: ${abandoned.join(', ')} — update them with set_route.` } : {}),
    note: ip === current
      ? 'The current address is now a static reservation — future lease renewals cannot move it.'
      : `The reservation takes effect when the guest renews its lease — restart with control_lxc_container to apply it now.`,
  });
}

// lxc_file_diff / restore_lxc_file — complete the .old backup story that
// write_lxc_file and apply_lxc_zip start: today the backups are written but
// nothing can show or restore them.

async function toolLxcFileDiff(args) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const path = validLxcFilePath(args.path);
  if (!path) return toolResult('path must be an absolute file path inside the container', { isError: true });
  let against = `${path}.old`;
  if (args.against != null && String(args.against).trim() !== '') {
    against = validLxcFilePath(args.against);
    if (!against) return toolResult('against must be an absolute file path inside the container', { isError: true });
  }
  const r = await runHostCapture(
    'incus', ['exec', `${LXC_PREFIX}${name}`, '--', 'sh', '-c',
      'a="$1"; b="$2"; test -f "$a" || { echo "PP_MISSING:$a" >&2; exit 66; }; test -f "$b" || { echo "PP_MISSING:$b" >&2; exit 66; }; diff -u -- "$b" "$a"',
      'sh', path, against],
    { timeoutMs: 30000 },
  );
  if (r.status === 66) {
    const missing = /PP_MISSING:(.*)/.exec(r.stderr || '')?.[1]?.trim() || 'a file';
    return toolResult(`Not a file: ${missing}${missing.endsWith('.old') ? ' — no backup exists for this path (backups appear after an overwrite via write_lxc_file / apply_lxc_zip)' : ''}`, { isError: true });
  }
  if (r.status === 127) return toolResult('diff is not installed in this guest', { isError: true });
  if (r.status !== 0 && r.status !== 1) {
    return toolResult(`Diff failed: ${(r.stderr || '').trim().slice(-300) || 'is the container running?'}`, { isError: true });
  }
  const patch = capPatch(r.stdout);
  return toolResult({
    path, against,
    identical: r.status === 0,
    diff: patch.text,
    truncated: patch.truncated,
  });
}

async function toolRestoreLxcFile(args, auth) {
  const name = String(args.container || '');
  if (!LXC_NAME_REGEX.test(name)) return toolResult('Invalid container name', { isError: true });
  const path = validLxcFilePath(args.path);
  if (!path) return toolResult('path must be an absolute file path inside the container', { isError: true });
  if (args.confirm !== true) {
    return toolResult(`Confirm with the user (lxc_file_diff shows what would change), then re-call with confirm: true to restore ${path} from ${path}.old.`, { isError: true });
  }
  // Swap live ↔ .old, so the restore is itself reversible by calling again.
  const r = await runHostCapture(
    'incus', ['exec', `${LXC_PREFIX}${name}`, '--', 'sh', '-c',
      'set -e; p="$1"; test -f "$p.old" || { echo PP_NO_BACKUP >&2; exit 66; }; t="$p.pp-swap.$$"; if [ -e "$p" ]; then mv -- "$p" "$t"; fi; mv -- "$p.old" "$p"; if [ -e "$t" ]; then mv -- "$t" "$p.old"; fi',
      'sh', path],
    { timeoutMs: 30000 },
  );
  if (r.status === 66) return toolResult(`No backup exists at ${path}.old — nothing to restore.`, { isError: true });
  if (r.status !== 0) {
    return toolResult(`Restore failed: ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  logAudit(auth.created_by, 'LXC_FILE_RESTORED', 'lxc', name, { via: 'mcp', path }, null);
  return toolResult({
    restored: true, path,
    note: 'The previous live version now sits in the .old slot — calling restore again swaps back. If a startup script is registered, apply the restored file with rerun_startup.',
  });
}

// ---- static sites (spec cycle 5): parity with the projects surface ----

const SERVICES_DATA_DIR = process.env.SERVICES_DATA_DIR || '/data/services';
const STATIC_FILE_READ_CAP = 512 * 1024;
const STATIC_FILE_WRITE_CAP = 2 * 1024 * 1024;

function getStaticSite(id) {
  const siteId = normalizeServiceId(id);
  if (!siteId) return null;
  try {
    return getDb().prepare(`SELECT * FROM services WHERE id = ? AND type = 'static'`).get(siteId) || null;
  } catch { return null; }
}

function staticSiteDomains(siteId) {
  try {
    return getDb().prepare(`SELECT domain, path_prefix, ssl_enabled FROM service_http_routes WHERE service_id = ? ORDER BY (path_prefix = '/') DESC, created_at`).all(siteId);
  } catch { return []; }
}

// Walk a docroot with a hard entry cap. Local fs — the backend owns
// SERVICES_DATA_DIR directly (the UI file manager reads/writes it the same way).
async function walkDocroot(root, subdir = '', cap = 2000) {
  const base = subdir ? join(root, subdir) : root;
  const out = [];
  const stack = [''];
  let truncated = false;
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = await readdir(join(base, rel), { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (out.length >= cap) { truncated = true; break; }
      if (e.isDirectory()) {
        stack.push(childRel);
      } else if (e.isFile()) {
        let st = null;
        try { st = await fsStat(join(base, childRel)); } catch { /* raced */ }
        out.push({ path: subdir ? `${subdir}/${childRel}` : childRel, size: st?.size ?? null, mtime: st ? st.mtime.toISOString() : null });
      }
    }
    if (truncated) break;
  }
  return { files: out, truncated };
}

async function toolCreateStaticSite(args, auth) {
  const siteName = String(args.name || '').trim().slice(0, 100);
  if (!siteName) return toolResult('name is required', { isError: true });
  const domain = validDomainName(args.domain);
  if (!domain) return toolResult('domain must be a fully qualified hostname', { isError: true });
  const tls = args.tls !== false;
  if (args.confirm !== true) {
    return toolResult(`Confirm with the user, then re-call with confirm: true to create static site "${siteName}" on ${domain}.`, { isError: true });
  }
  const db = getDb();
  // Creation-only: the domain must not already be routed anywhere.
  let taken = null;
  try {
    taken = db.prepare(`SELECT r.domain, s.name FROM service_http_routes r JOIN services s ON s.id = r.service_id WHERE r.domain = ? LIMIT 1`).get(domain);
  } catch (err) {
    return toolResult(`Could not check the domain: ${err?.message || err}`, { isError: true });
  }
  if (taken) return toolResult(`${domain} is already routed (service "${taken.name}") — creation never replaces. Pick another domain or manage the existing binding.`, { isError: true });

  // Same derivation the UI uses: a filesystem-safe directory from the name.
  const safeDir = siteName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!safeDir) return toolResult('name must contain at least one letter or digit', { isError: true });
  const dataDir = join(SERVICES_DATA_DIR, safeDir);
  const dirTaken = db.prepare(`SELECT id, name FROM services WHERE data_dir = ? LIMIT 1`).get(dataDir);
  if (dirTaken) return toolResult(`The derived directory ${dataDir} already belongs to service "${dirTaken.name}" — pick a different name.`, { isError: true });

  try {
    await mkdir(dataDir, { recursive: true });
    if (!existsSync(join(dataDir, 'index.html'))) {
      // The name is caller-supplied text landing in a served HTML page —
      // escape it so a name like "<script>…" is content, not markup.
      const escName = siteName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      await writeFile(join(dataDir, 'index.html'),
        `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escName}</title></head>\n<body><h1>${escName}</h1><p>Deployed by ProxyPilot — replace this page via the static-site tools.</p></body></html>\n`);
    }
  } catch (err) {
    return toolResult(`Could not create the docroot: ${err?.message || err}`, { isError: true });
  }

  const id = uuidv4();
  try {
    db.prepare(`INSERT INTO services (id, name, kind, runtime, type, root_dir, data_dir, status)
                VALUES (?, ?, 'static_site', NULL, 'static', ?, ?, 'active')`).run(id, siteName, dataDir, dataDir);
    syncPrimaryRouteFromLegacy(db, id, {
      domain, pathPrefix: '/', targetPort: null,
      sslEnabled: tls, forceHttps: tls, websocketEnabled: false, maxUploadSize: '1G',
    });
  } catch (err) {
    try { db.prepare(`DELETE FROM service_http_routes WHERE service_id = ?`).run(id); } catch { /* fk cascade */ }
    try { db.prepare(`DELETE FROM services WHERE id = ?`).run(id); } catch { /* best effort */ }
    return toolResult(`Could not register the site: ${err?.message || err}`, { isError: true });
  }

  const undo = async (stage, detail) => {
    try { db.prepare(`DELETE FROM service_http_routes WHERE service_id = ?`).run(id); } catch { /* */ }
    try { db.prepare(`DELETE FROM services WHERE id = ?`).run(id); } catch { /* */ }
    try { await regenerateDomainCaddyConfig(db, domain); } catch { /* */ }
    try { await caddyReload({}); } catch { /* */ }
    return toolResult(`${stage}: ${detail} — the site registration was rolled back (the docroot directory was left in place).`, { isError: true });
  };
  try { await ensureCaddyStructure(); } catch { /* regenerate re-checks */ }
  try { await regenerateDomainCaddyConfig(db, domain); } catch (err) { return undo('Failed to render the Caddy config', err?.message || err); }
  try { await caddyAdapt({}); } catch (err) { return undo('Generated Caddy config failed validation', err?.stderr || err?.message || err); }
  try { await caddyReload({}); } catch (err) { return undo('Caddy reload failed', err?.stderr || err?.message || err); }

  logAudit(auth.created_by, 'SERVICE_CREATED', 'service', id, { via: 'mcp', name: siteName, domain, type: 'static' }, null);
  return toolResult({
    created: true,
    site: { id, name: siteName, domain, docroot: dataDir, tls },
    next: 'Deploy content with inspect_static_site_zip → apply_static_site_zip, or write files directly with write_static_site_file. Verify with test_route.',
  });
}

async function toolGetStaticSite(args) {
  const site = getStaticSite(args.site_id);
  if (!site) return toolResult('Static site not found — use list_static_sites for valid ids', { isError: true });
  const domains = staticSiteDomains(site.id);
  const primary = domains[0]?.domain || null;
  let docroot = null;
  if (site.data_dir) {
    const walked = await walkDocroot(site.data_dir, '', 5000);
    const bytes = walked.files.reduce((sum, f) => sum + (f.size || 0), 0);
    const newest = walked.files.reduce((max, f) => (f.mtime && f.mtime > max ? f.mtime : max), '');
    docroot = {
      path: site.data_dir,
      file_count: walked.files.length,
      approximate: walked.truncated,
      total_bytes: bytes,
      last_modified: newest || null,
    };
  }
  return toolResult({
    id: site.id,
    name: site.name,
    status: site.status || null,
    domains: domains.map((d) => ({ domain: d.domain, path_prefix: d.path_prefix, tls: !!d.ssl_enabled })),
    docroot,
    ...(primary ? await certInfoForDomain(primary) : {}),
    next: primary ? `test_route probes ${primary} end-to-end.` : 'No domain is routed to this site yet.',
  });
}

async function toolListStaticSiteFiles(args) {
  const site = getStaticSite(args.site_id);
  if (!site?.data_dir) return toolResult('Static site not found — use list_static_sites for valid ids', { isError: true });
  let subdir = '';
  if (args.subdir != null && String(args.subdir).trim() !== '') {
    subdir = validProjectFilePath(args.subdir);
    if (!subdir) return toolResult('subdir must be a relative directory inside the docroot (no .., no leading /)', { isError: true });
  }
  const walked = await walkDocroot(site.data_dir, subdir);
  return toolResult({
    site: { id: site.id, name: site.name },
    subdir: subdir || null,
    file_count: walked.files.length,
    truncated: walked.truncated,
    files: walked.files,
  });
}

async function toolReadStaticSiteFile(args) {
  const site = getStaticSite(args.site_id);
  if (!site?.data_dir) return toolResult('Static site not found', { isError: true });
  const rel = validProjectFilePath(args.path);
  if (!rel) return toolResult('path must be relative to the docroot, e.g. css/site.css', { isError: true });
  const abs = join(site.data_dir, rel);
  let st;
  try { st = await fsStat(abs); } catch { return toolResult(`Not a file: ${rel} (list_static_site_files shows the deployed files)`, { isError: true }); }
  if (!st.isFile()) return toolResult(`Not a file: ${rel}`, { isError: true });
  let buf;
  try {
    const fh = await fsOpen(abs, 'r');
    try {
      buf = Buffer.alloc(Math.min(st.size, STATIC_FILE_READ_CAP));
      await fh.read(buf, 0, buf.length, 0);
    } finally { await fh.close(); }
  } catch (err) {
    return toolResult(`Could not read ${rel}: ${err?.message || err}`, { isError: true });
  }
  if (buf.includes(0)) return toolResult(`${rel} looks binary — this tool reads text files only`, { isError: true });
  const whole = st.size <= STATIC_FILE_READ_CAP;
  return toolResult({
    path: rel,
    size_bytes: st.size,
    // Only a whole-file read can carry a hash of the file; a windowed one
    // would be a hash of the window, which is a trap dressed as a guarantee.
    sha256: whole ? sha256Hex(buf) : null,
    truncated: !whole,
    ...(whole ? {} : { note: `Only the first ${Math.floor(STATIC_FILE_READ_CAP / 1024)} KB of ${st.size} bytes is here — do NOT write this back as the whole file.` }),
    content: buf.toString('utf8'),
  });
}

async function toolWriteStaticSiteFile(args, auth) {
  const site = getStaticSite(args.site_id);
  if (!site?.data_dir) return toolResult('Static site not found', { isError: true });
  const rel = validProjectFilePath(args.path);
  if (!rel) return toolResult('path must be relative to the docroot, e.g. robots.txt', { isError: true });
  const content = String(args.content ?? '');
  if (Buffer.byteLength(content) > STATIC_FILE_WRITE_CAP) {
    return toolResult(`Content exceeds the ${Math.floor(STATIC_FILE_WRITE_CAP / (1024 * 1024))} MB single-file cap — use the zip flow for bigger payloads`, { isError: true });
  }
  const abs = join(site.data_dir, rel);
  const exists = existsSync(abs);
  if (exists && args.confirm_overwrite !== true) {
    let size = null;
    try { size = (await fsStat(abs)).size; } catch { /* */ }
    return toolResult({
      written: false, needs_confirmation: true, path: rel,
      existing_size_bytes: size,
      message: `${rel} already exists${size != null ? ` (${size} bytes)` : ''}; it will be kept as ${rel}.old. Show the user your proposed change and re-call with confirm_overwrite: true after they approve.`,
    });
  }
  const wantSha = sha256Hex(Buffer.from(content, 'utf8'));
  const wantBytes = Buffer.byteLength(content, 'utf8');
  try {
    await mkdir(join(abs, '..'), { recursive: true });
    if (exists) await copyFile(abs, `${abs}.old`);
    // Stage, verify, then rename into place: a docroot is live, so a
    // half-written file is a half-served page. The rename is atomic, and a
    // failed verification never reaches the served path.
    const staged = `${abs}.pp-write-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(staged, content);
      const back = await readFile(staged);
      if (back.length !== wantBytes || sha256Hex(back) !== wantSha) {
        await rm(staged, { force: true });
        return toolResult(
          `Write of ${rel} did not verify on read-back (${back.length} bytes vs ${wantBytes}). Nothing was published — retry the call.`,
          { isError: true },
        );
      }
      await rename(staged, abs);
    } catch (err) {
      await rm(staged, { force: true }).catch(() => {});
      throw err;
    }
  } catch (err) {
    return toolResult(`Write failed: ${err?.message || err}`, { isError: true });
  }
  logAudit(auth.created_by, 'STATIC_FILE_WRITTEN', 'service', site.id, { via: 'mcp', path: rel, bytes: wantBytes, replaced: exists }, null);
  return toolResult({
    written: true, path: rel, bytes: wantBytes,
    total_lines: content === '' ? 0 : content.replace(/\n$/, '').split('\n').length,
    sha256: wantSha, verified: true,
    backup: exists ? `${rel}.old` : null,
    note: 'Static files serve immediately — no reload step.',
  });
}

async function toolGetStaticSiteCert(args) {
  const site = getStaticSite(args.site_id);
  if (!site) return toolResult('Static site not found', { isError: true });
  const domains = staticSiteDomains(site.id);
  if (!domains.length) return toolResult(`Site "${site.name}" has no routed domain — nothing to hold a certificate.`, { isError: true });
  const primary = domains[0].domain;
  const info = await certInfoForDomain(primary);
  return toolResult({
    site: { id: site.id, name: site.name },
    domain: primary,
    tls_enabled: !!domains[0].ssl_enabled,
    ...info,
    ...(info.certificate == null && domains[0].ssl_enabled
      ? { note: 'No issued certificate found on disk — issuance may be in flight (Caddy retries automatically), or the domain may not resolve to this host yet.' }
      : {}),
  });
}

// ---- edge routing (spec cycle 3: the layer where the field session's
// actual failure lived, previously invisible over MCP) ----

const ROUTE_SELECT = `
  SELECT r.id AS route_id, r.domain, r.path_prefix, r.target_port,
         r.websocket_enabled, r.ssl_enabled, r.force_https, r.health_path, r.service_id,
         s.name AS service_name, s.kind, s.runtime, s.type, s.target_ip,
         s.lxc_container_name, s.data_dir, s.status AS service_status
  FROM service_http_routes r
  INNER JOIN services s ON s.id = r.service_id
  WHERE s.is_admin = 0`;

function routeView(r) {
  const isStatic = r.kind === 'static_site';
  const orphaned = !isStatic && (!r.target_ip || !r.target_port);
  return {
    domain: r.domain,
    path_prefix: r.path_prefix,
    upstream: isStatic
      ? { type: 'static_site', site_id: r.service_id, name: r.service_name, docroot: r.data_dir || null }
      : {
        type: 'container',
        name: r.service_name,
        container: r.lxc_container_name || null,
        ip: r.target_ip || null,
        port: r.target_port || null,
      },
    websocket: !!r.websocket_enabled,
    health_path: r.health_path || null,
    tls: { ssl_enabled: !!r.ssl_enabled, force_https: !!r.force_https },
    ...(orphaned ? { orphaned: true, orphan_reason: !r.target_ip ? 'no upstream IP recorded' : 'no upstream port recorded' } : {}),
  };
}

async function toolListRoutes() {
  let rows;
  try {
    rows = getDb().prepare(`${ROUTE_SELECT} ORDER BY r.domain, length(r.path_prefix) DESC`).all();
  } catch (err) {
    return toolResult(`Could not list routes: ${err?.message || err}`, { isError: true });
  }
  const routes = rows.map(routeView);
  const orphaned = routes.filter((r) => r.orphaned).map((r) => `${r.domain}${r.path_prefix}`);
  return toolResult({
    route_count: routes.length,
    routes,
    ...(orphaned.length ? { orphaned_routes: orphaned, note: 'Orphaned routes render but their upstream is unrecorded — requests will 502. Fix with set_route.' } : {}),
  });
}

// Cert detail for a domain: the manual-cert decision plus, for ACME domains,
// the on-disk certificate parsed for expiry. Advisory — never fails the tool.
async function certInfoForDomain(domain) {
  const out = { tls_policy: null, certificate: null };
  try {
    const decision = resolveTlsForHost(domain);
    out.tls_policy = decision === null
      ? { mode: 'acme', note: 'Caddy manages issuance automatically' }
      : { mode: decision.mode, ...(decision.certId ? { manual_cert_id: decision.certId } : {}) };
  } catch { /* advisory */ }
  try {
    const dir = resolveCertDir(domain);
    if (dir?.certFile) {
      const pem = await runHostCapture('cat', [dir.certFile], { timeoutMs: 10000 });
      const parsed = pem.status === 0 ? parseCertificate(pem.stdout) : null;
      out.certificate = {
        issuer_directory: dir.issuer,
        ...(parsed ? {
          common_name: parsed.commonName,
          covered_names: parsed.coveredNames,
          not_before: parsed.notBefore,
          not_after: parsed.notAfter,
          days_until_expiry: daysUntil(parsed.notAfter),
          status: expiryStatus(parsed.notAfter),
        } : { note: 'certificate file present but not readable/parseable' }),
      };
    }
  } catch { /* advisory */ }
  return out;
}

// Recent 5xx counts from the domain's Caddy access log — the signal that was
// missing in the field, where a stale-upstream 502 was diagnosable only by
// inference. Advisory: a missing/unreadable log yields null, never an error.
async function recentErrorsForDomain(domain) {
  const logPath = caddyAccessLogPath(domain);
  // Last 512 KB is plenty for an hour on anything but a very hot site; the
  // summary flags partial_window when the tail starts inside the window.
  const r = await runHostCapture('tail', ['-c', '524288', logPath], { timeoutMs: 15000 });
  if (r.status !== 0) return null;
  return { log: logPath, ...summarizeAccessLog(r.stdout, Date.now()) };
}

async function toolGetRoute(args) {
  const domain = validDomainName(args.domain);
  if (!domain) return toolResult('domain must be a fully qualified hostname, e.g. web.example.com', { isError: true });
  let rows;
  try {
    rows = getDb().prepare(`${ROUTE_SELECT} AND r.domain = ? ORDER BY length(r.path_prefix) DESC`).all(domain);
  } catch (err) {
    return toolResult(`Could not read routes: ${err?.message || err}`, { isError: true });
  }
  if (!rows.length) return toolResult(`No route exists for ${domain} — list_routes shows every served hostname; set_route creates one.`, { isError: true });
  const recentErrors = await recentErrorsForDomain(domain);
  return toolResult({
    domain,
    routes: rows.map(routeView),
    ...(await certInfoForDomain(domain)),
    recent_errors: recentErrors,
    ...(recentErrors === null ? { recent_errors_note: 'No readable access log for this domain yet (the log appears after the first request to the merged site config).' } : {}),
    ...(recentErrors?.errors_5xx ? { note: `${recentErrors.errors_5xx} server error(s) in the last hour — test_route says which failure class they are.` } : {}),
    next: 'test_route probes this hostname end-to-end from the edge host.',
  });
}

// One curl probe on the HOST. Returns { parsed, exitClass|null }.
async function hostCurlProbe(url, { resolveTo = null, headers = [], maxTimeSeconds = 15 } = {}) {
  const argv = ['-sS', '-o', '/dev/null', '-D', '-', '-k', '--max-time', String(maxTimeSeconds),
    '-w', '\\nPP_TIME:%{time_total}\\nPP_CODE:%{http_code}'];
  for (const r of resolveTo || []) argv.push('--resolve', r);
  for (const h of headers) argv.push('-H', h);
  argv.push(url);
  const r = await runHostCapture('curl', argv, { timeoutMs: (maxTimeSeconds + 5) * 1000 });
  const parsed = parseCurlProbeOutput(r.stdout);
  // Exit 28 after a 101 upgrade is success that ran out the clock, not failure.
  const failed = r.status !== 0 && !(r.status === 28 && parsed.status_code);
  return { parsed, exitClass: failed ? classifyCurlExit(r.timedOut ? 28 : r.status) : null };
}

async function toolTestRoute(args, auth) {
  const domain = validDomainName(args.domain);
  if (!domain) return toolResult('domain must be a fully qualified hostname', { isError: true });
  let path = '/';
  if (args.path != null && String(args.path).trim() !== '') {
    path = String(args.path).trim();
    if (!path.startsWith('/') || /[\u0000-\u001f\u007f\s]/.test(path)) {
      return toolResult('path must be a URL path starting with /', { isError: true });
    }
  }
  let rows = [];
  try {
    rows = getDb().prepare(`${ROUTE_SELECT} AND r.domain = ? ORDER BY length(r.path_prefix) DESC`).all(domain);
  } catch { /* still probe */ }
  const root = rows.find((r) => r.path_prefix === '/') || rows[0] || null;
  const ssl = root ? !!root.ssl_enabled : true;
  const wantWs = args.test_websocket === true || (args.test_websocket == null && !!root?.websocket_enabled);

  // DNS — informational: the edge probe below pins to loopback regardless.
  let dns = { resolved: false, addresses: [] };
  const g = await runHostCapture('getent', ['hosts', domain], { timeoutMs: 10000 });
  if (g.status === 0) {
    dns = {
      resolved: true,
      addresses: [...new Set(g.stdout.split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/)[0]))].slice(0, 8),
    };
  }

  // Edge probe, pinned to this host's proxy.
  const scheme = ssl ? 'https' : 'http';
  const edgeUrl = `${scheme}://${domain}${path}`;
  const pin = [`${domain}:443:127.0.0.1`, `${domain}:80:127.0.0.1`];
  const edge = await hostCurlProbe(edgeUrl, { resolveTo: pin });

  // Upstream probe, direct from the host to the recorded target.
  let upstream = null;
  if (root && root.kind !== 'static_site' && root.target_ip && root.target_port) {
    const u = await hostCurlProbe(`http://${root.target_ip}:${root.target_port}${path}`, { maxTimeSeconds: 10 });
    upstream = {
      target: `${root.target_ip}:${root.target_port}`,
      ...(u.exitClass ? { reachable: false, failure: u.exitClass } : {
        reachable: true, status_code: u.parsed.status_code, time_seconds: u.parsed.time_seconds,
      }),
    };
  }

  // WebSocket upgrade through the proxy.
  let websocket = null;
  if (wantWs) {
    const key = randomBytes(16).toString('base64');
    const w = await hostCurlProbe(edgeUrl, {
      resolveTo: pin,
      maxTimeSeconds: 8,
      headers: ['Connection: Upgrade', 'Upgrade: websocket', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13'],
    });
    websocket = {
      upgraded: w.parsed.status_code === 101,
      status_code: w.parsed.status_code,
      ...(w.exitClass && w.parsed.status_code !== 101 ? { failure: w.exitClass } : {}),
    };
  }

  // The one-line answer: which of the three look-alike failure classes is it.
  let assessment;
  if (edge.exitClass) {
    assessment = `The edge proxy itself is unreachable on this host (${edge.exitClass.class}: ${edge.exitClass.hint}).`;
  } else if ([502, 503, 504].includes(edge.parsed.status_code)) {
    // Three signals, not two. Reachability alone said "binding is stale" for
    // an upstream that was reachable AND returning its own 502 — the binding
    // was correct, the app was broken, and "Fix with set_route" would have
    // made it worse. An upstream that answers with the SAME status the edge
    // shows is a faithfully relayed application error.
    if (!upstream) {
      assessment = `The proxy returns ${edge.parsed.status_code} and no upstream is recorded for this domain.`;
    } else if (!upstream.reachable) {
      assessment = `The proxy returns ${edge.parsed.status_code} and the recorded upstream ${upstream.target} is not answering — the app is down (or the guest's IP moved; see set_lxc_network).`;
    } else if (upstream.status_code === edge.parsed.status_code) {
      assessment = `The proxy is relaying the upstream's own ${upstream.status_code}: ${upstream.target} returns the same status when probed directly. The binding is correct — this is an application-level error, so look inside the guest (get_lxc_logs, probe_lxc_port), not at the route.`;
    } else if (upstream.status_code >= 500) {
      assessment = `The proxy returns ${edge.parsed.status_code} and the upstream ${upstream.target} answers ${upstream.status_code} — both are erroring, and the upstream's own failure is the one to fix first.`;
    } else {
      assessment = `The proxy returns ${edge.parsed.status_code} but the recorded upstream answers ${upstream.status_code} directly — the proxy's upstream binding is stale or wrong. Fix with set_route.`;
    }
  } else if (edge.parsed.status_code != null) {
    assessment = `The route serves: ${edge.parsed.status_code} in ${edge.parsed.time_seconds}s.`
      + (edge.parsed.status_code === 401 || edge.parsed.status_code === 403 ? ' (An auth status is the APP answering — the path through the proxy works.)' : '');
  } else {
    assessment = 'The probe produced no readable response.';
  }

  logAudit(auth.created_by, 'ROUTE_TESTED', 'route', domain, { via: 'mcp', path, edge_status: edge.parsed.status_code ?? null }, null);
  return toolResult({
    domain, path,
    routed: !!root,
    dns,
    edge: edge.exitClass
      ? { reachable: false, failure: edge.exitClass }
      : {
        reachable: true, scheme,
        status_code: edge.parsed.status_code,
        status_chain: edge.parsed.status_chain,
        server: edge.parsed.server,
        location: edge.parsed.location,
        time_seconds: edge.parsed.time_seconds,
      },
    upstream,
    websocket,
    assessment,
  });
}

// set_route — create or update one (domain, path_prefix) binding.
// Updating requires confirm_overwrite and returns the previous binding so the
// change is reversible by a second call. Removal is delete_route; there is
// still no enable/disable toggle (the Caddy regenerator renders every stored
// route — parking a hostname is a UI/host operation today).
async function toolSetRoute(args, auth) {
  const domain = validDomainName(args.domain);
  if (!domain) return toolResult('domain must be a fully qualified hostname, e.g. web.example.com', { isError: true });
  const port = normalizePort(args.upstream_port);
  if (!port) return toolResult('upstream_port must be a port number (1–65535)', { isError: true });
  const hasContainer = args.upstream_container != null && String(args.upstream_container).trim() !== '';
  const hasIp = args.upstream_ip != null && String(args.upstream_ip).trim() !== '';
  if (hasContainer === hasIp) {
    return toolResult('Provide exactly one of upstream_container (preferred — survives IP changes) or upstream_ip.', { isError: true });
  }
  const pathPrefix = validRoutePathPrefix(args.path_prefix);
  if (!pathPrefix) return toolResult('path_prefix must be an absolute URL path, e.g. /api (default "/")', { isError: true });
  const health = validRouteHealthPath(args.health_path);
  if (health.error) return toolResult(health.error, { isError: true });
  const healthPath = health.value;
  const websocket = args.websocket !== false;   // default TRUE: modern upstreams break without it and the failure mode is misleading
  const tls = args.tls !== false;

  // Resolve the upstream to (ip, containerShortName|null).
  let ip = null; let containerName = null; let upstreamSelection = null;
  if (hasContainer) {
    containerName = String(args.upstream_container).trim();
    if (!LXC_NAME_REGEX.test(containerName)) return toolResult('Invalid container name', { isError: true });
    const probe = await fetchLxcInstance(`${LXC_PREFIX}${containerName}`);
    if (probe.error) return toolResult(`Could not resolve container ${containerName}: ${probe.error}`, { isError: true });
    if (probe.notFound) return toolResult(`Container ${containerName} not found — list_lxc_containers shows valid names`, { isError: true });

    // The guest's managed NIC decides which address the edge can reach —
    // ask Incus for the bridge subnet rather than trusting interface names.
    const bridgeName = instanceNicParent(probe.instance);
    let subnetCidr = null;
    if (bridgeName) {
      const net = await runHostCapture('incus', ['network', 'show', bridgeName], { timeoutMs: 15000 });
      if (net.status === 0) subnetCidr = parseNetworkIpv4Cidr(net.stdout);
    }
    const detail = lxcContainerDetail(probe.instance);
    const pick = pickUpstreamAddress(detail.addresses, { subnetCidr });
    if (pick.error === 'no_ipv4') {
      return toolResult(`Container ${containerName} holds no IPv4 address — is it running? (Pin one with set_lxc_network once it does.)`, { isError: true });
    }
    if (pick.error === 'all_filtered') {
      const shown = pick.rejected.map((a) => `${a.interface} ${a.address} (${a.why})`).join('; ');
      return toolResult(`Container ${containerName} has no edge-reachable IPv4 — every address belongs to a virtual interface: ${shown}. `
        + 'Is its managed NIC up? Pass upstream_ip explicitly to override.', { isError: true });
    }
    if (pick.error === 'ambiguous') {
      const shown = pick.candidates.map((a) => `${a.interface} ${a.address}`).join(', ');
      return toolResult(`Container ${containerName} has more than one routable IPv4 (${shown})`
        + (subnetCidr ? ` and the managed bridge subnet ${subnetCidr} does not separate them` : ' and no managed bridge subnet was readable to separate them')
        + '. Refusing to guess — re-call with upstream_ip set to the one the edge should dial.', { isError: true });
    }
    ip = pick.ip;
    upstreamSelection = {
      chosen: pick.chosen,
      rejected: pick.rejected,
      bridge: bridgeName || null,
      bridge_subnet: subnetCidr,
    };
  } else {
    ip = validIpv4(args.upstream_ip);
    if (!ip) return toolResult('upstream_ip must be a plain IPv4 address', { isError: true });
  }

  const db = getDb();
  let existing = null;
  try {
    existing = db.prepare(`${ROUTE_SELECT} AND r.domain = ? AND r.path_prefix = ?`).get(domain, pathPrefix);
  } catch (err) {
    return toolResult(`Could not read existing routes: ${err?.message || err}`, { isError: true });
  }
  if (existing?.kind === 'static_site') {
    return toolResult(`${domain} is bound to the static site "${existing.service_name}" (id ${existing.service_id}) — set_route only manages container upstreams. Manage the site with the static-site tools instead.`, { isError: true });
  }
  const previous = existing ? {
    path_prefix: existing.path_prefix,
    upstream_container: existing.lxc_container_name || null,
    upstream_ip: existing.target_ip || null,
    upstream_port: existing.target_port || null,
    websocket: !!existing.websocket_enabled,
    health_path: existing.health_path || null,
    tls: !!existing.ssl_enabled,
  } : null;
  const proposed = {
    path_prefix: pathPrefix,
    upstream_container: containerName,
    upstream_ip: ip,
    upstream_port: port,
    websocket,
    health_path: healthPath,
    tls,
  };
  if (existing && args.confirm_overwrite !== true) {
    return toolResult({
      applied: false, needs_confirmation: true, domain,
      current_binding: previous,
      proposed_binding: proposed,
      message: `${domain}${pathPrefix} already has a binding. Show the user both bindings and re-call with confirm_overwrite: true after they approve.`,
    });
  }

  // One site block per domain: every route on it must agree on TLS stance.
  try {
    assertRoutesShareSslStance(db, domain, { sslEnabled: tls, forceHttps: tls }, existing?.route_id || null);
  } catch (err) {
    return toolResult(err?.message || 'TLS stance conflicts with this domain\'s other routes', { isError: true });
  }

  // Service row: per-container when a container was named, else keyed by IP.
  let service;
  try {
    if (containerName) {
      service = findOrCreateLxcService(db, containerName, ip);
    } else {
      service = db.prepare(`SELECT * FROM services WHERE target_ip = ? AND lxc_container_name IS NULL AND is_admin = 0 LIMIT 1`).get(ip);
      if (!service) {
        const id = uuidv4();
        db.prepare(`INSERT INTO services (id, name, kind, runtime, target_ip, type, status)
                    VALUES (?, ?, 'container_service', NULL, ?, 'docker', 'active')`).run(id, domain, ip);
        service = db.prepare(`SELECT * FROM services WHERE id = ?`).get(id);
      } else if (service.target_ip !== ip) {
        db.prepare(`UPDATE services SET target_ip = ? WHERE id = ?`).run(ip, service.id);
      }
    }
  } catch (err) {
    return toolResult(`Could not prepare the upstream service record: ${err?.message || err}`, { isError: true });
  }

  // Mutate the route row, keeping enough to roll back.
  const rollback = [];
  try {
    if (existing) {
      rollback.push(() => db.prepare(
        `UPDATE service_http_routes SET service_id = ?, target_port = ?, websocket_enabled = ?, ssl_enabled = ?, force_https = ?, health_path = ? WHERE id = ?`,
      ).run(existing.service_id, existing.target_port, existing.websocket_enabled, existing.ssl_enabled, existing.force_https, existing.health_path ?? null, existing.route_id));
      db.prepare(
        `UPDATE service_http_routes SET service_id = ?, target_port = ?, websocket_enabled = ?, ssl_enabled = ?, force_https = ?, health_path = ? WHERE id = ?`,
      ).run(service.id, port, websocket ? 1 : 0, tls ? 1 : 0, tls ? 1 : 0, healthPath, existing.route_id);
    } else {
      const routeId = uuidv4();
      rollback.push(() => db.prepare(`DELETE FROM service_http_routes WHERE id = ?`).run(routeId));
      db.prepare(
        `INSERT INTO service_http_routes
           (id, service_id, domain, path_prefix, target_port, websocket_enabled, ssl_enabled, force_https, max_upload_size, health_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1G', ?)`,
      ).run(routeId, service.id, domain, pathPrefix, port, websocket ? 1 : 0, tls ? 1 : 0, tls ? 1 : 0, healthPath);
    }
  } catch (err) {
    return toolResult(`Could not write the route: ${err?.message || err}`, { isError: true });
  }

  // Render → validate → reload, rolling the DB back on any failure so a bad
  // route never survives to poison the next reconcile.
  const undo = async (stage, detail) => {
    for (const fn of rollback.reverse()) { try { fn(); } catch { /* best effort */ } }
    try { await regenerateDomainCaddyConfig(db, domain); } catch { /* best effort */ }
    try { await caddyReload({}); } catch { /* best effort */ }
    return toolResult(`${stage}: ${detail} — the route change was rolled back.`, { isError: true });
  };
  try { await ensureCaddyStructure(); } catch { /* regenerate re-checks */ }
  try {
    await regenerateDomainCaddyConfig(db, domain);
  } catch (err) {
    return undo('Failed to render the Caddy config', err?.message || err);
  }
  try {
    await caddyAdapt({});
  } catch (err) {
    return undo('Generated Caddy config failed validation', err?.stderr || err?.message || err);
  }
  try {
    await caddyReload({});
  } catch (err) {
    return undo('Caddy reload failed', err?.stderr || err?.message || err);
  }

  logAudit(auth.created_by, 'ROUTE_SET', 'route', domain, {
    via: 'mcp', path_prefix: pathPrefix, upstream: `${ip}:${port}`, container: containerName,
    websocket, tls, health_path: healthPath, replaced: !!existing,
  }, null);
  return toolResult({
    applied: true,
    domain,
    binding: proposed,
    // The address was CHOSEN, not read off the top of a list — show the work
    // so a wrong upstream is visible here instead of as a later 502.
    ...(upstreamSelection ? { upstream_selection: upstreamSelection } : {}),
    ...(previous ? { previous_binding: previous, note: 'Reversible: call set_route again with previous_binding to restore it.' } : {}),
    ...(containerName ? { hint: `Upstream resolved from container ${containerName} (currently ${ip}). Pin that address with set_lxc_network so a lease renewal cannot break this route.` } : {}),
    next: 'Verify end-to-end with test_route.',
  });
}

// delete_route — the counterpart set_route never had. An agent that can
// create a binding but not remove one leaves orphans behind and has to ask a
// human to finish. Two-phase, like every other destructive verb here: the
// unconfirmed call shows exactly what would go, the confirmed one echoes what
// went so set_route can restore it verbatim.
async function toolDeleteRoute(args, auth) {
  const domain = validDomainName(args.domain);
  if (!domain) return toolResult('domain must be a fully qualified hostname, e.g. web.example.com', { isError: true });
  const pathPrefix = validRoutePathPrefix(args.path_prefix);
  if (!pathPrefix) return toolResult('path_prefix must be an absolute URL path, e.g. /api (default "/")', { isError: true });

  const db = getDb();
  let row = null;
  try {
    row = db.prepare(`${ROUTE_SELECT} AND r.domain = ? AND r.path_prefix = ?`).get(domain, pathPrefix);
  } catch (err) {
    return toolResult(`Could not read existing routes: ${err?.message || err}`, { isError: true });
  }
  if (!row) {
    return toolResult(`No route is bound to ${domain}${pathPrefix} — list_routes shows what exists.`, { isError: true });
  }
  if (row.kind === 'static_site') {
    return toolResult(`${domain}${pathPrefix} belongs to the static site "${row.service_name}" (id ${row.service_id}) — delete_route only removes container bindings. Manage the site with the static-site tools instead.`, { isError: true });
  }

  const binding = {
    path_prefix: row.path_prefix,
    upstream_container: row.lxc_container_name || null,
    upstream_ip: row.target_ip || null,
    upstream_port: row.target_port || null,
    websocket: !!row.websocket_enabled,
    health_path: row.health_path || null,
    tls: !!row.ssl_enabled,
  };
  if (args.confirm !== true) {
    return toolResult({
      deleted: false, needs_confirmation: true, domain,
      binding_to_delete: binding,
      message: `Show the user this binding and re-call with confirm: true to remove ${domain}${pathPrefix}. The container and its files are not touched.`,
    });
  }

  const full = db.prepare(`SELECT * FROM service_http_routes WHERE id = ?`).get(row.route_id);
  try {
    db.prepare(`DELETE FROM service_http_routes WHERE id = ?`).run(row.route_id);
  } catch (err) {
    return toolResult(`Could not delete the route: ${err?.message || err}`, { isError: true });
  }
  // Put the row back if the render/reload cycle rejects the result — a
  // half-applied delete would leave Caddy serving what the DB says is gone.
  const restore = () => {
    try {
      const cols = Object.keys(full);
      db.prepare(
        `INSERT INTO service_http_routes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ).run(...cols.map((c) => full[c]));
    } catch { /* best effort */ }
  };
  const undo = async (stage, detail) => {
    restore();
    try { await regenerateDomainCaddyConfig(db, domain); } catch { /* best effort */ }
    try { await caddyReload({}); } catch { /* best effort */ }
    return toolResult(`${stage}: ${detail} — the deletion was rolled back.`, { isError: true });
  };
  try { await ensureCaddyStructure(); } catch { /* regenerate re-checks */ }
  try {
    await regenerateDomainCaddyConfig(db, domain);
  } catch (err) {
    return undo('Failed to render the Caddy config', err?.message || err);
  }
  try {
    await caddyAdapt({});
  } catch (err) {
    return undo('Generated Caddy config failed validation', err?.stderr || err?.message || err);
  }
  try {
    await caddyReload({});
  } catch (err) {
    return undo('Caddy reload failed', err?.stderr || err?.message || err);
  }

  logAudit(auth.created_by, 'ROUTE_DELETED', 'route', domain, {
    via: 'mcp', path_prefix: pathPrefix, upstream: `${binding.upstream_ip}:${binding.upstream_port}`,
    container: binding.upstream_container,
  }, null);
  return toolResult({
    deleted: true,
    domain,
    deleted_binding: binding,
    note: 'Reversible: set_route with these values restores it. The container, its files and its service record were not touched.',
  });
}

// get_host_diagnostics — the read-only host view. Several failures in the
// field were host conditions invisible from inside a guest (keyring quota,
// incus version, bridge subnet) and cost an hour of indirect probing each.
async function toolGetHostDiagnostics() {
  try {
    const facts = await collectHostDiagnostics();
    return toolResult({
      ...facts,
      note: facts.keyring?.assessment?.warning
        || 'Nothing here is blocking: incus is reachable, the keyring has headroom, and the managed bridge subnet is the one an upstream address must fall inside.',
    });
  } catch (err) {
    return toolResult(`Could not read host diagnostics: ${err?.message || err}`, { isError: true });
  }
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
  const script = 'p="$1"; cap="$4"; test -f "$p" || { echo "PP_NOT_A_FILE" >&2; exit 66; }; '
    + FILE_READ_HEADER
    + 'if [ "$2" = "all" ]; then head -c "$4" -- "$p"; else sed -n "$2,$3p" "$p" | head -c "$4"; fi';
  const startArg = range.ranged ? String(range.start) : 'all';
  const endArg = range.ranged ? (range.end === null ? '$' : String(range.end)) : '0';
  const r = await runHostCapture(
    'incus',
    ['exec', projectContainerName(m, project), '--', 'sh', '-c', script,
      'sh', abs, startArg, endArg, String(LXC_FILE_READ_CAP)],
    { timeoutMs: 30000, maxCapture: FILE_READ_CAPTURE },
  );
  if (r.status === 66) return toolResult(`Not a file: ${rel} (use list_project_files to see the tracked files)`, { isError: true });
  if (r.status !== 0) {
    return toolResult(`Could not read ${rel} — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const capped = captureTruncationError(rel, r);
  if (capped) return toolResult(capped, { isError: true });
  const head = parseReadHeader(r.stdout);
  if (!head) return toolResult(`Read of ${rel} came back malformed — retry the call.`, { isError: true });
  const { size, totalLines } = head;
  const body = Buffer.from(head.body, 'utf8');
  if (body.includes(0)) return toolResult(`${rel} looks binary — this tool reads text files only`, { isError: true });
  const content = body.toString('utf8');
  const returnedLines = content === '' ? 0 : content.replace(/\n$/, '').split('\n').length;

  const out = {
    path: rel,
    size_bytes: size,
    total_lines: totalLines,
    // The file's hash, computed in the container. Pass it back as
    // expected_sha256 on a later edit/write and the change is refused if
    // anything moved underneath you in the meantime.
    sha256: head.sha256,
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
    // A whole-file read that matches the file's own size and hash is provably
    // complete; anything else says so out loud rather than looking normal.
    const short = readIntegrityError(rel, size, head.sha256, body);
    out.truncated = size > LXC_FILE_READ_CAP;
    if (short && !out.truncated) return toolResult(short, { isError: true });
    if (out.truncated) {
      out.note = `Only the first ${Math.floor(LXC_FILE_READ_CAP / 1024)} KB of ${size} bytes is here. `
        + 'Do NOT write this back as the whole file — use edit_project_file, or read a line range with offset/limit.';
    }
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
  const expectedSha = validSha256(args.expected_sha256);
  if (args.expected_sha256 != null && String(args.expected_sha256).trim() !== '' && !expectedSha) {
    return toolResult('expected_sha256 must be the 64-character hex SHA-256 of the file you read (read_project_file returns it).', { isError: true });
  }

  // Ask-first when the file exists — same contract as every other overwrite.
  // git history (not a .old copy) is the backup here: a stray .old inside the
  // checkout would ride into the next build's diff.
  const probe = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c',
      `${PP_SHA_FN}p="$1"; if [ -e "$p" ]; then echo EXISTS; wc -c < "$p"; pp_sha "$p"; else echo ABSENT; fi`, 'sh', abs],
    { timeoutMs: 30000 },
  );
  if (probe.status !== 0) {
    return toolResult(`Cannot inspect the project container — is it running? ${(probe.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const probeLines = probe.stdout.split('\n');
  const exists = probe.stdout.startsWith('EXISTS');
  if (exists && args.confirm_overwrite !== true) {
    const size = Number(String(probeLines[1] || '').trim()) || 0;
    const cur = String(probeLines[2] || '').trim();
    return toolResult({
      written: false,
      needs_confirmation: true,
      path: rel,
      existing_size_bytes: size,
      sha256: cur === NO_SHA ? null : cur,
      message: `${rel} already exists (${size} bytes; the previous version stays in git history). Show the user your proposed change and re-call with confirm_overwrite: true after they approve.`,
    });
  }

  // Staged, hashed, moved into place, then read back — see
  // verifiedContainerWrite. A failure here means the file was NOT touched.
  const written = await verifiedContainerWrite(incusName, abs, content, {
    expectedSha: expectedSha || null, label: rel,
  });
  if (written.error) return toolResult(written.error, { isError: true });

  // Commit the edit and push to the project's bare repo, so it survives
  // rehydrate and shows in the project's history like any other change.
  const git = await commitProjectPaths(incusName, [rel], args.commit_message || `chat edit: ${rel}`);
  logAudit(auth.created_by, 'MOCK2_FILE_WRITTEN', 'mock2_project', project.id, { via: 'mcp', path: rel, bytes: written.bytes, replaced: exists }, null);
  return toolResult({
    written: true, path: rel,
    bytes: written.bytes, total_lines: written.total_lines, sha256: written.sha256,
    verified: true,
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
// THE TRUNCATION TRAP, and the four locks on it. Because this tool is a
// read-modify-write, a short read is a data-destroying bug: the replacement
// lands in a partial copy and the partial copy goes back over the file. That
// happened — five times, cutting at ~267 KB, ~299 KB and ~327 KB, because the
// transport capped at 256 KB while this tool believed it could read 512 KB.
// So, in order:
//   1. a file over the read cap is refused outright rather than edited;
//   2. the read is checked against the file's own size and SHA-256, computed
//      in the container, so a short or mangled transfer cannot pass as the
//      file;
//   3. the edited buffer is checked against arithmetic — original − old×n +
//      new×n is the exact byte length the result must have, and a short read
//      misses it by tens of thousands of bytes;
//   4. the write itself stages, verifies and reads back (see
//      verifiedContainerWrite), so even a corrupted transfer OUT cannot land.
// Any of these failing means nothing is written and the file is untouched.
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
  const expectedSha = validSha256(args.expected_sha256);
  if (args.expected_sha256 != null && String(args.expected_sha256).trim() !== '' && !expectedSha) {
    return toolResult('expected_sha256 must be the 64-character hex SHA-256 of the file you read (read_project_file returns it).', { isError: true });
  }
  const r = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c',
      `p="$1"; cap="$2"; test -f "$p" || { echo "PP_NOT_A_FILE" >&2; exit 66; }; ${FILE_READ_HEADER}head -c "$cap" -- "$p"`,
      'sh', abs, String(LXC_FILE_READ_CAP)],
    { timeoutMs: 30000, maxCapture: FILE_READ_CAPTURE },
  );
  if (r.status === 66) return toolResult(`Not a file: ${rel} (use list_project_files to see the tracked files)`, { isError: true });
  if (r.status !== 0) {
    return toolResult(`Could not read ${rel} — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const capped = captureTruncationError(rel, r);
  if (capped) return toolResult(capped, { isError: true });
  const head = parseReadHeader(r.stdout);
  if (!head) return toolResult(`Read of ${rel} came back malformed — nothing was written. Retry the call.`, { isError: true });
  const size = head.size;
  if (size > LXC_FILE_READ_CAP) {
    return toolResult(
      `${rel} is ${size} bytes, over the ${Math.floor(LXC_FILE_READ_CAP / 1024)} KB limit this tool can edit safely — editing it would risk truncating the part it cannot see. Use write_project_file with the complete new content instead.`,
      { isError: true },
    );
  }
  const before = head.body;
  const beforeBuf = Buffer.from(before, 'utf8');
  if (beforeBuf.includes(0)) {
    return toolResult(`${rel} looks binary — this tool edits text files only`, { isError: true });
  }
  // Lock 2: what arrived must BE the file — same length, same hash. Checked
  // before the replacement, so a short read never becomes a write.
  const shortRead = readIntegrityError(rel, size, head.sha256, beforeBuf);
  if (shortRead) return toolResult(shortRead, { isError: true });
  // Lock 3 (precondition): refuse an edit built against a version of the file
  // that is no longer there — the concurrent-editor case.
  const stale = expectedSha256Error(rel, args.expected_sha256, head.sha256);
  if (stale) return toolResult(stale, { isError: true });

  const edited = applyStringEdit(before, args.old_string, args.new_string, args.expect_occurrences);
  if (edited.error) return toolResult(edited.error, { isError: true });

  // Lock 4: arithmetic. `size` is the file's length on disk (wc -c), never the
  // length of what we read, so this compares the buffer about to be written
  // against the size the file MUST have — three lines that turn a silent
  // truncation into a clean refusal.
  const shortWrite = editByteInvariantError({
    path: rel, originalBytes: size, oldString: args.old_string,
    newString: args.new_string, replaced: edited.replaced, content: edited.content,
  });
  if (shortWrite) return toolResult(shortWrite, { isError: true });

  const written = await verifiedContainerWrite(incusName, abs, edited.content, {
    // The file was just read; hand its hash back as the precondition so the
    // window between our read and our write is closed too.
    expectedSha: head.sha256, label: rel,
  });
  if (written.error) return toolResult(written.error, { isError: true });

  const git = await commitProjectPaths(incusName, [rel], args.commit_message || `chat edit: ${rel}`);
  logAudit(auth.created_by, 'MOCK2_FILE_EDITED', 'mock2_project', project.id, {
    via: 'mcp', path: rel, replaced: edited.replaced, bytes: written.bytes,
  }, null);
  return toolResult({
    edited: true,
    path: rel,
    replaced_count: edited.replaced,
    bytes: written.bytes,
    total_lines: written.total_lines,
    sha256: written.sha256,
    verified: true,
    ...git,
    next: 'When your edits are complete, apply them with redeploy_project.',
  });
}

// append_project_file / insert_project_file_at_line — additions that never
// move the file.
//
// Adding a route to a 400 KB router should not require reading 400 KB out and
// writing 400 KB back: every byte of that round trip is a chance to corrupt
// the file, and above the read cap it is not possible at all. These do the
// work inside the container — `cat >>` for an append, head/tail for an
// insert — and check the one invariant that matters: the file must end up
// exactly `before + added` bytes long. An append that misses it is truncated
// back to `before`; an insert that misses it never leaves the staging file.
async function toolAppendProjectFile(args, auth) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const guard = liveBuildGuard(m, project);
  if (guard) return toolResult(guard, { isError: true });
  const rel = validProjectFilePath(args.path);
  if (!rel) return toolResult('path must be a file path relative to the app root, e.g. src/server/routes.ts', { isError: true });
  const content = String(args.content ?? '');
  if (content === '') return toolResult('content is required — there is nothing to append.', { isError: true });
  if (Buffer.byteLength(content) > LXC_FILE_WRITE_CAP) {
    return toolResult(`Content exceeds the ${Math.floor(LXC_FILE_WRITE_CAP / (1024 * 1024))} MB single-call cap`, { isError: true });
  }
  const expectedSha = validSha256(args.expected_sha256);
  if (args.expected_sha256 != null && String(args.expected_sha256).trim() !== '' && !expectedSha) {
    return toolResult('expected_sha256 must be the 64-character hex SHA-256 of the file you read.', { isError: true });
  }
  const incusName = projectContainerName(m, project);
  const abs = `${M2_APP_DIR}/${rel}`;
  const added = Buffer.byteLength(content, 'utf8');
  const mustExist = args.create !== true;

  const w = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', appendScript(),
      'sh', abs, String(added), mustExist ? '1' : '0', expectedSha || ''],
    { input: content, timeoutMs: 60000 },
  );
  const detail = (w.stderr || '').trim().slice(-300);
  if (w.status === 67) {
    return toolResult(`${rel} does not exist in the checkout — pass create: true to start it, or use write_project_file.`, { isError: true });
  }
  if (w.status === 64) {
    return toolResult(`${rel} has changed since you read it (${detail}). Nothing was appended — re-read it first.`, { isError: true });
  }
  if (w.status === 66) {
    return toolResult(
      `Append to ${rel} did not land the expected number of bytes (${detail}); the file was rolled back to its previous length. Nothing was appended — retry the call.`,
      { isError: true },
    );
  }
  if (w.status !== 0) return toolResult(`Append failed: ${detail || 'is the container running?'}`, { isError: true });
  const ok = parseWriteOk(w.stdout);
  if (!ok) return toolResult(`Append to ${rel} did not report a verified result — read the file back before doing anything else.`, { isError: true });

  const git = await commitProjectPaths(incusName, [rel], args.commit_message || `chat append: ${rel}`);
  logAudit(auth.created_by, 'MOCK2_FILE_EDITED', 'mock2_project', project.id, {
    via: 'mcp', path: rel, appended_bytes: added,
  }, null);
  return toolResult({
    appended: true, path: rel, appended_bytes: added,
    bytes: ok.bytes, total_lines: ok.total_lines, sha256: ok.sha256, verified: true,
    ...git,
    next: 'When your edits are complete, apply them with redeploy_project.',
  });
}

async function toolInsertProjectFileAtLine(args, auth) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const guard = liveBuildGuard(m, project);
  if (guard) return toolResult(guard, { isError: true });
  const rel = validProjectFilePath(args.path);
  if (!rel) return toolResult('path must be a file path relative to the app root, e.g. src/server/routes.ts', { isError: true });
  const line = normalizeInsertLine(args.line);
  if (line === null) return toolResult('line must be a whole number ≥ 1 — the text is inserted BEFORE that line.', { isError: true });
  let content = String(args.content ?? '');
  if (content === '') return toolResult('content is required — there is nothing to insert.', { isError: true });
  // Inserting a fragment without a trailing newline would weld the caller's
  // last line onto the line it was inserted before.
  if (!content.endsWith('\n')) content += '\n';
  if (Buffer.byteLength(content) > LXC_FILE_WRITE_CAP) {
    return toolResult(`Content exceeds the ${Math.floor(LXC_FILE_WRITE_CAP / (1024 * 1024))} MB single-call cap`, { isError: true });
  }
  const expectedSha = validSha256(args.expected_sha256);
  if (args.expected_sha256 != null && String(args.expected_sha256).trim() !== '' && !expectedSha) {
    return toolResult('expected_sha256 must be the 64-character hex SHA-256 of the file you read.', { isError: true });
  }
  const incusName = projectContainerName(m, project);
  const abs = `${M2_APP_DIR}/${rel}`;
  const added = Buffer.byteLength(content, 'utf8');

  const w = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', insertAtLineScript(),
      'sh', abs, String(line), String(added), expectedSha || ''],
    { input: content, timeoutMs: 60000 },
  );
  const detail = (w.stderr || '').trim().slice(-300);
  if (w.status === 67) return toolResult(`Not a file: ${rel} (use list_project_files to see the tracked files)`, { isError: true });
  if (w.status === 68) {
    const total = detail.split(' ')[1] || '?';
    return toolResult(`line ${line} is past the end of ${rel} (${total} lines). Insert at ${Number(total) + 1} to add at the end, or use append_project_file.`, { isError: true });
  }
  if (w.status === 64) {
    return toolResult(`${rel} has changed since you read it (${detail}). Nothing was inserted — re-read it first.`, { isError: true });
  }
  if (w.status === 65 || w.status === 66) {
    return toolResult(`Insert into ${rel} did not produce the expected byte count (${detail}); the file is untouched. Retry the call.`, { isError: true });
  }
  if (w.status !== 0) return toolResult(`Insert failed: ${detail || 'is the container running?'}`, { isError: true });
  const ok = parseWriteOk(w.stdout);
  if (!ok) return toolResult(`Insert into ${rel} did not report a verified result — read the file back before doing anything else.`, { isError: true });

  const git = await commitProjectPaths(incusName, [rel], args.commit_message || `chat insert: ${rel}`);
  logAudit(auth.created_by, 'MOCK2_FILE_EDITED', 'mock2_project', project.id, {
    via: 'mcp', path: rel, inserted_at_line: line, inserted_bytes: added,
  }, null);
  return toolResult({
    inserted: true, path: rel, line, inserted_bytes: added,
    bytes: ok.bytes, total_lines: ok.total_lines, sha256: ok.sha256, verified: true,
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
  const contextLines = normalizeContextLines(args.context_lines);
  const filesOnly = args.files_with_matches === true;
  const maxBytes = normalizeSearchByteBudget(args.max_bytes);

  const argv = ['exec', projectContainerName(m, project), '--',
    'git', '-C', M2_APP_DIR, 'grep', '-I', '-E'];
  // -l answers "where does this live" and has no lines to number; everything
  // else is the line-oriented form the tool has always returned.
  if (filesOnly) argv.push('-l');
  else {
    argv.push('-n');
    if (contextLines > 0) argv.push(`-C${contextLines}`);
  }
  if (args.ignore_case === true) argv.push('-i');
  argv.push('-e', pattern);
  if (glob) argv.push('--', glob);

  const r = await runHostCapture('incus', argv, {
    timeoutMs: 60000,
    // Context multiplies the output; never SHRINK the capture below what the
    // tool used to allow, or a plain search would start losing hits.
    maxCapture: Math.max(CAPTURE_CAP, maxBytes + 64 * 1024),
  });
  // git grep exits 1 for "no matches" — a result, not a failure.
  if (r.status !== 0 && r.status !== 1) {
    return toolResult(`Search failed: ${(r.stderr || '').trim().slice(-300) || 'is the container running?'}`, { isError: true });
  }

  if (filesOnly) {
    const list = parseGitGrepFileList(r.stdout, maxResults);
    return toolResult({
      pattern, glob, mode: 'files_with_matches',
      file_count: list.files.length, truncated: list.truncated || r.stdoutTruncated === true,
      files: list.files,
      next: list.files.length
        ? 'Open them together with read_project_files, or re-run with context_lines to see the hits in place.'
        : 'No file contains this pattern.',
    });
  }

  if (contextLines > 0) {
    const ctx = parseGitGrepContext(r.stdout, { maxResults, maxBytes });
    return toolResult({
      pattern, glob, context_lines: contextLines,
      match_count: ctx.match_count, block_count: ctx.blocks.length,
      truncated: ctx.truncated || r.stdoutTruncated === true,
      bytes: ctx.bytes,
      blocks: ctx.blocks,
      next: ctx.match_count
        ? 'Each block is the code around a hit — only read the file if this was not enough. To change what you found, send the whole edit as one apply_project_patch.'
        : 'No matches. Check the pattern (it is an extended regex, not a glob) or widen the pathspec.',
      ...(ctx.truncated ? { truncation_note: `Stopped at ${ctx.match_count} match(es) / ${ctx.bytes} bytes — narrow the pattern or lower context_lines to see the rest.` } : {}),
    });
  }

  const matches = parseGitGrepOutput(r.stdout, maxResults);
  const totalLines = r.stdout ? r.stdout.split('\n').filter(Boolean).length : 0;
  return toolResult({
    pattern, glob, match_count: matches.length,
    truncated: totalLines > matches.length,
    matches,
    next: matches.length
      ? 'Re-run with context_lines (5-10) to get the surrounding code in this same call instead of paying a read per hit.'
      : 'No matches. Check the pattern (it is an extended regex, not a glob) or widen the pathspec.',
  });
}

// read_project_files — the batch read.
//
// Same guarantees as read_project_file, N files at a time: the container
// hashes each file before it sends it, and the hash is checked here, so a
// short transfer is an error against THAT file rather than a plausible-looking
// prefix of it. Nothing is ever partially returned; a file that does not fit
// is named in `dropped` with its size.
async function toolReadProjectFiles(args) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  const req = normalizeBatchReadRequest(args.files);
  if (req.error) return toolResult(req.error, { isError: true });
  const budget = normalizeBatchReadBudget(args.max_total_bytes);
  const nonce = randomBytes(6).toString('hex');
  const triples = req.items.flatMap((it) => [it.path, it.start, it.end]);

  const r = await runHostCapture(
    'incus', ['exec', projectContainerName(m, project), '--', 'sh', '-c', batchReadScript(),
      'sh', nonce, String(LXC_FILE_READ_CAP), String(budget), ...triples],
    // Headroom over the budget for the frame markers and the header lines.
    { timeoutMs: 120000, maxCapture: budget + 128 * 1024 },
  );
  if (r.status !== 0) {
    return toolResult(`Could not read the files — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }
  const parsed = parseBatchReadOutput(r.stdout, nonce);

  const files = [];
  const dropped = [];
  for (let i = 0; i < parsed.files.length; i += 1) {
    const rec = parsed.files[i];
    // The script emits one record per requested entry, in order — including
    // the ones it skipped — so position is the join, not the path (the same
    // path may legitimately appear twice with different ranges).
    const item = req.items[i] || req.items.find((it) => it.path === rec.path);
    if (rec.status === 'missing') {
      dropped.push({ path: rec.path, reason: 'not a file in the checkout — check the path with project_map or list_project_files' });
      continue;
    }
    if (rec.status === 'toobig') {
      dropped.push({
        path: rec.path, size_bytes: rec.size_bytes, total_lines: rec.total_lines,
        reason: `over the ${Math.floor(LXC_FILE_READ_CAP / 1024)} KB per-file read cap — read a line range with offset/limit instead of the whole file`,
      });
      continue;
    }
    if (rec.status === 'budget') {
      dropped.push({
        path: rec.path, size_bytes: rec.size_bytes, total_lines: rec.total_lines,
        reason: `would not fit in the ${budget}-byte response budget — request it in a second call, raise max_total_bytes, or narrow it with offset/limit`,
      });
      continue;
    }
    if (rec.status !== 'ok' || rec.content === undefined) {
      dropped.push({ path: rec.path, reason: 'the response stream ended before this file was complete — nothing of it is included; retry the call' });
      continue;
    }
    const body = Buffer.from(rec.content, 'utf8');
    if (body.includes(0)) {
      dropped.push({ path: rec.path, reason: 'looks binary — these tools read text files only' });
      continue;
    }
    const ranged = Boolean(item && item.range.ranged);
    if (!ranged) {
      // Same lock as the single-file read: what arrived must BE the file.
      const short = readIntegrityError(rec.path, rec.size_bytes, rec.sha256, body);
      if (short) { dropped.push({ path: rec.path, reason: short }); continue; }
    }
    const out = {
      path: rec.path,
      size_bytes: rec.size_bytes,
      total_lines: rec.total_lines,
      sha256: rec.sha256,
      content: rec.content,
    };
    if (ranged) {
      out.offset = item.range.start;
      out.limit = item.range.count;
      out.returned_lines = rec.content === '' ? 0 : rec.content.replace(/\n$/, '').split('\n').length;
      if (item.range.start > rec.total_lines && rec.total_lines > 0) {
        out.note = `offset ${item.range.start} is past the end of the file (${rec.total_lines} lines).`;
      }
    }
    files.push(out);
  }
  // Anything the stream never got to. Silence here would read as "that file
  // does not exist", which is a different and much worse answer.
  for (let i = parsed.files.length; i < req.items.length; i += 1) {
    dropped.push({
      path: req.items[i].path,
      reason: parsed.complete
        ? 'not reported by the container — retry the call'
        : 'the response stopped before this file was reached (budget or capture limit) — request it in a second call',
    });
  }

  return toolResult({
    requested: req.items.length,
    returned: files.length,
    budget_bytes: budget,
    used_bytes: parsed.used_bytes,
    files,
    ...(dropped.length ? { dropped } : {}),
    ...(dropped.length ? { dropped_note: `${dropped.length} of ${req.items.length} requested file(s) are NOT in this result — see dropped. None of them is partially included.` } : {}),
  });
}

// project_map — the orientation call.
//
// Three cheap git questions in one exec: what is tracked, how long is each
// file, and which lines look like a top-level declaration. Joining them here
// rather than in the caller is the point — an agent that has to ask three
// times has paid three round trips to learn what one answer holds.
async function toolProjectMap(args) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  let sub = '';
  if (args.subdir != null && String(args.subdir).trim() !== '') {
    sub = validPathspec(args.subdir);
    if (!sub) return toolResult('subdir must be a relative directory or pathspec inside the app (no .., no leading /)', { isError: true });
  }
  const maxFiles = Number.isFinite(Number(args.max_files)) && Number(args.max_files) >= 1
    ? Math.min(Math.floor(Number(args.max_files)), PROJECT_MAP_MAX_FILES_CAP)
    : PROJECT_MAP_MAX_FILES_DEFAULT;
  const maxSymbols = Number.isFinite(Number(args.max_symbols_per_file)) && Number(args.max_symbols_per_file) >= 1
    ? Math.min(Math.floor(Number(args.max_symbols_per_file)), 200)
    : PROJECT_MAP_SYMBOLS_PER_FILE;

  // The pattern rides as $1 and the pathspec as "$@" — never interpolated
  // into the script text, same convention as every other tool here.
  const script = 'P="$1"; shift; cd /srv/app || { echo PP_NO_CHECKOUT >&2; exit 68; }; '
    + 'echo PP_FILES_BEGIN; git ls-files -- "$@" | head -n 5000; echo PP_FILES_END; '
    // `git grep -c -e ""` counts the lines of every tracked TEXT file in one
    // pass: no `wc` total row to disambiguate, binaries skipped for free.
    + 'echo PP_COUNTS_BEGIN; git grep -c -I -e "" -- "$@" 2>/dev/null | head -n 5000; echo PP_COUNTS_END; '
    + 'echo PP_SYMS_BEGIN; git grep -n -I -E -e "$P" -- "$@" 2>/dev/null | head -n 20000; echo PP_SYMS_END';
  const argv = ['exec', projectContainerName(m, project), '--', 'sh', '-c', script, 'sh', PROJECT_MAP_SYMBOL_PATTERN];
  if (sub) argv.push(sub);
  const r = await runHostCapture('incus', argv, { timeoutMs: 120000, maxCapture: 4 * 1024 * 1024 });
  if (r.status !== 0) {
    return toolResult(`Could not map the project — is the container running? ${(r.stderr || '').trim().slice(-300)}`, { isError: true });
  }

  const fileList = patchScriptBlock(r.stdout, 'FILES');
  const counts = parseLineCounts(patchScriptBlock(r.stdout, 'COUNTS').join('\n'));
  const symbolHits = parseGitGrepOutput(patchScriptBlock(r.stdout, 'SYMS').join('\n'), 20000);
  const map = buildProjectMap({ files: fileList, counts, symbolHits, maxFiles, maxSymbolsPerFile: maxSymbols });

  return toolResult({
    subdir: sub || null,
    ...map,
    total_lines: [...counts.values()].reduce((a, b) => a + b, 0),
    approximate: true,
    note: 'Symbols are extracted with a regular expression, not parsed — treat a missing symbol as "search for it", not as "it does not exist". Line counts cover tracked text files only.',
    next: 'Search inside the interesting files with search_project_files (set context_lines), then open what is left with a single read_project_files call.',
  });
}

// apply_project_patch — a whole change in one call.
//
// The failure mode that matters is not "the patch was rejected", it is "half
// the patch landed and the tool said something vague". So the contract is
// binary: the checkout is what it was, or it is the patch applied. See
// applyPatchScript for how — a staged-and-hashed diff, a clean-tree
// precondition scoped to the touched paths, and a rollback on every failure
// path including the --3way "applied with conflicts" one, which git scores as
// a SUCCESS in --check mode.
async function toolApplyProjectPatch(args, auth) {
  const m = await mock2Modules();
  const { project, error } = requireActiveProject(m, args);
  if (error) return toolResult(error, { isError: true });
  // A dry run is read-only, but a build is rewriting the very files it would
  // report on, so its answer would be stale before it was read.
  const guard = liveBuildGuard(m, project);
  if (guard) return toolResult(guard, { isError: true });

  let patchText;
  try {
    patchText = await patchTextFromArgs(args);
  } catch (err) {
    return toolResult(err.message, { isError: true });
  }
  const parsed = parseUnifiedDiffPaths(patchText);
  if (parsed.error) return toolResult(parsed.error, { isError: true });
  const pre = normalizeExpectedShaMap(args.expected_sha256);
  if (pre.error) return toolResult(pre.error, { isError: true });

  const dryRun = args.dry_run === true;
  const bytes = Buffer.byteLength(patchText, 'utf8');
  const incusName = projectContainerName(m, project);
  // The preconditions travel INTO the container as "<sha> <path>" lines: they
  // have to be checked before the apply, and only the far side can do that.
  const preList = pre.map ? [...pre.map].map(([path, sha]) => `${sha} ${path}`).join('\n') : '';
  const r = await runHostCapture(
    'incus', ['exec', incusName, '--', 'sh', '-c', applyPatchScript(),
      'sh', String(bytes), sha256Hex(Buffer.from(patchText, 'utf8')), dryRun ? 'check' : 'apply',
      preList, ...parsed.paths],
    { input: patchText, timeoutMs: 120000, maxCapture: 512 * 1024 },
  );
  const detail = stripApplyNoise(r.stderr);

  if (r.status === 68) {
    return toolResult(`The project container has no checkout at ${M2_APP_DIR} — nothing was applied.`, { isError: true });
  }
  if (r.status === 65) {
    return toolResult(
      `The patch did not arrive intact (${detail.slice(-200)}) — nothing was applied. Re-send it, and pass sha256 so a corrupt transfer is caught before git sees it.`,
      { isError: true },
    );
  }
  if (r.status === 64) {
    return toolResult({
      applied: false,
      checkout_unchanged: true,
      error: 'The checkout has uncommitted changes on the files this patch touches, so it was refused rather than applied on top of work that is not committed.',
      dirty: detail.split('\n').filter((l) => l && !l.startsWith('PP_')).slice(0, 20),
      next: 'Commit or discard that work first (project_git_diff shows it), then re-send the patch.',
    }, { isError: true });
  }
  if (r.status === 69) {
    const m = /PP_PRECONDITION (\S+) (\S+)/.exec(r.stderr || '');
    const observed = new Map(m ? [[m[1], m[2] === 'ABSENT' ? null : m[2]]] : []);
    return toolResult({
      applied: false,
      checkout_unchanged: true,
      error: patchPreconditionError(pre.map, observed)
        || 'One of the expected_sha256 preconditions no longer holds. Nothing was applied.',
    }, { isError: true });
  }
  if (r.status === 66 || r.status === 67) {
    const failure = parseGitApplyFailure(r.stderr);
    return toolResult({
      applied: false,
      checkout_unchanged: true,
      error: failure.conflicted
        ? 'The patch could only be applied with conflicts, which would have left conflict markers in the files — it was refused and rolled back instead.'
        : 'The patch does not apply to this checkout.',
      rejected: failure.rejects.length ? failure.rejects : [{ reason: detail.slice(-300) || 'git apply rejected the patch' }],
      files: parsed.files.map((f) => ({ path: f.path, change: f.change })),
      next: 'Re-read the affected files (read_project_files returns their sha256) and rebuild the diff against what is actually there. Nothing was written — the checkout is byte-identical.',
    }, { isError: true });
  }
  if (r.status !== 0) {
    return toolResult(`Patch failed: ${detail.slice(-300) || 'is the container running?'} — nothing was applied.`, { isError: true });
  }

  const before = parseBeforeBlock(patchScriptBlock(r.stdout, 'BEFORE'));
  const numstat = parseApplyNumstat(patchScriptBlock(r.stdout, 'NUMSTAT').join('\n'));
  // Belt and braces. The container already refused a stale patch (exit 69,
  // above) before it applied anything; this re-checks the same thing against
  // the hashes it reported, so a future change to the script that dropped the
  // far-side check would surface here rather than silently stop guarding.
  const staleness = patchPreconditionError(pre.map, before);
  if (staleness) {
    return toolResult({ applied: false, checkout_unchanged: dryRun, error: staleness }, { isError: true });
  }

  if (dryRun) {
    return toolResult({
      applied: false,
      dry_run: true,
      would_apply: true,
      files_changed: parsed.files.length,
      files: buildPatchFileReport(parsed.files, numstat, null),
      lines_added: numstat.reduce((a, x) => a + (x.lines_added || 0), 0),
      lines_removed: numstat.reduce((a, x) => a + (x.lines_removed || 0), 0),
      message: 'The patch applies cleanly. Nothing was written and nothing was committed.',
      next: 'Re-send the same patch with dry_run omitted (or false) to apply and commit it.',
    });
  }

  const after = parseAfterBlock(patchScriptBlock(r.stdout, 'AFTER'));
  const files = buildPatchFileReport(parsed.files, numstat, after);
  const git = await commitProjectPaths(incusName, parsed.paths, args.commit_message || `chat patch: ${parsed.files.length} file(s)`);
  logAudit(auth.created_by, 'MOCK2_FILE_PATCHED', 'mock2_project', project.id, {
    via: 'mcp', paths: parsed.paths, files: parsed.files.length, patch_bytes: bytes,
  }, null);
  return toolResult({
    applied: true,
    files_changed: files.length,
    lines_added: numstat.reduce((a, x) => a + (x.lines_added || 0), 0),
    lines_removed: numstat.reduce((a, x) => a + (x.lines_removed || 0), 0),
    files,
    verified: true,
    ...git,
    next: 'Verify with run_project_command (e.g. "npm run gates"), then apply with redeploy_project.',
  });
}

/** The patch bytes: inline, or from an upload ticket for a large diff. The
 *  ticket path is the same one the zip tools use, so a client that already
 *  knows how to deliver bytes to ProxyPilot needs no new mechanism. */
async function patchTextFromArgs(args) {
  let buf;
  if (args.ticket != null && String(args.ticket).trim() !== '') {
    sweepTickets();
    if (!looksLikeUploadTicket(args.ticket)) throw new Error('Invalid upload ticket');
    const rec = uploadTickets.get(String(args.ticket));
    if (!rec || !rec.filePath) {
      throw new Error('Upload ticket unknown, expired, or no bytes were uploaded to it yet (chunked uploads must be sealed with finish_upload first)');
    }
    uploadTickets.delete(String(args.ticket));
    buf = await readFile(rec.filePath);
    await rm(rec.filePath, { force: true }).catch(() => {});
  } else if (args.patch != null && String(args.patch) !== '') {
    buf = Buffer.from(String(args.patch), 'utf8');
    if (buf.length > PATCH_INLINE_MAX_BYTES) {
      throw new Error(`Inline patches are limited to ${Math.floor(PATCH_INLINE_MAX_BYTES / 1024)} KB — deliver a bigger diff with create_upload_ticket and pass the ticket instead`);
    }
  } else {
    throw new Error('Provide the unified diff as `patch`, or upload it and pass its `ticket`.');
  }
  if (buf.length === 0) throw new Error('The patch is empty — there is nothing to apply.');
  if (buf.length > PATCH_MAX_BYTES) {
    throw new Error(`Patches are limited to ${Math.floor(PATCH_MAX_BYTES / (1024 * 1024))} MB (got ${buf.length} bytes) — split the change.`);
  }
  if (args.sha256 != null && String(args.sha256).trim() !== '') {
    const want = validSha256(args.sha256);
    if (!want) throw new Error('sha256 must be the 64-character hex SHA-256 of the patch bytes');
    const got = sha256Hex(buf);
    if (got !== want) {
      throw new Error(`The patch bytes do not match the declared sha256 — the transfer corrupted them (declared ${want}, got ${got} over ${buf.length} bytes). Nothing was applied; re-send the diff.`);
    }
  }
  if (buf.includes(0)) throw new Error('The patch contains NUL bytes — a unified diff is text. Nothing was applied.');
  return buf.toString('utf8');
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
  const streams = parseMarkedStreams(r.stdout, nonce);

  if (r.status !== 0 && !streams.found) {
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

  const exitCode = streams.found ? streams.exit_code : null;
  const { stdout, stderr } = streams;

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
  // Verified like every other write: a mirror of the audit trail that landed
  // half-written would be worse than one that failed loudly.
  const w = await verifiedContainerWrite(incusName, `${M2_APP_DIR}/${rel}`, mirror, { label: rel });
  let git = { committed: false, unchanged: false, commit: null, push_failed: false };
  if (!w.error) {
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
    mirror_written: !w.error,
    ...(w.error ? { mirror_error: w.error } : {}),
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
  append_upload_chunk: toolAppendUploadChunk,
  finish_upload: toolFinishUpload,
  inspect_static_site_zip: toolInspectStaticSiteZip,
  apply_static_site_zip: toolApplyStaticSiteZip,
  list_lxc_containers: toolListLxcContainers,
  get_lxc_container: toolGetLxcContainer,
  run_lxc_command: toolRunLxcCommand,
  list_lxc_files: toolListLxcFiles,
  search_lxc_files: toolSearchLxcFiles,
  get_lxc_logs: toolGetLxcLogs,
  probe_lxc_port: toolProbeLxcPort,
  get_lxc_startup: toolGetLxcStartup,
  create_lxc_container: toolCreateLxcContainer,
  control_lxc_container: toolControlLxcContainer,
  set_lxc_config: toolSetLxcConfig,
  set_lxc_network: toolSetLxcNetwork,
  snapshot_lxc_container: toolSnapshotLxcContainer,
  lxc_file_diff: toolLxcFileDiff,
  restore_lxc_file: toolRestoreLxcFile,
  inspect_lxc_zip: toolInspectLxcZip,
  apply_lxc_zip: toolApplyLxcZip,
  create_static_site: toolCreateStaticSite,
  get_static_site: toolGetStaticSite,
  list_static_site_files: toolListStaticSiteFiles,
  read_static_site_file: toolReadStaticSiteFile,
  write_static_site_file: toolWriteStaticSiteFile,
  get_static_site_cert: toolGetStaticSiteCert,
  list_routes: toolListRoutes,
  get_route: toolGetRoute,
  test_route: toolTestRoute,
  set_route: toolSetRoute,
  delete_route: toolDeleteRoute,
  get_host_diagnostics: toolGetHostDiagnostics,
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
  append_project_file: toolAppendProjectFile,
  insert_project_file_at_line: toolInsertProjectFileAtLine,
  search_project_files: toolSearchProjectFiles,
  read_project_files: toolReadProjectFiles,
  project_map: toolProjectMap,
  apply_project_patch: toolApplyProjectPatch,
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
        instructions: MCP_SERVER_INSTRUCTIONS,
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
    if (rec.chunkPath) return res.status(409).json({ error: 'This ticket is receiving a chunked upload (append_upload_chunk) — finish or abandon that instead of PUTting' });
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
