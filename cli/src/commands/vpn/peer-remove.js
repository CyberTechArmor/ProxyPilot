import { removePeer } from '../../core/vpn/index.js';
import { surfaceFirewallResult } from './_firewall-feedback.js';
import * as output from '../../output.js';

const PHRASE_LAST = 'I understand this locks everyone out';
const PHRASE_ACTIVE = 'remove this active peer';

/**
 * Hard-remove a peer. Two lockout-class gates apply:
 *  - LAST_ENABLED_PEER — same semantics as peer disable.
 *  - RECENTLY_ACTIVE   — peer handshook in the last 24h. Operators
 *    don't usually want to evict someone mid-session by accident.
 * Both gates require --force AND a typed phrase. JSON mode refuses to
 * proceed past either gate (no way to type without a TTY).
 */
export async function peerRemoveCommand(name, opts, globalOpts) {
  try {
    let result;
    try {
      result = await removePeer({ name, force: false });
    } catch (e) {
      if (e.code !== 'LAST_ENABLED_PEER' && e.code !== 'RECENTLY_ACTIVE') throw e;
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
        output.json({ ok: false, error: e.message, code: e.code, requires_typed_confirm: true });
        process.exitCode = 1;
        return;
      }
      const phrase = e.code === 'LAST_ENABLED_PEER' ? PHRASE_LAST : PHRASE_ACTIVE;
      const banner = e.code === 'LAST_ENABLED_PEER'
        ? `Removing "${name}" would leave zero enabled peers — every VPN user is locked out.`
        : `Peer "${name}" handshook within the last 24h — removing will evict them mid-session.`;
      const ok = await output.confirmTyped(banner, phrase);
      if (!ok) {
        output.error('typed confirmation did not match — aborting');
        process.exitCode = 1;
        return;
      }
      result = await removePeer({ name, force: true });
    }
    if (globalOpts.json) {
      output.json({
        ok: true,
        name: result.name,
        ip: result.ip,
        firewall: result.firewall ?? null,
      });
      return;
    }
    output.success(`peer "${name}" removed (ip ${result.ip} returned to pool)`);
    surfaceFirewallResult(result.firewall);
  } catch (e) {
    if (globalOpts.json) {
      output.json({ ok: false, error: e.message, code: e.code ?? null });
      process.exitCode = 1;
      return;
    }
    output.error(`vpn peer remove failed: ${e.message}`);
    process.exitCode = 1;
  }
}
