// Drift detection: does the running edge match declared intent?
//
// ProxyPilot's route table is the intent. Two things downstream of it can
// disagree with it, and until now nothing checked either:
//
//   1. The per-domain site files under CADDY_SITES_DIR. A write path that
//      updated the database without re-rendering every affected domain left
//      these frozen at an old upstream address — silently, because a stale
//      file is still a syntactically valid one.
//   2. Caddy's own running configuration, which can differ from the files on
//      disk if a reload failed, never happened, or someone edited the host by
//      hand. Caddy publishes it at the admin API's `GET /config/`; the endpoint
//      has been enabled all along (`admin localhost:2019` in the generated
//      Caddyfile) and nothing has ever read it.
//
// This module reports; it does not repair. That matches the decision the
// cert-mount reconciler already states at boot — operator edits beat
// ProxyPilot intent, so drift is surfaced rather than silently overwritten —
// and it keeps a diagnostic from becoming a second writer. Repair stays an
// explicit action (POST /api/services/caddy/regenerate-all).
//
// The cross-tenant check is the part that matters most. A route whose upstream
// address resolves to a DIFFERENT managed guest than the route names is never
// benign: it means one project's hostname is pointed into another project's
// container, served over a certificate legitimately issued for the first. If
// the receiving guest happens to listen on that port, it answers 200 and
// nothing anywhere raises an error. That is a containment failure, not an
// availability bug, and it is reported at `error` level.
//
// See docs/incidents/2026-09-04-route-config-drift.md.

import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import http from 'http';

import { parseCaddySiteFile, sameHost } from './caddy-site-file.js';

const CADDY_SITES_DIR = process.env.CADDY_SITES_DIR || '/etc/caddy/sites';
const CADDY_ADMIN = process.env.CADDY_ADMIN_ENDPOINT || 'http://localhost:2019';

/** Status of one domain's comparison. */
export const STATUS = {
  MATCH: 'match',
  DRIFT: 'drift',
  MISSING: 'missing_in_caddy',
  UNMANAGED: 'unmanaged_in_caddy',
};

/**
 * Fetch Caddy's running configuration from the admin API.
 *
 * Advisory: any failure returns null and the report degrades to a
 * database-vs-disk comparison rather than erroring out. A drift check that
 * fails closed would be worse than one that reports what it can.
 *
 * @param {object} [opts]
 * @param {string} [opts.endpoint]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object|null>}
 */
export function fetchCaddyConfig({ endpoint = CADDY_ADMIN, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = http.get(`${endpoint}/config/`, { timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return done(null); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { done(JSON.parse(body)); } catch { done(null); }
        });
      });
      req.on('error', () => done(null));
      req.on('timeout', () => { req.destroy(); done(null); });
    } catch {
      done(null);
    }
  });
}

/**
 * Walk Caddy's JSON config and collect, per host, the upstream addresses it
 * dials.
 *
 * Caddy's adapted JSON nests route lists inside `subroute` handlers, so the
 * host matcher that applies to a `reverse_proxy` can sit several levels above
 * it. This walks the tree carrying the nearest enclosing host matcher down,
 * which is what makes a path-fan-out domain (one host, several upstreams)
 * report correctly instead of collapsing to whichever handler sorts first.
 *
 * @param {object|null} config
 * @returns {Map<string, Set<string>>} host → set of `ip:port` dial strings
 */
export function extractCaddyUpstreams(config) {
  const out = new Map();
  if (!config || typeof config !== 'object') return out;

  const add = (hosts, dial) => {
    for (const h of hosts) {
      if (!out.has(h)) out.set(h, new Set());
      out.get(h).add(dial);
    }
  };

  const walk = (node, hosts) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, hosts);
      return;
    }
    // A route entry may narrow the host set for everything beneath it.
    let scoped = hosts;
    if (Array.isArray(node.match)) {
      const matched = [];
      for (const m of node.match) {
        if (m && Array.isArray(m.host)) matched.push(...m.host);
      }
      if (matched.length) scoped = matched;
    }
    if (node.handler === 'reverse_proxy' && Array.isArray(node.upstreams)) {
      for (const u of node.upstreams) {
        if (u && typeof u.dial === 'string') add(scoped, u.dial);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'match') continue;
      walk(value, scoped);
    }
  };

  walk(config, []);
  return out;
}

/**
 * The intended upstream set per domain, straight from the route table.
 *
 * @param {object} db
 * @returns {Map<string, {domain: string, container: string|null, expected: Set<string>, routes: object[]}>}
 */
