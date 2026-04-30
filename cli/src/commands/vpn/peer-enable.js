import { enablePeer } from '../../core/vpn/index.js';
import { surfaceFirewallResult } from './_firewall-feedback.js';
import * as output from '../../output.js';

export async function peerEnableCommand(name, _opts, globalOpts) {
  try {
    const result = await enablePeer({ name });
    if (globalOpts.json) {
      output.json({
        ok: true,
        name: result.name,
        ip: result.ip,
        already_enabled: !!result.alreadyEnabled,
        firewall: result.firewall ?? null,
      });
      return;
    }
    if (result.alreadyEnabled) {
      output.info(`peer "${name}" was already enabled`);
      return;
    }
    output.success(`peer "${name}" enabled (${result.ip})`);
    surfaceFirewallResult(result.firewall);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn peer enable failed: ${e.message}`);
    process.exitCode = 1;
  }
}
