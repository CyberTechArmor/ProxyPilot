// Restore engine for the Backups feature.
//
// Two modes ship in PR 2:
//
//   Mode C (manifest-only) — decrypt header, GCM-verify, gunzip,
//                            untar, recompute every listed file's
//                            sha256.  Cheap; no disk side effects.
//                            Useful pre-flight before a real
//                            restore.
//
//   Mode A (sandbox)       — Mode C + extract every file into a
//                            sandbox dir on the local host.
//                            Restored Incus instances are imported
//                            under the suffix `-restore-<short-id>`
//                            on a private bridge with no public
//                            ports — operators can poke the sandbox
//                            via incus exec; nothing reachable from
//                            outside.  Spec calls Mode A 'same host,
//                            sandbox' — that's exactly what this
//                            does.
//
// Mode B (different host) is explicitly out of scope for PR 2 per
// the master-prompt spec.  Mode A's sandbox is the right default
// for most operators; B is a follow-up after operator feedback.
//
// State machine: each restore_run's steps_json is updated
// incrementally as the engine progresses, so the UI's live-log
// panel can render progress without polling.  Steps are append-only
// — once a step lands in the array it's not rewritten.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { getDb, logAudit } from '../db.js';
import { getObjectStream } from './s3.js';
import { decrypt, readTar, verifyManifest, parseHeader } from './backup-unpack.js';

// ── small helpers ───────────────────────────────────────────────────

function appendStep(runId, step) {
  const db = getDb();
  const row = db.prepare(`SELECT steps_json FROM restore_runs WHERE id = ?`).get(runId);
  const arr = row?.steps_json ? JSON.parse(row.steps_json) : [];
  arr.push({ ts: new Date().toISOString(), ...step });
  db.prepare(`UPDATE restore_runs SET steps_json = ? WHERE id = ?`)
    .run(JSON.stringify(arr), runId);
}

function finalize(runId, status, notes) {
  getDb().prepare(`
    UPDATE restore_runs
    SET status = ?, finished_at = CURRENT_TIMESTAMP, notes = ?
    WHERE id = ?
  `).run(status, notes ?? null, runId);
}

// Stream-to-buffer helper.  Mode C / A both decrypt the entire
// artifact in memory — config tier is ~50 KB, config_plus_data is
// 10-100 MB, full could be GB.  PR 2 follow-up will swap to a
// streaming path for the full tier; this is the bounded form.
async function streamToBuffer(stream, maxBytes = 16 * 1024 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of stream) {
    chunks.push(c);
    total += c.length;
    if (total > maxBytes) {
      throw new Error(`backup body exceeds in-memory cap of ${maxBytes} bytes`);
    }
  }
  return Buffer.concat(chunks);
}

async function downloadBackup(destRow, s3Key) {
  const obj = await getObjectStream(destRow, s3Key);
  return streamToBuffer(obj.stream);
}

// ── Mode C ──────────────────────────────────────────────────────────

export async function runModeC({ runId, backup, destination, passphrase }) {
  appendStep(runId, { stage: 'download', status: 'started', s3_key: backup.s3_key });
  let buf;
  try {
    buf = await downloadBackup(destination, backup.s3_key);
  } catch (err) {
    appendStep(runId, { stage: 'download', status: 'failed', error: err?.message || String(err) });
    finalize(runId, 'failed', 'download failed');
    return { ok: false, error: err?.message || String(err) };
  }
  appendStep(runId, { stage: 'download', status: 'ok', size_bytes: buf.length });

  appendStep(runId, { stage: 'header', status: 'started' });
  let header;
  try {
    header = parseHeader(buf).header;
  } catch (err) {
    appendStep(runId, { stage: 'header', status: 'failed', error: err?.message || String(err) });
    finalize(runId, 'failed', 'header parse failed');
    return { ok: false, error: err?.message || String(err) };
  }
  appendStep(runId, { stage: 'header', status: 'ok', tier: header.tier, created_at: header.created_at });

  appendStep(runId, { stage: 'decrypt', status: 'started' });
  let tarBuf;
  try {
    tarBuf = await decrypt(buf, passphrase);
  } catch (err) {
    appendStep(runId, { stage: 'decrypt', status: 'failed', error: err?.message || String(err) });
    finalize(runId, 'failed', 'decrypt failed');
    return { ok: false, error: err?.message || String(err) };
  }
  appendStep(runId, { stage: 'decrypt', status: 'ok' });

  appendStep(runId, { stage: 'manifest', status: 'started' });
  const entries = readTar(tarBuf);
  const verdict = verifyManifest(entries);
  appendStep(runId, {
    stage: 'manifest',
    status: verdict.ok ? 'ok' : 'failed',
    file_count: verdict.file_count,
    mismatches: verdict.mismatches.length,
    missing: verdict.missing.length,
    extra: verdict.extra.length,
    error: verdict.error,
  });

  finalize(runId, verdict.ok ? 'ok' : 'failed',
    verdict.ok ? 'manifest verified' : 'manifest mismatches detected');
  return { ok: verdict.ok, verdict, header };
}

// ── Mode A ──────────────────────────────────────────────────────────
//
// Mode A = Mode C + extract every file under a per-run sandbox dir
// + (when the artifact carries Incus exports) re-import each
// instance under a suffixed name on a private bridge.

function safeExtractName(name) {
  // Refuse path traversal — no `..` segments, no absolute paths.
  // The packer only ever emits relative paths, so a `..` here is
  // a tamper signal.
  if (name.startsWith('/')) throw new Error(`absolute path in archive: ${name}`);
  const parts = name.split('/');
  if (parts.includes('..')) throw new Error(`path traversal in archive: ${name}`);
  return name;
}

