// Mock2 manifest port-drift check (Phase M4, ADR-005 — the inbound half).
//
// ADR-005: ports are DECLARED in mock2.yaml, never discovered. ProxyPilot
// publishes exactly one HTTPS route — to the declared `web` port — and the
// bridge fence keeps every other port internal (firewall.js). Scanning is
// VERIFICATION, not allow-listing: after a container comes up we read its live
// listeners (lib/port-detector.js, already written) and diff them against the
// manifest. A publicly-bound port that the manifest does not declare is DRIFT —
// it raises a `port_drift` queue item (the kind already exists in
// mock2_queue_items, migration 502) and, until the M8 queue UI lands, surfaces
// via the notifications bell. It is NEVER auto-allowed.
//
// computePortDrift is PURE (unit-tested stub-first, risk R9). runPortDriftCheck
// reads the container over the host pivot (mock2/host.js, risk R3) and records
// the verdict.
//
// Terminology (risk R7): nothing here is named "agent".

import { readListeningPorts } from '../lib/port-detector.js';
import { raiseQueueItem, resolveQueueItem } from './queue.js';
import { postNotification, resolveNotification } from '../lib/notifications.js';
import { sh } from './host.js';
import { computePortDrift } from './network-logic.js';

// computePortDrift (the pure comparator) lives in network-logic.js so it is
// unit-testable without the queue/notification/host machinery this module pulls
// in (stub-first, risk R9).

function driftDedupe(projectId) {
  return `mock2-port-drift:${projectId}`;
}

// An execHost adapter over the shared host pivot: port-detector calls
// execHost(commandString) and reads .stdout/.stderr. sh() already returns that
// shape (and never rejects), so a thin wrapper is all that's needed.
function execHost(command, { timeout = 5000 } = {}) {
  return sh(command, { timeoutMs: timeout });
}

// runPortDriftCheck(project) — read the container's live listeners and reconcile
// the port_drift queue item + bell notification. Non-fatal: a scan failure logs
// and leaves prior state alone (a missing container just means nothing to
// verify). Returns { checked, drift, tcp, udp, declared }.
export async function runPortDriftCheck(project) {
  const projectId = Number(project.id);
  const declared = Number(project.web_port);
  const containerName = project.container_name;
  if (!containerName || !declared) return { checked: false, drift: false };

  let live;
  try {
    live = await readListeningPorts(containerName, { execHost });
  } catch (err) {
    console.warn(`[mock2] port-drift: scan failed for project ${projectId}:`, err?.message);
    return { checked: false, drift: false };
  }
  if (live.error && (!live.tcp.anyHost.length && !live.udp.anyHost.length)) {
    // Couldn't read /proc/net at all — don't flip state on a blind scan.
    return { checked: false, drift: false };
  }

  const drift = computePortDrift({
    declared,
    tcpAnyHost: live.tcp.anyHost,
    udpAnyHost: live.udp.anyHost,
  });
  const dedupe = driftDedupe(projectId);

  if (drift.hasDrift) {
    const detail = `${project.name}: exposes undeclared port(s) — ` +
      `${drift.tcp.map((p) => `tcp/${p}`).concat(drift.udp.map((p) => `udp/${p}`)).join(', ')} ` +
      `(manifest declares only web tcp/${declared}). Not routed; review the manifest.`;
    try {
      raiseQueueItem({
        kind: 'port_drift',
        project_id: projectId,
        dedupe_key: dedupe,
        ref_table: 'mock2_projects',
        ref_id: projectId,
        detail,
      });
    } catch (err) { console.error('[mock2] port-drift raiseQueueItem failed:', err?.message); }
    try {
      postNotification({
        level: 'warning',
        title: `Mock2 port drift: ${project.name}`,
        body: detail,
        source: 'mock2-port-drift',
        source_id: projectId,
        dedupe_key: dedupe,
      });
    } catch (err) { console.error('[mock2] port-drift postNotification failed:', err?.message); }
  } else {
    resolveQueueItem(dedupe, { resolution: 'no drift' });
    resolveNotification(dedupe, { reason: 'no drift' });
  }
  return { checked: true, drift: drift.hasDrift, tcp: drift.tcp, udp: drift.udp, declared };
}
