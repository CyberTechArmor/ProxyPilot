import { readState, writeState } from './state.js';
import { reconcile } from './reconcile.js';
import { audit } from '../../db/audit.js';

/**
 * Stop-the-bleeding command for incident response.
 *
 * Flips state.panic_close to true, force-disables every discovered /
 * manual rule, and trims the base allowlist down to SSH (always) and
 * WireGuard (if it's currently enabled — we never re-enable a base
 * entry that was already off, since "panic" should never *increase*
 * exposure). The next discovery cycle still updates last_seen but
 * cannot enable anything because rules added under panic_close land
 * disabled.
 *
 * Followed by a reconcile to apply the locked-down ruleset to the
 * live kernel.
 */
export async function panicClose({ actor } = {}) {
  const state = readState();
  const before = JSON.parse(JSON.stringify(state));
  state.panic_close = true;
  for (const rule of state.base) {
    const keep = rule.id === 'base-ssh' || (rule.id === 'base-wireguard' && rule.enabled);
    rule.enabled = keep;
    if (!keep) {
      rule.disabled_at = new Date().toISOString();
      rule.disabled_by = actor ?? null;
    }
  }
  for (const rule of state.discovered) {
    if (rule.enabled) {
      rule.enabled = false;
      rule.disabled_at = new Date().toISOString();
      rule.disabled_by = actor ?? null;
    }
  }
  writeState(state);
  audit({
    subsystem: 'firewall',
    action: 'panic-close',
    resource: 'inet/proxypilot',
    actor,
    before,
    after: state,
  });
  // Force-lockout-ok: the operator has chosen to drop everything. SSH
  // is still on, so the lockout check should pass anyway.
  return reconcile({ actor, forceLockoutOk: false });
}

/**
 * Clears the panic flag. Does NOT re-enable any rules: those have to
 * be re-toggled explicitly so the operator reviews each one. (This is
 * the intentional asymmetry: easy to lock down, deliberate to reopen.)
 */
export async function panicOpen({ actor } = {}) {
  const state = readState();
  if (!state.panic_close) {
    return { ok: true, alreadyOpen: true };
  }
  const before = JSON.parse(JSON.stringify(state));
  state.panic_close = false;
  writeState(state);
  audit({
    subsystem: 'firewall',
    action: 'panic-open',
    resource: 'inet/proxypilot',
    actor,
    before,
    after: state,
  });
  return reconcile({ actor });
}
