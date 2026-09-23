// The Platform overview and its service actions (Part 2) — ONE implementation
// behind both the dashboard (routes/platform-overview.js) and the MCP tools
// (routes/mcp-tools/platform.js). Health comes from the same docker inspect
// shape get_platform_service returns (runtimeFacts), verification from the
// same verificationView, DNS from platform-dns, the upstream from `ss`, jobs
// from jobSummary; nothing here re-derives any of them.
//
// `run(argv)` runs one host command and returns { code|status, stdout, stderr }
// (the backend passes runHostCapture through nsenter; tests pass a fake).
// Host facts (inspect, listening ports, DNS) are cached for 15 s; logs are
// read only when asked for. Every returned object passes through redact():
// no secret, credential or protected reference leaves this module.

import { fullPlatformState, readFullPlatform, installedTargets, digest, fail, resyncReview } from './full-platform-store.js';
import { applyService, serviceReaders } from './full-platform-services.js';
import { lifecycleReview } from './full-platform-lifecycle.js';
import { platformServiceView, runtimeFacts, containerNames, ownedRoute, verificationView, jobSummary, serviceRetryRefusal, scrubKnownSecrets, SERVICE_IDS, SERVICE_PORTS, rowFor } from './full-platform-mcp.js';
import { getJob } from './store.js';
import { redact, redactText } from './logic.js';
import { checkHostnames, dnsRefusal } from './platform-dns.js';
import { readContainerLogs, startOwnedContainer, listeningPorts, reasonCodeOf, LOG_DRIVER } from './owned-runtime.js';
import { localEdgeAddress, SELF_CHECK_HEADER, selfCheckToken } from './local-edge.js';
import { recoveryReview } from './full-platform-kc-recovery.js';
import { platformFlagState, mcpAccess } from '../platform-mcp-flag.js';

export const RECOVERY_ROUTE_ID = 'proxypilot-local-recovery';
export const OVERVIEW_TTL_MS = 15_000;
const OPEN = ['queued', 'running'];
const NAMES = { keycloak: 'Keycloak', pomerium: 'Pomerium', infisical: 'Infisical', openbao: 'OpenBao', vaultwarden: 'Vaultwarden' };
const has = (db, t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
const norm = (r) => ({ code: r?.code ?? r?.status ?? -1, stdout: String(r?.stdout || ''), stderr: String(r?.stderr || '') });
const cache = new Map();
async function cached(key, fresh, fn, now = Date.now()) {
  const hit = cache.get(key);
  if (!fresh && hit && now - hit.at < OVERVIEW_TTL_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: now, value });
  return value;
}
export function clearOverviewCache() { cache.clear(); }

/* ------------------------------- host facts ------------------------------ */

export async function dockerInfo(run, { fresh = false } = {}) {
  return cached('docker', fresh, async () => {
    try {
      const r = norm(await run(['docker', 'info', '--format', '{{json .ServerVersion}} {{json .LoggingDriver}}']));
      if (r.code !== 0) return { ok: false, error: 'Docker is unreachable on the host (docker info failed).' };
      const [version, driver] = r.stdout.trim().split(' ').map((x) => { try { return JSON.parse(x); } catch { return null; } });
      return { ok: true, version: /^[\w.+-]{1,40}$/.test(version || '') ? version : 'unknown', default_log_driver: /^[\w-]{1,30}$/.test(driver || '') ? driver : null,
        note: driver && driver !== LOG_DRIVER ? `The daemon default log driver is "${driver}"; owned platform containers are created with "${LOG_DRIVER}" explicitly, so it does not affect them.` : null };
    } catch (e) { return { ok: false, error: `Docker is unreachable on the host: ${String(e?.message || e).slice(0, 120)}` }; }
  });
}

export async function listening(run, { fresh = false } = {}) {
  return cached('ss', fresh, async () => {
    try { const r = norm(await run(['ss', '-ltnH'])); return r.code === 0 ? [...listeningPorts(r.stdout)] : null; } catch { return null; }
  });
}

