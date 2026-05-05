// L4 forward diagnostics.
//
// When a call breaks "somewhere in the network", operators have three
// candidate failure layers between the browser and the LXC:
//
//   A. Cloud-provider security group / upstream firewall
//   B. Host-side incus proxy device + nftables
//   C. The LiveKit (or whatever) process listening inside the LXC
//
// ProxyPilot can verify B and C automatically. A is outside our
// reach, but once B and C are proven good, A is the only candidate
// left — which is far more actionable than "calls don't connect".
//
// This module runs four host-side checks per forward:
//
//   1. Bridge IP drift   — the cached service.target_ip used to plan
//      the proxy device's connect= still matches the LXC's actual
//      IPv4 from `incus list`. A mismatch means the proxy device is
//      forwarding to a stale address.
//
//   2. Incus device      — a `ppl4-<forward_id>` proxy device exists
//      on the container, with the listen/connect we'd plan.
//
//   3. LXC listener      — for each forward port, something inside
//      the LXC is listening on the connect side. UDP-range forwards
//      (the WebRTC class) are the worst case: LiveKit only opens
//      sockets on demand, so we don't fail the check on no listener
//      for ranges — we just report "no listener; expected for
//      WebRTC media until first call".
//
//   4. Firewall rule     — the paired `service-l4-<forward_id>`
//      nftables rule is live (admits the listen port from the
//      internet).
//
// Returns per-forward + per-check outcomes plus a one-line
// `next_step` summarizing what the operator should do next.

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { shellSingleQuote } from './shell-quote.js';
import { parseIncusDeviceShow, planServiceL4Forward } from './l4-reconciler.js';

const execAsync = promisify(exec);
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
const INSTANCE_PREFIX = 'pp-';

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
 * Look up the LXC's current IPv4 from `incus list --format json`.
 * Returns null when the container is missing or stopped.
 */
