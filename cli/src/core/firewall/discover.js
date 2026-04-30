import { spawnSync } from 'node:child_process';
import { readState, writeState } from './state.js';
import { audit } from '../../db/audit.js';
import { listInstances } from '../../incus/client.js';
import { getCaddyConfig } from '../../caddy/client.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Stable id for a discovered listener. Keeps a rule sticky across
 * scans so the operator's enable/disable choice is preserved when a
 * service restarts.
 */
function ruleId({ source, container, process: proc, port_start, port_end, proto }) {
  const cont = container ?? 'host';
  const p = proc ?? 'unknown';
  const range = port_end && port_end !== port_start
    ? `${port_start}-${port_end}`
    : `${port_start}`;
  return `${source}-${cont}-${p}-${range}-${proto}`;
}

/**
 * Parse a single line of `ss -H -tulnp` into 0+ listener records.
 *
 * Output (tabs/spaces):
 *   tcp  LISTEN 0  128  0.0.0.0:22  0.0.0.0:*  users:(("sshd",pid=1234,fd=3))
 *   tcp  LISTEN 0  128  [::]:22     [::]:*     users:(("sshd",pid=1234,fd=3))
 *   udp  UNCONN 0  0    0.0.0.0:67  0.0.0.0:*  users:(("dnsmasq",pid=890,fd=4))
 *
 * Returns an array because `ss` may report the same port on v4 and v6
 * and we want to dedupe to a single entry per (port, proto, process).
 */
function parseSsLine(line) {
  const cols = line.trim().split(/\s+/);
  if (cols.length < 5) return [];
  const proto = cols[0]; // tcp|udp
  if (proto !== 'tcp' && proto !== 'udp') return [];

  const localAddr = cols[4];
  const m = localAddr.match(/^(.*):(\d+)$/);
  if (!m) return [];
  const host = m[1];
  const port = parseInt(m[2], 10);

  // Skip loopback-only binds; the host firewall doesn't gate them.
  if (host === '127.0.0.1' || host === '[::1]' || host.startsWith('127.')) return [];

  // Extract process name from users:(("name",pid=...,fd=...)) field.
  const procField = cols.slice(5).join(' ');
  const procMatch = procField.match(/users:\(\("([^"]+)"/);
  const proc = procMatch ? procMatch[1] : null;

  return [{ proto, port, process: proc }];
}

/**
 * Run `ss` on the host and return the de-duplicated listener set.
 */
export function scanHost() {
  const out = spawnSync('ss', ['-H', '-tulnp'], { encoding: 'utf-8' });
  if (out.status !== 0) {
    throw new Error(`ss failed: ${out.stderr || out.error?.message || 'unknown'}`);
  }
  const seen = new Map(); // key proto:port:proc -> record
  for (const line of out.stdout.split('\n')) {
    if (!line.trim()) continue;
    for (const rec of parseSsLine(line)) {
      const key = `${rec.proto}:${rec.port}:${rec.process ?? ''}`;
      if (!seen.has(key)) {
        seen.set(key, { source: 'host', process: rec.process, port_start: rec.port, port_end: null, proto: rec.proto });
      }
    }
  }
  return [...seen.values()];
}

/**
 * Reconcile the discovered set against state. Inserts new entries with
 * `enabled: false` (per spec — discovery never opens ports), refreshes
 * `last_seen` on existing entries, and garbage-collects host-source
 * entries that have not been seen for 7 days.
 *
 * Operator toggles (enabled, scope, source_cidrs) are preserved.
 *
 * Returns { added, refreshed, gc }.
 */
export function reconcileDiscovery(discoveredSet, { now = new Date() } = {}) {
  const state = readState();
  const ts = now.toISOString();
  const cutoff = now.getTime() - RETENTION_MS;
  const before = JSON.stringify(state.discovered);

  // Index existing by id.
  const existing = new Map(state.discovered.map(r => [r.id, r]));
  let added = 0;
  let refreshed = 0;

  for (const rec of discoveredSet) {
    const id = ruleId(rec);
    const cur = existing.get(id);
    if (cur) {
      cur.last_seen = ts;
      // Pick up the latest process name in case `ss` learned it on this scan.
      if (rec.process && !cur.process) cur.process = rec.process;
      refreshed++;
    } else {
      existing.set(id, {
        id,
        source: rec.source,
        container: rec.container ?? null,
        process: rec.process ?? null,
        port_start: rec.port_start,
        port_end: rec.port_end ?? null,
        proto: rec.proto,
        scope: 'public',
        enabled: false,
        reason: null,
        first_seen: ts,
        last_seen: ts,
      });
      added++;
    }
  }

  // GC: drop entries whose last_seen is older than the retention window
  // AND whose source matches what we just scanned. We must not GC entries
  // from sources we don't scan in this round (e.g. lxc when scanHost-only
  // ran), or we'd wipe legitimate state.
  const scannedSources = new Set(discoveredSet.map(d => d.source));
  let gc = 0;
  for (const [id, rule] of existing) {
    if (!scannedSources.has(rule.source)) continue;
    if (rule.source === 'manual') continue;
    if (new Date(rule.last_seen).getTime() < cutoff) {
      existing.delete(id);
      gc++;
    }
  }

  state.discovered = [...existing.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeState(state);

  if (added > 0 || gc > 0) {
    audit({
      subsystem: 'firewall',
      action: 'discover',
      resource: [...scannedSources].sort().join(','),
      detail: `added=${added} refreshed=${refreshed} gc=${gc}`,
      before: JSON.parse(before),
      after: state.discovered,
    });
  }

  return { added, refreshed, gc };
}

/**
 * Walk listeners inside every running Incus instance via
 * `incus exec <name> -- ss -H -tulnp`. Containers without `ss`
 * available are silently skipped (a missing tool is not a discovery
 * failure — the operator just won't see those rows).
 */
export async function scanLxc() {
  let instances;
  try {
    instances = await listInstances();
  } catch {
    return []; // incus unavailable → no lxc listeners; not an error here
  }
  const out = [];
  for (const inst of instances) {
    if (inst.status !== 'Running') continue;
    const r = spawnSync('incus', ['exec', inst.name, '--', 'ss', '-H', '-tulnp'], {
      encoding: 'utf-8',
    });
    if (r.status !== 0) continue;
    const seen = new Set();
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      for (const rec of parseSsLine(line)) {
        const key = `${rec.proto}:${rec.port}:${rec.process ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          source: 'lxc',
          container: inst.name,
          process: rec.process,
          port_start: rec.port,
          port_end: null,
          proto: rec.proto,
        });
      }
    }
  }
  return out;
}

/**
 * `docker ps --format json` lines look like:
 *   {"Ports":"0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 0.0.0.0:50000-60000->50000-60000/udp",
 *    "Names":"livekit", ...}
 * We extract the *host-side* port (left of `->`) since that's what the
 * host firewall actually gates. Ranges (`50000-60000`) are preserved
 * as `port_end`.
 */
export function scanDocker() {
  const r = spawnSync('docker', ['ps', '--format', '{{json .}}'], { encoding: 'utf-8' });
  if (r.status !== 0) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    let json;
    try { json = JSON.parse(line); } catch { continue; }
    const ports = json.Ports ?? '';
    const name = json.Names ?? json.ID ?? 'unknown';
    const seen = new Set();
    for (const piece of ports.split(',').map(p => p.trim()).filter(Boolean)) {
      // host-side[->container-side]/proto, host-side may be omitted for unpublished ports
      const m = piece.match(/^(?:([^:]+):)?(\d+(?:-\d+)?)->(\d+(?:-\d+)?)\/(tcp|udp)/);
      if (!m) continue;
      const host = m[1];
      if (host === '127.0.0.1' || host === '[::1]') continue;
      const [start, end] = m[2].split('-').map(n => parseInt(n, 10));
      const proto = m[4];
      const key = `${proto}:${start}:${end ?? start}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        source: 'docker',
        container: name,
        process: null,
        port_start: start,
        port_end: end ?? null,
        proto,
      });
    }
  }
  return out;
}

