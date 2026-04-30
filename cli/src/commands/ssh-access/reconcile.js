import { reconcile } from '../../core/ssh-access/index.js';
import * as output from '../../output.js';

export async function reconcileCommand(opts, globalOpts) {
  try {
    const result = await reconcile({ dryRun: !!opts.dryRun });

    if (globalOpts.json) {
      output.json({ ok: true, dry_run: !!opts.dryRun, ...result });
      return;
    }

    if (result.users.length === 0) {
      output.info('no unix users have ssh-access entries — nothing to reconcile');
      return;
    }

    const changed = result.users.filter(u => u.changed);
    if (changed.length === 0) {
      output.info(`reconcile no-op: ${result.users.length} user(s) already converged`);
    } else {
      const verb = opts.dryRun ? 'would rewrite' : 'rewrote';
      output.success(`${verb} authorized_keys for ${changed.length} user(s):`);
      for (const u of changed) {
        output.info(`  ${u.user}: ${u.before_count} → ${u.after_count} managed lines  (${u.path})`);
      }
    }
    for (const w of result.warnings) {
      output.warn(`reconcile warning [${w.unix_user}]: ${w.message}`);
    }
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`ssh access reconcile failed: ${e.message}`);
    process.exitCode = 1;
  }
}