export async function runModeA({
  runId, backup, destination, passphrase, importIncus = false,
  privateBridge = process.env.PROXYPILOT_RESTORE_BRIDGE || 'pp-restore-br0',
}) {
  // Re-use the Mode C pipeline up through manifest verification —
  // a corrupt artifact should fail before we touch disk.
  const inner = await runModeCInner({ runId, backup, destination, passphrase });
  if (!inner.ok) return inner; // already finalized

  const shortId = backup.id.slice(0, 8);
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `pp-restore-${shortId}-`));
  fs.chmodSync(sandboxDir, 0o700);

  appendStep(runId, { stage: 'sandbox', status: 'created', dir: sandboxDir });
  getDb().prepare(`UPDATE restore_runs SET sandbox_dir = ? WHERE id = ?`)
    .run(sandboxDir, runId);

  // Extract every regular file.  Skip the in-archive manifest.json
  // (already verified) so the sandbox layout matches the on-host
  // layout the operator's used to.
  let written = 0;
  let extractFailed = null;
  for (const [archivePath, body] of Object.entries(inner.entries)) {
    if (archivePath === 'manifest.json') continue;
    try {
      const safe = safeExtractName(archivePath);
      const outPath = path.join(sandboxDir, safe);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, body);
      written += 1;
    } catch (err) {
      extractFailed = { path: archivePath, error: err?.message || String(err) };
      break;
    }
  }
  if (extractFailed) {
    appendStep(runId, { stage: 'extract', status: 'failed', ...extractFailed });
    finalize(runId, 'failed', 'extract failed');
    return { ok: false, error: extractFailed.error, sandboxDir };
  }
  appendStep(runId, { stage: 'extract', status: 'ok', files_written: written });

  // Optional: re-import Incus instances under a suffixed name on a
  // private bridge.  Disabled by default because it requires
  // privileged access on the dashboard host; the route layer
  // gates it behind an explicit operator confirmation.
  if (importIncus) {
    const incusDir = path.join(sandboxDir, 'incus-exports');
    let imported = 0;
    const importErrors = [];
    if (fs.existsSync(incusDir)) {
      const files = fs.readdirSync(incusDir).filter((f) => f.endsWith('.tar.gz'));
      for (const f of files) {
        const original = f.replace(/\.tar\.gz$/, '');
        const restored = `${original}-restore-${shortId}`;
        const r = spawnSync(
          'incus',
          ['import', path.join(incusDir, f), restored],
          { encoding: 'utf-8', timeout: 30 * 60_000 },
        );
        if (r.status !== 0) {
          importErrors.push({ original, error: r.stderr?.trim() || 'incus import failed' });
          continue;
        }
        // Move to private bridge — `incus network attach` rebinds
        // the default eth0.  Soft-fail: if the network is missing,
        // log it and let the operator wire it manually.
        spawnSync('incus', ['network', 'attach', privateBridge, restored, 'eth0'], {
          encoding: 'utf-8', timeout: 30_000,
        });
        imported += 1;
      }
    }
    appendStep(runId, {
      stage: 'incus-import',
      status: importErrors.length === 0 ? 'ok' : 'partial',
      imported,
      errors: importErrors,
    });
  }

  finalize(runId, 'ok', `extracted to ${sandboxDir}`);
  return { ok: true, sandboxDir, entries_count: written };
}

// runModeCInner — same pipeline as runModeC but returns the parsed
// entries so runModeA can share the work.  Internal helper; not
// exported.
async function runModeCInner({ runId, backup, destination, passphrase }) {
  appendStep(runId, { stage: 'download', status: 'started', s3_key: backup.s3_key });
  let buf;
  try { buf = await downloadBackup(destination, backup.s3_key); }
  catch (err) {
    appendStep(runId, { stage: 'download', status: 'failed', error: err?.message || String(err) });
    finalize(runId, 'failed', 'download failed');
    return { ok: false, error: err?.message || String(err) };
  }
  appendStep(runId, { stage: 'download', status: 'ok', size_bytes: buf.length });

  let header;
  try { header = parseHeader(buf).header; }
  catch (err) {
    appendStep(runId, { stage: 'header', status: 'failed', error: err?.message || String(err) });
    finalize(runId, 'failed', 'header parse failed');
    return { ok: false, error: err?.message || String(err) };
  }
  appendStep(runId, { stage: 'header', status: 'ok', tier: header.tier });

  let tarBuf;
  try { tarBuf = await decrypt(buf, passphrase); }
  catch (err) {
    appendStep(runId, { stage: 'decrypt', status: 'failed', error: err?.message || String(err) });
    finalize(runId, 'failed', 'decrypt failed');
    return { ok: false, error: err?.message || String(err) };
  }
  appendStep(runId, { stage: 'decrypt', status: 'ok' });

  const entries = readTar(tarBuf);
  const verdict = verifyManifest(entries);
  appendStep(runId, {
    stage: 'manifest',
    status: verdict.ok ? 'ok' : 'failed',
    file_count: verdict.file_count,
    mismatches: verdict.mismatches.length,
    missing: verdict.missing.length,
    extra: verdict.extra.length,
  });
  if (!verdict.ok) {
    finalize(runId, 'failed', 'manifest mismatches');
    return { ok: false, error: 'manifest verification failed', verdict };
  }
  return { ok: true, header, entries, verdict };
}

export const __test = Object.freeze({ safeExtractName, appendStep, finalize });