/**
 * Walk the Caddy admin API for caddy-l4 listeners. Caddy-L4 servers
 * sit under `apps.layer4.servers.<name>.listen[]`; each listen entry
 * is a string like `:3306` or `:50000-60000/udp`.
 */
export async function scanCaddyL4() {
  let cfg;
  try { cfg = await getCaddyConfig(); } catch { return []; }
  const servers = cfg?.apps?.layer4?.servers ?? {};
  const out = [];
  for (const [name, server] of Object.entries(servers)) {
    for (const spec of (server.listen ?? [])) {
      // [host]:start[-end][/proto]; default proto tcp
      const m = String(spec).match(/^([^:]*):(\d+(?:-\d+)?)(?:\/(tcp|udp))?$/);
      if (!m) continue;
      const host = m[1];
      if (host === '127.0.0.1' || host === '[::1]') continue;
      const [start, end] = m[2].split('-').map(n => parseInt(n, 10));
      const proto = (m[3] ?? 'tcp');
      out.push({
        source: 'caddy-l4',
        container: null,
        process: name,
        port_start: start,
        port_end: end ?? null,
        proto,
      });
    }
  }
  return out;
}

/**
 * Top-level entrypoint. Runs all four scanners and feeds their union
 * into reconcileDiscovery. A failing scanner does not abort the whole
 * scan — its records are simply absent for this round and existing
 * state for that source survives because reconcileDiscovery only GCs
 * sources it actually scanned.
 */
export async function scan() {
  const host = scanHost();
  const lxc = await scanLxc();
  const docker = scanDocker();
  const caddyL4 = await scanCaddyL4();
  return reconcileDiscovery([...host, ...lxc, ...docker, ...caddyL4]);
}
