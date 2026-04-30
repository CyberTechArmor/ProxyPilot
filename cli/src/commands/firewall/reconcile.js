import { reconcile } from '../../core/firewall/index.js';
import * as output from '../../output.js';

export async function reconcileCommand(opts, globalOpts) {
  const result = await reconcile({
    dryRun: !!opts.dryRun,
    forceLockoutOk: !!opts.forceLockoutOk,
  });

  if (globalOpts.json) {
    output.json({
      ok: result.ok,
      applied: result.applied,
      dry_run: !!result.dryRun,
      checksum: result.checksum,
      rule_count: result.ruleCount,
      rejection: result.rejection ?? null,
      ruleset: opts.dryRun ? result.ruleset : undefined,
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    output.error(`Reconcile rejected: ${result.rejection?.reason ?? 'unknown'}`);
    if (result.rejection?.rules) {
      for (const r of result.rejection.rules) {
        output.warn(`  ${r.id}: scope=${r.scope}`);
      }
    }
    if (result.rejection?.stderr) {
      console.error(result.rejection.stderr);
    }
    output.info('Re-run with --force-lockout-ok if you really want this.');
    process.exitCode = 1;
    return;
  }

  if (result.dryRun) {
    output.info(`Dry run — ruleset checksum ${result.checksum}, ${result.ruleCount} enabled rule(s)`);
    console.log('');
    console.log(result.ruleset);
    return;
  }

  output.success(`Reconcile applied (${result.ruleCount} enabled rules, ${result.checksum})`);
}
