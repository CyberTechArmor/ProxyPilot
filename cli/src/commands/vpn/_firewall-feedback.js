import * as output from '../../output.js';

/**
 * Render the firewall sub-result returned by every async peer
 * mutation (addPeer, rotatePeer, enablePeer, disablePeer,
 * removePeer, setPeerScope) to the operator's terminal.
 *
 * The mutation itself never throws on reconcile failure — SQLite +
 * audit + wg syncconf are durable, so a hard throw would mislead the
 * CLI into reporting the whole peer mutation as failed. We surface
 * warnings inline and report a clearly-tagged warning on hard
 * reconcile failure with the operator's recovery action ("re-run
 * proxypilot firewall reconcile").
 */
export function surfaceFirewallResult(firewall) {
  if (!firewall) return;
  for (const w of (firewall.warnings ?? [])) output.warn(w);
  if (!firewall.ok) {
    const reason = firewall.rejection?.reason ?? 'unknown';
    output.warn(
      `firewall reconcile did not complete (${reason}). ` +
      `The peer mutation IS durable — re-run \`proxypilot firewall reconcile\` to converge L4.`,
    );
  }
}
