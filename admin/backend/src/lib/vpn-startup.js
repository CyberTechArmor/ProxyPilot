// Startup-time WG listen-port auto-heal.
//
// Older deployments default to WireGuard's IANA port 51820, which sits
// inside the typical Linux ephemeral port pool (32768-60999) AND
// inside the WebRTC media range (50000-60000) used by ProxyPilot's
// Quick add MEET preset. That collision is the bug we chased through
// `incusd forkproxy` for half a session: the host's L4 forward for
// MEET wants to bind 50000-60000 contiguously, and 51820 is already
// taken by the WG endpoint exposure, so the device add fails with
// "address already in use".
//
// The fix is to keep the WG listen port outside that range. The CLI
// pins safe-range to 49000-49999 (WG_SAFE_PORT_MIN..MAX); this
// startup pass detects existing deployments that booted with 51820
// (or any other unsafe port) and migrates them to the safe-range
// default (49000) the same way the dashboard would — invoking the
// CLI's setListenPort, which atomically rewrites wg0.conf, restarts
// wg-quick@wg0, and reconciles the firewall.
//
// Skipped when:
//   - vpn_config row doesn't exist (VPN never enabled, nothing to heal).
//   - Listen port is already in the safe range (no-op).
//   - The CLI's setListenPort returns an error — logged, not retried,
//     because operator intervention will be needed (e.g. wg0 is in a
//     weird state). Never blocks /api/health.

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { shellSingleQuote } from './shell-quote.js';

const execAsync = promisify(exec);
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';
const PROXYPILOT_BIN = process.env.PROXYPILOT_BIN || '/usr/local/bin/proxypilot';

// Safe range — must match cli/src/core/vpn/server.js. Duplicated
// here rather than imported because the backend container doesn't
// have the CLI source on its module path; the CLI binary is on PATH
// inside the host namespace via nsenter. The constant is small and
// stable enough that the duplication is the cheaper of the two
// options.
const WG_SAFE_PORT_MIN = 49000;
const WG_SAFE_PORT_MAX = 49999;
const WG_SAFE_PORT_DEFAULT = WG_SAFE_PORT_MIN;

async function defaultExecHost(command, { timeout = 30_000 } = {}) {
  if (isInDocker) {
    return execAsync(
      `nsenter -t 1 -m -u -n -i sh -c ${shellSingleQuote(command)}`,
      { timeout, maxBuffer: 4 * 1024 * 1024 }
    );
  }
  return execAsync(command, { timeout, maxBuffer: 4 * 1024 * 1024 });
}

/**
 * Detect-and-migrate the WG listen port if it's outside the safe range.
 * Returns a small summary the caller can log; never throws.
 */
export async function autoHealVpnListenPort({
  db,
  execHost = defaultExecHost,
  log = console.log,
  errLog = console.error,
} = {}) {
  if (!db) return { skipped: 'no db' };

  let row;
  try {
    row = db.prepare(`SELECT id, endpoint, listen_port FROM vpn_config WHERE id = 1`).get();
  } catch (e) {
    // vpn_config table may not exist in very old schemas — treat
    // as "no VPN" rather than failing boot.
    return { skipped: `read vpn_config: ${e.message}` };
  }
  if (!row) return { skipped: 'vpn not enabled' };

  const currentPort = row.listen_port;
  // Also check the firewall state for a drifted base-wireguard rule.
  // The exact failure mode this catches: a previous setListenPort
  // moved listen_port to a safe value but did NOT move the firewall
  // rule's port_start (the bug we fixed). The rule then keeps emitting
  // `udp dport <old-port>` and every WG handshake on the new port is
  // silently dropped at the host edge — VPN never establishes, vpn-only
  // services like SSH-on-22 become unreachable.
  let firewallPort = null;
  try {
    const stateRaw = await execHost('cat /var/lib/proxypilot/firewall.json 2>/dev/null || true', { timeout: 5_000 });
    const stateBody = (stateRaw && stateRaw.stdout) || '';
    if (stateBody.trim()) {
      const state = JSON.parse(stateBody);
      const wgRule = (state.base ?? []).find((r) => r.id === 'base-wireguard');
      if (wgRule && Number.isInteger(wgRule.port_start)) {
        firewallPort = wgRule.port_start;
      }
    }
  } catch {
    // Firewall state unreadable — treat as "no drift detected".
    firewallPort = null;
  }

  const portInSafeRange = currentPort >= WG_SAFE_PORT_MIN && currentPort <= WG_SAFE_PORT_MAX;
  const ruleDrift = firewallPort !== null && firewallPort !== currentPort;

  if (portInSafeRange && !ruleDrift) {
    return { skipped: `already in safe range (${currentPort})`, currentPort };
  }

  // Pick the target. If listen_port is already in the safe range but
  // the firewall rule drifted, realign to the existing port (no need
  // to restart wg-quick); otherwise migrate to the safe-range default.
  const targetPort = portInSafeRange ? currentPort : WG_SAFE_PORT_DEFAULT;

  if (ruleDrift && portInSafeRange) {
    log(
      `[VPN-startup] base-wireguard firewall rule on ${firewallPort} but WG listen port is ` +
      `${currentPort}; realigning rule to ${targetPort}`
    );
  } else {
    log(
      `[VPN-startup] listen port ${currentPort} is outside safe range ` +
      `${WG_SAFE_PORT_MIN}-${WG_SAFE_PORT_MAX}; migrating to ${WG_SAFE_PORT_DEFAULT}`
    );
  }

  const cmd = [
    shellSingleQuote(PROXYPILOT_BIN),
    '--json', 'vpn', 'server', 'set-listen-port',
    '--port', String(targetPort),
  ].join(' ');

  let result;
  try {
    const r = await execHost(cmd, { timeout: 60_000 });
    try {
      result = JSON.parse((r && r.stdout) || '{}');
    } catch {
      // CLI returned non-JSON; surface the raw output.
      errLog(`[VPN-startup] non-JSON CLI output: ${r && r.stdout}`);
      return { migrated: false, error: 'non-JSON CLI output', from: currentPort };
    }
  } catch (e) {
    // Some CLIs return non-zero on error AND write JSON to stdout.
    if (e?.stdout) {
      try {
        const j = JSON.parse(e.stdout);
        if (j && j.ok === false) {
          errLog(`[VPN-startup] migrate failed: ${j.error || 'unknown'}`);
          return { migrated: false, error: j.error || 'unknown', from: currentPort };
        }
      } catch { /* fall through */ }
    }
    const msg = (e && (e.stderr || e.message)) || String(e);
    errLog(`[VPN-startup] migrate threw: ${String(msg).trim()}`);
    return { migrated: false, error: String(msg).trim(), from: currentPort };
  }

  if (result.ok === false) {
    errLog(`[VPN-startup] migrate refused: ${result.error || 'unknown'}`);
    return { migrated: false, error: result.error || 'unknown', from: currentPort };
  }

  log(
    `[VPN-startup] migrated wg0 listen port ${currentPort} -> ${result.listen_port}; ` +
    `endpoint now ${result.endpoint}. Re-distribute peer configs so existing peers reconnect.`
  );
  return {
    migrated: true,
    from: currentPort,
    to: result.listen_port,
    endpoint: result.endpoint,
  };
}
