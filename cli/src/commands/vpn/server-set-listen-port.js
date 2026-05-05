import { setListenPort, WG_SAFE_PORT_MIN, WG_SAFE_PORT_MAX } from '../../core/vpn/index.js';
import * as output from '../../output.js';

// `vpn server set-listen-port --port N` — change the WireGuard listen
// port in place. Pinned to the safe range (49000-49999); the dashboard
// uses this same code path so it's the one place to maintain the
// migrate-on-port-change ordering (write config → restart wg-quick →
// reconcile firewall → audit). See core/vpn/server.js setListenPort
// for the full ordering rationale.
export async function serverSetListenPortCommand(opts, globalOpts) {
  try {
    const result = await setListenPort({ port: opts.port });
    if (globalOpts.json) {
      output.json({
        ok: true,
        listen_port: result.listen_port,
        endpoint: result.endpoint,
        unchanged: !!result.unchanged,
      });
      return;
    }
    if (result.unchanged) {
      output.info(`VPN listen port already ${result.listen_port}/udp; no change`);
      return;
    }
    output.success(
      `VPN listen port changed to ${result.listen_port}/udp (endpoint ${result.endpoint}). ` +
      `Re-distribute peer configs so existing peers know the new endpoint.`
    );
  } catch (e) {
    if (globalOpts.json) {
      output.json({
        ok: false,
        error: e.message,
        safe_range: { min: WG_SAFE_PORT_MIN, max: WG_SAFE_PORT_MAX },
      });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn server set-listen-port failed: ${e.message}`);
    process.exitCode = 1;
  }
}
