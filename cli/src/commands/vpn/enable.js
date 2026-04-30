import { enable } from '../../core/vpn/index.js';
import * as output from '../../output.js';

export async function enableCommand(opts, globalOpts) {
  try {
    const result = await enable({
      endpoint: opts.endpoint,
      listenPort: opts.port,
      dns: opts.dns,
    });
    if (globalOpts.json) {
      output.json({
        ok: true,
        endpoint: result.endpoint,
        listen_port: result.listenPort,
        default_iface: result.defaultIface,
        public_key: result.publicKey,
      });
      return;
    }
    output.success(`VPN enabled on ${result.defaultIface} (endpoint ${result.endpoint}, port ${result.listenPort})`);
    output.info(`Server public key: ${result.publicKey}`);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn enable failed: ${e.message}`);
    process.exitCode = 1;
  }
}
