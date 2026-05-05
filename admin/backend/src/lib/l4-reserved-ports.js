// Reserve UDP port ranges from the kernel's ephemeral pool so they
// can't be grabbed by outbound sockets at boot, before Incus brings up
// our proxy devices.
//
// The bug this prevents
// ─────────────────────
// `net.ipv4.ip_local_port_range` defaults on Debian to 32768–60999,
// which overlaps every reasonable WebRTC media range. On a fresh boot
// systemd-networkd, chronyd, dnsmasq, etc. open outbound UDP sockets
// before incus brings up its proxy devices; the kernel hands them
// ephemeral source ports anywhere in 32768–60999, including inside a
// 50000–60000 range we want to bind. Incus's proxy needs a contiguous
// bind on the whole range — a single conflict drops the *entire*
// range, leaving the device unconfigured at first reconcile and the
// firewall rule unpaired. Single-port forwards (e.g. tcp/7881) survive
// reboots fine; large ranges almost never do.
//
// The fix
// ───────
// Whenever the L4 forward set contains any range, write
// `net.ipv4.ip_local_reserved_ports = <ranges>` to a sysctl drop-in
// at /etc/sysctl.d/99-proxypilot-l4-reserved.conf, then `sysctl -p` it
// to apply live. The kernel will refuse to assign ephemeral ports
// inside the reserved set; outbound connect()s pick from the rest of
// 32768–60999. The drop-in is owned by ProxyPilot, idempotent, and
// regenerated each reconcile.
//
// We deliberately reserve only when at least one *range* forward
// exists. Single-port forwards don't need reservation — the conflict
// space is too small to matter, and reserving every L4 listen port
// would inflate the sysctl unnecessarily. TCP forwards skip
// reservation regardless: ip_local_reserved_ports affects both
// protocols, but TCP source-port collisions on incus proxy bind are
// vanishingly rare and the cost of reserving lots of TCP ports for a
// non-issue is real.

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { shellSingleQuote } from './shell-quote.js';

const execAsync = promisify(exec);
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// Kept exported so tests can substitute a tmpdir path.
export const RESERVED_PORTS_PATH =
  process.env.PROXYPILOT_L4_RESERVED_PORTS_PATH ||
  '/etc/sysctl.d/99-proxypilot-l4-reserved.conf';

const RESERVED_PORTS_HEADER = [
  '# Managed by ProxyPilot. Do not edit.',
  '#',
  '# Reserves the listen ranges of every UDP L4 forward in',
  '# service_l4_forwards so the kernel refuses to assign ephemeral',
  '# ports inside them. Without this, an ephemeral allocation made',
  '# during early boot can collide with a port inside the range and',
  '# block Incus from binding the proxy device for the whole range —',
  '# WebRTC media goes dark and only a manual re-reconcile recovers.',
  '',
].join('\n');

async function defaultExecHost(command, { timeout = 10_000 } = {}) {
  if (isInDocker) {
    return execAsync(
      `nsenter -t 1 -m -u -n -i sh -c ${shellSingleQuote(command)}`,
      { timeout }
    );
  }
  return execAsync(command, { timeout });
}

/**
 * Compute the desired ip_local_reserved_ports value for the current
 * forward set. Sorted, comma-separated, ranges as `start-end`.
 *
 * @param {Array<{proto:string,listen_port:number,listen_port_end:number|null,enabled?:number}>} rows
 * @returns {string}  e.g. "50000-60000" or "" when no ranges to reserve.
 */
export function buildReservedPortsValue(rows) {
  const ranges = [];
  for (const r of rows || []) {
    if (r.enabled === 0) continue;
    if (r.proto !== 'udp') continue;          // see file header
    if (!r.listen_port_end || r.listen_port_end === r.listen_port) continue;
    ranges.push([r.listen_port, r.listen_port_end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  // Coalesce adjacent / overlapping ranges so the kernel gets a tidy list.
  const merged = [];
  for (const [s, e] of ranges) {
    if (merged.length === 0 || s > merged[merged.length - 1][1] + 1) {
      merged.push([s, e]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    }
  }
  return merged.map(([s, e]) => `${s}-${e}`).join(',');
}

/**
 * Reconcile /etc/sysctl.d/99-proxypilot-l4-reserved.conf to match the
 * desired reserved-ports value, applying the change live with
 * `sysctl -p` afterwards.
 *
 * Idempotent: if the file already contains the desired body, no write
 * and no sysctl invocation. The file is removed entirely when no
 * UDP ranges exist, so a host that's stopped using L4 forwards has no
 * stale ProxyPilot drop-in lingering.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {(cmd: string, opts?: object) => Promise<{stdout:string,stderr:string}>} [opts.execHost]
 * @returns {Promise<{ value: string, changed: boolean, applied: boolean, error?: string }>}
 */
export async function reconcileReservedPorts({ db, execHost = defaultExecHost } = {}) {
  if (!db) throw new Error('reconcileReservedPorts: db is required');
  const rows = db
    .prepare(
      `SELECT proto, listen_port, listen_port_end, enabled
         FROM service_l4_forwards
        WHERE enabled = 1`
    )
    .all();
  const value = buildReservedPortsValue(rows);
  const desired = value
    ? `${RESERVED_PORTS_HEADER}net.ipv4.ip_local_reserved_ports = ${value}\n`
    : '';

  let current = '';
  try {
    const { readFileSync } = await import('node:fs');
    current = readFileSync(RESERVED_PORTS_PATH, 'utf-8');
  } catch {
    current = '';
  }

  if (current === desired) {
    return { value, changed: false, applied: true };
  }

  const { writeFileSync, unlinkSync } = await import('node:fs');
  if (desired === '') {
    try { unlinkSync(RESERVED_PORTS_PATH); } catch { /* not present */ }
  } else {
    try {
      writeFileSync(RESERVED_PORTS_PATH, desired, { mode: 0o644 });
    } catch (err) {
      return { value, changed: false, applied: false, error: `write ${RESERVED_PORTS_PATH}: ${err.message}` };
    }
  }

  // Apply live. `sysctl -p <file>` is the right shape — it loads only
  // our drop-in, doesn't churn unrelated values, and on success makes
  // the new reserved set effective immediately. On a host where the
  // drop-in was just removed, hand it /etc/sysctl.conf to make sysctl
  // re-load the active set; otherwise the previous reservation
  // would stay in the kernel until reboot.
  const sysctlTarget = desired === '' ? '/etc/sysctl.conf' : RESERVED_PORTS_PATH;
  try {
    await execHost(`sysctl -p ${shellSingleQuote(sysctlTarget)}`, { timeout: 5_000 });
  } catch (err) {
    const detail = ((err && (err.stderr || err.message)) || '').toString().trim();
    return { value, changed: true, applied: false, error: `sysctl -p: ${detail}` };
  }
  return { value, changed: true, applied: true };
}
