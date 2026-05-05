// Housekeeping — disk-usage view + safe prune actions for stale
// docker artifacts and ProxyPilot's own backup leftovers.
//
// `docker system df` parsed into JSON for the dashboard, plus
// targeted prune actions per category. Everything mutating is
// sudo-gated and audit-logged. Pruning is conservative by default:
//
//   - Images:   `docker image prune -f` (DANGLING ONLY).
//               -a (remove all unused) is opt-in via {all: true} —
//               that's the dangerous one because the host's docker
//               daemon is shared with anything else the operator
//               runs and -a removes images without containers
//               regardless of who created them.
//   - Containers: `docker container prune -f` (stopped only).
//   - Volumes:    `docker volume prune -f` — also opt-in. Volumes
//                 typically hold persistent data; pruning unused
//                 ones is correct only when the operator has
//                 stopped+rmi'd whatever owned them.
//   - Build cache: `docker builder prune -f --keep-storage 1g`
//                  caps the build cache at 1GiB.
//   - Backups:    Removes /opt/proxypilot/data/db/backups/*.bak
//                 older than 30 days. Pure file-system; does not
//                 touch docker.

import { Router } from 'express';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { shellSingleQuote } from '../lib/shell-quote.js';

export const housekeepingRouter = Router();

const execAsync = promisify(exec);
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
const INSTALL_DIR = process.env.PROXYPILOT_INSTALL_DIR || '/opt/proxypilot';
const BACKUP_DIR = join(INSTALL_DIR, 'data', 'db', 'backups');

// Same shape as l4-reconciler / caddy-driver: nsenter to the host
// when we're inside the dashboard container so the docker CLI runs
// against the host's daemon (the container doesn't ship docker
// itself; the docker.sock bind-mount is for code that uses the
// HTTP API directly, not for shelling `docker`).
async function execHost(command, { timeout = 60_000 } = {}) {
  if (isInDocker) {
    return execAsync(
      `nsenter -t 1 -m -u -n -i sh -c ${shellSingleQuote(command)}`,
      { timeout }
    );
  }
  return execAsync(command, { timeout });
}

// Parse one row of `docker system df --format '{{json .}}'`. Sizes
// come back as human strings ("1.2GB", "180MB"); we keep them as
// strings — the operator UI shows them verbatim and the prune
// actions don't need numerics.
function parseDfRow(line) {
  try {
    const r = JSON.parse(line);
    return {
      type: r.Type,
      total: parseInt(r.TotalCount, 10) || 0,
      active: parseInt(r.Active, 10) || 0,
      size: r.Size || '0B',
      reclaimable: r.Reclaimable || '0B',
    };
  } catch {
    return null;
  }
}

// ── routes ──────────────────────────────────────────────────────────────────

// GET /api/housekeeping/usage — what's piling up.
housekeepingRouter.get('/usage', requireAdmin, async (_req, res) => {
  let docker = null;
  let dockerErr = null;
  try {
    const { stdout } = await execHost(
      `docker system df --format '{{json .}}'`,
      { timeout: 15_000 }
    );
    docker = stdout
      .split('\n')
      .filter(Boolean)
      .map(parseDfRow)
      .filter(Boolean);
  } catch (err) {
    dockerErr = err?.message || 'docker df failed';
  }

  // Pre-update DB backups. install.sh creates them before applying
  // schema migrations; they can pile up on long-running boxes. We
  // count + total their size but don't include their names (they
  // include timestamps that are noisy in JSON).
  let backups = { count: 0, bytes: 0, oldest: null, newest: null };
  try {
    if (existsSync(BACKUP_DIR)) {
      const names = await readdir(BACKUP_DIR);
      for (const name of names) {
        if (!/\.bak/i.test(name) && !/proxypilot\.db.*\.bak/.test(name)) continue;
        try {
          const s = await stat(join(BACKUP_DIR, name));
          backups.count += 1;
          backups.bytes += s.size;
          if (!backups.oldest || s.mtimeMs < backups.oldest) backups.oldest = s.mtimeMs;
          if (!backups.newest || s.mtimeMs > backups.newest) backups.newest = s.mtimeMs;
        } catch {}
      }
    }
  } catch {}

  res.json({
    docker,
    docker_error: dockerErr,
    backups: {
      ...backups,
      oldest: backups.oldest ? new Date(backups.oldest).toISOString() : null,
      newest: backups.newest ? new Date(backups.newest).toISOString() : null,
      dir: BACKUP_DIR,
    },
  });
});

