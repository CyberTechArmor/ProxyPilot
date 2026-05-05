// L4-forward reconciler.
//
// For each enabled row in service_l4_forwards we need TWO host-side
// state changes to actually expose the port:
//
//   1. An Incus `proxy` device on the LXC. Incus listens on the
//      host edge and forwards to the bridge IP transparently —
//      no host firewall rule on the bridge side, no NAT mess.
//      Device naming: `ppl4-<forward_id>` so the reconciler can
//      identify ProxyPilot-owned devices by prefix and clean up
//      orphans without guessing.
//
//   2. A host firewall rule (CLI source='service-l4') that admits
//      the same listen port from the public internet. Without this,
//      the host's default-deny firewall blocks the listener Incus
//      just opened. Rule id is deterministic
//      (`service-l4-<forward_id>`) so add and remove are pure
//      functions of the forward row.
//
// The reconciler is "stateless" in the sense that it never reads
// Incus to figure out what TO do — the DB is authoritative. It
// reads Incus only to figure out what's already in place so it can
// avoid no-op churn. This matches the way the Caddy reconciler
// regenerates from scratch each reconcile cycle.

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { shellSingleQuote } from './shell-quote.js';
import { reconcileReservedPorts } from './l4-reserved-ports.js';

const execAsync = promisify(exec);
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
const PROXYPILOT_BIN = process.env.PROXYPILOT_BIN || '/usr/local/bin/proxypilot';
const INSTANCE_PREFIX = 'pp-';

// Default execHost: nsenter into pid 1 when running inside the
// admin container, plain exec on bare metal. Same shape as the
// helpers in routes/firewall.js and routes/lxc.js.
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
 * Render an Incus listen= or connect= argument from a row's
 * proto/start/end ports. Single-port rows produce `tcp:0.0.0.0:80`,
 * range rows produce `udp:0.0.0.0:50000-60000`. Always binds the
 * host edge to 0.0.0.0; restriction to a smaller listen interface
 * is the firewall's job, not the proxy device's.
 */
export function renderIncusEndpoint({ proto, start, end, address }) {
  const portPart = end && end !== start ? `${start}-${end}` : `${start}`;
  return `${proto}:${address}:${portPart}`;
}

/**
 * Translate one DB row into the Incus device-add command and the
 * CLI firewall-add command. Pure: no I/O. Returns the spec the
 * caller hands to applyServiceL4Plan.
 */
export function planServiceL4Forward(forward, { bridgeIp, lxcName }) {
  if (!bridgeIp) throw new Error('planServiceL4Forward: bridgeIp is required');
  if (!lxcName) throw new Error('planServiceL4Forward: lxcName is required');
  if (!forward || !forward.id) throw new Error('planServiceL4Forward: forward.id is required');
  const incusName = lxcName.startsWith(INSTANCE_PREFIX) ? lxcName : `${INSTANCE_PREFIX}${lxcName}`;
  const deviceName = `ppl4-${forward.id}`;
  const ruleId = `service-l4-${forward.id}`;
  const listen = renderIncusEndpoint({
    proto: forward.proto,
    start: forward.listen_port,
    end: forward.listen_port_end,
    address: '0.0.0.0',
  });
  const connect = renderIncusEndpoint({
    proto: forward.proto,
    start: forward.connect_port,
    end: forward.connect_port_end,
    address: bridgeIp,
  });
  return {
    incusName,
    deviceName,
    ruleId,
    listen,
    connect,
    proto: forward.proto,
    listenPort: forward.listen_port,
    listenPortEnd: forward.listen_port_end ?? null,
    description: forward.description ?? null,
  };
}

/**
 * Apply one planned forward end-to-end:
 *   1. `incus config device add` (idempotent — we tolerate
 *      "device already exists" so a repeat reconcile is cheap)
 *   2. `proxypilot firewall add-service-l4` (idempotent at the
 *      CLI layer; "already exists" surfaces as a non-fatal warning)
 *
 * On any failure the function throws so the caller can log + bail.
 * It does NOT auto-rollback the half-applied state — leaving the
 * partial state visible so the operator can fix the underlying
 * issue (e.g. port conflict) and re-reconcile, rather than masking
 * the symptom.
 */
