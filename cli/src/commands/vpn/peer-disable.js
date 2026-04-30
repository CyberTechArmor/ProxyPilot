import { disablePeer } from '../../core/vpn/index.js';
import * as output from '../../output.js';

const TYPED_PHRASE = 'I understand this locks everyone out';

/**
 * Disable a peer. If it's the only enabled peer, the core throws
 * LAST_ENABLED_PEER unless --force is passed. --force alone is not
 * enough — the operator must also type the confirmation phrase. Run
 * the unforced call first so the gate fires whether or not --force
 * was set; the typed prompt only happens when --force is present.
 */
export async function peerDisableCommand(name, opts, globalOpts) {
  try {
    let result;
    try {
      result = disablePeer({ name, force: false });
    } catch (e) {
      if (e.code !== 'LAST_ENABLED_PEER') throw e;
      if (!opts.force) {
        if (globalOpts.json) {
          output.json({ ok: false, error: e.message, code: e.code });
          process.exitCode = 1;
          return;
        }
        output.error(e.message);
        process.exitCode = 1;
        return;
      }
      if (globalOpts.json) {
        // No interactive prompt over JSON — refuse and tell the caller
        // to re-run interactively. We do not want a script to bypass
        // the gate just by sending --json.
        output.json({ ok: false, error: e.message, code: e.code, requires_typed_confirm: true });
        process.exitCode = 1;
        return;
      }
      const ok = await output.confirmTyped(
        `Disabling "${name}" would leave zero enabled peers — every VPN user is locked out.`,
        TYPED_PHRASE,
      );
      if (!ok) {
        output.error('typed confirmation did not match — aborting');
        process.exitCode = 1;
        return;
      }
      result = disablePeer({ name, force: true });
    }
    if (globalOpts.json) {
      output.json({
        ok: true,
        name: result.name,
        ip: result.ip,
        already_disabled: !!result.alreadyDisabled,
      });
      return;
    }
    if (result.alreadyDisabled) {
      output.info(`peer "${name}" was already disabled`);
      return;
    }
    output.success(`peer "${name}" disabled (record + IP allocation preserved)`);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message, code: e.code ?? null });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn peer disable failed: ${e.message}`);
    process.exitCode = 1;
  }
}
