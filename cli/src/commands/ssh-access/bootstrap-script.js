import { renderBootstrapScript } from '../../core/ssh-access/index.js';
import * as output from '../../output.js';

/**
 * Print the bootstrap shell snippet to stdout. The operator copies it
 * to the new device and runs it there. The server side performs no
 * write — same trust model as ssh-copy-id.
 */
export async function bootstrapScriptCommand(id, opts, globalOpts) {
  try {
    const script = renderBootstrapScript({
      id,
      user: opts.user ?? '<unix-user>',
      server: opts.server ?? '<server>',
      shell: opts.shell ?? 'bash',
    });
    if (globalOpts.json) {
      output.json({ ok: true, id, shell: opts.shell ?? 'bash', script });
      return;
    }
    process.stdout.write(script);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message });
      process.exitCode = 1;
      return;
    }
    output.error(`ssh access bootstrap-script failed: ${e.message}`);
    process.exitCode = 1;
  }
}