export async function applyServiceL4Plan(plan, { execHost = defaultExecHost, serviceTag = null } = {}) {
  let incusStatus = 'applied';
  let firewallStatus = 'applied';
  const incusCmd = [
    'incus config device add',
    plan.incusName,
    plan.deviceName,
    'proxy',
    `listen=${plan.listen}`,
    `connect=${plan.connect}`,
  ].join(' ');
  try {
    await execHost(incusCmd, { timeout: 15_000 });
  } catch (e) {
    const stderr = ((e && (e.stderr || e.message)) || '').toString();
    if (!/already exists|conflict/i.test(stderr)) {
      throw new Error(`incus device add failed: ${stderr.trim()}`);
    }
    // Device already present from a previous reconcile — leave it.
    // We could `incus config device set` to update listen/connect
    // here, but a width or proto change is rare enough that asking
    // the operator to delete + re-add is the safer default than
    // silently swapping a live forward.
    incusStatus = 'present';
  }
  const portRange = plan.listenPortEnd && plan.listenPortEnd !== plan.listenPort
    ? `${plan.listenPort}-${plan.listenPortEnd}`
    : String(plan.listenPort);
  const cliArgs = [
    'firewall', 'add-service-l4',
    '--id', plan.ruleId,
    '--port', String(plan.listenPort),
    '--proto', plan.proto,
    '--reason', plan.description || `service-l4 ${plan.proto}/${portRange}`,
  ];
  if (plan.listenPortEnd) cliArgs.push('--port-end', String(plan.listenPortEnd));
  if (serviceTag) cliArgs.push('--service', serviceTag);
  const cliCmd = ['--json', ...cliArgs].map((a) => shellSingleQuote(a)).join(' ');
  try {
    await execHost(`${PROXYPILOT_BIN} ${cliCmd}`, { timeout: 30_000 });
  } catch (e) {
    const stderr = ((e && (e.stderr || e.message)) || '').toString();
    const stdout = ((e && e.stdout) || '').toString();
    if (/already exists/i.test(stderr) || /already exists/i.test(stdout)) {
      // Firewall row is already present — fine, the reconciler is
      // idempotent. The reconcile call inside add-service-l4 still
      // runs, so live nftables is in sync.
      firewallStatus = 'present';
    } else {
      throw new Error(`proxypilot firewall add-service-l4 failed: ${(stderr || stdout).trim()}`);
    }
  }
  return { incus: incusStatus, firewall: firewallStatus };
}

/**
 * Undo one forward's host-side state. Mirror of applyServiceL4Plan.
 * Always tries both removals; the firewall removal is treated as
 * idempotent (NOT_FOUND is fine), the device removal swallows
 * "Device not found" so retries converge.
 */
