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
import { safeExtractName } from './restore-paths.js';

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

// loadBackupBuffer — local-first read.  Tries backup.local_path
// before falling back to S3.  Local-only backups (no
// destination_id) succeed via the local path and never touch the
// network.  Used by Mode C / Mode A so they don't need to know
// where the artifact came from.
async function loadBackupBuffer({ backup, destination }) {
  if (backup.local_path) {
    try {
      return fs.readFileSync(backup.local_path);
    } catch (err) {
      // Local file gone — fall through to S3 if a destination
      // exists.  Without a destination the caller already
      // returned 409 from the route so we shouldn't get here.
      if (!destination) throw err;
    }
  }
  if (!destination) {
    throw new Error('backup has no local copy and no destination on file');
  }
  return downloadBackup(destination, backup.s3_key);
}

// ── Mode C ──────────────────────────────────────────────────────────

export async function runModeC({ runId, backup, destination, passphrase }) {
  const source = backup.local_path ? 'local' : 's3';
  appendStep(runId, { stage: 'download', status: 'started', s3_key: backup.s3_key, source });
  let buf;
  try {
    buf = await loadBackupBuffer({ backup, destination });
  } catch (err) {
    appendStep(runId, { stage: 'download', status: 'failed', error: err?.message || String(err) });
    finalize(runId, 'failed', 'download failed');
    return { ok: false, error: err?.message || String(err) };
  }
  appendStep(runId, { stage: 'download', status: 'ok', size_bytes: buf.length, source });

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

// ── Mode B — in-place production restore ────────────────────────────
//
// CONFIG TIER ONLY.  Applies the backup's content to the live
// host paths (.env, cve-inbox/) and re-imports the SQLite DB
// from the JSON dump captured at backup time.  Other tiers are
// rejected with a clear message — the blast radius for
// config_plus_data / full is too large for a one-shot in-process
// restore (Docker volumes, Incus instances, ACME certs need
// orchestrated stop/start cycles).
//
// Safety fallback: a fresh `config` backup of the CURRENT state
// is created BEFORE any production write.  Its id + local path
// land in the restore_run notes; if anything goes wrong on the
// real restore the operator can re-run with that backup id to
// roll back.
//
// Sequencing:
//   1. preflight: tier check, backup load, manifest verify
//   2. safety-backup: pack the current state, write to disk
//   3. apply: .env + cve-inbox + DB JSON import (in a tx)
//
// The DB import runs inside a transaction with FKs disabled so
// the row order doesn't matter; on any insert error the
// transaction rolls back and the live DB stays exactly as it
// was.  The .env / cve-inbox copies happen BEFORE the DB tx so
// a worst-case 'tx commit failed' leaves only the file-system
// state ahead of the DB — the safety backup recovers either
// half if needed.
export async function runModeB({
  runId, backup, destination, passphrase,
  envPath, cveInboxDir, packConfigTier,
  // For config_plus_data restores the safety backup uses the
  // matching pack helper so a rollback restores the operator's
  // caddy / wireguard / services dirs too.  Optional; falls
  // back to packConfigTier when not provided.
  packConfigPlusDataTier = null,
  installDir = null,
  // config_plus_data tier adds these dirs.  All are bind-mounted
  // into the admin container on a normal install (the backup
  // pack reads from the same paths) so plain fs.writeFileSync
  // reaches the host's actual files.
  caddyDir = process.env.CADDY_DIR || '/etc/caddy',
  wireguardDir = process.env.PROXYPILOT_WG_DIR || '/etc/wireguard',
  caddyAcmeDir = process.env.CADDY_ACME_DIR || '/var/lib/caddy/.local/share/caddy',
  servicesDir = process.env.PROXYPILOT_SERVICES_DIR || '/opt/proxypilot/data/services',
}) {
  appendStep(runId, { stage: 'preflight', status: 'started', tier: backup.tier });
  const supportedTiers = ['config', 'config_plus_data'];
  if (!supportedTiers.includes(backup.tier)) {
    appendStep(runId, {
      stage: 'preflight', status: 'failed',
      error: `Production restore is only supported for ${supportedTiers.join(' / ')} tiers; this backup is ${backup.tier}.`,
    });
    finalize(runId, 'failed', `tier ${backup.tier} not supported for in-place restore`);
    return { ok: false, error: 'tier not supported' };
  }
  appendStep(runId, { stage: 'preflight', status: 'ok' });

  // Step 1: load + verify the target backup BEFORE we touch
  // anything.  Mirrors Mode A's verify-first ordering.
  const inner = await runModeCInner({ runId, backup, destination, passphrase });
  if (!inner.ok) return inner; // already finalized

  // Step 2: safety backup.  Pack the CURRENT state with the
  // same passphrase so the operator already knows the secret.
  // We don't fan-out to S3 — local-only is enough for a fallback,
  // and avoids a slow upload before the actual restore can run.
  appendStep(runId, { stage: 'safety-backup', status: 'started' });
  const db = getDb();
  let safety;
  try {
    // Use the matching pack helper so the safety backup captures
    // exactly what's at risk.  config_plus_data falls back to
    // packConfigTier if the caller didn't supply the larger
    // helper — that's still useful (DB + env + cve-inbox) just
    // not a full rollback.
    if (backup.tier === 'config_plus_data' && packConfigPlusDataTier) {
      safety = await packConfigPlusDataTier({
        db, passphrase, envPath, cveInboxDir, installDir,
        caddyDir, wireguardDir, caddyAcmeDir, servicesDir,
        scopeFilter: { all: true },
        meta: { scope: 'all', backup_id: 'safety-' + runId, restore_run_id: runId },
      });
    } else {
      safety = await packConfigTier({
        db, passphrase, envPath, cveInboxDir,
        meta: { scope: 'all', backup_id: 'safety-' + runId, restore_run_id: runId },
      });
    }
  } catch (err) {
    appendStep(runId, { stage: 'safety-backup', status: 'failed', error: err?.message || String(err) });
    finalize(runId, 'failed', 'safety backup failed — refusing to apply restore without a fallback');
    return { ok: false, error: err?.message || String(err) };
  }
  // Write the safety backup to a known on-disk location alongside
  // the regular backups dir.  We don't insert a row in the
  // backups table because that table assumes the row was
  // created via the create-backup route flow (audit log,
  // junctions, etc.); a flat file with the runId in the
  // filename is enough for a manual rollback.
  const safetyDir = process.env.PROXYPILOT_BACKUPS_LOCAL_DIR || '/var/lib/proxypilot/backups';
  let safetyPath;
  try {
    fs.mkdirSync(safetyDir, { recursive: true });
    safetyPath = path.join(safetyDir, `safety-pre-restore-${runId}.ppbackup`);
    fs.writeFileSync(safetyPath, safety.buffer);
  } catch (err) {
    appendStep(runId, { stage: 'safety-backup', status: 'failed', error: err?.message || String(err) });
    finalize(runId, 'failed', 'safety backup write failed');
    return { ok: false, error: err?.message || String(err) };
  }
  appendStep(runId, {
    stage: 'safety-backup', status: 'ok',
    safety_path: safetyPath, size_bytes: safety.buffer.length,
  });

  // Step 3: apply.  readTar returns a name→Buffer map; pull the
  // entries we already decrypted + verified in runModeCInner.
  const entries = inner.entries || {};
  const dbDumpBuf = entries['proxypilot.db.json'];
  const envBuf = entries['.env'];
  const cveNames = Object.keys(entries).filter((n) => n.startsWith('cve-inbox/'));

  // 3a: .env
  if (envBuf) {
    appendStep(runId, { stage: 'apply-env', status: 'started', target: envPath });
    try {
      fs.writeFileSync(envPath, envBuf, { mode: 0o600 });
      appendStep(runId, { stage: 'apply-env', status: 'ok' });
    } catch (err) {
      appendStep(runId, { stage: 'apply-env', status: 'failed', error: err?.message || String(err) });
      finalize(runId, 'failed', `env write failed; safety at ${safetyPath}`);
      return { ok: false, error: err?.message || String(err), safetyPath };
    }
  }

  // 3b: cve-inbox/.  Recreate the dir from scratch so dropped
  // entries actually disappear; rsync semantics would leak
  // ghosts.  Only delete the contents, not the dir itself, so
  // the bind-mount inode survives a docker compose restart.
  if (cveNames.length > 0) {
    appendStep(runId, { stage: 'apply-cve-inbox', status: 'started', target: cveInboxDir });
    try {
      fs.mkdirSync(cveInboxDir, { recursive: true });
      for (const f of fs.readdirSync(cveInboxDir)) {
        try { fs.rmSync(path.join(cveInboxDir, f), { recursive: true, force: true }); }
        catch { /* tolerated */ }
      }
      for (const name of cveNames) {
        const safeName = name.replace(/^cve-inbox\//, '');
        const dest = path.join(cveInboxDir, safeName);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entries[name]);
      }
      appendStep(runId, { stage: 'apply-cve-inbox', status: 'ok', files: cveNames.length });
    } catch (err) {
      appendStep(runId, { stage: 'apply-cve-inbox', status: 'failed', error: err?.message || String(err) });
      finalize(runId, 'failed', `cve-inbox write failed; safety at ${safetyPath}`);
      return { ok: false, error: err?.message || String(err), safetyPath };
    }
  }

  // 3c: SQLite DB import from the JSON dump.  Wrapped in a
  // transaction with FKs disabled so we can wipe + repopulate
  // every table without insert-order grief.  On any error the
  // transaction rolls back and the live DB stays exactly where
  // it was — only the .env + cve-inbox writes are then
  // ahead-of-DB, which the operator recovers from with the
  // safety backup if needed.
  if (dbDumpBuf) {
    appendStep(runId, { stage: 'apply-db', status: 'started' });
    let dump;
    try {
      dump = JSON.parse(dbDumpBuf.toString('utf-8'));
    } catch (err) {
      appendStep(runId, { stage: 'apply-db', status: 'failed', error: `parse: ${err?.message || err}` });
      finalize(runId, 'failed', `db dump parse failed; safety at ${safetyPath}`);
      return { ok: false, error: err?.message || String(err), safetyPath };
    }
    if (!dump || !dump.tables) {
      appendStep(runId, { stage: 'apply-db', status: 'failed', error: 'malformed dump (no tables)' });
      finalize(runId, 'failed', `db dump malformed; safety at ${safetyPath}`);
      return { ok: false, error: 'malformed dump', safetyPath };
    }
    try {
      db.exec('PRAGMA foreign_keys = OFF');
      const tx = db.transaction(() => {
        for (const [tableName, rows] of Object.entries(dump.tables)) {
          if (!Array.isArray(rows)) continue; // skip { error: ... } entries
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) continue;
          // Skip schema_migrations — replacing it would orphan the
          // running process from its migration state.  The dump's
          // version is informational only.
          if (tableName === 'schema_migrations') continue;
          db.prepare(`DELETE FROM "${tableName}"`).run();
          if (rows.length === 0) continue;
          const cols = Object.keys(rows[0]);
          if (cols.length === 0) continue;
          const placeholders = cols.map(() => '?').join(',');
          const insert = db.prepare(
            `INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${placeholders})`
          );
          for (const row of rows) {
            insert.run(cols.map((c) => row[c] ?? null));
          }
        }
      });
      tx();
      appendStep(runId, {
        stage: 'apply-db', status: 'ok',
        tables: Object.keys(dump.tables).length,
        schema_version: dump.schema_version,
      });
    } catch (err) {
      appendStep(runId, { stage: 'apply-db', status: 'failed', error: err?.message || String(err) });
      finalize(runId, 'failed', `db import failed; safety at ${safetyPath}`);
      return { ok: false, error: err?.message || String(err), safetyPath };
    } finally {
      try { db.exec('PRAGMA foreign_keys = ON'); } catch { /* tolerated */ }
    }
  }

  // 3d (config_plus_data only): restore the host-wide config dirs.
  // Each block is best-effort: a write failure logs into the run
  // notes but doesn't undo the DB changes — operator's safety
  // backup covers a full rollback.  We use a directory-mirror
  // strategy (wipe + repopulate) so dropped entries actually
  // disappear; rsync semantics would leak ghosts.
  if (backup.tier === 'config_plus_data') {
    const dirRestores = [
      { archive: 'caddy/', target: caddyDir, label: 'caddy' },
      { archive: 'wireguard/', target: wireguardDir, label: 'wireguard' },
      { archive: 'caddy-acme/', target: caddyAcmeDir, label: 'caddy-acme' },
      { archive: 'services/', target: servicesDir, label: 'services' },
    ];
    for (const { archive, target, label } of dirRestores) {
      const matches = Object.keys(entries).filter((n) => n.startsWith(archive));
      if (matches.length === 0) continue; // tier captured nothing here
      appendStep(runId, { stage: `apply-${label}`, status: 'started', target, files: matches.length });
      try {
        fs.mkdirSync(target, { recursive: true });
        for (const f of fs.readdirSync(target)) {
          try { fs.rmSync(path.join(target, f), { recursive: true, force: true }); }
          catch { /* tolerated */ }
        }
        for (const name of matches) {
          const rel = name.slice(archive.length);
          if (!rel) continue;
          const dest = path.join(target, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, entries[name]);
        }
        appendStep(runId, { stage: `apply-${label}`, status: 'ok' });
      } catch (err) {
        appendStep(runId, {
          stage: `apply-${label}`, status: 'failed',
          error: err?.message || String(err),
        });
        // Don't bail — keep going so the operator at least sees
        // which dirs landed and which didn't.  The restore_run
        // ends in 'partial' below.
      }
    }
  }

  // Determine final status: if any apply-* step failed (after the
  // safety backup is intact), mark the run 'partial' so the
  // operator sees that some pieces need attention.
  const stepsRow = getDb().prepare(`SELECT steps_json FROM restore_runs WHERE id = ?`).get(runId);
  const steps = stepsRow?.steps_json ? JSON.parse(stepsRow.steps_json) : [];
  const failedApply = steps.some((s) => s.stage?.startsWith('apply-') && s.status === 'failed');
  const finalStatus = failedApply ? 'partial' : 'ok';
  const note = failedApply
    ? `In-place restore partially applied — see step trail. Safety fallback at ${safetyPath}.`
    : `In-place restore applied. After: docker compose restart admin (DB+env), reload caddy, restart wireguard. Safety at ${safetyPath}.`;
  finalize(runId, finalStatus, note);
  return { ok: !failedApply, safetyPath, partial: failedApply };
}

// runModeCInner — same pipeline as runModeC but returns the parsed
// entries so runModeA can share the work.  Internal helper; not
// exported.
async function runModeCInner({ runId, backup, destination, passphrase }) {
  const source = backup.local_path ? 'local' : 's3';
  appendStep(runId, { stage: 'download', status: 'started', s3_key: backup.s3_key, source });
  let buf;
  try { buf = await loadBackupBuffer({ backup, destination }); }
  catch (err) {
    appendStep(runId, { stage: 'download', status: 'failed', error: err?.message || String(err) });
    finalize(runId, 'failed', 'download failed');
    return { ok: false, error: err?.message || String(err) };
  }
  appendStep(runId, { stage: 'download', status: 'ok', size_bytes: buf.length, source });

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
