// Mock2 filtering egress proxy (Phase M4, ADR-010 + its complexity guardrail).
//
// The bridge default-deny (firewall.js) blocks a container from reaching the
// internet directly; the ONLY egress path is the host's filtering proxy, which
// the container reaches on its gateway (allowed through the fence). The proxy
// permits CONNECT/GET only to the project's allowlisted hosts (allowlist.js),
// keyed by the project's bridge subnet — one squid listener, source-IP → project
// mapping, since every project has its own /24. TLS is tunnelled via CONNECT,
// never intercepted: squid filters by host/SNI, it does not decrypt (ADR-010).
//
// GUARDRAIL COMPLIANCE (ADR-010, operator: "squid is only fine if it doesn't add
// that much complexity"). The intended weight — one apt package, one service,
// ONE ProxyPilot-generated config file — is met exactly:
//   * one package: squid, installed by scripts/mock2-enable-egress.sh only when
//     Mock2 is enabled (ADR-001);
//   * one service: the stock squid systemd unit;
//   * one generated file: /etc/squid/conf.d/mock2.conf, an ACL-only drop-in
//     (Debian's squid.conf already `include`s conf.d before its default
//     `http_access deny all`, so we add allows and never rewrite squid's config).
// No custom build, no TLS interception, no per-project proxy instance. If a
// future need pushes past this, the fallback is bridge-isolation-only — record
// the dropped allowlist in ADR-010 (that is the guardrail, not a suggestion).
//
// If squid is NOT installed, egress reconcile logs and no-ops — and the bridge
// default-deny still holds, so the failure mode is "no egress" (safe), never
// "unfiltered egress". The proxy is the allow path; the firewall is enforcement.
//
// renderSquidAcl / buildEgressPlan are PURE (unit-tested stub-first, risk R9);
// the write/reload/install-check functions shell to the host (mock2/host.js,
// risk R3).
//
// Terminology (risk R7): nothing here is named "agent".

import { sh, b64 } from './host.js';
import { listProjects } from './projects.js';
import { allAllowlists } from './allowlist.js';
import { buildEgressPlan, renderSquidAcl, EGRESS_PROXY_PORT } from './network-logic.js';

export { EGRESS_PROXY_PORT };

// The stock Debian squid conf.d drop-in dir (squid.conf `include`s it before its
// default `http_access deny all`). One file — mock2.conf — is written here.
// Overridable for non-Debian squid layouts.
const SQUID_CONF_DIR = process.env.MOCK2_EGRESS_PROXY_CONF_DIR || '/etc/squid/conf.d';
const SQUID_CONF_FILE = `${SQUID_CONF_DIR}/mock2.conf`;

// egressProxyInstalled() — is squid on the host? (command -v via the host pivot).
export async function egressProxyInstalled() {
  const r = await sh('command -v squid >/dev/null 2>&1 && echo yes || echo no', { timeoutMs: 8000 });
  return (r.stdout || '').trim() === 'yes';
}

// writeSquidAcl(content) — write the drop-in on the host (base64-streamed so the
// content is shell-safe) and reload squid. Returns { ok, error, installed }.
// Never throws. A missing squid is not an error — it's the documented
// fail-safe: no proxy, and the firewall keeps egress denied.
export async function writeSquidAcl(content) {
  const installed = await egressProxyInstalled();
  if (!installed) {
    return { ok: false, installed: false, error: 'squid not installed (run scripts/mock2-enable-egress.sh)' };
  }
  const write = await sh(
    `mkdir -p ${SQUID_CONF_DIR} && printf '%s' '${b64(content)}' | base64 -d > ${SQUID_CONF_FILE} && chmod 0644 ${SQUID_CONF_FILE}`,
    { timeoutMs: 15000 },
  );
  if (write.code !== 0) {
    return { ok: false, installed: true, error: `${write.stdout || ''}${write.stderr || ''}`.trim().slice(-400) };
  }
  // Reload (reconfigure) so the new ACLs take effect without dropping live
  // connections. Fall back to a systemd reload if `squid -k` isn't on PATH.
  const reload = await sh('squid -k reconfigure 2>&1 || systemctl reload squid 2>&1 || service squid reload 2>&1', { timeoutMs: 20000 });
  if (reload.code !== 0) {
    return { ok: false, installed: true, error: `squid reload failed: ${(reload.stdout || reload.stderr || '').trim().slice(-300)}` };
  }
  return { ok: true, installed: true };
}

// reconcileMock2Egress() — regenerate the squid drop-in from the DB and reload.
// Called at boot and after any change that alters a project's bridge or
// allowlist. Non-fatal. When squid is absent it logs once and returns — the
// fence still denies egress.
export async function reconcileMock2Egress() {
  let projects = [];
  try {
    projects = listProjects();
  } catch (err) {
    console.error('[mock2] egress reconcile: could not read projects:', err?.message);
    return { ok: false, error: err?.message };
  }
  const plan = buildEgressPlan(projects, allAllowlists());
  const content = renderSquidAcl(plan);
  const r = await writeSquidAcl(content);
  if (!r.ok && r.installed === false) {
    console.warn('[mock2] egress reconcile: squid not installed — bridge default-deny still blocks all egress');
  } else if (!r.ok) {
    console.error(`[mock2] egress reconcile: ${r.error}`);
  } else {
    console.log(`[mock2] egress reconcile: allowlist ACLs for ${plan.length} project(s)`);
  }
  return r;
}