export async function removeServiceL4Plan(
  { incusName, deviceName, ruleId },
  { execHost = defaultExecHost } = {}
) {
  const errors = [];
  try {
    await execHost(`incus config device remove ${incusName} ${deviceName}`, { timeout: 15_000 });
  } catch (e) {
    const stderr = ((e && (e.stderr || e.message)) || '').toString();
    if (!/not found|doesn't exist|does not exist/i.test(stderr)) {
      errors.push(`incus device remove: ${stderr.trim()}`);
    }
  }
  try {
    const cmd = `${PROXYPILOT_BIN} --json firewall remove-service-l4 ${shellSingleQuote(ruleId)}`;
    await execHost(cmd, { timeout: 30_000 });
  } catch (e) {
    const stderr = ((e && (e.stderr || e.message)) || '').toString();
    const stdout = ((e && e.stdout) || '').toString();
    if (!/not found|NOT_FOUND/i.test(stderr) && !/already_absent|not found/i.test(stdout)) {
      errors.push(`proxypilot firewall remove-service-l4: ${(stderr || stdout).trim()}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

/**
 * Reconcile every L4 forward for a service against the live Incus
 * device set. Picks up:
 *
 *   - new rows in service_l4_forwards: applies them
 *   - rows the DB has dropped (or set enabled=0) that still have
 *     a `ppl4-*` device: removes the device + paired firewall row
 *
 * Caller is responsible for resolving the bridge IP (it changes
 * across container restarts and the right place to read it from is
 * the existing helper in routes/lxc.js).
 *
 * Returns a per-forward outcome list so the route layer can put
 * "applied" / "removed" / "error: …" status onto the response —
 * the operator should see partial-success states, not just a 500.
 */
export async function reconcileServiceL4Forwards({
  db,
  serviceId,
  lxcName,
  bridgeIp,
  serviceTag = null,
  execHost = defaultExecHost,
  listIncusDevices = defaultListIncusDevices,
}) {
  const incusName = lxcName.startsWith(INSTANCE_PREFIX) ? lxcName : `${INSTANCE_PREFIX}${lxcName}`;
  const desired = db
    .prepare(
      `SELECT id, proto, listen_port, listen_port_end, connect_port, connect_port_end,
              description, enabled
         FROM service_l4_forwards
        WHERE service_id = ? AND enabled = 1`
    )
    .all(serviceId);
  const desiredById = new Map(desired.map((r) => [r.id, r]));

  const live = await listIncusDevices(incusName, { execHost });
  const liveProxyDevices = live.filter((d) => d.name.startsWith('ppl4-'));

  const outcomes = [];

  // Apply or update everything desired.
  for (const row of desired) {
    const plan = planServiceL4Forward(row, { bridgeIp, lxcName });
    try {
      const r = await applyServiceL4Plan(plan, { execHost, serviceTag });
      outcomes.push({ id: row.id, status: 'applied', detail: r });
    } catch (e) {
      outcomes.push({ id: row.id, status: 'error', error: e.message });
    }
  }

  // Anything live with a `ppl4-` prefix that the DB doesn't claim is an
  // orphan — remove it.
  for (const dev of liveProxyDevices) {
    const forwardId = dev.name.replace(/^ppl4-/, '');
    if (desiredById.has(forwardId)) continue;
    try {
      await removeServiceL4Plan(
        {
          incusName,
          deviceName: dev.name,
          ruleId: `service-l4-${forwardId}`,
        },
        { execHost }
      );
      outcomes.push({ id: forwardId, status: 'removed' });
    } catch (e) {
      outcomes.push({ id: forwardId, status: 'error', error: e.message });
    }
  }

  // After every reconcile, refresh the kernel's
  // ip_local_reserved_ports drop-in to match the current set of UDP
  // ranges. This stops the early-boot ephemeral allocation from
  // silently breaking large UDP forwards (the WebRTC media class) on
  // the next host reboot. Failures here don't fail the reconcile —
  // the host-side state just stays as it was.
  let reservedPorts = null;
  try {
    reservedPorts = await reconcileReservedPorts({ db, execHost });
  } catch (e) {
    reservedPorts = { error: e.message };
  }

  return { applied: outcomes, reservedPorts };
}

/**
 * Default device-list implementation. `incus config device show` emits
 * one device per stanza in YAML; we only need the device names plus
 * the type/listen/connect fields, so a tiny line-oriented parse is
 * enough — pulling in a YAML dependency for this would be overkill.
 *
 * Returns: [ { name, type, listen, connect } ... ]
 */
async function defaultListIncusDevices(incusName, { execHost = defaultExecHost } = {}) {
  let stdout = '';
  try {
    const r = await execHost(`incus config device show ${shellSingleQuote(incusName)}`, {
      timeout: 10_000,
    });
    stdout = (r && r.stdout) || '';
  } catch (e) {
    const stderr = ((e && (e.stderr || e.message)) || '').toString();
    // Container missing or stopped — surface as empty list rather
    // than a thrown error; the caller's reconciler should still
    // proceed with the desired-set walk so the operator gets a
    // useful per-row "error: container not running" outcome.
    if (/not found|doesn't exist|does not exist/i.test(stderr)) return [];
    throw e;
  }
  return parseIncusDeviceShow(stdout);
}

/**
 * Parse the YAML-ish output of `incus config device show`. The
 * top-level keys are device names, indented two spaces, with
 * sub-keys at four spaces. We only look at the keys we care about
 * (type, listen, connect); everything else gets ignored. Tested
 * against Incus 0.x and LXD 5.x, which share this output shape.
 */
export function parseIncusDeviceShow(text) {
  const out = [];
  let cur = null;
  for (const raw of (text || '').split('\n')) {
    if (!raw || raw.startsWith('#')) continue;
    // Top-level key: device name at column 0 followed by `:` and EOL.
    // `incus config device show` always emits one device per top-level
    // key; properties live below at 2+ space indent.
    const top = raw.match(/^([A-Za-z0-9_-][A-Za-z0-9_.\-]*):\s*$/);
    if (top) {
      if (cur) out.push(cur);
      cur = { name: top[1], type: null, listen: null, connect: null };
      continue;
    }
    const m = raw.match(/^(\s+)([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!m || !cur) continue;
    const key = m[2];
    const val = m[3].trim();
    if (key === 'type') cur.type = val;
    else if (key === 'listen') cur.listen = val;
    else if (key === 'connect') cur.connect = val;
  }
  if (cur) out.push(cur);
  return out.filter((d) => d.type === 'proxy');
}
