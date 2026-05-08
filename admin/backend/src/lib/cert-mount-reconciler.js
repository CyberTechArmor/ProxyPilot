// Cert-mount reconciler.
//
// Source-of-truth split mirrors lib/l4-reconciler:
//   - service_cert_mounts is intent-only. ProxyPilot stores the
//     desired (container, device, source-dir, target-path) tuple.
//   - Incus owns the live `disk` device on the consumer LXC. The
//     reconciler reads `incus config device show` to figure out
//     what's already in place and only emits writes for the diff.
//
// Drift policy (from the locked architecture decisions):
//   - missing       device gone from Incus → re-attach (auto-heal at
//                   boot AND in response to operator's Reconcile
//                   click).
//   - matched       device present, source matches DB row → no-op.
//   - drifted       device present but source points elsewhere →
//                   DO NOT touch. Surface as a badge in the UI so
//                   the operator can decide whether their manual
//                   edit was deliberate or whether they want a
//                   ProxyPilot reconcile to overwrite it.
//
// Boot sweep (called from index.js post-listen) walks every row.
// Per-row reconcile (called from POST .../reconcile) operates on a
// single mountId so the UI's drift Reconcile button is a cheap
// targeted call, not a full sweep.
//
// All shell-outs go through the existing host-exec wrapper so the
// nsenter pivot inside the admin container is centralised — see
// lib/host-exec.js for the rationale.

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { shellSingleQuote } from './shell-quote.js';

const execAsync = promisify(exec);
const isInDocker =
  existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// Default execHost — same shape as l4-reconciler's defaultExecHost.
// Kept inline rather than imported so this module is independent of
// the L4 path's lifecycle.
async function defaultExecHost(command, { timeout = 20_000 } = {}) {
  if (isInDocker) {
    return execAsync(
      `nsenter -t 1 -m -u -n -i sh -c ${shellSingleQuote(command)}`,
      { timeout }
    );
  }
  return execAsync(command, { timeout });
}

/**
 * Inspect a single Incus device on a container. Returns:
 *   { exists: false }                      device not configured
 *   { exists: true, type, source, path,    device present; fields
 *     readonly }                           extracted from `incus
 *                                          config device show <c>`
 *
 * The `device show` form emits YAML for ALL devices on the
 * container; we filter to the one we care about by name. Pulling
 * one device with `incus config device get` would be cheaper but
 * splits across N round trips; one show + a parse is one shell call
 * regardless of how many devices live on the container.
 */
export async function inspectIncusDevice(
  containerName,
  deviceName,
  { execHost = defaultExecHost } = {}
) {
  let stdout = '';
  try {
    const r = await execHost(
      `incus config device show ${shellSingleQuote(containerName)}`,
      { timeout: 10_000 }
    );
    stdout = (r && r.stdout) || '';
  } catch (e) {
    const stderr = ((e && (e.stderr || e.message)) || '').toString();
    if (/not found|doesn't exist|does not exist/i.test(stderr)) {
      // Container missing — surface as "device doesn't exist" so
      // the caller's drift logic treats it the same as a missing
      // device on a present container. The route layer pre-flights
      // container existence anyway.
      return { exists: false, containerMissing: true };
    }
    throw e;
  }
  return parseDeviceFromShow(stdout, deviceName);
}

/**
 * Parse `incus config device show <c>` for one named device. The
 * top level is a YAML map keyed by device name; each value is an
 * indented sub-map with `type:`, `source:`, `path:`, `readonly:`.
 *
 * Hand-rolled rather than pulling in a YAML dep — the L4 reconciler
 * uses the same trick, and the device-show output has been stable
 * across Incus 0.x and LXD 5.x.
 */