export function intendedUpstreams(db) {
  const rows = db
    .prepare(
      `SELECT r.domain, r.path_prefix, r.target_port,
              s.kind, s.target_ip, s.lxc_container_name, s.name AS service_name
         FROM service_http_routes r
         JOIN services s ON s.id = r.service_id
        WHERE s.is_admin = 0`
    )
    .all();

  const byDomain = new Map();
  for (const r of rows) {
    if (!byDomain.has(r.domain)) {
      byDomain.set(r.domain, {
        domain: r.domain,
        container: r.lxc_container_name || null,
        expected: new Set(),
        routes: [],
      });
    }
    const entry = byDomain.get(r.domain);
    entry.routes.push(r);
    // Static sites serve from disk — no upstream to compare.
    if (r.kind !== 'static_site' && r.target_ip && r.target_port) {
      entry.expected.add(`${r.target_ip}:${r.target_port}`);
    }
    // A domain can carry routes from more than one service; keep the first
    // named container but record the conflict for the report.
    if (!entry.container && r.lxc_container_name) entry.container = r.lxc_container_name;
  }
  return byDomain;
}

/**
 * Read every site file under the sites directory.
 *
 * @param {string} [dir]
 * @returns {Promise<Map<string, {file: string, upstreams: string[]}>>}
 */
export async function readSiteFiles(dir = CADDY_SITES_DIR) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  let files = [];
  try { files = await readdir(dir); } catch { return out; }
  for (const file of files) {
    try {
      const parsed = parseCaddySiteFile(await readFile(join(dir, file), 'utf-8'));
      if (!parsed.primaryDomain) continue;
      for (const domain of parsed.domains) {
        out.set(domain, {
          file,
          upstreams: parsed.upstreams
            .filter((u) => u.port != null)
            .map((u) => `${u.host}:${u.port}`),
        });
      }
    } catch {
      // Unreadable file — reported as missing rather than crashing the sweep.
    }
  }
  return out;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Build a guest address → name index so an upstream can be resolved back to
 * the container that actually holds it.
 *
 * @param {Array<{name: string, ip: string}>} guests
 * @returns {Map<string, string>}
 */
export function indexGuestsByIp(guests) {
  const m = new Map();
  for (const g of guests || []) {
    if (g && g.ip && g.name) m.set(String(g.ip).trim(), g.name);
  }
  return m;
}

/**
 * Compare declared intent against the site files and Caddy's running config.
 *
 * Pure given its inputs — the callers do the I/O — so the comparison logic is
 * unit-testable without a filesystem, a Caddy admin socket, or Incus.
 *
 * @param {object} opts
 * @param {Map} opts.intended     from intendedUpstreams()
 * @param {Map} opts.siteFiles    from readSiteFiles()
 * @param {Map|null} opts.running from extractCaddyUpstreams(), or null when unreachable
 * @param {Map} [opts.guestsByIp] from indexGuestsByIp()
 * @returns {{clean: boolean, checked: number, caddy_admin_reachable: boolean,
 *           domains: object[], cross_tenant: object[], summary: object}}
 */
