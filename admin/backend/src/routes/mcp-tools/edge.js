// Edge, routes, certificates and DNS over MCP.
//
//   delete_route / set_route_path / set_route_options — the route verbs the
//   root-only set_route left out, through the same DB → regenerate → adapt →
//   reload pipeline with rollback on every failure.
//   list_certs / get_cert / renew_cert / upload_cert / set_dns_challenge —
//   manual certs (lib/tls-cert-store.js) and the ACME on-disk state.
//   get_route_access_log — the Caddy JSON access log, summarized + tailed.
//   list_dns_records / set_dns_record — Cloudflare, through the DNS-01 token
//   the domains card already stores (the only DNS integration ProxyPilot has).

import { platformRouteRefusal } from '../../lib/setup-engine/platform-hostnames.js';
import bcrypt from 'bcryptjs';
import { validateRouteEdgeOptions, parseRouteEdgeOptions } from '../../lib/caddy-site-file.js';
import { parseCertificate, validateCertKeyPair, assembleServedChain, daysUntil, expiryStatus, redactKeyMaterial } from '../../lib/tls-certs.js';
import { encryptSecret, decryptSecret } from '../../lib/secrets.js';
import { parseDns01List } from '../../lib/domain-provision-logic.js';
import { intIn, stamp } from '../../lib/mcp-ext/logic.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_TOKEN_SETTING = 'cloudflare_global_token';
const CF_TOKEN_RE = /^[A-Za-z0-9_-]{30,}$/;

// The cert store, the managed-TLS apply and the ACME directory resolver pull in
// the native DB module at import time; loaded lazily so this family (and its
// tests) can be instantiated without it.
async function certDeps() {
  const [store, certsRoute, caddyCert] = await Promise.all([
    import('../../lib/tls-cert-store.js'), import('../tls-certs.js'), import('../../lib/caddy-cert.js'),
  ]);
  return { ...store, applyManagedTls: certsRoute.applyManagedTls, resolveCertDir: caddyCert.resolveCertDir };
}

