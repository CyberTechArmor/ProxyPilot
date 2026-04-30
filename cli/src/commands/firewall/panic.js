import { panicClose, panicOpen } from '../../core/firewall/panic.js';
import * as output from '../../output.js';

export async function panicCloseCommand(opts, globalOpts) {
  if (!opts.yes && !globalOpts.json) {
    const ok = await output.confirm(
      'Drop every discovered firewall rule and reduce base to SSH (+ WireGuard if on)?',
    );
    if (!ok) {
      output.info('Aborted.');
      return;
    }
  }
  let result;
  try { result = await panicClose({}); }
  catch (err) { output.error(err.message); process.exitCode = 1; return; }

  if (globalOpts.json) {
    output.json({ ok: result.ok, applied: result.applied, checksum: result.checksum, rule_count: result.ruleCount });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (result.ok && result.applied) {
    output.success(`Panic-close applied (${result.ruleCount} rules, ${result.checksum})`);
  } else {
    output.error(`Panic-close reconcile rejected: ${result.rejection?.reason ?? 'unknown'}`);
    process.exitCode = 1;
  }
}

export async function panicOpenCommand(opts, globalOpts) {
  let result;
  try { result = await panicOpen({}); }
  catch (err) { output.error(err.message); process.exitCode = 1; return; }

  if (globalOpts.json) {
    output.json(result);
    return;
  }
  if (result.alreadyOpen) {
    output.info('Firewall is not in panic-close.');
    return;
  }
  if (result.ok && result.applied) {
    output.success(`Panic flag cleared (${result.ruleCount} rules, ${result.checksum})`);
    output.info('Note: previously enabled rules were NOT auto-restored. Re-toggle them explicitly.');
  } else {
    output.warn(`Panic flag cleared but reconcile reported: ${JSON.stringify(result.rejection ?? result)}`);
  }
}