export function compareRoutes({ intended, siteFiles, running, guestsByIp = new Map() }) {
  const domains = [];
  const crossTenant = [];
  const summary = { match: 0, drift: 0, missing_in_caddy: 0, unmanaged_in_caddy: 0 };

  for (const [domain, want] of intended) {
    const file = siteFiles.get(domain) || null;
    const onDisk = new Set(file ? file.upstreams : []);
    const inCaddy = running ? new Set(running.get(domain) || []) : null;

    const differences = [];
    let status = STATUS.MATCH;

    if (!file) {
      status = STATUS.MISSING;
      differences.push(`no site file for ${domain} — the route is declared but the edge cannot serve it`);
    } else if (want.expected.size && !setsEqual(want.expected, onDisk)) {
      status = STATUS.DRIFT;
      differences.push(
        `site file dials ${[...onDisk].join(', ') || 'nothing'} but the route table says ` +
        `${[...want.expected].join(', ')}`
      );
    }

    if (inCaddy !== null && want.expected.size) {
      if (inCaddy.size === 0) {
        if (status === STATUS.MATCH) status = STATUS.MISSING;
        differences.push(`Caddy's running config serves no upstream for ${domain}`);
      } else if (!setsEqual(want.expected, inCaddy)) {
        status = STATUS.DRIFT;
        differences.push(
          `Caddy is running ${[...inCaddy].join(', ')} but the route table says ` +
          `${[...want.expected].join(', ')}`
        );
      }
    }

    // Cross-tenant check. Compare against what the edge is ACTUALLY dialing —
    // the running config first, the file second — because the whole failure
    // mode is that those disagree with the route table.
    const effective = inCaddy && inCaddy.size ? inCaddy : onDisk;
    for (const dial of effective) {
      const host = dial.slice(0, dial.lastIndexOf(':')) || dial;
      const holder = guestsByIp.get(host);
      if (!holder) continue;
      if (want.container && holder !== want.container) {
        crossTenant.push({
          domain,
          declared_container: want.container,
          serving_container: holder,
          upstream: dial,
          detail:
            `${domain} is declared against '${want.container}' but the edge dials ${dial}, ` +
            `which belongs to '${holder}'. This hostname is being served from another ` +
            `tenant's guest under its own certificate.`,
        });
        if (status === STATUS.MATCH) status = STATUS.DRIFT;
      }
    }

    summary[status] += 1;
    domains.push({
      domain,
      status,
      container: want.container,
      expected: [...want.expected],
      on_disk: [...onDisk],
      ...(inCaddy !== null ? { in_caddy: [...inCaddy] } : {}),
      ...(differences.length ? { differences } : {}),
    });
  }

  // Site files serving a domain the route table does not declare. Reported,
  // never removed: the operator's own /etc/caddy/custom files are legitimate,
  // and so is a hand-written site file they chose to keep.
  for (const [domain, file] of siteFiles) {
    if (intended.has(domain)) continue;
    summary.unmanaged_in_caddy += 1;
    domains.push({
      domain,
      status: STATUS.UNMANAGED,
      container: null,
      expected: [],
      on_disk: file.upstreams,
      differences: [`${file.file} serves ${domain}, which ProxyPilot does not manage`],
    });
  }

  return {
    clean: summary.drift === 0 && summary.missing_in_caddy === 0 && crossTenant.length === 0,
    checked: domains.length,
    caddy_admin_reachable: running !== null,
    domains,
    cross_tenant: crossTenant,
    summary,
  };
}

/**
 * Run a full drift check: read both downstream stores and compare them to the
 * route table.
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {() => Promise<Array<{name: string, ip: string}>>} [opts.listGuests]
 * @param {string} [opts.sitesDir]
 * @returns {Promise<object>} the compareRoutes report
 */
export async function checkRouteDrift({ db, listGuests = null, sitesDir = CADDY_SITES_DIR } = {}) {
  const intended = intendedUpstreams(db);
  const siteFiles = await readSiteFiles(sitesDir);
  const config = await fetchCaddyConfig();
  const running = config ? extractCaddyUpstreams(config) : null;

  let guestsByIp = new Map();
  if (listGuests) {
    try {
      guestsByIp = indexGuestsByIp(await listGuests());
    } catch (e) {
      console.warn('[route-drift] guest enumeration failed:', e?.message || e);
    }
  }

  return compareRoutes({ intended, siteFiles, running, guestsByIp });
}

/**
 * Turn a report into the notification payloads it warrants.
 *
 * Cross-tenant findings are `error` — a hostname pointed into another project's
 * guest is a containment failure. Plain drift is `warning`. A clean report
 * produces nothing. Dedupe keys are stable per condition so a persistent
 * problem refreshes one row rather than spamming a new one every sweep.
 *
 * @param {object} report
 * @returns {Array<{level: string, title: string, body: string, source: string, dedupe_key: string}>}
 */
export function driftNotifications(report) {
  const out = [];
  for (const x of report.cross_tenant || []) {
    out.push({
      level: 'error',
      title: `Route ${x.domain} is served from another tenant's guest`,
      body: x.detail,
      source: 'route-drift',
      dedupe_key: `route-drift:cross-tenant:${x.domain}`,
    });
  }
  const drifted = (report.domains || []).filter((d) => d.status === STATUS.DRIFT);
  const missing = (report.domains || []).filter((d) => d.status === STATUS.MISSING);
  if (drifted.length) {
    out.push({
      level: 'warning',
      title: `${drifted.length} route${drifted.length === 1 ? '' : 's'} drifted from the route table`,
      body: drifted
        .map((d) => `${d.domain}: ${(d.differences || []).join('; ')}`)
        .join('\n'),
      source: 'route-drift',
      dedupe_key: 'route-drift:drift',
    });
  }
  if (missing.length) {
    out.push({
      level: 'warning',
      title: `${missing.length} declared route${missing.length === 1 ? '' : 's'} not served by Caddy`,
      body: missing
        .map((d) => `${d.domain}: ${(d.differences || []).join('; ')}`)
        .join('\n'),
      source: 'route-drift',
      dedupe_key: 'route-drift:missing',
    });
  }
  return out;
}