export function createEdgeHandlers(kit) {
  const { ctx, ok, err, mutation, reader, confirmToken, confirmFlag, dry, hostSh, tail, policy } = kit;
  const {
    getDb, getSetting, setSetting, runHostCapture, LXC_PREFIX, LXC_NAME_REGEX, fetchLxcInstance, lxcReachableAddress,
    validDomainName, normalizePort, validIpv4, ROUTE_SELECT, routeView, certInfoForDomain, recentErrorsForDomain,
    caddyAccessLogPath, summarizeAccessLog, regenerateDomainCaddyConfig, ensureCaddyStructure, assertRoutesShareSslStance,
    caddyAdapt, caddyReload, findOrCreateLxcService, syncLxcServiceUpstream, normalizePathPrefix, uuidv4, agentCall,
  } = ctx;

  const prefixOf = (v) => {
    const p = normalizePathPrefix ? normalizePathPrefix(v == null || v === '' ? '/' : String(v)) : (v || '/');
    return /^\/[A-Za-z0-9._~\/-]*$/.test(p) && !p.includes('..') ? p : null;
  };

  function routeRow(domain, prefix) {
    return getDb().prepare(`${ROUTE_SELECT} AND r.domain = ? AND r.path_prefix = ?`).get(domain, prefix) || null;
  }

  /** regenerate → adapt → reload, undoing `rollback` fns on failure. Returns null or an error result. */
  async function applyDomain(domain, rollback, { alsoDomains = [] } = {}) {
    const db = getDb();
    const undo = async (stage, detail) => {
      for (const fn of [...rollback].reverse()) { try { fn(); } catch { /* best effort */ } }
      for (const d of [domain, ...alsoDomains]) { try { await regenerateDomainCaddyConfig(db, d); } catch { /* best effort */ } }
      try { await caddyReload({}); } catch { /* best effort */ }
      return err(`${stage}: ${redactKeyMaterial(String(detail))} — the change was rolled back.`);
    };
    try { await ensureCaddyStructure(); } catch { /* regenerate re-checks */ }
    try { for (const d of [domain, ...alsoDomains]) await regenerateDomainCaddyConfig(db, d); } catch (e) { return undo('Failed to render the Caddy config', e?.message || e); }
    try { await caddyAdapt({}); } catch (e) { return undo('Generated Caddy config failed validation', e?.stderr || e?.message || e); }
    try { await caddyReload({}); } catch (e) { return undo('Caddy reload failed', e?.stderr || e?.message || e); }
    return null;
  }

  /* -------------------------------- routes ------------------------------- */

  const delete_route = mutation('delete_route', { subjectType: 'route', flag: 'mcp.destructive' }, async (args, auth, req, note) => {
    const domain = validDomainName(args.domain);
    if (!domain) return err('domain must be a fully qualified hostname');
    const prefix = prefixOf(args.path_prefix);
    if (!prefix) return err('path_prefix must be an absolute path like /api');
    note.subject_id = `${domain}${prefix}`;
    const db = getDb();
    const row = db.prepare(`SELECT r.*, s.name AS service_name, s.kind, s.is_admin FROM service_http_routes r JOIN services s ON s.id = r.service_id WHERE r.domain = ? AND r.path_prefix = ?`).get(domain, prefix);
    if (!row) return err(`No route for ${domain}${prefix} — list_routes shows every served hostname`);
    if (row.is_admin) return err('The admin dashboard route cannot be deleted over MCP');
    const siblings = db.prepare(`SELECT path_prefix FROM service_http_routes WHERE domain = ? AND id != ?`).all(domain, row.id).map((r) => r.path_prefix);
    const plan = { domain, path_prefix: prefix, service: row.service_name, kind: row.kind, remaining_routes_on_domain: siblings, site_file: siblings.length ? 'rewritten' : 'removed (Caddy stops serving the hostname; the ACME cert stays on disk)' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmToken(args, auth, note, { tool: 'delete_route', subject: `${domain}${prefix}`, action: `delete route ${domain}${prefix} → ${row.service_name}`, preview: plan });
    if (gate) return gate;
    const cols = Object.keys(row).filter((k) => !['service_name', 'kind', 'is_admin'].includes(k));
    const rollback = [() => db.prepare(`INSERT INTO service_http_routes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => row[k]))];
    db.prepare(`DELETE FROM service_http_routes WHERE id = ?`).run(row.id);
    const fail = await applyDomain(domain, rollback);
    if (fail) return fail;
    note.summary = `deleted route ${domain}${prefix}`;
    note.detail = { service: row.service_name, target_port: row.target_port };
    return ok({ deleted: true, ...plan, previous: { service_id: row.service_id, target_port: row.target_port, websocket: !!row.websocket_enabled, tls: !!row.ssl_enabled, strip_prefix: !!row.strip_prefix }, reverse_with: prefix === '/' ? 'set_route with the previous binding' : `set_route_path({ domain: "${domain}", path_prefix: "${prefix}", … })` });
  });

  const set_route_path = mutation('set_route_path', { subjectType: 'route' }, async (args, auth, req, note) => {
    const domain = validDomainName(args.domain);
    if (!domain) return err('domain must be a fully qualified hostname');
    const prefix = prefixOf(args.path_prefix);
    if (!prefix || prefix === '/') return err('path_prefix must be a sub-path like /api — set_route manages the root path');
    note.subject_id = `${domain}${prefix}`;
    { const pr = platformRouteRefusal(getDb(), { hostname: domain }); if (pr) { note.refused = true; return err(pr.error, pr); } }
    const port = normalizePort(args.upstream_port);
    if (!port) return err('upstream_port must be 1–65535');
    const hasContainer = args.upstream_container != null && String(args.upstream_container).trim() !== '';
    const hasIp = args.upstream_ip != null && String(args.upstream_ip).trim() !== '';
    if (hasContainer === hasIp) return err('Provide exactly one of upstream_container (preferred) or upstream_ip');
    let ip = null; let containerName = null;
    if (hasContainer) {
      containerName = String(args.upstream_container).trim();
      if (!LXC_NAME_REGEX.test(containerName)) return err('Invalid container name');
      const probe = await fetchLxcInstance(`${LXC_PREFIX}${containerName}`);
      if (probe.error) return err(`Could not resolve container ${containerName}: ${probe.error}`);
      if (probe.notFound) return err(`Container ${containerName} not found`);
      ip = lxcReachableAddress(probe.instance)?.address || null;
      if (!ip) return err(`Container ${containerName} has no host-reachable IPv4 address — is it running?`);
    } else {
      ip = validIpv4(args.upstream_ip);
      if (!ip) return err('upstream_ip must be a plain IPv4 address');
    }
    const db = getDb();
    const root = routeRow(domain, '/');
    const existing = routeRow(domain, prefix);
    if (existing && args.confirm_overwrite !== true) {
      note.needs_confirmation = true;
      return ok({ applied: false, needs_confirmation: true, domain, path_prefix: prefix, current_binding: routeView(existing), message: 'This prefix already has a binding. Show the user both and re-call with confirm_overwrite: true.' });
    }
    const websocket = args.websocket !== false;
    const strip = args.strip_prefix === true;
    const tls = root ? !!root.ssl_enabled : args.tls !== false;
    const plan = { domain, path_prefix: prefix, upstream: `${ip}:${port}`, container: containerName, websocket, strip_prefix: strip, tls, inherits_tls_from_root: !!root, replaces: existing ? routeView(existing) : null };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Bind ${domain}${prefix} → ${ip}:${port}${strip ? ' (prefix stripped)' : ''}.`); if (gate) return gate;
    try { assertRoutesShareSslStance(db, domain, { sslEnabled: tls, forceHttps: tls }, existing?.route_id || null); } catch (e) { return err(e?.message || 'TLS stance conflicts with the other routes on this domain'); }
    let service;
    try {
      if (containerName) {
        service = findOrCreateLxcService(db, containerName, ip);
        await syncLxcServiceUpstream(db, service, ip);
      } else {
        service = db.prepare(`SELECT * FROM services WHERE target_ip = ? AND lxc_container_name IS NULL AND is_admin = 0 LIMIT 1`).get(ip);
        if (!service) {
          const id = uuidv4();
          db.prepare(`INSERT INTO services (id, name, kind, runtime, target_ip, type, status) VALUES (?, ?, 'container_service', NULL, ?, 'docker', 'active')`).run(id, `${domain}${prefix}`, ip);
          service = db.prepare(`SELECT * FROM services WHERE id = ?`).get(id);
        }
      }
    } catch (e) { return err(`Could not prepare the upstream service record: ${e?.message || e}`); }
    const rollback = [];
    if (existing) {
      const prev = db.prepare(`SELECT * FROM service_http_routes WHERE id = ?`).get(existing.route_id);
      rollback.push(() => db.prepare(`UPDATE service_http_routes SET service_id = ?, target_port = ?, websocket_enabled = ?, ssl_enabled = ?, force_https = ?, strip_prefix = ? WHERE id = ?`).run(prev.service_id, prev.target_port, prev.websocket_enabled, prev.ssl_enabled, prev.force_https, prev.strip_prefix, prev.id));
      db.prepare(`UPDATE service_http_routes SET service_id = ?, target_port = ?, websocket_enabled = ?, ssl_enabled = ?, force_https = ?, strip_prefix = ? WHERE id = ?`).run(service.id, port, websocket ? 1 : 0, tls ? 1 : 0, tls ? 1 : 0, strip ? 1 : 0, prev.id);
    } else {
      const id = uuidv4();
      rollback.push(() => db.prepare(`DELETE FROM service_http_routes WHERE id = ?`).run(id));
      db.prepare(`INSERT INTO service_http_routes (id, service_id, domain, path_prefix, target_port, websocket_enabled, ssl_enabled, force_https, max_upload_size, strip_prefix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1G', ?)`).run(id, service.id, domain, prefix, port, websocket ? 1 : 0, tls ? 1 : 0, tls ? 1 : 0, strip ? 1 : 0);
    }
    const fail = await applyDomain(domain, rollback);
    if (fail) return fail;
    note.summary = `route ${domain}${prefix} → ${ip}:${port}`;
    note.detail = plan;
    return ok({ applied: true, ...plan, next: `test_route({ domain: "${domain}", path: "${prefix}" }) verifies it from the edge.` });
  });

  async function rateLimitModulePresent() {
    try {
      const r = await agentCall('caddy.list_modules', {}, { timeoutMs: 15000 });
      const text = typeof r === 'string' ? r : JSON.stringify(r || '');
      return /http\.handlers\.rate_limit/.test(text);
    } catch { /* fall back to the host binary */ }
    const r = await runHostCapture('caddy', ['list-modules'], { timeoutMs: 15000 }).catch(() => null);
    if (!r || r.status !== 0) return null;
    return /http\.handlers\.rate_limit/.test(r.stdout || '');
  }

  const set_route_options = mutation('set_route_options', { subjectType: 'route' }, async (args, auth, req, note) => {
    const domain = validDomainName(args.domain);
    if (!domain) return err('domain must be a fully qualified hostname');
    const prefix = prefixOf(args.path_prefix);
    if (!prefix) return err('path_prefix must be an absolute path');
    note.subject_id = `${domain}${prefix}`;
    const db = getDb();
    const row = db.prepare(`SELECT r.*, s.is_admin, s.kind FROM service_http_routes r JOIN services s ON s.id = r.service_id WHERE r.domain = ? AND r.path_prefix = ?`).get(domain, prefix);
    if (!row) return err(`No route for ${domain}${prefix}`);
    if (row.is_admin) return err('The admin dashboard route is not editable over MCP');
    const o = args.options && typeof args.options === 'object' ? args.options : {};
    const unknown = Object.keys(o).filter((k) => !policy.route_options.keys.includes(k));
    if (unknown.length) return err(`Unknown option(s): ${unknown.join(', ')}. Known: ${policy.route_options.keys.join(', ')}`);
    if (!Object.keys(o).length) return err('options is empty');
    const sets = {};
    if (o.websocket !== undefined) sets.websocket_enabled = o.websocket ? 1 : 0;
    if (o.strip_prefix !== undefined) { if (prefix === '/') return err('strip_prefix only applies to sub-path routes'); sets.strip_prefix = o.strip_prefix ? 1 : 0; }
    if (o.read_timeout_seconds !== undefined) { const n = o.read_timeout_seconds === null ? null : intIn(o.read_timeout_seconds, 1, 86400 * 7); if (o.read_timeout_seconds !== null && !n) return err('read_timeout_seconds must be 1–604800'); sets.read_timeout_seconds = n; }
    if (o.write_timeout_seconds !== undefined) { const n = o.write_timeout_seconds === null ? null : intIn(o.write_timeout_seconds, 1, 86400 * 7); if (o.write_timeout_seconds !== null && !n) return err('write_timeout_seconds must be 1–604800'); sets.write_timeout_seconds = n; }
    if (o.max_body_bytes !== undefined) { const n = o.max_body_bytes === null ? null : intIn(o.max_body_bytes, 1024, 1024 ** 4); if (o.max_body_bytes !== null && !n) return err('max_body_bytes must be 1024–1 TiB'); sets.max_body_bytes = n; }
    if (o.host_header_override !== undefined) { const v = o.host_header_override === null ? null : String(o.host_header_override).trim(); if (v && !/^[a-z0-9.-]+(:\d{1,5})?$/i.test(v)) return err('host_header_override must be hostname[:port]'); sets.host_header_override = v || null; }
    if (o.allow_framing !== undefined) sets.allow_framing = o.allow_framing ? 1 : 0;
    if (o.frame_ancestors !== undefined) { const v = o.frame_ancestors === null ? null : String(o.frame_ancestors).trim(); if (v && !/^[A-Za-z0-9:\/.*' ,_-]+$/.test(v)) return err('frame_ancestors must be a space/comma separated origin list'); sets.frame_ancestors = v || null; }
    if (o.health_path !== undefined) { const v = o.health_path === null ? null : String(o.health_path).trim(); if (v && !/^\/[A-Za-z0-9._~\/?=&-]*$/.test(v)) return err('health_path must be an absolute path'); sets.health_path = v || null; }
    if (o.tls !== undefined) {
      const tls = !!o.tls;
      try { assertRoutesShareSslStance(db, domain, { sslEnabled: tls, forceHttps: tls }, row.id); } catch (e) { return err(`${e?.message || 'TLS stance conflict'} — every route on a domain shares one stance; change them together or delete the others.`); }
      sets.ssl_enabled = tls ? 1 : 0; sets.force_https = tls ? 1 : 0;
    }
    const edgeInput = {};
    for (const k of ['headers', 'csp', 'basic_auth', 'ip_allowlist', 'rate_limit']) if (o[k] !== undefined) edgeInput[k] = o[k];
    if (Object.keys(edgeInput).length) {
      const rlAvail = edgeInput.rate_limit ? await rateLimitModulePresent() : null;
      const v = validateRouteEdgeOptions(edgeInput, { bcryptHash: (pw) => bcrypt.hashSync(pw, 10), rateLimitAvailable: rlAvail });
      if (v.error) return err(v.error);
      const eo = v.options;
      if (eo.headers !== undefined) sets.extra_headers_json = eo.headers ? JSON.stringify(eo.headers) : null;
      if (eo.csp !== undefined) sets.csp = eo.csp;
      if (eo.basic_auth !== undefined) sets.basic_auth_json = eo.basic_auth ? JSON.stringify(eo.basic_auth) : null;
      if (eo.ip_allowlist !== undefined) sets.ip_allowlist_json = eo.ip_allowlist ? JSON.stringify(eo.ip_allowlist) : null;
      if (eo.rate_limit !== undefined) sets.rate_limit_json = eo.rate_limit ? JSON.stringify(eo.rate_limit) : null;
      if (rlAvail === null && edgeInput.rate_limit) note.detail.warning = 'Could not verify the rate_limit module is present; if Caddy rejects the config the change rolls back.';
    }
    const current = Object.fromEntries(Object.keys(sets).map((k) => [k, row[k] ?? null]));
    const redactedSets = { ...sets, ...(sets.basic_auth_json ? { basic_auth_json: '[hashes]' } : {}) };
    const plan = { domain, path_prefix: prefix, set: redactedSets, current: { ...current, ...(current.basic_auth_json ? { basic_auth_json: '[hashes]' } : {}) } };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Change options on ${domain}${prefix}: ${Object.keys(sets).join(', ')}.`); if (gate) return gate;
    const cols = Object.keys(sets);
    const rollback = [() => db.prepare(`UPDATE service_http_routes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => current[c]), row.id)];
    db.prepare(`UPDATE service_http_routes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => sets[c]), row.id);
    const fail = await applyDomain(domain, rollback);
    if (fail) return fail;
    note.summary = `options on ${domain}${prefix}: ${cols.join(', ')}`;
    note.detail = { ...note.detail, changed: cols };
    const after = db.prepare(`SELECT * FROM service_http_routes WHERE id = ?`).get(row.id);
    return ok({ applied: true, domain, path_prefix: prefix, changed: cols, options: shapeOptions(after), ...(note.detail.warning ? { warning: note.detail.warning } : {}), next: `test_route({ domain: "${domain}" }) verifies the edge still answers.` });
  });

  function shapeOptions(r) {
    const eo = parseRouteEdgeOptions(r) || {};
    return {
      websocket: !!r.websocket_enabled, strip_prefix: !!r.strip_prefix, tls: !!r.ssl_enabled,
      read_timeout_seconds: r.read_timeout_seconds ?? null, write_timeout_seconds: r.write_timeout_seconds ?? null,
      max_body_bytes: r.max_body_bytes ?? null, host_header_override: r.host_header_override ?? null,
      allow_framing: !!r.allow_framing, frame_ancestors: r.frame_ancestors ?? null, health_path: r.health_path ?? null,
      headers: eo.headers ?? null, csp: eo.csp ?? null,
      basic_auth: eo.basic_auth ? eo.basic_auth.map((u) => u.username) : null,
      ip_allowlist: eo.ip_allowlist ?? null, rate_limit: eo.rate_limit ?? null,
    };
  }

  /* ------------------------------- certs -------------------------------- */

  const list_certs = reader('list_certs', async () => {
    const { listCertRows, certPublicShape } = await certDeps();
    const now = Date.now();
    const manual = listCertRows().map((r) => certPublicShape(r, { nowMs: now }));
    const domains = getDb().prepare(`SELECT DISTINCT r.domain FROM service_http_routes r JOIN services s ON s.id = r.service_id WHERE s.is_admin = 0 AND r.ssl_enabled = 1 ORDER BY r.domain`).all().map((r) => r.domain);
    const acme = [];
    for (const domain of domains.slice(0, 200)) {
      const info = await certInfoForDomain(domain);
      acme.push({ domain, ...info });
    }
    let provisioned = [];
    try { provisioned = getDb().prepare(`SELECT domain, method_resolved, wildcard, status, last_error FROM provisioned_domains ORDER BY domain`).all(); } catch { provisioned = []; }
    return ok({ tls_mode: getSetting('tls_mode') || 'acme', manual_certificates: manual, acme_domains: acme, provisioned_domains: provisioned, expiring: acme.filter((a) => a.certificate?.status && a.certificate.status !== 'ok').map((a) => a.domain) });
  });

  const get_cert = reader('get_cert', async (args) => {
    const { getCertRow, certPublicShape, resolveCertDir } = await certDeps();
    if (args.id != null) {
      const row = getCertRow(args.id);
      if (!row) return err('No manual certificate with that id');
      return ok({ manual: certPublicShape(row, { nowMs: Date.now() }), note: 'Key material is never returned.' });
    }
    const domain = validDomainName(args.domain);
    if (!domain) return err('Pass id (manual cert) or domain');
    let dir = null;
    try { dir = resolveCertDir(domain); } catch { dir = null; }
    return ok({ domain, ...(await certInfoForDomain(domain)), on_disk: dir ? { directory: dir.dir, issuer: dir.issuer, cert_file: dir.certFile, modified_at: dir.mtime || null } : null });
  });

  const renew_cert = mutation('renew_cert', { subjectType: 'cert' }, async (args, auth, req, note) => {
    const domain = validDomainName(args.domain);
    if (!domain) return err('domain must be a fully qualified hostname');
    note.subject_id = domain;
    const { resolveTlsForHost, resolveCertDir } = await certDeps();
    let decision = null;
    try { decision = resolveTlsForHost(domain); } catch { decision = null; }
    if (decision && decision.mode === 'manual') return err(`${domain} is served by a manual certificate (id ${decision.certId}) — manual certs never auto-renew; upload_cert a rotated one.`);
    let dir = null;
    try { dir = resolveCertDir(domain); } catch { dir = null; }
    if (!dir?.dir) return err(`No ACME certificate directory found for ${domain} — Caddy has not issued one yet (is the route TLS-enabled and reachable?).`);
    const info = await certInfoForDomain(domain);
    const plan = { domain, issuer_directory: dir.issuer, current: info.certificate, moves_aside_to: `${dir.dir}.pp-renew-${stamp()}`, then: 'caddy reload (Caddy re-issues on the next TLS handshake / immediately for managed hosts)', warning: 'ACME issuers rate-limit re-issuance (Let\'s Encrypt: 5 duplicate certs per week). Only renew when the current certificate is actually wrong.' };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Force re-issue for ${domain} by moving its ACME cert aside and reloading Caddy.`); if (gate) return gate;
    const mv = await hostSh('src="$1"; dst="$2"; test -d "$src" || exit 66; mv -- "$src" "$dst"', [dir.dir, plan.moves_aside_to], { timeoutMs: 15000 });
    if (mv.status === 66) return err(`Certificate directory ${dir.dir} vanished before the move`);
    if (mv.status !== 0) return err(`Could not move the certificate aside: ${tail(mv.stderr)}`);
    note.snapshot = plan.moves_aside_to;
    try { await caddyReload({}); } catch (e) {
      await hostSh('mv -- "$1" "$2"', [plan.moves_aside_to, dir.dir], { timeoutMs: 15000 });
      return err(`Caddy reload failed (${redactKeyMaterial(String(e?.stderr || e?.message || e))}); the certificate was moved back.`);
    }
    note.summary = `forced re-issue for ${domain}`;
    note.detail = { backup: plan.moves_aside_to };
    return ok({ requested: true, domain, previous_certificate_kept_at: plan.moves_aside_to, next: `Poll get_cert({ domain: "${domain}" }) — a fresh not_before proves the re-issue; if it stays absent, move the backup back with the host shell and check the Caddy journal.` });
  });

  const upload_cert = mutation('upload_cert', { subjectType: 'cert' }, async (args, auth, req, note) => {
    const label = String(args.label || '').trim().slice(0, 100);
    if (!label) return err('label is required');
    const v = validateCertKeyPair(String(args.certificate || ''), String(args.private_key || ''), args.passphrase || null);
    if (!v.ok) return err(v.message);
    const assembled = assembleServedChain(String(args.certificate || ''), args.chain || null);
    if (!assembled.ok) return err(assembled.message);
    const plan = { label, common_name: v.parsed.commonName, covered_names: v.parsed.coveredNames, not_after: v.parsed.notAfter, days_until_expiry: daysUntil(v.parsed.notAfter), status: expiryStatus(v.parsed.notAfter), applies_to: 'every managed host the certificate covers, on the next apply' };
    note.subject_id = v.parsed.commonName || label;
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `Store certificate "${label}" (${plan.covered_names.join(', ')}) and apply it to matching hosts.`); if (gate) return gate;
    const { insertCert, materializeCertFiles, applyManagedTls } = await certDeps();
    const row = insertCert({ label, certPem: String(args.certificate), chainPem: args.chain || null, normalizedKeyPem: v.normalizedKeyPem, parsed: v.parsed, createdBy: auth.created_by || null });
    try { materializeCertFiles(row.id, assembled.chainPem, v.normalizedKeyPem); } catch (e) { return err(`Stored but could not write the certificate files: ${redactKeyMaterial(String(e?.message || e))}`); }
    const applied = await applyManagedTls();
    note.summary = `uploaded certificate ${label}`;
    note.detail = { cert_id: row.id, covered_names: plan.covered_names };
    return ok({ stored: true, cert_id: row.id, ...plan, applied, ...(applied.ok ? {} : { warning: `Caddy did not pick it up cleanly at stage ${applied.stage}: ${applied.error}` }) });
  });

  const set_dns_challenge = mutation('set_dns_challenge', { subjectType: 'dns', flag: 'mcp.dns' }, async (args, auth, req, note) => {
    const changes = {};
    if (args.cloudflare_token !== undefined) {
      if (args.cloudflare_token === null || args.cloudflare_token === '') changes.cloudflare_token = 'clear';
      else if (!CF_TOKEN_RE.test(String(args.cloudflare_token))) return err('That does not look like a Cloudflare API token (Zone → DNS → Edit and Zone → Zone → Read scopes).');
      else changes.cloudflare_token = 'set';
    }
    let list = null;
    if (args.dns01_domains !== undefined) {
      list = parseDns01List(args.dns01_domains);
      if (Array.isArray(args.dns01_domains) && list.length !== args.dns01_domains.length) return err('dns01_domains contains an entry that is not a domain (wildcards as *.example.com)');
      changes.dns01_domains = list;
    }
    if (!Object.keys(changes).length) return err('Pass cloudflare_token (or null to clear) and/or dns01_domains (the list of domains issued via DNS-01)');
    note.subject_id = 'dns01';
    const current = { token: getSetting(CF_TOKEN_SETTING) ? 'set (ui)' : (process.env.CLOUDFLARE_API_TOKEN ? 'set (env)' : 'unset'), dns01_domains: parseDns01List(getSetting('dns01_domains') || '[]') };
    const d = dry(args, { changes, current }); if (d) return d;
    const gate = confirmFlag(args, note, `Update the DNS-01 challenge settings (${Object.keys(changes).join(', ')}).`); if (gate) return gate;
    if (changes.cloudflare_token === 'set') setSetting(CF_TOKEN_SETTING, encryptSecret(String(args.cloudflare_token)));
    if (changes.cloudflare_token === 'clear') setSetting(CF_TOKEN_SETTING, '');
    if (list) setSetting('dns01_domains', JSON.stringify(list));
    let plugin = null;
    const r = await runHostCapture('caddy', ['list-modules'], { timeoutMs: 15000 }).catch(() => null);
    if (r && r.status === 0) plugin = /dns\.providers\.cloudflare/.test(r.stdout || '');
    note.summary = `dns-01 settings: ${Object.keys(changes).join(', ')}`;
    note.detail = { token: changes.cloudflare_token || 'unchanged', dns01_domains: list ? list.length : 'unchanged' };
    return ok({ applied: true, cloudflare_token: changes.cloudflare_token || 'unchanged', dns01_domains: list || current.dns01_domains, cloudflare_plugin_installed: plugin, ...(plugin === false ? { warning: 'Caddy on this host lacks the Cloudflare DNS provider — run `caddy add-package github.com/caddy-dns/cloudflare` on the host (Domains card → Install plugin) before DNS-01 issuance can work.' } : {}) });
  });

  /* ------------------------------ access log ------------------------------ */

  const get_route_access_log = reader('get_route_access_log', async (args) => {
    const domain = validDomainName(args.domain);
    if (!domain) return err('domain must be a fully qualified hostname');
    const windowSeconds = intIn(args.window_seconds, 60, 86400 * 7) || 3600;
    const tailBytes = intIn(args.tail_bytes, 4096, 8 * 1024 * 1024) || 524288;
    const entries = intIn(args.entries, 0, 500) ?? 50;
    const logPath = caddyAccessLogPath(domain);
    const r = await runHostCapture('tail', ['-c', String(tailBytes), logPath], { timeoutMs: 20000, maxCapture: tailBytes + 65536 });
    if (r.status !== 0) return err(`No readable access log at ${logPath} (${tail(r.stderr) || 'the log appears after the first request to the merged site config'})`);
    const summary = summarizeAccessLog(r.stdout, Date.now(), windowSeconds);
    const lines = r.stdout.split('\n').filter(Boolean);
    const filterStatus = args.status_min != null ? intIn(args.status_min, 100, 599) : null;
    const pathFilter = args.path ? String(args.path) : null;
    const recent = [];
    for (let i = lines.length - 1; i >= 0 && recent.length < entries; i -= 1) {
      let j; try { j = JSON.parse(lines[i]); } catch { continue; }
      const status = Number(j.status);
      if (filterStatus && !(status >= filterStatus)) continue;
      const uri = j.request?.uri || '';
      if (pathFilter && !uri.startsWith(pathFilter)) continue;
      recent.push({ ts: j.ts ? new Date(j.ts * 1000).toISOString() : null, status, method: j.request?.method || null, uri, remote: j.request?.remote_ip || j.request?.client_ip || null, duration_ms: j.duration != null ? Math.round(j.duration * 1000) : null, bytes: j.size ?? null, user_agent: j.request?.headers?.['User-Agent']?.[0] || null });
    }
    return ok({ domain, log: logPath, window_seconds: windowSeconds, ...summary, entries: recent, note: `Newest first; ${entries} entries max from the last ${Math.round(tailBytes / 1024)} KB of the log.` });
  });

  /* ---------------------------------- DNS --------------------------------- */

  function cfToken() {
    try { const stored = getSetting(CF_TOKEN_SETTING); if (stored) { const t = String(decryptSecret(stored) || '').trim(); if (t) return t; } } catch { /* fall through */ }
    const t = String(process.env.CLOUDFLARE_API_TOKEN || '').trim();
    return t || null;
  }

  async function cf(method, path, body = null) {
    const token = cfToken();
    if (!token) return { error: 'No Cloudflare API token is configured — set_dns_challenge({ cloudflare_token }) stores one (Zone → DNS → Edit, Zone → Zone → Read). DNS tools only work through Cloudflare on this install.' };
    let res;
    try {
      res = await fetch(`${CF_API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    } catch (e) { return { error: `Cloudflare API unreachable: ${e?.message || e}` }; }
    let j = null; try { j = await res.json(); } catch { j = null; }
    if (!res.ok || !j?.success) return { error: `Cloudflare API ${method} ${path} → ${res.status}: ${(j?.errors || []).map((e) => e.message).join('; ') || 'request failed'}` };
    return { result: j.result, info: j.result_info || null };
  }

  async function cfZone(name) {
    const labels = String(name).split('.');
    for (let i = 0; i < labels.length - 1; i += 1) {
      const zone = labels.slice(i).join('.');
      const r = await cf('GET', `/zones?name=${encodeURIComponent(zone)}&status=active`);
      if (r.error) return r;
      if (r.result?.length) return { zone: r.result[0] };
    }
    return { error: `No Cloudflare zone on this token covers ${name}` };
  }

  const list_dns_records = reader('list_dns_records', async (args) => {
    if (!kit.flag('mcp.dns')) return err(kit.flagRefusal('mcp.dns'));
    const zoneName = validDomainName(args.zone || args.domain);
    if (!zoneName) return err('zone (or a hostname inside it) is required');
    const z = await cfZone(zoneName);
    if (z.error) return err(z.error);
    const type = args.type ? String(args.type).toUpperCase() : null;
    const name = args.name ? validDomainName(args.name) : null;
    const qs = new URLSearchParams({ per_page: '100', ...(type ? { type } : {}), ...(name ? { name } : {}) });
    const r = await cf('GET', `/zones/${z.zone.id}/dns_records?${qs}`);
    if (r.error) return err(r.error);
    return ok({ zone: z.zone.name, zone_id: z.zone.id, count: r.result.length, records: r.result.map((rec) => ({ id: rec.id, type: rec.type, name: rec.name, content: rec.content, ttl: rec.ttl, proxied: !!rec.proxied, modified_on: rec.modified_on })), ...(r.info && r.info.total_count > r.result.length ? { truncated: true, total: r.info.total_count } : {}) });
  });

  const set_dns_record = mutation('set_dns_record', { subjectType: 'dns', flag: 'mcp.dns' }, async (args, auth, req, note) => {
    const name = validDomainName(args.name);
    if (!name) return err('name must be a fully qualified record name, e.g. app.example.com');
    note.subject_id = name;
    const action = ['add', 'update', 'upsert', 'delete'].includes(args.action) ? args.action : 'upsert';
    const type = String(args.type || 'A').toUpperCase();
    if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA'].includes(type)) return err('type must be A, AAAA, CNAME, TXT, MX, SRV or CAA');
    const content = args.content != null ? String(args.content).trim() : null;
    if (action !== 'delete' && !content) return err('content is required');
    if (type === 'A' && action !== 'delete' && !validIpv4(content)) return err('content must be an IPv4 address for an A record');
    const ttl = args.ttl == null ? 1 : intIn(args.ttl, 60, 86400) || (Number(args.ttl) === 1 ? 1 : null);
    if (ttl === null) return err('ttl must be 1 (auto) or 60–86400');
    const proxied = args.proxied === true;
    const z = await cfZone(name);
    if (z.error) return err(z.error);
    const existing = await cf('GET', `/zones/${z.zone.id}/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
    if (existing.error) return err(existing.error);
    const match = existing.result[0] || null;
    if (action === 'add' && match) return err(`A ${type} record for ${name} already exists (${match.content}) — use update, upsert or delete`);
    if ((action === 'update' || action === 'delete') && !match) return err(`No ${type} record for ${name} exists`);
    const plan = { zone: z.zone.name, action: action === 'upsert' ? (match ? 'update' : 'add') : action, type, name, content, ttl, proxied, current: match ? { id: match.id, content: match.content, ttl: match.ttl, proxied: !!match.proxied } : null };
    const d = dry(args, plan); if (d) return d;
    const gate = confirmFlag(args, note, `${plan.action} ${type} ${name}${content ? ` → ${content}` : ''} in Cloudflare zone ${z.zone.name}.`); if (gate) return gate;
    let r;
    if (plan.action === 'delete') r = await cf('DELETE', `/zones/${z.zone.id}/dns_records/${match.id}`);
    else if (plan.action === 'update') r = await cf('PUT', `/zones/${z.zone.id}/dns_records/${match.id}`, { type, name, content, ttl, proxied: ['A', 'AAAA', 'CNAME'].includes(type) ? proxied : undefined });
    else r = await cf('POST', `/zones/${z.zone.id}/dns_records`, { type, name, content, ttl, proxied: ['A', 'AAAA', 'CNAME'].includes(type) ? proxied : undefined });
    if (r.error) return err(r.error);
    note.summary = `dns ${plan.action} ${type} ${name}${content ? ` → ${content}` : ''}`;
    note.detail = plan;
    return ok({ applied: true, ...plan, record: plan.action === 'delete' ? null : { id: r.result?.id, content: r.result?.content, ttl: r.result?.ttl, proxied: !!r.result?.proxied }, ...(match && plan.action !== 'delete' ? { reverse_with: `set_dns_record({ action: "update", type: "${type}", name: "${name}", content: "${match.content}", ttl: ${match.ttl}, proxied: ${!!match.proxied}, confirm: true })` } : {}) });
  });

  return {
    delete_route, set_route_path, set_route_options,
    list_certs, get_cert, renew_cert, upload_cert, set_dns_challenge,
    get_route_access_log, list_dns_records, set_dns_record,
  };
}
