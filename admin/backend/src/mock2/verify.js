// Mock2 parent-domain verification pipeline (Phase M1, ADR-009).
//
// Two stages, gated in order:
//   1. Wildcard DNS — a random label under the parent domain must resolve to
//      this host (proves `*.<domain>` is pointed here before we ask ACME for
//      anything and risk a Let's Encrypt rate-limit hit on a misconfigured
//      domain).
//   2. Probe certificate — write a canary FQDN block into the domain's own
//      Mock2 Caddy site file, reload, and confirm the canary serves a
//      publicly-trusted cert (proves HTTP-01 works end to end). The canary
//      block is then removed and the file returns to its steady state.
//
// This module is the IMPURE orchestrator: it does real DNS and HTTPS and
// drives the Caddy writers. It is deliberately decoupled from the DB and the
// notification store — the caller passes a `hooks` object (progress/fail/
// succeed) and may inject `deps` to override DNS/HTTPS/Caddy for tests. It
// therefore imports nothing native (no better-sqlite3), so it never worsens
// the fresh-checkout test gap even if a future test imports it.

import { randomBytes } from 'crypto';
import dns from 'dns/promises';
import https from 'https';
import {
  canaryLabel,
  evaluateWildcardDns,
  classifyProbe,
  parseHostIps,
} from './domain-logic.js';
import {
  writeMock2DomainSite,
  reloadMock2Caddy,
  buildMock2SiteBlock,
} from './caddy.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// This host's public IP(s), used to cross-check the wildcard DNS answer.
// MOCK2_PUBLIC_IP (comma-separated) is the explicit operator override; with
// nothing set we return [] and evaluateWildcardDns downgrades to "resolves but
// not cross-checked" rather than blocking (ADR-009's pragmatic v1 stance).
function defaultExpectedHostIps() {
  return parseHostIps(process.env.MOCK2_PUBLIC_IP);
}

// Resolve A (and AAAA) records for a hostname; empty array on NXDOMAIN or any
// resolver error (the caller treats "did not resolve" as the failure).
async function defaultResolve(hostname) {
  const out = [];
  try {
    out.push(...(await dns.resolve4(hostname)));
  } catch { /* no A record */ }
  try {
    out.push(...(await dns.resolve6(hostname)));
  } catch { /* no AAAA record */ }
  return out;
}

// Fetch https://<fqdn>/robots.txt and report the HTTP status and whether the
// presented certificate chain was publicly trusted. rejectUnauthorized:false
// lets us READ `socket.authorized` ourselves — an untrusted cert (Caddy's
// internal CA, i.e. ACME hasn't completed) comes back authorized=false rather
// than throwing, which is exactly the signal classifyProbe needs.
function defaultProbe(fqdn, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = https.request(
      {
        host: fqdn,
        servername: fqdn,
        port: 443,
        path: '/robots.txt',
        method: 'GET',
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        const authorized = !!(res.socket && res.socket.authorized);
        res.resume();
        res.on('end', () => finish({ status: res.statusCode || 0, tlsAuthorized: authorized, error: null }));
      },
    );
    req.on('timeout', () => { req.destroy(); finish({ status: 0, tlsAuthorized: false, error: 'timeout' }); });
    req.on('error', (err) => finish({ status: 0, tlsAuthorized: false, error: err.message }));
    req.end();
  });
}