/** docker inspect of one service's owned containers — the path behind get_platform_service. */
export async function inspectServiceRuntime(db, service, run, { fresh = false } = {}) {
  const { target, row } = rowFor(db, service);
  const names = target?.mode === 'install' ? containerNames(service, row) : [];
  if (!names.length) return { runtime: null, runtimeError: null, names };
  return cached(`inspect:${service}:${names.join(',')}`, fresh, async () => {
    try {
      const listed = norm(await run(['docker', 'container', 'ls', '-a', '--format', '{{.Names}}']));
      if (listed.code !== 0) throw new Error('docker is unavailable on the host');
      const present = names.filter((n) => listed.stdout.split('\n').includes(n));
      let runtime = {};
      if (present.length) {
        const r = norm(await run(['docker', 'container', 'inspect', ...present]));
        if (r.code !== 0) throw new Error('docker inspect failed');
        runtime = runtimeFacts(service, row, JSON.parse(r.stdout));
      }
      return { runtime, runtimeError: null, names };
    } catch (e) { return { runtime: null, runtimeError: String(e?.message || e).slice(0, 200), names }; }
  });
}

/* ------------------------------- the rows -------------------------------- */

function liveCheck(db, service) {
  try { const v = db.prepare('SELECT value FROM app_settings WHERE key=?').get(`platform_live_check:${service}`)?.value; return v ? JSON.parse(v) : null; } catch { return null; }
}

function operationRunning(db, service = null) {
  const full = readFullPlatform(db);
  const op = full?.last_job_id && getJob(db, full.last_job_id);
  if (op && OPEN.includes(op.status)) return { id: op.id, status: op.status, phase: op.phase || null, kind: op.kind };
  if (service && serviceReaders[service]) {
    const row = serviceReaders[service](db), last = row?.last_job_id && getJob(db, row.last_job_id);
    if (last && OPEN.includes(last.status)) return { id: last.id, status: last.status, phase: last.phase || null, kind: last.kind };
  }
  return null;
}

const action = (id, label, enabled, reason = null, extra = {}) => ({ id, label, enabled: !!enabled, reason: enabled ? null : reason, ...extra });

function dependents(db, service) {
  if (!['keycloak', 'pomerium'].includes(service)) return [];
  try { return lifecycleReview(db, service, 'remove').blockers; } catch { return []; }
}

function serviceActions(db, service, { ownership, containers, dns, op, selected }) {
  const busy = op ? `Operation ${op.id} is ${op.status}${op.phase ? ` (${op.phase})` : ''}; actions are disabled until it finishes.` : null;
  const managed = ownership === 'managed';
  const notManaged = ownership === 'external' ? 'External services are never started, stopped, repaired or removed by ProxyPilot.' : 'Not selected in the saved plan.';
  const deps = dependents(db, service);
  const out = [];
  for (const c of containers) {
    const present = c.present === true;
    out.push(action(`start:${c.name}`, `Start ${c.name}`, managed && present && !c.running && !busy, busy || (!managed ? notManaged : !present ? `${c.name} is not present; use Repair or Reinstall.` : 'Already running.'), { kind: 'container', container: c.name, verb: 'start' }));
    for (const verb of ['stop', 'restart']) out.push(action(`${verb}:${c.name}`, `${verb[0].toUpperCase()}${verb.slice(1)} ${c.name}`, managed && present && !busy && !deps.length && (verb === 'restart' || c.running), busy || (!managed ? notManaged : !present ? `${c.name} is not present.` : deps.length ? `Refused while ${NAMES[service]} has active dependents: ${deps.join(' ')}` : 'Already stopped.'), { kind: 'container', container: c.name, verb, preview: true }));
  }
  let retry = null;
  if (!selected) retry = 'Not selected in the saved plan.';
  else if (busy) retry = busy;
  else if (!serviceReaders[service]) retry = 'Keycloak has no separate adapter job; use Continue saved setup (Platform Setup step 3).';
  else { const r = serviceRetryRefusal(db, service); if (r) retry = r.error; else if (dns && !dns.ok) retry = dns.reason; }
  out.push(action('retry', 'Retry this service\'s adapter', !retry, retry, { kind: 'service' }));
  out.push(action('verify', 'Re-run verification only', selected && ownership !== 'not_selected', 'Not selected in the saved plan.', { kind: 'service' }));
  for (const verb of ['repair', 'reinstall', 'remove']) {
    let why = !managed ? notManaged : busy;
    if (!why) { try { const r = lifecycleReview(db, service, verb); if (r.blockers.length) why = r.blockers.join(' '); } catch (e) { why = e.fullPlatformSafe ? e.message : 'No saved installation is available for this action.'; } }
    out.push(action(verb, `${verb[0].toUpperCase()}${verb.slice(1)}`, !why, why, { kind: 'lifecycle', preview: true }));
  }
  out.push(action('logs', 'View logs', managed && containers.some((c) => c.present), !managed ? notManaged : 'No owned container is present.', { kind: 'read' }));
  out.push(action('preflight', 'Re-run preflight', selected, 'Not selected in the saved plan.', { kind: 'read' }));
  if (service === 'keycloak') {
    let why = null; try { const r = recoveryReview(db); if (r.blockers.length) why = r.blockers.join(' '); } catch (e) { why = e.fullPlatformSafe ? e.message : 'Unavailable.'; }
    out.push(action('recover_bootstrap', 'Recover bootstrap administrator', !why, why, { kind: 'service', preview: true }));
  }
  return out;
}

