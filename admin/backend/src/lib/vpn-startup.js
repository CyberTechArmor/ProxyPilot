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
// (or any other unsafe port) AND deployments where the listen port
// is in the safe range but the base-wireguard firewall rule's
// port_start drifted (a previous-version setListenPort updated wg0
// without updating nft — handshakes then get silently dropped).
//
// All state is read via `proxypilot --json vpn status` — the CLI's
// SQLite DB is the authoritative source for vpn_config and the
// firewall.json state. The backend has its own DB at
// /data/db/proxypilot.db that does NOT contain vpn_config; reading
// from the wrong DB was the bug that produced
// `[VPN-startup] skipped: read vpn_config: no such table`.

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
// inside the host namespace via nsenter.
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

// Run a `proxypilot --json` subcommand on the host and parse the
// JSON envelope. The CLI writes `{ok:false, error}` to stdout on
// recoverable failures (and exits non-zero); execHost throws in that
// case but still leaves the JSON in err.stdout. Returns the parsed
// payload either way; callers check `.ok`.
async function callProxypilot(args, { execHost = defaultExecHost, timeout = 60_000 } = {}) {
  const cmd = [
    shellSingleQuote(PROXYPILOT_BIN),
    '--json',
    ...args.map(shellSingleQuote),
  ].join(' ');
  try {
    const r = await execHost(cmd, { timeout });
    const out = (r && r.stdout) || '';
    if (!out.trim()) return { ok: false, error: 'empty CLI output' };
    return JSON.parse(out);
  } catch (e) {
    if (e?.stdout) {
      try { return JSON.parse(e.stdout); } catch { /* fall through */ }
    }
    const msg = (e && (e.stderr || e.message)) || String(e);
    return { ok: false, error: String(msg).trim() };
  }
}

/**
 * Detect-and-migrate the WG listen port if it's outside the safe range,
 * or if the base-wireguard firewall rule drifted from the listen port.
 * Returns a small summary the caller can log; never throws.
 *
 * Resolution paths, in order:
 *   - vpn not enabled (no cfg)                → skipped
 *   - listen_port in safe range AND rule aligned → skipped
 *   - listen_port in safe range, rule drifted    → realign rule
 *   - listen_port outside safe range             → migrate to default
 */
export async function autoHealVpnListenPort({
  execHost = defaultExecHost,
  log = console.log,
  errLog = console.error,
} = {}) {
  const status = await callProxypilot(['vpn', 'status'], { execHost });
  if (status.ok === false) {
    return { skipped: `vpn status failed: ${status.error}` };
  }
  if (!status.enabled) {
    return { skipped: 'vpn not enabled' };
  }

  const currentPort = Number(status.listen_port);
  if (!Number.isInteger(currentPort)) {
    return { skipped: `vpn status returned non-integer listen_port: ${status.listen_port}` };
  }

  const rulePort = status.base_wireguard_rule && Number.isInteger(status.base_wireguard_rule.port_start)
    ? status.base_wireguard_rule.port_start
    : null;

  const portInSafeRange = currentPort >= WG_SAFE_PORT_MIN && currentPort <= WG_SAFE_PORT_MAX;
  const ruleDrift = rulePort !== null && rulePort !== currentPort;

  if (portInSafeRange && !ruleDrift) {
    return { skipped: `already in safe range (${currentPort}) and rule aligned`, currentPort };
  }

  // Pick the target. If listen_port is already in the safe range but
  // the firewall rule drifted, realign to the existing port (no need
  // to restart wg-quick); otherwise migrate to the safe-range default.
  const targetPort = portInSafeRange ? currentPort : WG_SAFE_PORT_DEFAULT;

  if (ruleDrift && portInSafeRange) {
    log(
      `[VPN-startup] base-wireguard firewall rule on ${rulePort} but WG listen port is ` +
      `${currentPort}; realigning rule to ${targetPort}`
    );
  } else {
    log(
      `[VPN-startup] listen port ${currentPort} is outside safe range ` +
      `${WG_SAFE_PORT_MIN}-${WG_SAFE_PORT_MAX}; migrating to ${WG_SAFE_PORT_DEFAULT}`
    );
  }

  const result = await callProxypilot(
    ['vpn', 'server', 'set-listen-port', '--port', String(targetPort)],
    { execHost }
  );
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
    realigned: !!result.realigned,
  };
}
