import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readState } from './state.js';
import { render, checksum } from './render.js';
import { getDb } from '../../db/index.js';
import { audit } from '../../db/audit.js';

/**
 * Sentinel CIDR for "no allowed peers". The original spec assumed
 * `ip saddr { }` (empty inline anonymous set) is valid nft syntax —
 * nft 1.0.9 (Debian Bookworm, the version on every host this ships
 * to today) actually rejects it as a syntax error, which would
 * cascade-fail the whole atomic reconcile and break every OTHER
 * rule with it. Sentinel approach: render the closed rule with a
 * single CIDR that is syntactically valid AND never appears as a
 * legitimate source — 255.255.255.255/32, the limited broadcast
 * address, fits both criteria. The rule stays visible in
 * `nft list table inet proxypilot` so the operator can observe the
 * closed state, and its presence is also noted in the warning the
 * resolver returns.
 */
const NO_ALLOWED_PEERS_SENTINEL = '255.255.255.255/32';

/**
 * Sort an array of /32 strings ("10.100.0.10") by trailing octet so
 * the rendered ruleset is byte-identical for identical peer sets.
 * Matches the IP-pool picker in cli/src/core/vpn/peer.js, which
 * orders the pool by CAST(substr(ip,10) AS INTEGER) for the same
 * reason: deterministic, operator-readable diffs.
 */
function sortIpsByTrailingOctet(ips) {
  return [...ips].sort((a, b) => {
    const ao = Number(a.split('/')[0].split('.')[3]);
    const bo = Number(b.split('/')[0].split('.')[3]);
    return ao - bo;
  });
}

/**
 * Pre-render hook: for every enabled rule with scope="vpn-only",
 * compute the effective source-CIDR list as the union of
 *   - every full or admin peer's /32 (regardless of rule.service), and
 *   - every services-scope peer's /32 whose scope_services_json
 *     includes the rule's service tag (only when rule.service is set).
 *
 * A vpn-only rule with no service tag defaults to "all full+admin
 * peers, no services peers" — implementing the spec sentence "Other
 * vpn-only rules deny this peer's /32" for services-scope peers.
 *
 * The rendered rule's source_cidrs is materialized in-place; the
 * renderer is pure and already honors source_cidrs over scope, so
 * this function is the only mutation point. An explicit empty source
 * set is allowed (rule renders with `ip saddr { }` and effectively
 * blocks everyone) — the alternative (silently dropping the rule)
 * would hide the operator's intent. A warning is logged so the
 * operator notices that the rule is closed but present.
 *
 * Pure on input: state is mutated in place but reconcile is the
 * single L4 writer, and writeState() is not called here, so this
 * never persists the resolved /32 list to firewall.json. firewall.json
 * keeps `scope: "vpn-only"` as the durable form; resolveVpnSources()
 * recomputes the inline /32 set on every reconcile.
 */
export function resolveVpnSources(state) {
  const db = getDb();
  const peers = db.prepare(`
    SELECT name, allowed_ip, scope, scope_services_json
    FROM vpn_peers
    WHERE status = 'enabled'
  `).all();

  const fullAdminCidrs = peers
    .filter(p => p.scope === 'full' || p.scope === 'admin')
    .map(p => `${p.allowed_ip}/32`);

  const servicePeers = peers
    .filter(p => p.scope === 'services')
    .map(p => ({
      cidr: `${p.allowed_ip}/32`,
      services: p.scope_services_json ? JSON.parse(p.scope_services_json) : [],
    }));

  const warnings = [];
  const rules = [...(state.base ?? []), ...(state.discovered ?? [])];
  for (const rule of rules) {
    if (!rule.enabled || rule.scope !== 'vpn-only') continue;

    // Operator-supplied explicit source_cidrs override the join.
    // This preserves the existing `firewall enable --source-cidr`
    // escape hatch — useful e.g. for a single-/32 lock-down that
    // shouldn't widen as new admin peers are added.
    if (rule.source_cidrs && rule.source_cidrs.length > 0) continue;

    const allowed = new Set(fullAdminCidrs);
    if (rule.service) {
      for (const sp of servicePeers) {
        if (sp.services.includes(rule.service)) allowed.add(sp.cidr);
      }
    }

    const sorted = sortIpsByTrailingOctet([...allowed]);
    if (sorted.length === 0) {
      // Render with sentinel rather than the empty array. See the
      // NO_ALLOWED_PEERS_SENTINEL comment for why nft rejects literal
      // empty inline sets and how the broadcast sentinel preserves
      // operational closed-ness while keeping the rule visible.
      rule.source_cidrs = [NO_ALLOWED_PEERS_SENTINEL];
      warnings.push(
        `vpn-only rule "${rule.id}"${rule.service ? ` (service=${rule.service})` : ''} has no allowed peers — rule rendered with broadcast sentinel and is effectively closed`,
      );
    } else {
      rule.source_cidrs = sorted;
    }
  }

  return { warnings };
}

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
 * Apply a ruleset by writing to a temp file and invoking `nft -f <path>`.
 * Some nft builds reject `-f -` ("Not a regular file") even when piped
 * via stdin. The temp file is created in /run with mode 0600 and removed
 * after apply succeeds or fails. nft's own transaction semantics still
 * give us atomicity: the whole file is parsed and committed in one go.
 */
function applyRuleset(ruleset) {
  const dir = fs.existsSync('/run') ? '/run/proxypilot' : os.tmpdir();
  if (dir === '/run/proxypilot') {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = path.join(dir, `firewall-${process.pid}-${Date.now()}.nft`);
  fs.writeFileSync(tmp, ruleset, { mode: 0o600 });
  try {
    return spawnSync('nft', ['-f', tmp], { encoding: 'utf-8' });
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
  }
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
  // Pre-render hook: materialize per-/32 source sets for every enabled
  // vpn-only rule from vpn_peers + scope_services_json. The renderer
  // honors source_cidrs over scope, so this function is the only entry
  // point that joins peer-scope state into rule-scope state. Mutates
  // `state` in memory only — firewall.json is not rewritten.
  const { warnings: vpnWarnings } = resolveVpnSources(state);
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
    return { ok: true, applied: false, dryRun: true, ruleset, checksum: sum, ruleCount, warnings: vpnWarnings };
  }

  const apply = applyRuleset(ruleset);
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

  return { ok: true, applied: true, ruleset, checksum: sum, ruleCount, warnings: vpnWarnings };
}

function recordReconcile({ checksum, ruleCount, applied, rejection, actor }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO firewall_reconciles (ruleset_checksum, rule_count, applied, rejection_reason, reconciled_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(checksum, ruleCount, applied, rejection ?? null, actor ?? null);
}
