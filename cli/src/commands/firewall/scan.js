import { scan } from '../../core/firewall/index.js';
import * as output from '../../output.js';

export async function scanCommand(opts, globalOpts) {
  let result;
  try {
    result = scan();
  } catch (err) {
    output.error(`Scan failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (globalOpts.json) {
    output.json(result);
    return;
  }

  output.success(`Scan complete: added=${result.added} refreshed=${result.refreshed} gc=${result.gc}`);
  if (result.added > 0) {
    output.info('New entries are disabled by default. Review with: proxypilot firewall list --needs-review');
  }
}
