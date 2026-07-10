// Mock2 network fence — the nftables default-deny in front of every per-project
// bridge (Phase M4, ADR-010; risk R2).
//
// WHY A DEDICATED `table inet mock2` (and not `table inet proxypilot`).
// ADR-010's letter said "extend the container_egress chain rather than invent a
// second table." Building M4 against the actual running code changed that call,
// and it is recorded here (and in 02-adrs.md's ADR-010 implementation note):
//   * The running backend does not manage nftables directly — it shells to the
//     CLI binary (routes/firewall.js → `proxypilot firewall …`), and the CLI's
//     renderer emits `flush table inet proxypilot` on EVERY reconcile
//     (cli/src/core/firewall/render.js). Anything Mock2 added to that table
//     would be wiped the next time the operator toggled a firewall rule.
//   * The CLI firewall may not be installed at all on a given host — the
//     backend is the product; the CLI is the "largely-planned core" layer
//     (survey §13). A Mock2 fence cannot depend on it.
//   * ADR-001 wants a disabled host byte-for-byte unchanged. A dedicated table
//     is trivially absent — this module is never imported on a disabled host,
//     so `table inet mock2` never exists there. Extending a shared table cannot
//     make that guarantee.
//   * nftables `drop` is FINAL across tables: a drop in our chain wins even when
//     Incus's or Docker's own tables ACCEPT the same packet, so a separate
//     table is no weaker for the deny half (the security-critical half).
// The residual question — how our ALLOW rules (DNS/proxy to the gateway)
// interact with the CLI firewall's input policy-drop when BOTH are active — is
// exactly the host matrix R2 demanded be tested on real hardware, and is a step
// in scripts/mock2-m4-verify.sh, not something to reason out from docs.
//
// The rendered ruleset is deterministic from the project rows (the l4-reconciler
// discipline: the DB is authoritative, we render from scratch every reconcile).
// State — the plan we applied — is persisted to MOCK2_DATA_DIR/firewall.json
// (Mock2's OWN state file, next to its repos; the CLI owns the separate
// /var/lib/proxypilot/firewall.json and we never touch it). Reconciled at boot.
//
// renderMock2Nft is PURE (unit-tested stub-first, risk R9). The apply/reconcile
// functions shell to the host through the shared nsenter-aware runner
// (mock2/host.js, risk R3).
//
// Terminology (risk R7): nothing here is named "agent".

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { sh, runHost } from './host.js';
import { listProjects } from './projects.js';
import { buildFenceEntries, renderMock2Nft, EGRESS_PROXY_PORT } from './network-logic.js';

export const MOCK2_DATA_DIR = process.env.MOCK2_DATA_DIR || '/var/lib/proxypilot/mock2';
const FIREWALL_STATE_FILE = `${MOCK2_DATA_DIR}/firewall.json`;
const TABLE = 'mock2';

function writeState(state) {
  try {
    const dir = dirname(FIREWALL_STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(FIREWALL_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[mock2] firewall: could not write state file:', err?.message);
  }
}

export function readFirewallState() {
  try {
    if (!existsSync(FIREWALL_STATE_FILE)) return null;
    return JSON.parse(readFileSync(FIREWALL_STATE_FILE, 'utf8'));
  } catch { return null; }
}

// applyMock2Nft(ruleset) — feed the ruleset to `nft -f -` on the host. Returns
// { ok, error }. Never throws. When there are zero entries we DELETE the table
// entirely rather than leaving an empty one, so an enabled-but-idle host has no
// Mock2 nftables state (absence-consistent).
export async function applyMock2Nft(ruleset, { hasEntries = true } = {}) {
  if (!hasEntries) {
    const del = await sh(`nft delete table inet ${TABLE} 2>/dev/null || true`, { timeoutMs: 15000 });
    return { ok: del.code === 0 || true };
  }
  const r = await runHost('nft', ['-f', '-'], { input: ruleset, timeoutMs: 20000 });
  if (r.code === 0) return { ok: true };
  return { ok: false, error: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-500) };
}

// reconcileMock2Firewall() — the DB-authoritative reconcile. Renders the fence
// for every active project and applies it. Called at boot (index.js) and after
// any change that alters the plan (provision, wake, archive, delete, idle-stop).
// Non-fatal: a failure logs and leaves the running ruleset alone.
export async function reconcileMock2Firewall() {
  let projects = [];
  try {
    projects = listProjects();
  } catch (err) {
    console.error('[mock2] firewall reconcile: could not read projects:', err?.message);
    return { ok: false, error: err?.message };
  }
  const entries = buildFenceEntries(projects);
  const ruleset = renderMock2Nft(entries);
  const applied = await applyMock2Nft(ruleset, { hasEntries: entries.length > 0 });
  writeState({
    updated_at: new Date().toISOString(),
    proxy_port: EGRESS_PROXY_PORT,
    entries,
    applied_ok: applied.ok,
    error: applied.error || null,
  });
  if (!applied.ok) {
    console.error(`[mock2] firewall reconcile: nft apply failed: ${applied.error}`);
  } else {
    console.log(`[mock2] firewall reconcile: ${entries.length} project bridge(s) fenced`);
  }
  return { ok: applied.ok, entries: entries.length, error: applied.error || null };
}