export function parseDeviceFromShow(text, deviceName) {
  let inside = false;
  let dev = null;
  for (const raw of (text || '').split('\n')) {
    if (!raw || raw.startsWith('#')) continue;
    const top = raw.match(/^([A-Za-z0-9_-][A-Za-z0-9_.\-]*):\s*$/);
    if (top) {
      // Reached a new top-level key. If we were inside our device
      // we're now done — return what we found.
      if (inside) break;
      if (top[1] === deviceName) {
        inside = true;
        dev = { exists: true, type: null, source: null, path: null, readonly: false };
      }
      continue;
    }
    if (!inside) continue;
    const m = raw.match(/^(\s+)([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[2];
    const val = m[3].trim();
    if (key === 'type') dev.type = val;
    else if (key === 'source') dev.source = unquoteYamlScalar(val);
    else if (key === 'path') dev.path = unquoteYamlScalar(val);
    else if (key === 'readonly') dev.readonly = /^true$|^"true"$/i.test(val);
  }
  return dev || { exists: false };
}

function unquoteYamlScalar(v) {
  if (typeof v !== 'string') return v;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Attach a disk device on a consumer LXC. Idempotent: if the device
 * is already there with the same `source=`, the underlying `incus
 * config device add` returns "already exists" which we treat as a
 * matched no-op.
 */
export async function attachCertMount(row, { execHost = defaultExecHost } = {}) {
  const cmd = [
    'incus config device add',
    shellSingleQuote(row.container_name),
    shellSingleQuote(row.device_name),
    'disk',
    `source=${shellSingleQuote(row.cert_dir)}`,
    `path=${shellSingleQuote(row.target_path)}`,
    `readonly=${row.readonly ? 'true' : 'false'}`,
  ].join(' ');
  await execHost(cmd, { timeout: 15_000 });
}

/**
 * Detach a disk device. Tolerates "not found" so a redundant remove
 * after the operator already cleaned up is not an error.
 */
export async function detachCertMount(
  { container_name, device_name },
  { execHost = defaultExecHost } = {}
) {
  try {
    await execHost(
      `incus config device remove ${shellSingleQuote(container_name)} ${shellSingleQuote(device_name)}`,
      { timeout: 15_000 }
    );
  } catch (e) {
    const stderr = ((e && (e.stderr || e.message)) || '').toString();
    if (!/not found|doesn't exist|does not exist/i.test(stderr)) {
      throw e;
    }
  }
}

/**
 * Reconcile cert-mount rows.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} [opts.serviceId]   when set, only rows for this
 *                                    service are reconciled. Omit
 *                                    for the boot sweep.
 * @param {string} [opts.mountId]     when set, only this single row.
 * @param {Function} [opts.execHost]  shell-out hook (test seam).
 *
 * @returns {Promise<{ results: Array<{ id, action, drift? }> }>}
 *
 * Per-row outcomes:
 *   - 'created'   device wasn't there, we attached it
 *   - 'matched'   device already there with matching source
 *   - 'drifted'   device exists but source points elsewhere; left
 *                 untouched so an operator's deliberate edit isn't
 *                 silently overwritten. drift.kind === 'wrong_source'
 *                 with the live source surfaced for the UI.
 *   - 'missing'   container itself isn't running / doesn't exist on
 *                 Incus right now; nothing to attach against. Row
 *                 stays in DB so a later boot reconcile can heal.
 *   - 'error'     unexpected failure (shelled-out command threw).
 */
export async function reconcileServiceCertMounts({
  db,
  serviceId,
  mountId,
  execHost = defaultExecHost,
} = {}) {
  if (!db) throw new Error('reconcileServiceCertMounts: db is required');

  let rows;
  if (mountId) {
    rows = db
      .prepare(`SELECT * FROM service_cert_mounts WHERE id = ?`)
      .all(mountId);
  } else if (serviceId) {
    rows = db
      .prepare(`SELECT * FROM service_cert_mounts WHERE service_id = ?`)
      .all(serviceId);
  } else {
    rows = db.prepare(`SELECT * FROM service_cert_mounts`).all();
  }

  const results = [];
  for (const row of rows) {
    try {
      const live = await inspectIncusDevice(row.container_name, row.device_name, { execHost });
      if (live.containerMissing) {
        results.push({
          id: row.id,
          action: 'missing',
          drift: { kind: 'container_missing' },
        });
        continue;
      }
      if (!live.exists) {
        // Try to attach. If the container itself is gone the
        // attempt will fail with a clear error — surface that as
        // 'missing' so operators see the same shape regardless of
        // whether the inspect or the add caught it first.
        try {
          await attachCertMount(row, { execHost });
          results.push({ id: row.id, action: 'created' });
        } catch (e) {
          const msg = (e && e.message ? e.message : String(e || '')).toString();
          const stderr = ((e && e.stderr) || '').toString();
          const blob = (msg + ' ' + stderr).toLowerCase();
          if (/not found|doesn't exist|does not exist/.test(blob)) {
            results.push({
              id: row.id,
              action: 'missing',
              drift: { kind: 'container_missing' },
            });
          } else if (/already exists/.test(blob)) {
            // Race: between inspect and add the device materialised.
            // Re-inspect to settle on the right outcome.
            const again = await inspectIncusDevice(row.container_name, row.device_name, { execHost });
            if (again.exists && again.source === row.cert_dir) {
              results.push({ id: row.id, action: 'matched' });
            } else if (again.exists) {
              results.push({
                id: row.id,
                action: 'drifted',
                drift: { kind: 'wrong_source', incus_source: again.source },
              });
            } else {
              results.push({ id: row.id, action: 'error', error: msg });
            }
          } else {
            results.push({ id: row.id, action: 'error', error: msg });
          }
        }
        continue;
      }
      if (live.source === row.cert_dir) {
        results.push({ id: row.id, action: 'matched' });
      } else {
        results.push({
          id: row.id,
          action: 'drifted',
          drift: { kind: 'wrong_source', incus_source: live.source },
        });
      }
    } catch (e) {
      results.push({ id: row.id, action: 'error', error: e.message });
    }
  }
  return { results };
}
