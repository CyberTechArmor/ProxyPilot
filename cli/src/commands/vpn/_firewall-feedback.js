import * as output from '../../output.js';

/**
 * Render the firewall + caddy sub-results returned by every async
 * peer mutation (addPeer, rotatePeer, enablePeer, disablePeer,
 * removePeer, setPeerScope) to the operator's terminal.
 *
 * Neither layer throws on reconcile failure — the SQLite mutation
 * + audit row + wg syncconf are already durable when reconcile
 * runs, so a hard throw would mislead the CLI into reporting the
 * whole peer mutation as failed. We surface warnings inline and
 * report a clearly-tagged warning on hard reconcile failure with
 * the operator's recovery action.
 *
 * Sequencing: firewall first, caddy second — matches the order
 * reconcileAfterPeerMutation() runs them, which is also the order
 * the operator should re-run them manually if the auto-reconcile
 * failed.
 */
export function surfacePeerMutationResult({ firewall, caddy } = {}) {
  if (firewall) {
    for (const w of (firewall.warnings ?? [])) output.warn(w);
    if (!firewall.ok) {
      const reason = firewall.rejection?.reason ?? 'unknown';
      output.warn(
        `firewall reconcile did not complete (${reason}). ` +
        `The peer mutation IS durable — re-run \`proxypilot firewall reconcile\` to converge L4.`,
      );
    }
  }
  if (caddy) {
    for (const w of (caddy.warnings ?? [])) output.warn(w);
    if (!caddy.ok && caddy.reload !== 'skipped') {
      output.warn(
        `caddy reconcile did not complete. The peer mutation IS durable — ` +
        `re-run \`proxypilot route reconcile\` to converge L7.`,
      );
    }
  }
}

