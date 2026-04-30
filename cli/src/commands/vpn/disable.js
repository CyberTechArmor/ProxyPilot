import { disable } from '../../core/vpn/index.js';
import * as output from '../../output.js';

export async function disableCommand(_opts, globalOpts) {
  try {
    await disable({});
    if (globalOpts.json) {
      output.json({ ok: true });
      return;
    }
    output.success('VPN disabled (peer records preserved)');
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn disable failed: ${e.message}`);
    process.exitCode = 1;
  }
}
