import { disable } from '../../core/vpn/index.js';
import * as output from '../../output.js';

export async function disableCommand(_opts, globalOpts) {
  try {
    const result = await disable({});
    if (globalOpts.json) {
      output.json({ ok: true, already_disabled: !!result.alreadyDisabled });
      return;
    }
    if (result.alreadyDisabled) {
      output.info('VPN is not enabled — nothing to do');
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
