import { detectBridge } from '../../core/firewall/detect.js';
import { readState, writeState } from '../../core/firewall/state.js';
import * as output from '../../output.js';

/**
 * Auto-detect the host's managed Incus bridge and (with --apply)
 * commit it to firewall.json's `state.network` field. Idempotent —
 * --apply is a no-op when the existing state already matches what
 * detection found, and refuses to overwrite an operator's existing
 * different value unless --force is given.
 *
 * Run from install-firewall.sh on every install / update so a host
 * whose Incus bridge isn't ProxyPilot's `pp-br0` (legacy `incusbr0`
 * installs, operator-renamed bridges) gets the correct network
 * values without anyone editing JSON by hand.
 */
export async function detectBridgeCommand(opts, globalOpts) {
  const detected = detectBridge();
  if (!detected) {
    if (globalOpts.json) {
      output.json({ ok: false, reason: 'no managed Incus bridge detected' });
      // Not a hard failure on fresh installs where Incus may not be
      // up yet — the next install/update run will succeed once it is.
      return;
    }
    output.warn('No managed Incus bridge detected (incus not installed, daemon down, or no bridges).');
    output.info('Skipping. Re-run after `incus admin init` completes.');
    return;
  }

  const state = readState();
  const current = state.network ?? {};
  const wouldChange =
    current.bridge_iface !== detected.iface ||
    current.bridge_cidr  !== detected.cidr  ||
    current.bridge_gw    !== detected.gw;

  const action = !opts.apply
    ? 'preview'
    : !wouldChange
      ? 'unchanged'
      : (current.bridge_iface || current.bridge_cidr || current.bridge_gw) && !opts.force
        ? 'skipped'
        : 'applied';

  if (globalOpts.json) {
    output.json({
      ok: true,
      action,
      detected: {
        bridge_iface: detected.iface,
        bridge_cidr: detected.cidr,
        bridge_gw: detected.gw,
        candidates_count: detected.candidatesCount,
      },
      current: state.network ?? null,
    });
    return;
  }

  if (detected.candidatesCount > 1) {
    output.warn(
      `${detected.candidatesCount} managed Incus bridges found; picked "${detected.iface}" (alphabetical first). ` +
      `If that's wrong, set state.network in /var/lib/proxypilot/firewall.json by hand.`,
    );
  }

  const detectedSummary =
    `iface=${detected.iface}  cidr=${detected.cidr}  gw=${detected.gw}`;

  if (action === 'preview') {
    output.info(`Detected: ${detectedSummary}`);
    if (wouldChange) {
      output.info('Re-run with --apply to commit to firewall.json.');
    } else {
      output.info('firewall.json already matches — nothing to apply.');
    }
    return;
  }

  if (action === 'unchanged') {
    output.success(`Bridge already configured: ${detectedSummary}`);
    return;
  }

  if (action === 'skipped') {
    output.warn(
      `state.network already set to a different value:\n` +
      `  current:  iface=${current.bridge_iface}  cidr=${current.bridge_cidr}  gw=${current.bridge_gw}\n` +
      `  detected: ${detectedSummary}\n` +
      `Re-run with --force to overwrite.`,
    );
    return;
  }

  // action === 'applied'
  state.network = {
    ...(state.network ?? {}),
    bridge_iface: detected.iface,
    bridge_cidr: detected.cidr,
    bridge_gw: detected.gw,
  };
  writeState(state);
  output.success(`Bridge configured in firewall.json: ${detectedSummary}`);
  output.info('Run `proxypilot firewall reconcile` to apply.');
}