// runVerification — drive both stages for one parent domain.
//
// domain:  the bare parent domain string (already validated).
// hooks:   { progress(status), fail(reason), succeed() } — the caller wires
//          these to the DB row + notification/queue store.
// deps:    optional overrides { resolve, expectedHostIps, probe, writeSite,
//          reload, randHex, log, probeAttempts, probeDelayMs }.
//
// Returns the final verify_status ('cert_ok' | 'failed'). Never throws — every
// failure path lands on hooks.fail and returns 'failed'.
export async function runVerification(domain, hooks = {}, deps = {}) {
  const {
    resolve = defaultResolve,
    expectedHostIps = defaultExpectedHostIps,
    probe = defaultProbe,
    writeSite = writeMock2DomainSite,
    reload = reloadMock2Caddy,
    randHex = () => randomBytes(6).toString('hex'),
    log = () => {},
    probeAttempts = 12,
    probeDelayMs = 5000,
    // The canary cert probe is opt-in now — DNS-verified is terminal, and the
    // real per-slug cert is minted at project-create time. Kept behind a flag
    // so the probe pipeline (and its tests) survive for diagnostics.
    runProbe = false,
  } = deps;

  const progress = hooks.progress || (() => {});
  const fail = hooks.fail || (() => {});
  const succeed = hooks.succeed || (() => {});

  progress('pending');

  // ---- Stage 1: wildcard DNS ----
  const label = canaryLabel(randHex());
  const canaryFqdn = `${label}.${domain}`;
  let resolvedIps = [];
  try {
    resolvedIps = await resolve(canaryFqdn);
  } catch (err) {
    log(`dns resolve threw: ${err.message}`);
  }
  const dnsVerdict = evaluateWildcardDns({
    resolvedIps,
    expectedIps: expectedHostIps(),
  });
  log(`dns: ${dnsVerdict.reason}`);
  if (!dnsVerdict.ok) {
    fail(`DNS check failed: ${dnsVerdict.reason}`);
    return 'failed';
  }
  progress('dns_ok');

  // DNS verification is the terminal success state (operator decision): the
  // per-slug Let's Encrypt certificate is issued when a project is actually
  // created (publishDomain → Caddy HTTP-01 for `<slug>.<domain>`), NOT by an
  // up-front canary probe. Verification therefore does no Caddy write and no
  // ACME during registration — it only proves the wildcard DNS points here.
  if (!runProbe) {
    succeed('dns_ok');
    return 'dns_ok';
  }

  // ---- Stage 2 (opt-in): probe certificate on the canary FQDN ----
  try {
    // Write the domain file with ONLY the canary block, then reload so Caddy
    // begins HTTP-01 for it. buildMock2SiteBlock is the same template M2 uses.
    await writeSite(domain, [{ fqdn: canaryFqdn, note: 'M1 verification canary — auto-removed after probe' }]);
    const reloaded = await reload();
    if (!reloaded.ok) {
      fail(`Caddy reload failed during probe (${reloaded.stage}): ${reloaded.error}`);
      // Best-effort: drop the canary block again.
      await writeSite(domain, []).catch(() => {});
      await reload().catch(() => {});
      return 'failed';
    }

    // Poll the canary until it serves a trusted cert or we exhaust attempts —
    // HTTP-01 issuance takes a few seconds on first hit (ADR-009's accepted
    // first-hit latency).
    let verdict = { ok: false, reason: 'not attempted' };
    for (let i = 0; i < probeAttempts; i++) {
      const result = await probe(canaryFqdn);
      verdict = classifyProbe(result);
      log(`probe ${i + 1}/${probeAttempts}: ${verdict.reason}`);
      if (verdict.ok) break;
      if (i < probeAttempts - 1) await sleep(probeDelayMs);
    }

    // Always return the file to its steady state (no canary block) regardless
    // of the verdict.
    await writeSite(domain, []).catch(() => {});
    await reload().catch(() => {});

    if (!verdict.ok) {
      fail(`Probe certificate not issued: ${verdict.reason}`);
      return 'failed';
    }
  } catch (err) {
    fail(`Probe stage error: ${err.message}`);
    await writeSite(domain, []).catch(() => {});
    await reload().catch(() => {});
    return 'failed';
  }

  succeed('cert_ok');
  return 'cert_ok';
}

// Expose buildMock2SiteBlock re-export so a caller that only imports verify
// can render a block for logging without reaching into caddy.js. (No behavior
// — kept for import ergonomics.)
export { buildMock2SiteBlock };
