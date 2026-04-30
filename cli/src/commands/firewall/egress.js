import { allowEgress, denyEgress, listEgress } from '../../core/firewall/egress.js';
import { reconcile } from '../../core/firewall/index.js';
import { NAMED_SERVICES } from '../../core/firewall/render.js';
import * as output from '../../output.js';

async function reconcileAfter(action, payload, globalOpts) {
  const rec = await reconcile({});
  if (globalOpts.json) {
    output.json({ action, payload, reconcile: { applied: rec.applied, checksum: rec.checksum, rejection: rec.rejection ?? null } });
    if (!rec.ok) process.exitCode = 1;
    return;
  }
  if (rec.ok && rec.applied) {
    output.success(`${action} → reconciled (${rec.ruleCount} rules, ${rec.checksum})`);
  } else {
    output.error(`Reconcile rejected: ${rec.rejection?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}

export async function egressAllowCommand(container, service, opts, globalOpts) {
  let entry;
  try {
    entry = allowEgress({
      container,
      service,
      reason: opts.reason ?? null,
      containerIp: opts.containerIp ?? null,
    });
  } catch (err) {
    output.error(err.message);
    process.exitCode = 1;
    return;
  }
  await reconcileAfter('egress-allow', entry, globalOpts);
}

export async function egressDenyCommand(container, service, opts, globalOpts) {
  const r = denyEgress({ container, service });
  if (!r.ok) {
    output.error(r.reason);
    process.exitCode = 1;
    return;
  }
  await reconcileAfter('egress-deny', { container, service }, globalOpts);
}

export async function egressListCommand(opts, globalOpts) {
  const entries = listEgress();
  if (globalOpts.json) {
    output.json({
      services: NAMED_SERVICES,
      entries,
    });
    return;
  }
  if (entries.length === 0) {
    output.info('No container-egress allow rules. Default-deny applies to all bridge → host flows.');
    output.info('Known services: ' + Object.keys(NAMED_SERVICES).join(', '));
    return;
  }
  const headers = ['container', 'allow', 'reason', 'container_ip'];
  const rows = entries.map(e => [
    e.container,
    e.allow.join(','),
    e.reason ?? '-',
    e.container_ip ?? '(bridge cidr)',
  ]);
  output.table(headers, rows);
}