function dnsLinks(verdict) {
  if (!verdict) return null;
  if (verdict.zone?.managed) return { kind: 'cloudflare', zone: verdict.zone.zone, page: '/domains', tool: 'set_dns_record', record: verdict.record };
  return { kind: 'external', record: verdict.record, note: 'This zone is not on the stored Cloudflare token: set this record at the external DNS host.' };
}

function lastJobView(db, job, service) {
  if (!job) return null;
  const s = jobSummary(job);
  const full = readFullPlatform(db);
  const dnsBlocked = full?.state?.dnsBlocked?.[service];
  return { ...s, reason_code: reasonCodeOf(s.reason) || (s.status === 'failed' ? s.phase : null), link: `/platform-setup?job=${encodeURIComponent(s.id)}`, ...(dnsBlocked ? { dns_blocked: redactText(dnsBlocked), reason_code_dns: 'dns_mismatch' } : {}) };
}

/** One service row (and its detail panel data). */
export async function serviceOverview(db, service, { run, resolvers, fresh = false, dnsResults = null, ports = undefined } = {}) {
  const s = fullPlatformState(db), mode = s.config.services[service].mode, selected = mode !== 'skip';
  const ownership = !selected ? 'not_selected' : mode === 'install' ? 'managed' : 'external';
  const rt = await inspectServiceRuntime(db, service, run, { fresh });
  const view = platformServiceView(db, service, { runtime: rt.runtime, runtimeError: rt.runtimeError });
  const hostname = view.route?.hostname || null;
  const listen = ports === undefined ? await listening(run, { fresh }) : ports;
  const { row } = rowFor(db, service);
  const route = ownedRoute(service, row);
  const recordedPort = route && has(db, 'service_http_routes') ? db.prepare('SELECT target_port FROM service_http_routes WHERE id=?').get(route.route_id)?.target_port : null;
  const port = recordedPort || SERVICE_PORTS[service][0];
  const upstream = { address: `127.0.0.1:${port}`, port, listening: listen ? listen.includes(Number(port)) : null };
  const containers = view.containers;
  // A pending container (not created yet by design, e.g. the Agent Proxy
  // before bootstrap) is neither missing nor a reason for "broken".
  const missing = rt.runtime ? containers.filter((c) => c.present === false && !c.pending).map((c) => c.name) : [];
  const pending = containers.filter((c) => c.pending).map((c) => ({ name: c.name, status: c.status }));
  const notRunning = containers.filter((c) => c.present && !c.running);
  const unhealthy = containers.filter((c) => c.running && c.health === 'unhealthy');
  let health = 'unknown', healthReason = null;
  if (ownership !== 'managed') { health = ownership === 'external' ? 'external' : 'not_selected'; }
  else if (!row) { health = 'not_installed'; healthReason = 'No saved service record yet; the coordinator prepares it.'; }
  else if (rt.runtimeError) { health = 'unknown'; healthReason = `Docker unreachable: ${rt.runtimeError}`; }
  else if (!rt.runtime) { health = 'unknown'; }
  else if (missing.length + pending.length === containers.length && !containers.some((c) => c.present)) { health = 'not_installed'; healthReason = 'No owned container exists yet.'; }
  else {
    const reasons = [];
    if (missing.length) reasons.push(`expected but missing: ${missing.join(', ')}`);
    for (const c of notRunning) reasons.push(`${c.name} is ${c.status}${c.exit_code != null ? ` (exit ${c.exit_code})` : ''}${c.error ? `: ${c.error}` : ''}`);
    for (const c of unhealthy) reasons.push(`${c.name} is unhealthy`);
    if (view.route?.recorded && upstream.listening === false) reasons.push(`the route's upstream ${upstream.address} is not listening`);
    health = reasons.length ? 'broken' : 'healthy';
    healthReason = [...reasons, ...pending.map((p) => `${p.name}: ${p.status}`)].join('; ') || null;
  }
  const dns = hostname ? (dnsResults?.[hostname] || (await checkHostnames(db, [hostname], { resolvers, fresh })).results[hostname]) : null;
  const op = operationRunning(db, service);
  const entry = s.services.find((x) => x.id === service);
  return redact({
    id: service, name: NAMES[service], url: entry.url || null, selected, mode, ownership, state: entry.state,
    health: { status: health, reason: healthReason, containers, missing, pending, runtime_error: rt.runtimeError, verification: view.verification, live_check: liveCheck(db, service) },
    upstream,
    route: { hostname, route_id: view.route?.route_id || null, recorded: !!view.route?.recorded, restricted_networks: view.route?.restricted_networks || null, other_routes_on_hostname: view.route?.other_routes_on_hostname || [], created_by: 'the service adapter' },
    dns: dns ? { ...dns, links: dnsLinks(dns) } : null,
    last_job: lastJobView(db, entry.job, service), action_text: entry.action ? redactText(entry.action) : null,
    operation: op,
    mcp: mcpAccess(db, { service }),
    actions: serviceActions(db, service, { ownership, containers, dns, op, selected }),
    dependencies: view.dependencies,
    kept_elsewhere: {
      secrets: { page: '/platform-setup', where: 'Platform Setup → the service\'s own form (client secrets, admin tokens, Infisical personal password, OpenBao PGP keys, unseal shares, root/bootstrap token, vault passwords)' },
      sso_activation: service === 'keycloak' ? { page: '/platform-setup', where: 'Platform Setup → E. Verify everything and activate SSO' } : null,
      reset: { page: '/platform-setup', where: 'Platform Setup → Reset Full Platform' },
    },
  });
}