async function fetchCurrentBridgeIp(lxcName, { execHost = defaultExecHost } = {}) {
  const incusName = lxcName.startsWith(INSTANCE_PREFIX) ? lxcName : `${INSTANCE_PREFIX}${lxcName}`;
  try {
    const r = await execHost(
      `incus list ${shellSingleQuote(incusName)} --format json 2>/dev/null`,
      { timeout: 5_000 }
    );
    const arr = JSON.parse((r && r.stdout) || '[]');
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const addrs = (arr[0].state && arr[0].state.network) || {};
    for (const ifaceName of Object.keys(addrs)) {
      if (ifaceName === 'lo') continue;
      const list = (addrs[ifaceName] && addrs[ifaceName].addresses) || [];
      for (const a of list) {
        if (a.family === 'inet' && a.scope === 'global') return a.address;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Probe what's listening inside the LXC on a given protocol/port.
 * Uses `incus exec ... -- ss -tlnp` (or -ulnp) and grep — neither
 * netstat nor /proc/net/* parsing is needed for this.
 *
 * For ranges, returns { listening: true } if ANY port in the range
 * is bound. Most range-style forwards (WebRTC) only open sockets on
 * demand, so a "false" doesn't mean broken; the caller decides.
 */
async function probeLxcListening({ lxcName, proto, listenPort, listenPortEnd, execHost = defaultExecHost }) {
  const incusName = lxcName.startsWith(INSTANCE_PREFIX) ? lxcName : `${INSTANCE_PREFIX}${lxcName}`;
  const flag = proto === 'udp' ? '-ulnp' : '-tlnp';
  try {
    const r = await execHost(
      `incus exec ${shellSingleQuote(incusName)} -- ss ${flag} 2>/dev/null`,
      { timeout: 5_000 }
    );
    const out = (r && r.stdout) || '';
    const lines = out.split('\n').filter((l) => l.includes('LISTEN') || (proto === 'udp' && l.includes('UNCONN')));
    const start = listenPort;
    const end = listenPortEnd && listenPortEnd > listenPort ? listenPortEnd : listenPort;
    for (const line of lines) {
      // Match :PORT at end of the local-address column. ss output
      // includes brackets for v6 ([::]:7880) and dotted-quad for v4
      // (0.0.0.0:7880); both end with `:<port>` followed by whitespace.
      const m = line.match(/[:.]([0-9]{1,5})\s/);
      if (!m) continue;
      const p = parseInt(m[1], 10);
      if (p >= start && p <= end) return { listening: true, samplePort: p };
    }
    return { listening: false };
  } catch (err) {
    return { listening: false, error: err.message || String(err) };
  }
}

/**
 * Check whether `service-l4-<forward_id>` is live in nftables. We
 * grep `iptables-save -t filter` because that's the lowest common
 * denominator — works whether the host is iptables-legacy,
 * iptables-nft, or pure nft (which iptables-nft fronts).
 */
async function probeFirewallRule(ruleId, { execHost = defaultExecHost }) {
  try {
    const r = await execHost(
      `iptables-save -t filter 2>/dev/null | grep ${shellSingleQuote(ruleId)} || true`,
      { timeout: 5_000 }
    );
    const out = ((r && r.stdout) || '').trim();
    return { present: out !== '', sample: out.split('\n')[0] || '' };
  } catch (err) {
    return { present: false, error: err.message || String(err) };
  }
}

function summarize(forward, checks) {
  // Walk the checks in dependency order and pick the first one that's
  // failing. The next_step is the operator-facing instruction for it.
  if (!checks.bridgeIp.matches) {
    return {
      ok: false,
      severity: 'error',
      next_step: `LXC's current IP (${checks.bridgeIp.actual || 'unknown'}) doesn't match the forward's connect IP (${checks.bridgeIp.expected}). Click Reconcile to rewrite the proxy device with the live IP.`,
    };
  }
  if (!checks.incusDevice.present) {
    return {
      ok: false,
      severity: 'error',
      next_step: 'Proxy device missing on the LXC. Click Reconcile to recreate it.',
    };
  }
  if (!checks.firewall.present) {
    return {
      ok: false,
      severity: 'error',
      next_step: `Host firewall rule ${checks.firewall.ruleId} not found. Click Reconcile (the rule is paired with the device).`,
    };
  }
  if (!checks.lxcListener.listening) {
    const isRange = forward.listen_port_end && forward.listen_port_end !== forward.listen_port;
    if (isRange && forward.proto === 'udp') {
      // Expected — WebRTC stacks open UDP sockets on demand.
      return {
        ok: true,
        severity: 'info',
        next_step: 'Host-side path looks correct. No process is currently listening on the LXC side, which is normal for WebRTC media (LiveKit allocates UDP sockets when a call starts). If calls still fail, the next layer to check is your cloud-provider security group — it must allow this listen port from the internet.',
      };
    }
    return {
      ok: false,
      severity: 'warn',
      next_step: `Host-side path is correct but nothing inside the LXC is listening on ${forward.proto}/${forward.listen_port}. Start the upstream service in the container.`,
    };
  }
  return {
    ok: true,
    severity: 'info',
    next_step: 'Host-side path verified end-to-end. If calls still fail, the next layer is your cloud-provider security group — it must allow this listen port (UDP and/or TCP) from the internet. ProxyPilot can\'t reach that layer.',
  };
}

/**
 * Diagnose every L4 forward for a service. Pure with respect to the
 * caller — no DB writes, no host mutations.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.serviceId
 * @param {string} opts.lxcName
 * @param {string} opts.bridgeIp                     cached service.target_ip
 * @param {(cmd:string,opts?:object)=>Promise<{stdout:string,stderr:string}>} [opts.execHost]
 */
export async function diagnoseServiceL4Forwards({
  db,
  serviceId,
  lxcName,
  bridgeIp,
  execHost = defaultExecHost,
}) {
  if (!db) throw new Error('diagnoseServiceL4Forwards: db is required');
  if (!serviceId) throw new Error('diagnoseServiceL4Forwards: serviceId is required');
  if (!lxcName) throw new Error('diagnoseServiceL4Forwards: lxcName is required');

  const incusName = lxcName.startsWith(INSTANCE_PREFIX) ? lxcName : `${INSTANCE_PREFIX}${lxcName}`;
  const forwards = db
    .prepare(
      `SELECT id, proto, listen_port, listen_port_end, connect_port, connect_port_end,
              description, enabled
         FROM service_l4_forwards
        WHERE service_id = ? AND enabled = 1`
    )
    .all(serviceId);

  // One incus call to fetch live devices, one to fetch the current IP.
  let liveDevices = [];
  try {
    const r = await execHost(`incus config device show ${shellSingleQuote(incusName)}`, { timeout: 8_000 });
    liveDevices = parseIncusDeviceShow((r && r.stdout) || '');
  } catch {
    liveDevices = [];
  }
  const actualIp = await fetchCurrentBridgeIp(lxcName, { execHost });

  const out = {
    service_id: serviceId,
    lxc_name: lxcName,
    cached_bridge_ip: bridgeIp || null,
    actual_bridge_ip: actualIp,
    forwards: [],
  };

  for (const fw of forwards) {
    const plan = planServiceL4Forward(fw, { bridgeIp: bridgeIp || actualIp || '0.0.0.0', lxcName });
    const liveDev = liveDevices.find((d) => d.name === plan.deviceName);

    const bridgeIpCheck = {
      expected: bridgeIp,
      actual: actualIp,
      matches: !actualIp || !bridgeIp || actualIp === bridgeIp,
    };
    const incusDeviceCheck = {
      present: !!liveDev,
      expected_listen: plan.listen,
      expected_connect: plan.connect,
      actual_listen: liveDev ? liveDev.listen || null : null,
      actual_connect: liveDev ? liveDev.connect || null : null,
      mismatched:
        !!liveDev &&
        ((liveDev.listen && liveDev.listen !== plan.listen) ||
          (liveDev.connect && liveDev.connect !== plan.connect)),
    };
    const lxcListenerCheck = await probeLxcListening({
      lxcName,
      proto: fw.proto,
      listenPort: fw.connect_port,
      listenPortEnd: fw.connect_port_end || fw.connect_port,
      execHost,
    });
    const firewallCheck = await probeFirewallRule(plan.ruleId, { execHost });
    firewallCheck.ruleId = plan.ruleId;

    const checks = {
      bridgeIp: bridgeIpCheck,
      incusDevice: incusDeviceCheck,
      lxcListener: lxcListenerCheck,
      firewall: firewallCheck,
    };
    const summary = summarize(fw, checks);

    out.forwards.push({
      id: fw.id,
      proto: fw.proto,
      listen: fw.listen_port_end ? `${fw.listen_port}-${fw.listen_port_end}` : `${fw.listen_port}`,
      connect: fw.connect_port_end ? `${fw.connect_port}-${fw.connect_port_end}` : `${fw.connect_port}`,
      description: fw.description || null,
      checks,
      ...summary,
    });
  }

  return out;
}
