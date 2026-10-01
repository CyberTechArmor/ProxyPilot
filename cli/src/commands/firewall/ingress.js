import { protectIngress, recordedIngress, bootCheckIngress, removeIngress } from '../../core/firewall/ingress.js';
import * as output from '../../output.js';

export async function ingressProtectCommand(routeId, opts, globalOpts) {
  try {
    const result = await protectIngress({ routeId, container: opts.container, targetIp: opts.targetIp, port: Number(opts.port), expectedUuid: opts.expectedUuid, expectedMac: opts.expectedMac });
    if (globalOpts.json) output.json({ ok: true, ...result });
    else output.success(`Host ingress fence recorded and reconciled for ${routeId}`);
  } catch (error) {
    if (globalOpts.json) output.json({ ok: false, error: error.message });
    else output.error(error.message);
    process.exitCode = 1;
  }
}

export async function ingressShowCommand(routeId, _opts, globalOpts) {
  try {
    const entry = await recordedIngress(routeId);
    if (globalOpts.json) output.json({ entry });
    else if (entry) output.info(JSON.stringify(entry));
    else output.info('No host ingress fence recorded for this route.');
  } catch (error) {
    if (globalOpts.json) output.json({ error: error.message });
    else output.error(error.message);
    process.exitCode = 1;
  }
}

export async function ingressBootCheckCommand(_opts, globalOpts) {
  try {
    const result = await bootCheckIngress();
    if (globalOpts.json) output.json({ ok:true, ...result });
    else output.success(`${result.protected_upstreams} protected upstream fence(s) live before Incus start`);
  } catch (error) {
    if (globalOpts.json) output.json({ ok:false, error:error.message });
    else output.error(error.message);
    process.exitCode = 1;
  }
}

export async function ingressRemoveCommand(routeId, _opts, globalOpts) {
  try {
    const result = await removeIngress(routeId);
    if (globalOpts.json) output.json({ ok:true, ...result });
    else output.success(`Host ingress fence removed for ${routeId}`);
  } catch (error) {
    if (globalOpts.json) output.json({ ok:false, error:error.message });
    else output.error(error.message);
    process.exitCode = 1;
  }
}