async function recoveryOverview(db, { run, resolvers, fresh, ports }) {
  const s = fullPlatformState(db);
  const url = s.config.recoveryOrigin || null, hostname = url ? new URL(url).hostname : null;
  const routeRow = has(db, 'service_http_routes') ? db.prepare('SELECT id, domain, target_port, ip_allowlist_json FROM service_http_routes WHERE id=?').get(RECOVERY_ROUTE_ID) : null;
  const port = routeRow?.target_port || Number(process.env.PORT || 3001);
  const listen = ports === undefined ? await listening(run, { fresh }) : ports;
  const dns = hostname ? (await checkHostnames(db, [hostname], { resolvers, fresh })).results[hostname] : null;
  const upstream = { address: `127.0.0.1:${port}`, port, listening: listen ? listen.includes(Number(port)) : null };
  return redact({
    id: 'recovery', name: 'ProxyPilot recovery route', url, selected: !!url, ownership: 'managed',
    health: { status: !routeRow ? 'not_installed' : upstream.listening === false ? 'broken' : 'healthy', reason: !routeRow ? 'The recovery route is created by the coordinator (configure_recovery_route).' : upstream.listening === false ? `the route's upstream ${upstream.address} is not listening` : null, containers: [], missing: [] },
    upstream,
    route: { hostname, route_id: RECOVERY_ROUTE_ID, recorded: !!routeRow, restricted_networks: routeRow?.ip_allowlist_json ? JSON.parse(routeRow.ip_allowlist_json) : null, created_by: 'the Full Platform coordinator' },
    dns: dns ? { ...dns, links: dnsLinks(dns) } : null,
    actions: [], mcp: mcpAccess(db),
  });
}

