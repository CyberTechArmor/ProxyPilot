import { spawnSync } from 'node:child_process';
import { readState, writeState } from './state.js';
import { audit } from '../../db/audit.js';

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
 * Top-level entrypoint for the host scanner. Returns the same summary
 * as reconcileDiscovery so the CLI can print it.
 */
export function scan() {
  const host = scanHost();
  return reconcileDiscovery(host);
}
