import { spawnSync } from 'node:child_process';
import { readState } from './state.js';
import { render, checksum } from './render.js';
import { getDb } from '../../db/index.js';
import { audit } from '../../db/audit.js';

/**
 * Lockout safety: at least one enabled rule must allow inbound TCP 22
 * from a source the operator could plausibly reach. We treat `public`,
 * `lan-only`, and any explicit `source_cidrs` as plausibly reachable;
 * `localhost-only` is not. This catches the common foot-gun of toggling
 * 22/tcp's scope to vpn-only before the VPN is actually working.
 */
export function lockoutCheck(state) {
  const sshRules = [...state.base, ...state.discovered].filter(
    r => r.enabled && r.proto === 'tcp' && r.port_start <= 22 && (r.port_end ?? r.port_start) >= 22,
  );
  if (sshRules.length === 0) {
    return { ok: false, reason: 'no enabled TCP rule covers port 22' };
  }
  const reachable = sshRules.some(r => {
    if (r.source_cidrs && r.source_cidrs.length > 0) return true;
    return r.scope === 'public' || r.scope === 'lan-only' || r.scope === 'vpn-only';
  });
  if (!reachable) {
    return {
      ok: false,
      reason: 'every SSH rule is localhost-only — this would lock out remote access',
      rules: sshRules.map(r => ({ id: r.id, scope: r.scope })),
    };
  }
  return { ok: true };
}

function nft(args, input) {
  return spawnSync('nft', args, { input, encoding: 'utf-8' });
}

/**
 * Reconcile state → live nftables. Runs lockout check first, then
 * applies the full ruleset atomically with `nft -f -`. nft transactions
 * are atomic: if any rule in the file is invalid, none are applied, and
 * the previous ruleset stays live. On success, verify by listing the
 * table and record the apply in firewall_reconciles + audit_log.
 */
export async function reconcile({ dryRun = false, forceLockoutOk = false, actor } = {}) {
  const state = readState();
  const ruleset = render(state);
  const sum = checksum(ruleset);
  const ruleCount =
    state.base.filter(r => r.enabled).length +
    state.discovered.filter(r => r.enabled).length;

  const safety = lockoutCheck(state);
  if (!safety.ok && !forceLockoutOk) {
    recordReconcile({ checksum: sum, ruleCount, applied: 0, rejection: safety.reason, actor });
    return { ok: false, applied: false, ruleset, checksum: sum, ruleCount, rejection: safety };
  }

  if (dryRun) {
    return { ok: true, applied: false, dryRun: true, ruleset, checksum: sum, ruleCount };
  }

  const apply = nft(['-f', '-'], ruleset);
  if (apply.status !== 0) {
    recordReconcile({
      checksum: sum,
      ruleCount,
      applied: 0,
      rejection: `nft apply failed: ${apply.stderr.trim() || apply.error?.message || 'unknown error'}`,
      actor,
    });
    return {
      ok: false,
      applied: false,
      ruleset,
      checksum: sum,
      ruleCount,
      rejection: { reason: 'nft apply failed', stderr: apply.stderr },
    };
  }

  const verify = nft(['list', 'table', 'inet', 'proxypilot']);
  if (verify.status !== 0) {
    recordReconcile({
      checksum: sum,
      ruleCount,
      applied: 0,
      rejection: `verify failed: ${verify.stderr.trim()}`,
      actor,
    });
    return {
      ok: false,
      applied: false,
      ruleset,
      checksum: sum,
      ruleCount,
      rejection: { reason: 'verify failed', stderr: verify.stderr },
    };
  }

  recordReconcile({ checksum: sum, ruleCount, applied: 1, actor });
  audit({
    subsystem: 'firewall',
    action: 'reconcile',
    resource: 'inet/proxypilot',
    actor,
    after: { checksum: sum, rule_count: ruleCount, panic_close: state.panic_close },
  });

  return { ok: true, applied: true, ruleset, checksum: sum, ruleCount };
}

function recordReconcile({ checksum, ruleCount, applied, rejection, actor }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO firewall_reconciles (ruleset_checksum, rule_count, applied, rejection_reason, reconciled_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(checksum, ruleCount, applied, rejection ?? null, actor ?? null);
}