/** The whole Platform overview: the toggle state, section actions and one row per service. */
export async function platformOverview(db, { run, resolvers, fresh = false } = {}) {
  const full = readFullPlatform(db);
  const flag = platformFlagState(db);
  if (!full) return redact({ saved: false, flag, mcp_access: mcpAccess(db), services: [], note: 'No Full Platform plan is saved yet. Start in Platform Setup → A. Domains, realm and networks.' });
  const docker = await dockerInfo(run, { fresh });
  const ports = await listening(run, { fresh });
  const s = fullPlatformState(db);
  const hostnames = [s.config.recoveryOrigin, ...SERVICE_IDS.map((id) => s.config.services[id].url)].filter(Boolean).map((u) => new URL(u).hostname);
  const dnsAll = await checkHostnames(db, hostnames, { resolvers, fresh });
  const services = [];
  for (const id of SERVICE_IDS) services.push(await serviceOverview(db, id, { run, resolvers, fresh, dnsResults: dnsAll.results, ports }));
  services.push(await recoveryOverview(db, { run, resolvers, fresh, ports }));
  const op = operationRunning(db);
  let resync = null; try { resync = resyncReview(db); } catch { resync = null; }
  // Additional addresses can be changed at any time — also after SSO is
  // active (the networks are outside the SSO fingerprint). Only a running
  // operation, or no applied setup yet (save them in stage A), blocks it.
  const netBlock = op ? `Operation ${op.id} is ${op.status}${op.phase ? ` (${op.phase})` : ''}.` : !full.approved_revision ? 'Not applied yet: the additional addresses are part of the saved plan (stage A).' : null;
  return redact({
    saved: true, revision: full.revision, approved_revision: full.approved_revision, flag, mcp_access: mcpAccess(db),
    docker, caddy_host: dnsAll.expected, operation: op,
    vpn_networks: s.networks.vpn, additional_networks: s.networks.additional, restricted_networks: s.networks.effective, restricted_networks_applied: s.networks.applied,
    shared_plan: { in_sync: resync ? resync.in_sync : true, shared_revision: resync?.shared_plan_revision || null, recorded_revision: resync?.recorded_plan_revision || null },
    section_actions: [
      action('edit_networks', 'Edit additional addresses', !netBlock, netBlock, { preview: true }),
      action('resync_plan', 'Resync shared plan', resync && !resync.blockers.length, resync ? resync.blockers.join(' ') : 'No saved plan.', { preview: true }),
    ],
    services, generated_at: new Date().toISOString(), cache_seconds: OVERVIEW_TTL_MS / 1000,
  });
}

/* -------------------------------- actions -------------------------------- */

function ownedContainer(db, service, container) {
  if (!SERVICE_IDS.includes(service)) throw fail(`Unknown service ${service}.`);
  const { target, row } = rowFor(db, service);
  if (!target) throw fail(`${service} has no saved installation.`);
  if (target.mode !== 'install') throw fail('External services are never started, stopped or restarted by ProxyPilot.');
  if (!containerNames(service, row).includes(container)) throw fail(`${container} is not an owned ${service} container.`);
  return { row, ref: service === 'keycloak' ? row.id : row.credential_ref };
}

/** Preview of start/stop/restart (inspects the container: its immutable ID binds the token). */
export async function containerControlReview(db, { service, container, action: verb }, run) {
  if (!['start', 'stop', 'restart'].includes(verb)) throw fail('action must be start, stop or restart.');
  const { ref } = ownedContainer(db, service, container);
  const blockers = [];
  const op = operationRunning(db, service);
  if (op) blockers.push(`Operation ${op.id} is ${op.status}${op.phase ? ` (${op.phase})` : ''}. Wait for it.`);
  if (verb !== 'start') for (const b of dependents(db, service)) blockers.push(`Refused while ${NAMES[service]} has active dependents: ${b}`);
  const r = norm(await run(['docker', 'container', 'inspect', container]));
  let actual = null; try { actual = r.code === 0 ? JSON.parse(r.stdout)[0] : null; } catch { actual = null; }
  if (!actual) blockers.push(`${container} is not present on this host; use Repair or Reinstall.`);
  else if (actual.Config?.Labels?.[`io.proxypilot.${service}`] !== ref) blockers.push(`${container} does not carry this installation's ownership label; nothing will be changed.`);
  const id = actual?.Id || null;
  const effects = verb === 'start' ? [`Start ${container} (ID ${String(id || '').slice(0, 12)}) and wait until it is running and, if its image has a healthcheck, healthy.`]
    : verb === 'stop' ? [`Stop ${container} (ID ${String(id || '').slice(0, 12)}) with a 30 s grace period. ${NAMES[service]} is unavailable until it is started again; its route answers 502.`, 'No data, volume, file or credential is touched.']
      : [`Restart ${container} (ID ${String(id || '').slice(0, 12)}) with a 30 s grace period, then wait for running/healthy. Brief downtime.`, 'No data, volume, file or credential is touched.'];
  return redact({ service, container, action: verb, container_id: id ? id.slice(0, 12) : null, running: !!actual?.State?.Running, blockers, effects, reviewToken: digest(['container', service, container, verb, id, blockers]) });
}