// POST /api/housekeeping/prune — opt in to each prune category. The
// per-category booleans default to false so an empty body is a no-op
// rather than a "prune everything by accident" footgun.
const pruneSchema = z.object({
  // Dangling images (untagged, replaced by a new build of the same
  // tag). Always safe.
  dangling_images: z.boolean().optional(),
  // ALL unused images (no container references the tag). Removes
  // images other apps on the same docker daemon may depend on.
  all_unused_images: z.boolean().optional(),
  // Stopped containers.
  stopped_containers: z.boolean().optional(),
  // Volumes with no container reference. Can permanently delete data.
  unused_volumes: z.boolean().optional(),
  // Build cache layers older than the keep-storage threshold.
  build_cache: z.boolean().optional(),
  // Pre-update DB backups older than `backups_older_than_days`.
  backups: z.boolean().optional(),
  backups_older_than_days: z.number().int().min(1).max(3650).optional(),
}).strict();

housekeepingRouter.post('/prune', requireAdmin, requireSudo, async (req, res) => {
  let body;
  try {
    body = pruneSchema.parse(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const summary = { ran: [], errors: [], freed_bytes: 0 };

  // Each step uses --filter "until=" or specific flags so we don't
  // surprise the operator. Errors are non-fatal — we keep going so
  // partial success is reported in the response.
  async function runPrune(label, cmd) {
    try {
      const { stdout } = await execHost(cmd, { timeout: 5 * 60_000 });
      summary.ran.push({ label, output: stdout.trim().slice(0, 2000) });
      // `docker ... prune` outputs "Total reclaimed space: 1.23GB"
      const m = stdout.match(/reclaimed space:\s*([\d.]+)\s*([KMGT]?B)/i);
      if (m) {
        const v = parseFloat(m[1]);
        const u = (m[2] || 'B').toUpperCase();
        const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[u] || 1;
        summary.freed_bytes += Math.round(v * mult);
      }
    } catch (err) {
      summary.errors.push({ label, error: err?.message || 'prune failed' });
    }
  }

  if (body.dangling_images) {
    await runPrune('dangling_images', `docker image prune -f`);
  }
  if (body.all_unused_images) {
    await runPrune('all_unused_images', `docker image prune -af`);
  }
  if (body.stopped_containers) {
    await runPrune('stopped_containers', `docker container prune -f`);
  }
  if (body.unused_volumes) {
    await runPrune('unused_volumes', `docker volume prune -f`);
  }
  if (body.build_cache) {
    await runPrune('build_cache', `docker builder prune -f --keep-storage 1g`);
  }

  // DB backup pruning is independent of docker — pure FS.
  if (body.backups) {
    const days = body.backups_older_than_days ?? 30;
    const cutoff = Date.now() - days * 86400_000;
    let removed = 0;
    let bytes = 0;
    try {
      if (existsSync(BACKUP_DIR)) {
        const names = await readdir(BACKUP_DIR);
        for (const name of names) {
          if (!/\.bak/i.test(name) && !/proxypilot\.db.*\.bak/.test(name)) continue;
          const path = join(BACKUP_DIR, name);
          try {
            const s = await stat(path);
            if (s.mtimeMs < cutoff) {
              bytes += s.size;
              await unlink(path);
              removed += 1;
            }
          } catch {}
        }
      }
      summary.ran.push({
        label: 'backups',
        output: `removed ${removed} backup${removed === 1 ? '' : 's'} older than ${days} day${days === 1 ? '' : 's'} (${bytes} bytes)`,
      });
      summary.freed_bytes += bytes;
    } catch (err) {
      summary.errors.push({ label: 'backups', error: err?.message || 'backup prune failed' });
    }
  }

  logAudit(req.user.id, 'HOUSEKEEPING_PRUNE', 'docker', null, {
    requested: body,
    ran: summary.ran.map(r => r.label),
    errors_count: summary.errors.length,
    freed_bytes: summary.freed_bytes,
  }, req.ip);

  res.json(summary);
});