export async function controlContainer(db, { service, container, action: verb, reviewToken }, run, { job = null } = {}) {
  const review = await containerControlReview(db, { service, container, action: verb }, run);
  if (review.blockers.length) throw fail(review.blockers.join(' '));
  if (reviewToken !== undefined && reviewToken !== review.reviewToken) throw fail('The container changed since the preview. Review the action again.', 'CONTAINER_REVIEW_STALE');
  const full = norm(await run(['docker', 'container', 'inspect', container]));
  const id = JSON.parse(full.stdout)[0].Id;
  if (verb !== 'start') {
    const r = norm(await run(['docker', verb, '--time', '30', id]));
    if (r.code !== 0) throw fail(`docker ${verb} failed for ${container} (exit ${r.code}).`);
  }
  let started = null;
  if (verb !== 'stop') started = await startOwnedContainer({ run, name: container, fail, job, label: container, startTimeoutMs: 60000, healthTimeoutMs: 180000 });
  clearOverviewCache();
  return { service, container, action: verb, container_id: id.slice(0, 12), ...(started ? { health: started.health, already_running: started.already } : { stopped: true }) };
}

/** Retry one service's adapter — refusals (including DNS) first. */
export async function retryService(db, service, by, { resolvers } = {}) {
  if (!serviceReaders[service]) throw fail('Keycloak has no separate adapter job; continue the saved setup instead.');
  const refusal = serviceRetryRefusal(db, service);
  if (refusal) throw Object.assign(fail(refusal.error, refusal.code || 'RETRY_REFUSED'), { detail: refusal });
  const url = readFullPlatform(db).config.services[service].url;
  const dns = await dnsRefusal(db, [new URL(url).hostname], { resolvers });
  if (dns) throw Object.assign(fail(dns.error, dns.code), { detail: dns });
  const r = applyService(db, service, by);
  return { queued: r.created, job: jobSummary(r.job) };
}

/** Re-run verification only: runtime, upstream, DNS and a self-check probe through the local Caddy. Records the result. */
export async function verifyService(db, service, { run, resolvers } = {}) {
  const o = await serviceOverview(db, service, { run, resolvers, fresh: true });
  const checks = [];
  if (o.ownership === 'managed') {
    checks.push({ id: 'containers', ok: o.health.status === 'healthy', detail: o.health.reason || 'every owned container is running' + (o.health.containers.some((c) => c.health === 'healthy') ? ' and healthy' : '') });
    checks.push({ id: 'upstream', ok: o.upstream.listening !== false, detail: o.upstream.listening === null ? 'listening ports could not be read' : o.upstream.listening ? `${o.upstream.address} is listening` : `${o.upstream.address} is not listening (reason code: upstream_not_listening)` });
  }
  if (o.dns) checks.push({ id: 'dns', ok: o.dns.ok, detail: o.dns.ok ? `resolves to the Caddy host (${o.dns.expected.address}) from the host and from 1.1.1.1` : o.dns.reason });
  if (o.route.recorded && o.route.hostname) {
    const token = selfCheckToken(db);
    const r = norm(await run(['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15', '--resolve', `${o.route.hostname}:443:${localEdgeAddress()}`, '-H', `${SELF_CHECK_HEADER}: ${token}`, `https://${o.route.hostname}/`]));
    const code = Number(r.stdout.trim()) || 0;
    const ok = r.code === 0 && code > 0 && code !== 403 && code < 500;
    checks.push({ id: 'route_self_check', ok, detail: r.code !== 0 ? `the local Caddy probe failed (curl exit ${r.code}; TLS or listener)` : code === 403 ? 'HTTP 403: the restricted matcher refused the adapter self-check' : code >= 500 ? `HTTP ${code}: Caddy could not reach the upstream` : `HTTP ${code} through the local Caddy with SNI/Host ${o.route.hostname}` });
  } else if (o.selected && o.ownership === 'managed') checks.push({ id: 'route', ok: false, detail: 'The route is not created yet; the service adapter creates it.' });
  const result = { service, at: new Date().toISOString(), ok: checks.every((c) => c.ok), checks, verification: o.health.verification };
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`platform_live_check:${service}`, JSON.stringify({ at: result.at, ok: result.ok, checks }));
  clearOverviewCache();
  return redact(result);
}

/** Last N redacted log lines per owned container. */
export async function serviceLogs(db, service, { run, lines = 50, container = null } = {}) {
  const { target, row } = rowFor(db, service);
  if (!target) throw fail(`${service} has no saved installation.`);
  if (target.mode !== 'install') throw fail('External services\' logs are read where they run; ProxyPilot does not own them.');
  const n = Number(lines) === 200 ? 200 : 50;
  const names = containerNames(service, row).filter((c) => !container || c === container);
  if (container && !names.length) throw fail(`${container} is not an owned ${service} container.`);
  const listed = norm(await run(['docker', 'container', 'ls', '-a', '--format', '{{.Names}}']));
  if (listed.code !== 0) return redact({ service, lines: n, readable: false, reason: 'Docker is unreachable on the host.', containers: [] });
  const present = listed.stdout.split('\n');
  const out = [];
  for (const name of names) {
    if (!present.includes(name)) { out.push({ container: name, readable: false, reason: `${name} is not present on this host (expected but missing).` }); continue; }
    const logs = await readContainerLogs({ run, name, lines: n, scrub: (t) => scrubKnownSecrets(db, t) });
    out.push({ container: name, ...logs });
  }
  return redact({ service, lines: n, containers: out });
}

/** Preflight for one service's hostname and ports. */
export async function servicePreflight(db, service, { run, resolvers } = {}) {
  const s = fullPlatformState(db), url = s.config.services[service]?.url;
  if (!url) return { service, ready: false, checks: [{ id: 'selected', ok: false, detail: 'Not selected in the saved plan.' }] };
  const hostname = new URL(url).hostname;
  const dns = (await checkHostnames(db, [hostname], { resolvers, fresh: true })).results[hostname];
  const ports = await listening(run, { fresh: true });
  const docker = await dockerInfo(run, { fresh: true });
  const view = platformServiceView(db, service);
  const own = s.config.services[service].mode === 'install';
  const runningOwned = own ? (await inspectServiceRuntime(db, service, run, { fresh: true })).runtime : null;
  const ownedUp = runningOwned && Object.values(runningOwned).some((c) => c.running);
  const checks = [
    { id: `dns:${hostname}`, ok: dns.ok, detail: dns.ok ? `resolves to the Caddy host (${dns.expected.address}) from the host and from 1.1.1.1` : dns.reason, links: dnsLinks(dns) },
    ...(view.route.other_routes_on_hostname?.length ? [{ id: `route:${hostname}`, ok: false, detail: `another recorded route already serves ${hostname} (${view.route.other_routes_on_hostname.join(', ')}); the service adapter creates this route and refuses while it exists.` }] : []),
    { id: 'docker', ok: !!docker.ok, detail: docker.ok ? `Docker ${docker.version}` : docker.error },
    ...(own ? SERVICE_PORTS[service].map((p) => ({ id: `port:${p}`, ok: !ports || !ports.includes(p) || !!ownedUp, detail: ports === null ? 'listening ports could not be read' : ports.includes(p) ? (ownedUp ? `${p} is in use by the owned ${service} runtime` : `${p} is already in use by something else`) : `${p} is free` })) : []),
  ];
  return redact({ service, hostname, ready: checks.every((c) => c.ok), checks });
}

export { NAMES as SERVICE_NAMES };
